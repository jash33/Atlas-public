import {
  isCapabilityStep,
  createGraphCompiledWorkflowVersion,
  workflowStepExpressions,
  type CapabilityStep,
  versionedCompiledWorkflowVersionSchema,
  createCompiledWorkflowVersion,
  createTransformationCompiledWorkflowVersion,
  valueReferenceSchema,
  versionedExecutableWorkflowSchema,
  type TransformationExpression,
  visitTransformationExpression,
  type VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import type { Pool } from 'pg';
import { z } from 'zod';
import { recordWorkflowLifecycle } from './workflow-catalog.js';

import type { PlannerModel } from './workflow-planning.js';
import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { canonicalJson, type ChangeClassification } from './capability-versioning.js';
import { validateWorkflowDraft } from './workflow-validation.js';
import { assertEnvironmentWorkersSupportIr } from './environment-workers.js';
import { hasExactMigratedCapabilityPins } from './workflow-activation-readiness.js';

function createMigrationWorkflow(
  workflowVersionId: string,
  organizationId: string,
  rawExecutable: unknown,
) {
  const executable = versionedExecutableWorkflowSchema.parse(rawExecutable);
  return executable.irVersion === 3
    ? createGraphCompiledWorkflowVersion(workflowVersionId, organizationId, executable)
    : executable.irVersion === 2
      ? createTransformationCompiledWorkflowVersion(workflowVersionId, organizationId, executable)
      : createCompiledWorkflowVersion(workflowVersionId, organizationId, executable);
}

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const workflowMigrationRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    sourceWorkflowVersionId: z.string().min(1),
    workflowVersionId: z.string().min(1),
    fromCapabilityVersionId: z.string().min(1),
    toCapabilityVersionId: z.string().min(1),
    projectionFingerprint: fingerprintSchema,
  })
  .strict();

export const workflowMigrationCorrectionSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    projectionFingerprint: fingerprintSchema,
    mappings: z
      .array(
        z
          .object({
            stepId: z.string().min(1),
            argument: z.string().min(1),
            source: valueReferenceSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const migrationCandidateQuerySchema = z
  .object({ organizationId: z.string().min(1), candidateId: z.string().regex(/^\d+$/) })
  .strict();
const workflowActivationQuerySchema = z
  .object({ organizationId: z.string().min(1), activationId: z.string().regex(/^\d+$/) })
  .strict();

const fieldChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added-optional'), path: z.string().min(1) }).passthrough(),
  z
    .object({
      kind: z.literal('renamed'),
      fromPath: z.string().min(1),
      path: z.string().min(1),
    })
    .passthrough(),
  z.object({ kind: z.literal('retyped'), path: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal('added-required'), path: z.string().min(1) }).passthrough(),
  z.object({ kind: z.literal('removed'), path: z.string().min(1) }).passthrough(),
]);
type FieldChange = z.infer<typeof fieldChangeSchema>;

interface MigrationSourceRow {
  readonly compiled_workflow: unknown;
  readonly classification: ChangeClassification;
  readonly diff: { fieldChanges?: unknown[] };
  readonly from_capability_fragment: unknown;
  readonly to_capability_fragment: unknown;
}

export class WorkflowMigrationSourceNotFound extends Error {}
export class WorkflowMigrationPlannerRequired extends Error {}
export class WorkflowMigrationCandidateNotFound extends Error {}
export class WorkflowMigrationCorrectionRejected extends Error {}
export class WorkflowMigrationVersionIdentityConflict extends Error {}
export class WorkflowMigrationActivationConflict extends Error {}
export class WorkflowMigrationRollbackConflict extends Error {}

type JsonObject = Record<string, unknown>;
interface WorkflowCapabilityPair {
  readonly workflowVersionId: string;
  readonly capabilityVersionId: string;
}

function workflowCapabilityPair(
  workflowVersionId: string,
  capabilityVersionId: string,
): WorkflowCapabilityPair {
  return { workflowVersionId, capabilityVersionId: capabilityVersionId.trim() };
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function escapePointerSegment(value: string) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function propertyPointers(fragment: JsonObject, schemaValue: unknown, inlineSchemaPointer: string) {
  const schema = objectValue(schemaValue);
  if (!schema) return [];
  const reference = typeof schema.$ref === 'string' ? schema.$ref : undefined;
  const resolved = reference ? objectValue(objectValue(fragment.references)?.[reference]) : schema;
  const properties = objectValue(resolved?.properties);
  const propertiesPointer = reference
    ? `/references/${escapePointerSegment(reference)}/properties`
    : `${inlineSchemaPointer}/properties`;
  return Object.keys(properties ?? {}).map(
    (field) => `${propertiesPointer}/${escapePointerSegment(field)}`,
  );
}

function topLevelInputPropertyPointers(fragmentValue: unknown) {
  const fragment = objectValue(fragmentValue);
  if (!fragment) return new Set<string>();
  const pointers: string[] = [];
  const operation = objectValue(fragment.operation);
  const content = objectValue(objectValue(operation?.requestBody)?.content);
  for (const [mediaType, mediaValue] of Object.entries(content ?? {})) {
    pointers.push(
      ...propertyPointers(
        fragment,
        objectValue(mediaValue)?.schema,
        `/operation/requestBody/content/${escapePointerSegment(mediaType)}/schema`,
      ),
    );
  }
  pointers.push(
    ...propertyPointers(fragment, objectValue(fragment.message)?.payload, '/message/payload'),
  );
  return new Set(pointers);
}

function topLevelResponsePropertyPointers(fragmentValue: unknown) {
  const fragment = objectValue(fragmentValue);
  if (!fragment) return new Set<string>();
  const pointers: string[] = [];
  const operation = objectValue(fragment.operation);
  for (const [status, responseValue] of Object.entries(objectValue(operation?.responses) ?? {})) {
    const content = objectValue(objectValue(responseValue)?.content);
    for (const [mediaType, mediaValue] of Object.entries(content ?? {})) {
      pointers.push(
        ...propertyPointers(
          fragment,
          objectValue(mediaValue)?.schema,
          `/operation/responses/${escapePointerSegment(status)}/content/${escapePointerSegment(mediaType)}/schema`,
        ),
      );
    }
  }
  pointers.push(
    ...propertyPointers(fragment, objectValue(fragment.message)?.payload, '/message/payload'),
  );
  return new Set(pointers);
}

function decodePointerSegment(path: string) {
  const segment = path.split('/').at(-1);
  return segment?.replaceAll('~1', '/').replaceAll('~0', '~');
}

function deterministicInputRenames(
  fieldChanges: readonly FieldChange[],
  fromCapabilityFragment: unknown,
  toCapabilityFragment: unknown,
) {
  const renames = fieldChanges.flatMap((change) => {
    if (change.kind !== 'renamed') return [];
    const from = decodePointerSegment(change.fromPath);
    const to = decodePointerSegment(change.path);
    return from && to ? [{ from, to }] : [];
  });
  if (renames.length !== fieldChanges.filter(({ kind }) => kind === 'renamed').length) {
    return undefined;
  }
  const fromInputPointers = topLevelInputPropertyPointers(fromCapabilityFragment);
  const toInputPointers = topLevelInputPropertyPointers(toCapabilityFragment);
  return fieldChanges.some(
    (change) =>
      change.kind === 'renamed' &&
      (!fromInputPointers.has(change.fromPath) || !toInputPointers.has(change.path)),
  )
    ? undefined
    : renames;
}

function deterministicExecutable(
  workflow: VersionedCompiledWorkflowVersion,
  fromCapabilityVersionId: string,
  toCapabilityVersionId: string,
  classification: MigrationSourceRow['classification'],
  fieldChanges: readonly FieldChange[],
  inputRenames: readonly { from: string; to: string }[] | undefined,
  fromCapabilityFragment: unknown,
) {
  if (fieldChanges.length === 0 && classification !== 'compatible') return undefined;
  const migratedSteps = workflow.executable.steps.filter(
    (step): step is CapabilityStep =>
      isCapabilityStep(step) && step.capabilityVersionId === fromCapabilityVersionId,
  );
  const migratedStepIds = new Set(migratedSteps.map(({ id }) => id));
  const responsePointers = topLevelResponsePropertyPointers(fromCapabilityFragment);
  const safelyRemovedResponseFields = new Set(
    fieldChanges.flatMap((change) =>
      change.kind === 'removed' && responsePointers.has(change.path)
        ? [decodePointerSegment(change.path)].filter((field): field is string => Boolean(field))
        : [],
    ),
  );
  const removedResponseFieldsAreUnused = [...safelyRemovedResponseFields].every(
    (field) =>
      migratedSteps.every((step) => !step.responseSchema?.required[field]) &&
      workflow.executable.steps.every((step) =>
        [
          ...Object.values(workflowStepExpressions(step)),
          isCapabilityStep(step) ? step.idempotency?.businessKey : undefined,
        ]
          .filter((reference): reference is TransformationExpression => Boolean(reference))
          .every((expression) => {
            let unused = true;
            visitTransformationExpression(expression, (reference) => {
              const parsed = valueReferenceSchema.safeParse(reference);
              if (
                parsed.success &&
                parsed.data.source === 'stepOutput' &&
                migratedStepIds.has(parsed.data.stepId) &&
                (parsed.data.path.length === 0 || parsed.data.path[0] === field)
              )
                unused = false;
            });
            return unused;
          }),
      ),
  );
  if (
    !fieldChanges.every(
      ({ kind, path }) =>
        kind === 'added-optional' ||
        kind === 'renamed' ||
        (kind === 'removed' && responsePointers.has(path) && removedResponseFieldsAreUnused),
    )
  ) {
    return undefined;
  }
  if (!inputRenames) return undefined;

  const steps = workflow.executable.steps.map((step) => {
    if (!isCapabilityStep(step) || step.capabilityVersionId !== fromCapabilityVersionId) {
      return step;
    }
    let arguments_: Record<string, TransformationExpression> = { ...step.arguments };
    for (const rename of inputRenames) {
      if (!(rename.from in arguments_) || rename.to in arguments_) return step;
      const source = arguments_[rename.from]!;
      const { [rename.from]: _removed, ...remaining } = arguments_;
      arguments_ = { ...remaining, [rename.to]: source } as typeof arguments_;
    }
    return { ...step, capabilityVersionId: toCapabilityVersionId, arguments: arguments_ };
  });
  if (
    steps.some(
      (step) =>
        'capabilityVersionId' in step && step.capabilityVersionId === fromCapabilityVersionId,
    )
  ) {
    return undefined;
  }
  return { ...workflow.executable, steps };
}

async function readMigrationSource(
  pool: Pool,
  request: z.infer<typeof workflowMigrationRequestSchema>,
) {
  const result = await pool.query<MigrationSourceRow>(
    `SELECT version.compiled_workflow, diff.classification, diff.diff,
      from_version.capability_fragment AS from_capability_fragment,
      to_version.capability_fragment AS to_capability_fragment
     FROM workflow_versions version
     JOIN workflow_capability_dependencies dependency
       ON dependency.organization_id = version.organization_id
      AND dependency.workflow_version_id = version.workflow_version_id
      AND dependency.capability_version_id = $3
     JOIN compatibility_diffs diff
       ON diff.organization_id = version.organization_id
      AND diff.from_capability_version_id = $3
      AND diff.to_capability_version_id = $4
     JOIN capability_versions from_version
       ON from_version.organization_id = version.organization_id
      AND from_version.capability_version_id = $3
     JOIN capability_versions to_version
       ON to_version.organization_id = version.organization_id
      AND to_version.capability_version_id = $4
     WHERE version.organization_id = $1 AND version.workflow_version_id = $2
       AND version.compiled_workflow IS NOT NULL
     LIMIT 1`,
    [
      request.organizationId,
      request.sourceWorkflowVersionId,
      request.fromCapabilityVersionId,
      request.toCapabilityVersionId,
    ],
  );
  return result.rows[0];
}

export async function generateWorkflowMigrationCandidate(
  pool: Pool,
  planner: PlannerModel | undefined,
  rawRequest: unknown,
) {
  const request = workflowMigrationRequestSchema.parse(rawRequest);
  if (request.workflowVersionId === request.sourceWorkflowVersionId) {
    throw new WorkflowMigrationVersionIdentityConflict(
      'A migrated workflow must have a new workflow version id',
    );
  }
  const source = await readMigrationSource(pool, request);
  if (!source) throw new WorkflowMigrationSourceNotFound('Migration source was not found');
  const workflow = versionedCompiledWorkflowVersionSchema.parse(source.compiled_workflow);
  const fieldChanges = z.array(fieldChangeSchema).parse(source.diff.fieldChanges ?? []);
  const inputRenames = deterministicInputRenames(
    fieldChanges,
    source.from_capability_fragment,
    source.to_capability_fragment,
  );
  const executable = deterministicExecutable(
    workflow,
    request.fromCapabilityVersionId,
    request.toCapabilityVersionId,
    source.classification,
    fieldChanges,
    inputRenames,
    source.from_capability_fragment,
  );
  let candidateExecutable = executable;
  let author: 'compiler' | 'planner' = 'compiler';
  if (!candidateExecutable) {
    if (!planner?.migrateWorkflow) {
      throw new WorkflowMigrationPlannerRequired('Migration requires the grounded planner');
    }
    const projection = await readPlannerCapabilityProjection(
      pool,
      request.organizationId,
      request.environmentId,
    );
    const proposed = versionedCompiledWorkflowVersionSchema.parse(
      await planner.migrateWorkflow({
        sourceWorkflow: workflow,
        requestedWorkflowVersionId: request.workflowVersionId,
        fromCapabilityVersionId: request.fromCapabilityVersionId,
        toCapabilityVersionId: request.toCapabilityVersionId,
        classification: source.classification,
        fieldChanges,
        projection,
      }),
    );
    candidateExecutable = proposed.executable;
    author = 'planner';
  }
  const draft = await createMigrationWorkflow(
    request.workflowVersionId,
    request.organizationId,
    candidateExecutable,
  );
  const plannerAuthoredLiteralPaths =
    author === 'planner'
      ? plannerAuthoredLiteralPathsFrom(
          workflow,
          draft,
          request.fromCapabilityVersionId,
          request.toCapabilityVersionId,
          inputRenames ?? [],
        )
      : [];
  const validation = await validateWorkflowDraft(pool, {
    organizationId: request.organizationId,
    environmentId: request.environmentId,
    proposedApproverRole: 'admin',
    projectionFingerprint: request.projectionFingerprint,
    plannerAuthoredLiteralPaths,
    draft,
  });
  const client = await pool.connect();
  let recorded: { id: string; created_at: Date; updated_at: Date };
  try {
    await client.query('BEGIN');
    const reserved = await client.query(
      `INSERT INTO workflow_versions (organization_id, workflow_version_id, workflow_id)
       SELECT organization_id, $2, workflow_id
       FROM workflow_versions
       WHERE organization_id = $1 AND workflow_version_id = $3
       ON CONFLICT DO NOTHING RETURNING workflow_version_id`,
      [request.organizationId, request.workflowVersionId, request.sourceWorkflowVersionId],
    );
    if (!reserved.rows[0]) {
      throw new WorkflowMigrationVersionIdentityConflict(
        'Workflow version id is already assigned or reserved',
      );
    }
    const inserted = await client.query<{ id: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO workflow_migration_candidates
         (organization_id, environment_id, source_workflow_version_id, workflow_version_id,
          from_capability_version_id, to_capability_version_id, author, draft, validation,
          planner_authored_literal_paths)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, created_at, updated_at`,
      [
        request.organizationId,
        request.environmentId,
        request.sourceWorkflowVersionId,
        request.workflowVersionId,
        request.fromCapabilityVersionId,
        request.toCapabilityVersionId,
        author,
        draft,
        validation,
        JSON.stringify(plannerAuthoredLiteralPaths),
      ],
    );
    recorded = inserted.rows[0]!;
    await recordWorkflowLifecycle(client, {
      organizationId: request.organizationId,
      environmentId: request.environmentId,
      workflowVersionId: request.workflowVersionId,
      status: 'awaiting-approval',
      observedAt: recorded.updated_at,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {
    candidateId: recorded.id,
    author,
    sourceWorkflowVersionId: request.sourceWorkflowVersionId,
    fromCapabilityVersionId: request.fromCapabilityVersionId,
    toCapabilityVersionId: request.toCapabilityVersionId,
    draft,
    validation,
    validationContext: { plannerAuthoredLiteralPaths },
    createdAt: recorded.created_at.toISOString(),
    updatedAt: recorded.updated_at.toISOString(),
  };
}

function plannerAuthoredLiteralPathsFrom(
  sourceWorkflow: VersionedCompiledWorkflowVersion,
  candidateWorkflow: VersionedCompiledWorkflowVersion,
  fromCapabilityVersionId: string,
  toCapabilityVersionId: string,
  inputRenames: readonly { from: string; to: string }[],
) {
  const sourceSteps = new Map(sourceWorkflow.executable.steps.map((step) => [step.id, step]));
  return candidateWorkflow.executable.steps.flatMap((step) => {
    if (!isCapabilityStep(step)) return [];
    const sourceStep = sourceSteps.get(step.id);
    return Object.entries(step.arguments).flatMap(([argument, source]) => {
      const isMigratedStep =
        sourceStep &&
        isCapabilityStep(sourceStep) &&
        sourceStep?.capabilityVersionId === fromCapabilityVersionId &&
        step.capabilityVersionId === toCapabilityVersionId;
      const sourceArgument =
        (isMigratedStep ? inputRenames.find(({ to }) => to === argument)?.from : undefined) ??
        argument;
      const sourceMapping =
        sourceStep && isCapabilityStep(sourceStep)
          ? sourceStep.arguments[sourceArgument]
          : undefined;
      const previousLiterals = new Set<string>();
      visitTransformationExpression(sourceMapping, (node) => {
        if (node.source === 'literal') previousLiterals.add(canonicalJson(node.value));
      });
      let introducedLiteral = false;
      visitTransformationExpression(source, (node) => {
        if (node.source === 'literal' && !previousLiterals.has(canonicalJson(node.value))) {
          introducedLiteral = true;
        }
      });
      return introducedLiteral ? [`executable.steps[${step.id}].arguments.${argument}`] : [];
    });
  });
}

export async function correctWorkflowMigrationCandidate(
  pool: Pool,
  candidateId: string,
  rawCorrection: unknown,
) {
  const correction = workflowMigrationCorrectionSchema.parse(rawCorrection);
  const existing = await readWorkflowMigrationCandidate(
    pool,
    correction.organizationId,
    candidateId,
  );
  if (!existing) throw new WorkflowMigrationCandidateNotFound('Migration candidate was not found');
  if (correction.mappings.some(({ source }) => source.source === 'literal')) {
    throw new WorkflowMigrationCorrectionRejected(
      'Migration corrections must use a trusted workflow source path',
    );
  }
  let executable = existing.draft.executable;
  const plannerAuthoredLiteralPaths = new Set(
    existing.validationContext.plannerAuthoredLiteralPaths,
  );
  for (const mapping of correction.mappings) {
    let found = false;
    const steps = executable.steps.map((step) => {
      if (step.id !== mapping.stepId || !isCapabilityStep(step)) return step;
      found = true;
      const mappingPath = `executable.steps[${step.id}].arguments.${mapping.argument}`;
      plannerAuthoredLiteralPaths.delete(mappingPath);
      return {
        ...step,
        arguments: { ...step.arguments, [mapping.argument]: mapping.source },
      };
    });
    if (!found) {
      throw new WorkflowMigrationCorrectionRejected(`Step '${mapping.stepId}' does not exist`);
    }
    executable = versionedExecutableWorkflowSchema.parse({ ...executable, steps });
  }
  const draft = await createMigrationWorkflow(
    existing.draft.workflowVersionId,
    correction.organizationId,
    executable,
  );
  const validation = await validateWorkflowDraft(pool, {
    organizationId: correction.organizationId,
    environmentId: correction.environmentId,
    proposedApproverRole: 'admin',
    projectionFingerprint: correction.projectionFingerprint,
    plannerAuthoredLiteralPaths: [...plannerAuthoredLiteralPaths],
    draft,
  });
  const updated = await pool.query<{ updated_at: Date }>(
    `UPDATE workflow_migration_candidates
     SET draft = $3, validation = $4, planner_authored_literal_paths = $5,
       updated_at = current_timestamp
     WHERE id = $1 AND organization_id = $2
     RETURNING updated_at`,
    [
      candidateId,
      correction.organizationId,
      draft,
      validation,
      JSON.stringify([...plannerAuthoredLiteralPaths]),
    ],
  );
  if (!updated.rows[0]) {
    throw new WorkflowMigrationCandidateNotFound('Migration candidate was not found');
  }
  return {
    ...existing,
    draft,
    validation,
    validationContext: { plannerAuthoredLiteralPaths: [...plannerAuthoredLiteralPaths] },
    updatedAt: updated.rows[0].updated_at.toISOString(),
  };
}

export async function readWorkflowMigrationCandidate(
  pool: Pool,
  organizationId: string,
  candidateId: string,
) {
  const query = migrationCandidateQuerySchema.parse({ organizationId, candidateId });
  const result = await pool.query<{
    id: string;
    author: 'compiler' | 'planner';
    source_workflow_version_id: string;
    environment_id: string;
    from_capability_version_id: string;
    to_capability_version_id: string;
    draft: unknown;
    validation: unknown;
    planner_authored_literal_paths: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, author, source_workflow_version_id, environment_id,
      from_capability_version_id, to_capability_version_id, draft, validation,
      planner_authored_literal_paths, created_at, updated_at
     FROM workflow_migration_candidates WHERE id = $1 AND organization_id = $2`,
    [query.candidateId, query.organizationId],
  );
  const row = result.rows[0];
  return row
    ? {
        candidateId: row.id,
        author: row.author,
        environmentId: row.environment_id,
        sourceWorkflowVersionId: row.source_workflow_version_id,
        fromCapabilityVersionId: row.from_capability_version_id.trim(),
        toCapabilityVersionId: row.to_capability_version_id.trim(),
        draft: versionedCompiledWorkflowVersionSchema.parse(row.draft),
        validation: row.validation,
        validationContext: {
          plannerAuthoredLiteralPaths: z
            .array(z.string())
            .parse(row.planner_authored_literal_paths),
        },
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }
    : undefined;
}

export async function findWorkflowMigrationCandidateForApproval(
  pool: Pool,
  organizationId: string,
  environmentId: string,
  workflowVersionId: string,
  irHash: string,
) {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM workflow_migration_candidates
     WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3
       AND draft->>'irHash' = $4
     ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [organizationId, environmentId, workflowVersionId, irHash],
  );
  const row = result.rows[0];
  return row ? readWorkflowMigrationCandidate(pool, organizationId, row.id) : undefined;
}

export async function activateWorkflowMigrationCandidate(
  pool: Pool,
  candidateId: string,
  organizationId: string,
  environmentId: string,
  activatedBy: string,
) {
  const query = migrationCandidateQuerySchema.parse({ organizationId, candidateId });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const candidate = await client.query<{
      source_workflow_version_id: string;
      workflow_version_id: string;
      from_capability_version_id: string;
      to_capability_version_id: string;
      ir_version: number;
      source_compiled_workflow: unknown;
      candidate_compiled_workflow: unknown;
      artifact_id: string | null;
    }>(
      `SELECT candidate.source_workflow_version_id, candidate.workflow_version_id,
        candidate.from_capability_version_id, candidate.to_capability_version_id,
        (candidate.draft->'executable'->>'irVersion')::integer AS ir_version,
        source_version.compiled_workflow AS source_compiled_workflow,
        candidate.draft AS candidate_compiled_workflow, approval.artifact_id
       FROM workflow_migration_candidates candidate
       JOIN workflow_versions source_version
         ON source_version.organization_id = candidate.organization_id
        AND source_version.workflow_version_id = candidate.source_workflow_version_id
       JOIN workflow_approvals approval
         ON approval.organization_id = candidate.organization_id
        AND approval.environment_id = candidate.environment_id
        AND approval.workflow_version_id = candidate.workflow_version_id
        AND approval.ir_hash = candidate.draft->>'irHash'
       WHERE candidate.id = $1 AND candidate.organization_id = $2
         AND candidate.environment_id = $3 AND approval.lifecycle_status = 'approved'
       FOR UPDATE OF candidate, approval`,
      [query.candidateId, query.organizationId, environmentId],
    );
    const row = candidate.rows[0];
    if (!row) {
      throw new WorkflowMigrationActivationConflict(
        'Migration candidate must be approved before activation',
      );
    }
    if (!row.artifact_id) {
      throw new WorkflowMigrationActivationConflict(
        'Approved workflow has no compiled Temporal artifact',
      );
    }
    const fromCapabilityVersionId = row.from_capability_version_id.trim();
    const toCapabilityVersionId = row.to_capability_version_id.trim();
    const sourceWorkflow = versionedCompiledWorkflowVersionSchema.parse(
      row.source_compiled_workflow,
    );
    const candidateWorkflow = versionedCompiledWorkflowVersionSchema.parse(
      row.candidate_compiled_workflow,
    );
    if (
      !hasExactMigratedCapabilityPins(
        sourceWorkflow,
        candidateWorkflow,
        fromCapabilityVersionId,
        toCapabilityVersionId,
      )
    ) {
      throw new WorkflowMigrationActivationConflict(
        'Approved workflow does not replace the claimed capability pin',
      );
    }
    await assertEnvironmentWorkersSupportIr(
      client,
      query.organizationId,
      environmentId,
      row.ir_version,
    );
    const current = await client.query<{
      workflow_version_id: string;
      artifact_id: string | null;
    }>(
      `SELECT workflow_version_id, artifact_id FROM workflow_approvals
       WHERE organization_id = $1 AND environment_id = $2 AND lifecycle_status = 'current'
       FOR UPDATE`,
      [query.organizationId, environmentId],
    );
    if (current.rows[0]?.workflow_version_id !== row.source_workflow_version_id) {
      throw new WorkflowMigrationActivationConflict(
        'Migration source is not the current workflow version',
      );
    }
    await client.query(
      `UPDATE workflow_approvals SET lifecycle_status = 'superseded'
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3`,
      [query.organizationId, environmentId, row.source_workflow_version_id],
    );
    const activated = await client.query(
      `UPDATE workflow_approvals SET lifecycle_status = 'current'
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3
         AND lifecycle_status = 'approved'
       RETURNING workflow_version_id`,
      [query.organizationId, environmentId, row.workflow_version_id],
    );
    if (!activated.rows[0]) {
      throw new WorkflowMigrationActivationConflict(
        'Migration candidate must be approved before activation',
      );
    }
    await recordWorkflowLifecycle(client, {
      organizationId: query.organizationId,
      environmentId,
      workflowVersionId: row.source_workflow_version_id,
      status: 'approved-inactive',
      isActive: false,
    });
    await recordWorkflowLifecycle(client, {
      organizationId: query.organizationId,
      environmentId,
      workflowVersionId: row.workflow_version_id,
      status: 'active',
      isActive: true,
    });
    await client.query(
      `UPDATE workflow_quarantines SET lifted_at = current_timestamp
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3
         AND from_capability_version_id = $4 AND to_capability_version_id = $5
         AND lifted_at IS NULL`,
      [
        query.organizationId,
        environmentId,
        row.source_workflow_version_id,
        row.from_capability_version_id,
        row.to_capability_version_id,
      ],
    );
    const activation = await client.query<{ id: string }>(
      `INSERT INTO workflow_activations
         (organization_id, environment_id, migration_candidate_id,
          previous_workflow_version_id, current_workflow_version_id,
          previous_capability_version_id, current_capability_version_id, activated_by,
          previous_artifact_id, current_artifact_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        query.organizationId,
        environmentId,
        query.candidateId,
        row.source_workflow_version_id,
        row.workflow_version_id,
        row.from_capability_version_id,
        row.to_capability_version_id,
        activatedBy,
        current.rows[0]?.artifact_id,
        row.artifact_id,
      ],
    );
    await client.query('COMMIT');
    return {
      activationId: activation.rows[0]!.id,
      previous: workflowCapabilityPair(
        row.source_workflow_version_id,
        row.from_capability_version_id,
      ),
      current: workflowCapabilityPair(row.workflow_version_id, row.to_capability_version_id),
      artifactId: row.artifact_id.trim(),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function rollbackWorkflowActivation(
  pool: Pool,
  activationId: string,
  organizationId: string,
  environmentId: string,
  rolledBackBy: string,
) {
  const query = workflowActivationQuerySchema.parse({ organizationId, activationId });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const activation = await client.query<{
      previous_workflow_version_id: string;
      current_workflow_version_id: string;
      previous_capability_version_id: string;
      current_capability_version_id: string;
    }>(
      `SELECT previous_workflow_version_id, current_workflow_version_id,
        previous_capability_version_id, current_capability_version_id
       FROM workflow_activations
       WHERE id = $1 AND organization_id = $2 AND environment_id = $3
         AND rolled_back_at IS NULL
       FOR UPDATE`,
      [query.activationId, query.organizationId, environmentId],
    );
    const row = activation.rows[0];
    if (!row) {
      throw new WorkflowMigrationRollbackConflict('Activation is not available for rollback');
    }
    const current = await client.query<{ workflow_version_id: string }>(
      `SELECT workflow_version_id FROM workflow_approvals
       WHERE organization_id = $1 AND environment_id = $2 AND lifecycle_status = 'current'
       FOR UPDATE`,
      [query.organizationId, environmentId],
    );
    if (current.rows[0]?.workflow_version_id !== row.current_workflow_version_id) {
      throw new WorkflowMigrationRollbackConflict(
        'Activated workflow is no longer the current version',
      );
    }
    await client.query(
      `UPDATE workflow_approvals SET lifecycle_status = 'superseded'
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3`,
      [query.organizationId, environmentId, row.current_workflow_version_id],
    );
    const restored = await client.query(
      `UPDATE workflow_approvals SET lifecycle_status = 'current'
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3
         AND lifecycle_status = 'superseded'
       RETURNING workflow_version_id`,
      [query.organizationId, environmentId, row.previous_workflow_version_id],
    );
    if (!restored.rows[0]) {
      throw new WorkflowMigrationRollbackConflict('Previous workflow pair cannot be restored');
    }
    await recordWorkflowLifecycle(client, {
      organizationId: query.organizationId,
      environmentId,
      workflowVersionId: row.current_workflow_version_id,
      status: 'approved-inactive',
      isActive: false,
    });
    await recordWorkflowLifecycle(client, {
      organizationId: query.organizationId,
      environmentId,
      workflowVersionId: row.previous_workflow_version_id,
      status: 'blocked',
      isActive: true,
    });
    await client.query(
      `UPDATE workflow_quarantines SET lifted_at = NULL
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3
         AND from_capability_version_id = $4 AND to_capability_version_id = $5
         AND lifted_at IS NOT NULL`,
      [
        query.organizationId,
        environmentId,
        row.previous_workflow_version_id,
        row.previous_capability_version_id,
        row.current_capability_version_id,
      ],
    );
    await client.query(
      `UPDATE workflow_activations
       SET rolled_back_by = $2, rolled_back_at = current_timestamp
       WHERE id = $1`,
      [query.activationId, rolledBackBy],
    );
    await client.query('COMMIT');
    return {
      activationId: query.activationId,
      rolledBack: workflowCapabilityPair(
        row.current_workflow_version_id,
        row.current_capability_version_id,
      ),
      current: workflowCapabilityPair(
        row.previous_workflow_version_id,
        row.previous_capability_version_id,
      ),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
