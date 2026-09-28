import { isDeepStrictEqual } from 'node:util';

import {
  buildWorkflowGraph,
  createGraphCompiledWorkflowVersion,
  graphExecutableWorkflowSchema,
  isCapabilityStep,
  versionedCompiledWorkflowVersionSchema,
  computeIrHash,
  createTransformationCompiledWorkflowVersion,
  executableWorkflowSchema,
  transformationExecutableWorkflowSchema,
  WORKFLOW_STEP_START_TO_CLOSE_TIMEOUT,
} from '@atlas/workflow-ir';
import type {
  CompiledStep,
  TransformationStep,
  GraphStep,
  VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import type { Pool } from 'pg';
import { z } from 'zod';

import { readCapabilityVersion } from './capability-ingestion.js';
import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { renderWorkflowSource, withDefaultIdempotency } from './workflow-source.js';
import {
  hasExactMigratedCapabilityPins,
  workerIrReadiness,
} from './workflow-activation-readiness.js';
import { discardBackendOwnedDraftFields, validateWorkflowDraft } from './workflow-validation.js';
import { readWorkflowMigrationCandidate } from './workflow-migration.js';
import {
  readWorkflowSandboxReadinessForArtifact,
  workflowRequiresSandboxTests,
} from './workflow-sandbox.js';

export const workflowReviewRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    draft: z.unknown(),
    migrationCandidateId: z.string().regex(/^\d+$/).optional(),
    migration: z
      .object({
        fromCapabilityVersionId: z.string().min(1),
        toCapabilityVersionId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const workflowEditRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceWorkflowVersionId: z.string().min(1),
    executable: z.unknown(),
  })
  .strict();

type JsonObject = Record<string, unknown>;

export class WorkflowMigrationDiffNotFound extends Error {}
export class WorkflowReviewCandidateConflict extends Error {}
export class WorkflowVersionNotFound extends Error {}

export const workflowVersionHistoryQuerySchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();

export const workflowVersionDiffQuerySchema = workflowVersionHistoryQuerySchema
  .extend({
    fromVersionId: z.string().min(1),
    toVersionId: z.string().min(1),
  })
  .strict();

export const workflowLifecycleQuerySchema = workflowVersionHistoryQuerySchema;

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function parseEditedExecutable(value: unknown) {
  if (objectValue(value)?.irVersion === 3) return graphExecutableWorkflowSchema.parse(value);
  if (objectValue(value)?.irVersion !== 1) {
    return transformationExecutableWorkflowSchema.parse(value);
  }
  const versionOne = executableWorkflowSchema.parse(value);
  return transformationExecutableWorkflowSchema.parse({
    ...versionOne,
    irVersion: 2,
    steps: versionOne.steps.map((step) =>
      step.kind === 'terminal' ? step : { ...step, inputSchema: { required: {} } },
    ),
  });
}

function capabilityInputSchema(fragment: unknown) {
  const document = objectValue(fragment);
  const operation = objectValue(document?.operation);
  const requestBody = objectValue(operation?.requestBody);
  const content = objectValue(requestBody?.content);
  const requestSchema = objectValue(objectValue(content && Object.values(content)[0])?.schema);
  const messageSchema = objectValue(objectValue(document?.message)?.payload);
  const parameters = [
    ...(Array.isArray(document?.pathParameters) ? document.pathParameters : []),
    ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
  ];
  return {
    parameters,
    body: requestSchema ?? messageSchema ?? null,
  };
}

async function readMigrationHeader(
  pool: Pool,
  organizationId: string,
  migration: z.infer<typeof workflowReviewRequestSchema>['migration'],
) {
  if (!migration) return null;
  const result = await pool.query<{ classification: string; diff: unknown }>(
    `SELECT classification, diff
     FROM compatibility_diffs
     WHERE organization_id = $1
       AND from_capability_version_id = $2
       AND to_capability_version_id = $3`,
    [organizationId, migration.fromCapabilityVersionId, migration.toCapabilityVersionId],
  );
  const change = result.rows[0];
  if (!change) {
    throw new WorkflowMigrationDiffNotFound('Migration capability diff was not found');
  }
  return {
    ...migration,
    classification: change.classification,
    capabilityDiff: change.diff,
  };
}

export async function buildWorkflowReview(
  pool: Pool,
  request: z.infer<typeof workflowReviewRequestSchema>,
) {
  const candidate = request.migrationCandidateId
    ? await readWorkflowMigrationCandidate(
        pool,
        request.organizationId,
        request.migrationCandidateId,
      )
    : undefined;
  const requestedWorkflow = versionedCompiledWorkflowVersionSchema.safeParse(
    discardBackendOwnedDraftFields(request.draft),
  );
  if (
    request.migrationCandidateId &&
    (!candidate ||
      candidate.environmentId !== request.environmentId ||
      !requestedWorkflow.success ||
      candidate.draft.workflowVersionId !== requestedWorkflow.data.workflowVersionId ||
      candidate.draft.irHash !== requestedWorkflow.data.irHash)
  ) {
    throw new WorkflowReviewCandidateConflict(
      'Workflow Review draft does not match the migration candidate',
    );
  }
  const {
    migration: _migration,
    migrationCandidateId: _migrationCandidateId,
    ...validationRequest
  } = request;
  const validation = await validateWorkflowDraft(pool, {
    ...validationRequest,
    plannerAuthoredLiteralPaths: candidate?.validationContext.plannerAuthoredLiteralPaths ?? [],
    proposedApproverRole: 'admin',
  });
  const parsed = requestedWorkflow;
  const workflow = parsed.success ? parsed.data : null;
  const projection = workflow
    ? await readPlannerCapabilityProjection(pool, request.organizationId, request.environmentId)
    : null;
  const sandboxReadiness =
    workflow && workflowRequiresSandboxTests(workflow)
      ? await readWorkflowSandboxReadinessForArtifact(
          pool,
          { organizationId: request.organizationId, environmentId: request.environmentId },
          workflow,
        )
      : null;
  const diagnostics = [...validation.diagnostics];
  if (sandboxReadiness && !sandboxReadiness.ready) {
    diagnostics.push({
      kind: 'approvalRequirement',
      code: `SANDBOX_TESTS_${sandboxReadiness.status.toUpperCase()}`,
      path: 'workflowVersionId',
      message:
        sandboxReadiness.status === 'failed'
          ? 'Required workflow checks failed for this exact workflow artifact.'
          : sandboxReadiness.status === 'queued'
            ? 'Atlas queued automatic generated tests for this workflow artifact.'
            : sandboxReadiness.status === 'running'
              ? 'Atlas is running automatic generated tests for this workflow artifact.'
              : sandboxReadiness.status === 'unavailable'
                ? 'Automatic generated tests are unavailable. Review the run and retry the generated tests.'
                : sandboxReadiness.status === 'stale'
                  ? sandboxReadiness.staleDiagnostics.map(({ message }) => message).join(' ') ||
                    'Workflow check results are stale. Rerun the generated tests before approval.'
                  : 'Run the generated workflow checks for this exact workflow artifact.',
    });
  }
  const activitySteps = workflow?.executable.steps.filter(isCapabilityStep) ?? [];
  const compensationByStep = new Map(
    activitySteps.flatMap((step) =>
      step.kind === 'compensation' ? [[step.compensatesStepId, step] as const] : [],
    ),
  );
  const steps = await Promise.all(
    activitySteps.map(async (step) => {
      const capability = await readCapabilityVersion(
        pool,
        request.organizationId,
        step.capabilityVersionId,
        request.environmentId,
      );
      const compensation = compensationByStep.get(step.id);
      return {
        stepId: step.id,
        capabilityId: capability?.identity ?? null,
        capabilityVersionId: step.capabilityVersionId,
        verified: capability !== undefined,
        provenance: capability?.provenance ?? null,
        inputSchema: capabilityInputSchema(capability?.fragment),
        outputSchema: step.responseSchema ?? null,
        inputMappings: step.arguments,
        httpCall:
          typeof capability?.fragment.method === 'string' &&
          typeof capability.fragment.path === 'string'
            ? { method: capability.fragment.method, path: capability.fragment.path }
            : null,
        conditions: step.errorRouting ?? null,
        retryPolicy: step.retryPolicy ?? null,
        timeout: {
          startToClose: WORKFLOW_STEP_START_TO_CLOSE_TIMEOUT,
          source: 'runtime-default' as const,
        },
        idempotency: step.idempotency ?? null,
        secretReference:
          typeof objectValue(capability?.annotation)?.secretAlias === 'string'
            ? objectValue(capability?.annotation)?.secretAlias
            : null,
        compensation: compensation
          ? {
              stepId: compensation.id,
              capabilityVersionId: compensation.capabilityVersionId,
              inputMappings: compensation.arguments,
            }
          : null,
        irreversible: step.irreversibleAfter === true,
      };
    }),
  );

  return {
    workflowVersionId: workflow?.workflowVersionId ?? null,
    artifact: workflow,
    source: workflow && projection ? reviewableSource(workflow, projection) : null,
    irHash: validation.decision.recomputedIrHash,
    binding: {
      irHash: validation.decision.recomputedIrHash,
      policyVersion: validation.decision.policyVersion,
      projectionFingerprint: validation.decision.projectionFingerprint,
    },
    migration: await readMigrationHeader(pool, request.organizationId, request.migration),
    irreversibleBoundary: steps.find((step) => step.irreversible)?.stepId ?? null,
    steps,
    graph: buildWorkflowGraph(workflow),
    approval: {
      enabled: diagnostics.length === 0 && validation.decision.approvable,
      diagnostics,
    },
  };
}

function reviewableSource(
  workflow: z.infer<typeof versionedCompiledWorkflowVersionSchema>,
  projection: Awaited<ReturnType<typeof readPlannerCapabilityProjection>>,
) {
  try {
    return {
      filename: `${workflow.workflowVersionId}.atlas.yaml`,
      yaml: renderWorkflowSource(workflow, projection),
    };
  } catch {
    return null;
  }
}

export async function createWorkflowEdit(
  pool: Pool,
  request: z.infer<typeof workflowEditRequestSchema>,
) {
  const authored = parseEditedExecutable(request.executable);
  const projection = await readPlannerCapabilityProjection(
    pool,
    request.organizationId,
    request.environmentId,
  );
  const capabilities = new Map(
    projection.capabilities.map((capability) => [capability.capabilityVersionId, capability]),
  );
  const executable = parseEditedExecutable({
    ...authored,
    steps: authored.steps.map((step) =>
      isCapabilityStep(step)
        ? withDefaultIdempotency(
            step,
            capabilities.get(step.capabilityVersionId)?.annotation.idempotencyField,
          )
        : step,
    ),
  });
  const editedHash = await computeIrHash(executable);
  const workflowVersionId = `${request.sourceWorkflowVersionId}@edit-${editedHash}`;
  const draft =
    executable.irVersion === 3
      ? await createGraphCompiledWorkflowVersion(
          workflowVersionId,
          request.organizationId,
          executable,
        )
      : await createTransformationCompiledWorkflowVersion(
          workflowVersionId,
          request.organizationId,
          executable,
        );
  const review = await buildWorkflowReview(pool, {
    organizationId: request.organizationId,
    environmentId: request.environmentId,
    projectionFingerprint: request.projectionFingerprint,
    draft,
  });
  return { draft, review };
}

interface VersionHistoryRow {
  workflow_version_id: string;
  ir_hash: string;
  lifecycle_status: 'approved' | 'superseded' | 'current';
  approved_by: string;
  approved_at: Date;
  run_id: string | null;
  intake_key: string | null;
  run_state: string | null;
  started_at: Date | null;
}

export async function readWorkflowVersionHistory(
  pool: Pool,
  query: z.infer<typeof workflowVersionHistoryQuerySchema>,
) {
  const result = await pool.query<VersionHistoryRow>(
    `SELECT approval.workflow_version_id, approval.ir_hash, approval.lifecycle_status,
            approval.approved_by, approval.approved_at, run.run_id, run.intake_key,
            run.state AS run_state, run.started_at
     FROM workflow_approvals approval
     JOIN workflow_versions version
       ON version.organization_id = approval.organization_id
      AND version.workflow_version_id = approval.workflow_version_id
      AND version.ir_hash = approval.ir_hash
     LEFT JOIN workflow_runs run
       ON run.organization_id = approval.organization_id
      AND run.environment_id = approval.environment_id
      AND run.workflow_version_id = approval.workflow_version_id
     WHERE approval.organization_id = $1 AND approval.environment_id = $2
     ORDER BY approval.approved_at DESC, approval.workflow_version_id DESC,
              run.started_at DESC, run.run_id DESC`,
    [query.organizationId, query.environmentId],
  );
  const versions = new Map<
    string,
    {
      workflowVersionId: string;
      irHash: string;
      status: VersionHistoryRow['lifecycle_status'];
      approvedBy: string;
      approvedAt: string;
      runs: Array<{ runId: string; paymentId: string; state: string; startedAt: string }>;
    }
  >();
  for (const row of result.rows) {
    let version = versions.get(row.workflow_version_id);
    if (!version) {
      version = {
        workflowVersionId: row.workflow_version_id,
        irHash: row.ir_hash,
        status: row.lifecycle_status,
        approvedBy: row.approved_by,
        approvedAt: row.approved_at.toISOString(),
        runs: [],
      };
      versions.set(row.workflow_version_id, version);
    }
    if (row.run_id && row.intake_key && row.run_state && row.started_at) {
      version.runs.push({
        runId: row.run_id,
        paymentId: row.intake_key,
        state: row.run_state,
        startedAt: row.started_at.toISOString(),
      });
    }
  }
  return { versions: [...versions.values()] };
}

export async function compareWorkflowVersions(
  pool: Pool,
  query: z.infer<typeof workflowVersionDiffQuerySchema>,
) {
  const result = await pool.query<{ workflow_version_id: string; compiled_workflow: unknown }>(
    `SELECT version.workflow_version_id, version.compiled_workflow
     FROM workflow_versions version
     JOIN workflow_approvals approval
       ON approval.organization_id = version.organization_id
      AND approval.workflow_version_id = version.workflow_version_id
      AND approval.ir_hash = version.ir_hash
     WHERE version.organization_id = $1 AND approval.environment_id = $2
       AND version.workflow_version_id = ANY($3::text[])`,
    [query.organizationId, query.environmentId, [query.fromVersionId, query.toVersionId]],
  );
  const workflows = new Map(
    result.rows.map((row) => [
      row.workflow_version_id,
      versionedCompiledWorkflowVersionSchema.parse(row.compiled_workflow),
    ]),
  );
  const from = workflows.get(query.fromVersionId);
  const to = workflows.get(query.toVersionId);
  if (!from || !to) throw new WorkflowVersionNotFound('A workflow version was not found');

  return buildStepDiff(from, to);
}

function buildStepDiff(
  from: VersionedCompiledWorkflowVersion,
  to: VersionedCompiledWorkflowVersion,
) {
  const fromSteps = new Map(from.executable.steps.map((step, index) => [step.id, { step, index }]));
  const toSteps = new Map(to.executable.steps.map((step, index) => [step.id, { step, index }]));
  const addedSteps = [...toSteps]
    .filter(([stepId]) => !fromSteps.has(stepId))
    .map(([stepId, value]) => ({ stepId, toIndex: value.index, step: value.step }));
  const removedSteps = [...fromSteps]
    .filter(([stepId]) => !toSteps.has(stepId))
    .map(([stepId, value]) => ({ stepId, fromIndex: value.index, step: value.step }));
  const changedSteps = [...fromSteps].flatMap(([stepId, before]) => {
    const after = toSteps.get(stepId);
    if (!after) return [];
    const beforeDefinition = withoutCapabilityVersion(before.step);
    const afterDefinition = withoutCapabilityVersion(after.step);
    return isDeepStrictEqual(beforeDefinition, afterDefinition)
      ? []
      : [
          {
            stepId,
            fromIndex: before.index,
            toIndex: after.index,
            before: beforeDefinition,
            after: afterDefinition,
          },
        ];
  });
  const capabilityVersionBumps = [...fromSteps].flatMap(([stepId, before]) => {
    const after = toSteps.get(stepId);
    if (
      !after ||
      !isCapabilityStep(before.step) ||
      !isCapabilityStep(after.step) ||
      before.step.capabilityVersionId === after.step.capabilityVersionId
    ) {
      return [];
    }
    return [
      {
        stepId,
        fromCapabilityVersionId: before.step.capabilityVersionId,
        toCapabilityVersionId: after.step.capabilityVersionId,
      },
    ];
  });
  const commonFromOrder = [...fromSteps.keys()].filter((stepId) => toSteps.has(stepId));
  const commonToOrder = [...toSteps.keys()].filter((stepId) => fromSteps.has(stepId));
  const commonToIndex = new Map(commonToOrder.map((stepId, index) => [stepId, index]));
  const reorderedSteps = commonFromOrder.flatMap((stepId, fromIndex) => {
    const toIndex = commonToIndex.get(stepId);
    return toIndex === undefined || fromIndex === toIndex ? [] : [{ stepId, fromIndex, toIndex }];
  });
  return {
    fromVersionId: from.workflowVersionId,
    toVersionId: to.workflowVersionId,
    addedSteps,
    removedSteps,
    changedSteps,
    reorderedSteps,
    capabilityVersionBumps,
  };
}

function withoutCapabilityVersion(step: CompiledStep | TransformationStep | GraphStep) {
  if (!isCapabilityStep(step)) return step;
  const { capabilityVersionId: _capabilityVersionId, ...definition } = step;
  return definition;
}

interface LifecycleCandidateRow {
  id: string;
  source_workflow_version_id: string;
  workflow_version_id: string;
  from_capability_version_id: string;
  to_capability_version_id: string;
  draft: unknown;
  source_compiled_workflow: unknown;
  approved_workflow_version_id: string | null;
  artifact_id: string | null;
  source_is_current: boolean;
}

interface WorkerDeclarationRow {
  worker_id: string;
  minimum_ir_version: number;
  maximum_ir_version: number;
}

interface RollbackActivationRow {
  id: string;
  previous_workflow_version_id: string;
  current_workflow_version_id: string;
  previous_capability_version_id: string;
  current_capability_version_id: string;
  activated_by: string;
  activated_at: Date;
  current_is_active: boolean;
}

export async function readWorkflowLifecycle(
  pool: Pool,
  query: z.infer<typeof workflowLifecycleQuerySchema>,
) {
  const [candidateResult, workerResult, activationResult] = await Promise.all([
    pool.query<LifecycleCandidateRow>(
      `SELECT candidate.id::text, candidate.source_workflow_version_id,
              candidate.workflow_version_id, candidate.from_capability_version_id,
              candidate.to_capability_version_id, candidate.draft,
              source_version.compiled_workflow AS source_compiled_workflow,
              target_approval.workflow_version_id AS approved_workflow_version_id,
              target_approval.artifact_id,
              EXISTS (
                SELECT 1 FROM workflow_approvals current_approval
                WHERE current_approval.organization_id = candidate.organization_id
                  AND current_approval.environment_id = candidate.environment_id
                  AND current_approval.workflow_version_id = candidate.source_workflow_version_id
                  AND current_approval.lifecycle_status = 'current'
              ) AS source_is_current
       FROM workflow_migration_candidates candidate
       JOIN workflow_versions source_version
         ON source_version.organization_id = candidate.organization_id
        AND source_version.workflow_version_id = candidate.source_workflow_version_id
       LEFT JOIN workflow_approvals target_approval
         ON target_approval.organization_id = candidate.organization_id
        AND target_approval.environment_id = candidate.environment_id
        AND target_approval.workflow_version_id = candidate.workflow_version_id
        AND target_approval.ir_hash = candidate.draft->>'irHash'
       LEFT JOIN workflow_activations activation
         ON activation.migration_candidate_id = candidate.id
       WHERE candidate.organization_id = $1 AND candidate.environment_id = $2
         AND activation.id IS NULL
       ORDER BY candidate.created_at DESC, candidate.id DESC`,
      [query.organizationId, query.environmentId],
    ),
    pool.query<WorkerDeclarationRow>(
      `SELECT worker_id, minimum_ir_version, maximum_ir_version
       FROM environment_workers
       WHERE organization_id = $1 AND environment_id = $2
       ORDER BY worker_id`,
      [query.organizationId, query.environmentId],
    ),
    pool.query<RollbackActivationRow>(
      `SELECT activation.id::text, activation.previous_workflow_version_id,
              activation.current_workflow_version_id,
              activation.previous_capability_version_id,
              activation.current_capability_version_id, activation.activated_by,
              activation.activated_at,
              current_approval.workflow_version_id IS NOT NULL AS current_is_active
       FROM workflow_activations activation
       LEFT JOIN workflow_approvals current_approval
         ON current_approval.organization_id = activation.organization_id
        AND current_approval.environment_id = activation.environment_id
        AND current_approval.workflow_version_id = activation.current_workflow_version_id
        AND current_approval.lifecycle_status = 'current'
       WHERE activation.organization_id = $1 AND activation.environment_id = $2
         AND activation.rolled_back_at IS NULL
       ORDER BY activation.activated_at DESC, activation.id DESC`,
      [query.organizationId, query.environmentId],
    ),
  ]);

  const activationCandidates = candidateResult.rows.map((row) => {
    const draft = versionedCompiledWorkflowVersionSchema.parse(row.draft);
    const sourceWorkflow = versionedCompiledWorkflowVersionSchema.parse(
      row.source_compiled_workflow,
    );
    const fromCapabilityVersionId = row.from_capability_version_id.trim();
    const toCapabilityVersionId = row.to_capability_version_id.trim();
    const candidatePins = draft.executionRequirements.requiredCapabilityVersionIds;
    const workerReadiness = workerIrReadiness(
      workerResult.rows.map((worker) => ({
        workerId: worker.worker_id,
        minimumIrVersion: worker.minimum_ir_version,
        maximumIrVersion: worker.maximum_ir_version,
      })),
      draft.executable.irVersion,
      query.environmentId,
    );
    const blockers: Array<{ code: string; message: string }> = [];
    if (!row.approved_workflow_version_id) {
      blockers.push({
        code: 'fresh-approval-required',
        message: 'Every new capability-version pin requires a fresh approval.',
      });
    } else if (!row.artifact_id) {
      blockers.push({
        code: 'compiled-artifact-required',
        message: 'The approved workflow must be compiled into a tested Temporal artifact.',
      });
    }
    if (!row.source_is_current) {
      blockers.push({
        code: 'migration-source-not-current',
        message: 'Migration source is not the current workflow version.',
      });
    }
    if (
      !hasExactMigratedCapabilityPins(
        sourceWorkflow,
        draft,
        fromCapabilityVersionId,
        toCapabilityVersionId,
      )
    ) {
      blockers.push({
        code: 'execution-grant-pin-mismatch',
        message: 'Candidate ExecutionGrant pins do not contain the migrated capability version.',
      });
    }
    blockers.push(...workerReadiness.blockers);
    return {
      candidateId: row.id,
      source: {
        workflowVersionId: row.source_workflow_version_id,
        capabilityVersionId: fromCapabilityVersionId,
      },
      candidate: {
        workflowVersionId: row.workflow_version_id,
        capabilityVersionId: toCapabilityVersionId,
        irHash: draft.irHash,
        irVersion: draft.executable.irVersion,
        requiredCapabilityVersionIds: candidatePins,
        artifactId: row.artifact_id?.trim() ?? null,
      },
      workerDeclarations: workerReadiness.workers,
      blockers,
      activationEnabled: blockers.length === 0,
    };
  });

  return {
    activationCandidates,
    rollbackActivations: activationResult.rows.map((row) => ({
      activationId: row.id,
      previous: {
        workflowVersionId: row.previous_workflow_version_id,
        capabilityVersionId: row.previous_capability_version_id.trim(),
      },
      current: {
        workflowVersionId: row.current_workflow_version_id,
        capabilityVersionId: row.current_capability_version_id.trim(),
      },
      activatedBy: row.activated_by,
      activatedAt: row.activated_at.toISOString(),
      rollbackEnabled: row.current_is_active,
      blocker: row.current_is_active
        ? null
        : 'Activated workflow is no longer the current version.',
    })),
  };
}
