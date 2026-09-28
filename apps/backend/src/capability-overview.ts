import {
  buildWorkflowGraph,
  isCapabilityStep,
  workflowStepExpressions,
  type CapabilityStep as ExecutableCapabilityStep,
  capabilityOverviewSchema,
  visitTransformationExpression,
  versionedCompiledWorkflowVersionSchema,
  type CapabilityOverviewRelationship,
  type FailureAction,
  type VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { readCapabilityCatalog } from './capability-catalog.js';
import { canonicalJson, sha256 } from './capability-versioning.js';

export const capabilityOverviewQuerySchema = z
  .object({
    organizationId: z.string().trim().min(1),
    environmentId: z.string().trim().min(1),
    focusType: z.enum(['change', 'runtime-mismatch']).optional(),
    focusId: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.focusType) !== Boolean(value.focusId)) {
      context.addIssue({
        code: 'custom',
        message: 'focusType and focusId must be provided together',
      });
    }
    if (value.focusType === 'change' && value.focusId && !/^\d+$/.test(value.focusId)) {
      context.addIssue({
        code: 'custom',
        path: ['focusId'],
        message: 'A contract change focus needs a numeric id',
      });
    }
  });

export type CapabilityOverviewFocus =
  | { type: 'change'; id: string }
  | { type: 'runtime-mismatch'; id: string };

type RelationshipKind = CapabilityOverviewRelationship['kind'];

interface WorkflowRow {
  workflow_id: string;
  workflow_name: string;
  workflow_version_id: string;
  lifecycle_status: CapabilityOverviewRelationship['evidence']['workflowLifecycle'];
  is_active: boolean;
  replacement_workflow_version_id: string | null;
  replacement_activated_at: Date | null;
  compiled_workflow: unknown;
}

interface CapabilityVersionRow {
  capability_version_id: string;
  capability_identity_id: string;
}

interface CapabilityStep {
  id: string;
  capabilityVersionId: string;
}

interface DiscoveryChangeRow {
  from_capability_version_id: string;
  to_capability_version_id: string | null;
  classification: 'compatible' | 'conditional' | 'breaking' | 'metadata';
  change_kind: 'version-change' | 'removal';
  field_changes: unknown;
  affected_workflows: unknown;
  from_capability_fragment: unknown;
  to_capability_fragment: unknown;
  capability_identity_id: string;
  service_id: string;
  operation_id: string;
}

interface ParsedWorkflow {
  row: WorkflowRow;
  workflow: VersionedCompiledWorkflowVersion;
  steps: Map<string, CapabilityStep>;
}

interface AffectedUsage {
  workflowId: string;
  workflowName: string;
  workflowVersionId: string;
  workflowLifecycle: WorkflowRow['lifecycle_status'];
  currentState: {
    isActive: boolean;
    quarantine: 'not-recorded' | 'active' | 'cleared';
    quarantineClearedAt?: string;
    replacementWorkflowVersionId?: string;
    replacementActivatedAt?: string;
    blockedWorkflowStart?: {
      id: string;
      toCapabilityVersionId: string;
      blockedAt: string;
    };
    latestFailedRun?: {
      runId: string;
      failureType: string;
      failedAt: string;
    };
  };
  stepId: string;
  capabilityVersionId: string;
  reason: string;
  evidence:
    | {
        discoveryId: string;
        fromCapabilityVersionId: string;
        fieldPath?: string;
        sourceStepId?: string;
        path: ImpactPathHop[];
      }
    | {
        runtimeMismatchId: string;
        observationId: string;
        capabilityVersionId: string;
        status: number;
        normalizedReason: 'required-field-missing';
        fieldPath: string;
        observedAt: string;
        sourceStepId?: string;
        path: ImpactPathHop[];
      };
}

interface RuntimeMismatchRow {
  id: string;
  capability_identity_id: string;
  capability_version_id: string;
  service_id: string;
  operation_id: string;
  reason: 'required-field-missing';
  field_path: string;
  status_code: number;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrence_count: number;
  state: 'active' | 'recovered';
  recovered_at: Date | null;
  observation_id: string;
  observed_at: Date;
}

interface BlockedWorkflowStartRow {
  id: string;
  workflow_version_id: string;
  from_capability_version_id: string;
  to_capability_version_id: string;
  quarantined_at: Date;
  lifted_at: Date | null;
}

interface FailedRunRow {
  run_id: string;
  workflow_version_id: string;
  failed_step_id: string;
  capability_version_id: string;
  failure_type: string;
  recorded_at: Date;
}

interface ImpactPathHop {
  kind: RelationshipKind;
  fromStepId: string;
  toStepId: string;
  fromCapabilityVersionId: string;
  toCapabilityVersionId: string;
}

interface DiscoveryRow {
  id: string;
  discovered_at: Date;
}

const discoveryFieldChangeSchema = z
  .object({
    kind: z.string(),
    path: z.string().optional(),
    classification: z.string().optional(),
    previousValue: z.union([z.string(), z.boolean(), z.null()]).optional(),
    nextValue: z.union([z.string(), z.boolean(), z.null()]).optional(),
  })
  .passthrough();

const supportedChangeKinds = new Set([
  'added-optional',
  'added-required',
  'removed',
  'retyped',
  'renamed',
  'idempotency-changed',
  'compensation-changed',
  'irreversibility-changed',
]);

const discoveryAffectedWorkflowSchema = z.object({
  workflowVersionId: z.string(),
  stepId: z.string(),
});

function workflowCapabilitySteps(workflow: VersionedCompiledWorkflowVersion) {
  return new Map<string, CapabilityStep>(
    workflow.executable.steps.flatMap((step) =>
      !isCapabilityStep(step)
        ? []
        : [[step.id, { id: step.id, capabilityVersionId: step.capabilityVersionId }]],
    ),
  );
}

function workflowRepeatsStep(workflow: VersionedCompiledWorkflowVersion, stepId: string): boolean {
  const primaryStepIds = workflow.executable.steps
    .filter((step) => step.kind !== 'compensation')
    .map((step) => step.id);
  const stepIndex = primaryStepIds.indexOf(stepId);
  if (stepIndex < 0) return false;
  return buildWorkflowGraph(workflow).edges.some((edge) => {
    if (edge.kind !== 'revalidation') return false;
    const targetIndex = primaryStepIds.indexOf(edge.toStepId);
    const sourceIndex = primaryStepIds.indexOf(edge.fromStepId);
    return (
      targetIndex >= 0 && sourceIndex >= 0 && targetIndex <= stepIndex && stepIndex <= sourceIndex
    );
  });
}

function compensationForStep(workflow: VersionedCompiledWorkflowVersion, stepId: string) {
  const step = workflow.executable.steps.find(
    (step) => step.kind === 'compensation' && step.compensatesStepId === stepId,
  );
  return step?.kind === 'compensation' ? step : undefined;
}

function failureActionUsesCompensation(action: FailureAction): boolean {
  if (action.kind === 'revalidateFrom') return failureActionUsesCompensation(action.onExhausted);
  return action.kind === 'compensateThenLand';
}

function workflowCanRunCompensation(
  workflow: VersionedCompiledWorkflowVersion,
  compensatedStepId: string,
): boolean {
  const compensatedIndex = workflow.executable.steps.findIndex(
    (step) => step.id === compensatedStepId,
  );
  if (compensatedIndex < 0) return false;
  return workflow.executable.steps.slice(compensatedIndex + 1).some((step, offset) => {
    if (!isCapabilityStep(step) || step.kind === 'compensation') return false;
    const failingIndex = compensatedIndex + offset + 1;
    const compensationIsEnabled = !workflow.executable.steps
      .slice(0, failingIndex)
      .some((prior) => isCapabilityStep(prior) && prior.irreversibleAfter === true);
    if (!compensationIsEnabled) return false;
    if (step.errorRouting) {
      return [
        ...step.errorRouting.rules.map((rule) => rule.action),
        step.errorRouting.defaultAction,
      ].some(failureActionUsesCompensation);
    }
    return true;
  });
}

function overviewRelationshipKind(kind: string): RelationshipKind | null {
  if (kind === 'mapping') return 'data-flow';
  if (kind === 'next') return 'execution-order';
  if (kind === 'compensation') return 'compensation';
  return null;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

type ContractFieldPaths = Map<string, string[][]>;

function addContractFieldPaths(
  fragment: Record<string, unknown>,
  schemaValue: unknown,
  schemaPointer: string,
  dataPath: readonly string[],
  paths: ContractFieldPaths,
  visitedReferences: ReadonlySet<string> = new Set(),
): void {
  const schema = objectValue(schemaValue);
  if (!schema) return;
  const reference = typeof schema.$ref === 'string' ? schema.$ref : undefined;
  if (reference) {
    if (visitedReferences.has(reference)) return;
    const resolved = objectValue(objectValue(fragment.references)?.[reference]);
    if (!resolved) return;
    addContractFieldPaths(
      fragment,
      resolved,
      `/references/${escapePointerSegment(reference)}`,
      dataPath,
      paths,
      new Set([...visitedReferences, reference]),
    );
    return;
  }
  for (const [field, fieldSchema] of Object.entries(objectValue(schema.properties) ?? {})) {
    const fieldPointer = `${schemaPointer}/properties/${escapePointerSegment(field)}`;
    const fieldDataPath = [...dataPath, field];
    const existing = paths.get(fieldPointer) ?? [];
    existing.push(fieldDataPath);
    paths.set(fieldPointer, existing);
    addContractFieldPaths(
      fragment,
      fieldSchema,
      fieldPointer,
      fieldDataPath,
      paths,
      visitedReferences,
    );
  }
}

function requestFieldPaths(fragmentValue: unknown): ContractFieldPaths {
  const fragment = objectValue(fragmentValue);
  const paths: ContractFieldPaths = new Map();
  if (!fragment) return paths;
  const operation = objectValue(fragment.operation);
  const content = objectValue(objectValue(operation?.requestBody)?.content);
  for (const [mediaType, mediaValue] of Object.entries(content ?? {})) {
    addContractFieldPaths(
      fragment,
      objectValue(mediaValue)?.schema,
      `/operation/requestBody/content/${escapePointerSegment(mediaType)}/schema`,
      [],
      paths,
    );
  }
  addContractFieldPaths(
    fragment,
    objectValue(fragment.message)?.payload,
    '/message/payload',
    [],
    paths,
  );
  return paths;
}

function responseFieldPaths(fragmentValue: unknown): ContractFieldPaths {
  const fragment = objectValue(fragmentValue);
  const paths: ContractFieldPaths = new Map();
  if (!fragment) return paths;
  const operation = objectValue(fragment.operation);
  for (const [status, responseValue] of Object.entries(objectValue(operation?.responses) ?? {})) {
    for (const [mediaType, mediaValue] of Object.entries(
      objectValue(objectValue(responseValue)?.content) ?? {},
    )) {
      addContractFieldPaths(
        fragment,
        objectValue(mediaValue)?.schema,
        `/operation/responses/${escapePointerSegment(status)}/content/${escapePointerSegment(mediaType)}/schema`,
        [],
        paths,
      );
    }
  }
  addContractFieldPaths(
    fragment,
    objectValue(fragment.message)?.payload,
    '/message/payload',
    [],
    paths,
  );
  return paths;
}

type RequestFieldStatus = 'supplied' | 'missing' | 'unknown';

function expressionFieldStatus(expression: unknown, path: readonly string[]): RequestFieldStatus {
  if (path.length === 0) return 'supplied';
  const node = objectValue(expression);
  if (!node) return 'unknown';
  const [field, ...remaining] = path;
  if (field === undefined) return 'supplied';
  if (node.kind === 'object') {
    const fields = objectValue(node.fields);
    return fields && field in fields ? expressionFieldStatus(fields[field], remaining) : 'missing';
  }
  if (node.source === 'literal') {
    const value = objectValue(node.value);
    return value && field in value ? expressionFieldStatus(value[field], remaining) : 'missing';
  }
  if (node.kind === 'conditional') {
    const thenStatus = expressionFieldStatus(node.then, path);
    const elseStatus = expressionFieldStatus(node.else, path);
    return thenStatus === elseStatus ? thenStatus : 'unknown';
  }
  return 'unknown';
}

function requestFieldStatus(
  step: ExecutableCapabilityStep,
  path: readonly string[],
): RequestFieldStatus {
  const [argument, ...remaining] = path;
  if (!argument || !(argument in step.arguments)) return 'missing';
  return expressionFieldStatus(step.arguments[argument], remaining);
}

function pathStartsWith(path: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((segment, index) => path[index] === segment);
}

function valueAtJsonPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const encodedSegment of pointer.split('/').slice(1)) {
    const record = objectValue(current);
    if (!record) return undefined;
    const segment = encodedSegment.replaceAll('~1', '/').replaceAll('~0', '~');
    current = record[segment];
  }
  return current;
}

type RetypedFieldUse = 'broken' | 'safe' | 'unknown';

function retypedFieldUse(
  workflow: VersionedCompiledWorkflowVersion,
  sourceStepId: string,
  targetStepId: string,
  destinationField: string | undefined,
  fieldPath: readonly string[],
  newFieldSchema: unknown,
): RetypedFieldUse {
  if (workflow.executable.irVersion !== 2 || !destinationField) return 'unknown';
  const target = workflow.executable.steps.find((step) => step.id === targetStepId);
  if (!target || target.kind === 'terminal') return 'unknown';
  const expression = workflowStepExpressions(target)[destinationField];
  if (
    !expression ||
    !('source' in expression) ||
    expression.source !== 'stepOutput' ||
    expression.stepId !== sourceStepId ||
    !Array.isArray(expression.path) ||
    expression.path.length !== fieldPath.length ||
    !pathStartsWith(expression.path as string[], fieldPath)
  ) {
    return 'unknown';
  }
  const expectedType = target.inputSchema.required[destinationField]?.type;
  const newType = objectValue(newFieldSchema)?.type;
  if (typeof expectedType !== 'string' || typeof newType !== 'string') return 'unknown';
  return expectedType === newType ? 'safe' : 'broken';
}

function stepUsesResponsePath(
  workflow: VersionedCompiledWorkflowVersion,
  sourceStepId: string,
  targetStepId: string,
  destinationField: string | undefined,
  fieldPath: readonly string[],
): boolean {
  const target = workflow.executable.steps.find((step) => step.id === targetStepId);
  if (!target || !destinationField) return false;
  const expression = workflowStepExpressions(target)[destinationField];
  if (!expression) return false;
  let usesField = false;
  visitTransformationExpression(expression, (node) => {
    if (
      node.source === 'stepOutput' &&
      node.stepId === sourceStepId &&
      Array.isArray(node.path) &&
      pathStartsWith(node.path as string[], fieldPath)
    ) {
      usesField = true;
    }
  });
  return usesField;
}

function workflowStepKey(workflowVersionId: string, stepId: string): string {
  return `${workflowVersionId}\u0000${stepId}`;
}

function workflowCapabilityVersionKey(
  workflowVersionId: string,
  capabilityVersionId: string,
): string {
  return `${workflowVersionId}\u0000${capabilityVersionId}`;
}

function failedRunKey(
  workflowVersionId: string,
  stepId: string,
  capabilityVersionId: string,
): string {
  return `${workflowStepKey(workflowVersionId, stepId)}\u0000${capabilityVersionId}`;
}

function usageKey(usage: Pick<AffectedUsage, 'workflowVersionId' | 'stepId'>): string {
  return workflowStepKey(usage.workflowVersionId, usage.stepId);
}

function affectedRelationshipKey(
  workflowVersionId: string,
  sourceStepId: string,
  targetStepId: string,
  kind: RelationshipKind,
): string {
  return `${workflowVersionId}\u0000${sourceStepId}\u0000${targetStepId}\u0000${kind}`;
}

function spreadFailureThroughLaterSteps(
  parsed: ParsedWorkflow,
  nextEdges: ReturnType<typeof buildWorkflowGraph>['edges'],
  directFailures: readonly AffectedUsage[],
  usages: Map<string, AffectedUsage>,
  affectedRelationships: Set<string>,
  createDownstreamUsage: (
    failed: AffectedUsage,
    target: CapabilityStep,
    sourceStepId: string,
    path: ImpactPathHop[],
  ) => AffectedUsage,
) {
  const queue = [...directFailures];
  for (const usage of queue) usages.set(usageKey(usage), usage);
  for (let index = 0; index < queue.length; index += 1) {
    const failed = queue[index]!;
    for (const edge of nextEdges) {
      if (edge.kind !== 'next' || edge.fromStepId !== failed.stepId) continue;
      const target = parsed.steps.get(edge.toStepId);
      if (!target) continue;
      const key = workflowStepKey(parsed.row.workflow_version_id, edge.toStepId);
      affectedRelationships.add(
        affectedRelationshipKey(
          parsed.row.workflow_version_id,
          edge.fromStepId,
          edge.toStepId,
          'execution-order',
        ),
      );
      if (usages.has(key)) continue;
      const path = [
        ...failed.evidence.path,
        {
          kind: 'execution-order' as const,
          fromStepId: edge.fromStepId,
          toStepId: edge.toStepId,
          fromCapabilityVersionId: failed.capabilityVersionId,
          toCapabilityVersionId: target.capabilityVersionId,
        },
      ];
      const downstream = createDownstreamUsage(failed, target, edge.fromStepId, path);
      usages.set(key, downstream);
      queue.push(downstream);
    }
  }
}

function affectedUsageFields(
  parsed: ParsedWorkflow,
  step: CapabilityStep,
  reason: string,
): Omit<AffectedUsage, 'evidence'> {
  return {
    workflowId: parsed.row.workflow_id,
    workflowName: parsed.row.workflow_name,
    workflowVersionId: parsed.row.workflow_version_id,
    workflowLifecycle: parsed.row.lifecycle_status,
    currentState: {
      isActive: parsed.row.is_active,
      quarantine: 'not-recorded',
      ...(parsed.row.replacement_workflow_version_id
        ? { replacementWorkflowVersionId: parsed.row.replacement_workflow_version_id }
        : {}),
      ...(parsed.row.replacement_activated_at
        ? { replacementActivatedAt: parsed.row.replacement_activated_at.toISOString() }
        : {}),
    },
    stepId: step.id,
    capabilityVersionId: step.capabilityVersionId,
    reason,
  };
}

function affectedUsage(
  parsed: ParsedWorkflow,
  step: CapabilityStep,
  focus: Extract<CapabilityOverviewFocus, { type: 'change' }>,
  change: DiscoveryChangeRow,
  reason: string,
  evidence: { fieldPath?: string; sourceStepId?: string; path?: ImpactPathHop[] } = {},
): AffectedUsage {
  return {
    ...affectedUsageFields(parsed, step, reason),
    evidence: {
      discoveryId: focus.id,
      fromCapabilityVersionId: change.from_capability_version_id,
      path: evidence.path ?? [],
      ...evidence,
    },
  };
}

async function readDiscoveredChangeImpact(
  client: Pick<PoolClient, 'query'>,
  organizationId: string,
  environmentId: string,
  focus: Extract<CapabilityOverviewFocus, { type: 'change' }>,
  workflows: readonly ParsedWorkflow[],
  identityByVersion: ReadonlyMap<string, string>,
) {
  const discovery = await client.query<DiscoveryRow>(
    `SELECT id::text AS id, discovered_at
     FROM capability_discoveries
     WHERE id = $1 AND organization_id = $2 AND environment_id = $3`,
    [focus.id, organizationId, environmentId],
  );
  if (!discovery.rows[0]) {
    return {
      summary: {
        type: 'change' as const,
        id: focus.id,
        affectedWorkflowCount: 0,
        affectedStepCount: 0,
        currentlyExposedWorkflowCount: 0,
        currentlyExposedStepCount: 0,
        incompleteAnalysisCount: 1,
        analysis: 'unavailable' as const,
        sources: [],
      },
      sources: new Set<string>(),
      usagesByIdentity: new Map<string, AffectedUsage[]>(),
      affectedRelationships: new Set<string>(),
      notices: ['Atlas could not find the selected contract change in this environment.'],
    };
  }

  const result = await client.query<DiscoveryChangeRow>(
    `SELECT trim(change.from_capability_version_id) AS from_capability_version_id,
            CASE WHEN change.to_capability_version_id IS NULL THEN NULL
              ELSE trim(change.to_capability_version_id) END AS to_capability_version_id,
            change.classification, change.change_kind, change.field_changes,
            change.affected_workflows,
            previous.capability_fragment AS from_capability_fragment,
            next.capability_fragment AS to_capability_fragment,
            identity.id::text AS capability_identity_id,
            identity.service_id, identity.operation_id
     FROM capability_discovery_changes change
     JOIN capability_versions previous
       ON previous.organization_id = change.organization_id
      AND previous.capability_version_id = change.from_capability_version_id
     LEFT JOIN capability_versions next
       ON next.organization_id = change.organization_id
      AND next.capability_version_id = change.to_capability_version_id
     JOIN capability_identities identity ON identity.id = previous.capability_identity_id
     WHERE change.discovery_id = $1 AND change.organization_id = $2
     ORDER BY identity.service_id, identity.operation_id, change.from_capability_version_id`,
    [focus.id, organizationId],
  );

  const usages = new Map<string, AffectedUsage>();
  const affectedRelationships = new Set<string>();
  const unresolved = new Set<string>();
  const sources = result.rows.map((change) => ({
    capabilityIdentityId: change.capability_identity_id,
    capabilityVersionId: change.from_capability_version_id,
    serviceId: change.service_id,
    operationId: change.operation_id,
  }));
  const blockedWorkflowStarts = await client.query<BlockedWorkflowStartRow>(
    `SELECT blocked.id::text, blocked.workflow_version_id,
            trim(blocked.from_capability_version_id) AS from_capability_version_id,
            trim(blocked.to_capability_version_id) AS to_capability_version_id,
             blocked.quarantined_at, blocked.lifted_at
     FROM workflow_quarantines blocked
     JOIN capability_discovery_changes change
       ON change.discovery_id = $3
      AND change.organization_id = blocked.organization_id
      AND change.from_capability_version_id = blocked.from_capability_version_id
      AND change.to_capability_version_id = blocked.to_capability_version_id
     WHERE blocked.organization_id = $1 AND blocked.environment_id = $2
      ORDER BY blocked.workflow_version_id, blocked.quarantined_at DESC, blocked.id DESC`,
    [organizationId, environmentId, focus.id],
  );
  const latestFailedRuns = await client.query<FailedRunRow>(
    `SELECT DISTINCT ON
       (run.workflow_version_id, attempt.step_id, attempt.capability_version_id)
       run.run_id, run.workflow_version_id, attempt.step_id AS failed_step_id,
       attempt.capability_version_id, attempt.failure_type, attempt.recorded_at
     FROM workflow_runs run
     JOIN workflow_run_step_attempts attempt
       ON attempt.organization_id = run.organization_id
      AND attempt.environment_id = run.environment_id
      AND attempt.run_id = run.run_id
      AND attempt.step_id = run.failed_step_id
     JOIN capability_rediscovery_requests request
       ON request.discovery_id = $3
      AND request.organization_id = attempt.organization_id
      AND request.environment_id = attempt.environment_id
      AND request.capability_version_id = attempt.capability_version_id
      AND request.step_id = attempt.step_id
     WHERE run.organization_id = $1 AND run.environment_id = $2
       AND run.failed_step_id IS NOT NULL AND run.failure_type IS NOT NULL
       AND run.state <> 'completed' AND attempt.status = 'failed'
       AND attempt.failure_type IS NOT NULL
       AND attempt.recorded_at BETWEEN request.requested_at - interval '5 minutes'
         AND request.requested_at
     ORDER BY run.workflow_version_id, attempt.step_id, attempt.capability_version_id,
       attempt.recorded_at DESC, run.run_id`,
    [organizationId, environmentId, focus.id],
  );
  const blockedByWorkflowAndVersion = new Map<string, BlockedWorkflowStartRow>();
  for (const blocked of blockedWorkflowStarts.rows) {
    const key = workflowCapabilityVersionKey(
      blocked.workflow_version_id,
      blocked.from_capability_version_id,
    );
    if (!blockedByWorkflowAndVersion.has(key)) blockedByWorkflowAndVersion.set(key, blocked);
  }
  const failedRunByWorkflowAndStep = new Map(
    latestFailedRuns.rows.map((run) => [
      failedRunKey(run.workflow_version_id, run.failed_step_id, run.capability_version_id),
      run,
    ]),
  );

  for (const parsed of workflows) {
    const workflowEdges = buildWorkflowGraph(parsed.workflow).edges;
    const nextEdges = workflowEdges.filter((edge) => edge.kind === 'next');
    for (const change of result.rows) {
      if (change.classification !== 'breaking') continue;
      const recordedPins = z
        .array(discoveryAffectedWorkflowSchema)
        .safeParse(change.affected_workflows);
      if (!recordedPins.success) {
        unresolved.add(`${change.from_capability_version_id}:stored-workflow-pins`);
        continue;
      }
      const directStepIds = new Set(
        recordedPins.data
          .filter((pin) => pin.workflowVersionId === parsed.row.workflow_version_id)
          .map((pin) => pin.stepId),
      );
      if (directStepIds.size === 0) continue;
      const fieldChanges = z.array(discoveryFieldChangeSchema).safeParse(change.field_changes);
      if (change.change_kind === 'version-change' && !fieldChanges.success) {
        unresolved.add(`${change.from_capability_version_id}:stored-field-changes`);
        continue;
      }
      for (const fieldChange of fieldChanges.success ? fieldChanges.data : []) {
        if (!supportedChangeKinds.has(fieldChange.kind)) {
          unresolved.add(`${change.from_capability_version_id}:${fieldChange.kind}:change-kind`);
        }
      }
      const requestFields = requestFieldPaths(change.to_capability_fragment);
      const previousRequestFields = requestFieldPaths(change.from_capability_fragment);
      const responseFields = responseFieldPaths(change.from_capability_fragment);
      const directFailures = new Map<string, AffectedUsage>();

      for (const stepId of directStepIds) {
        const step = parsed.workflow.executable.steps.find((candidate) => candidate.id === stepId);
        if (
          !step ||
          !isCapabilityStep(step) ||
          step.capabilityVersionId.trim() !== change.from_capability_version_id
        ) {
          unresolved.add(
            `${change.from_capability_version_id}:${parsed.row.workflow_version_id}:${stepId}`,
          );
          continue;
        }
        if (change.change_kind === 'removal') {
          directFailures.set(
            stepId,
            affectedUsage(
              parsed,
              step,
              focus,
              change,
              `This call will fail because ${change.operation_id} was removed.`,
            ),
          );
        }
        for (const fieldChange of fieldChanges.success ? fieldChanges.data : []) {
          if (
            fieldChange.kind === 'idempotency-changed' ||
            fieldChange.kind === 'compensation-changed' ||
            fieldChange.kind === 'irreversibility-changed'
          ) {
            const compensation = compensationForStep(parsed.workflow, stepId);
            const compensationIdentity = compensation
              ? identityByVersion.get(compensation.capabilityVersionId.trim())
              : undefined;
            const usesCompensation =
              compensation !== undefined && workflowCanRunCompensation(parsed.workflow, stepId);
            const usesRepeatedCalls =
              (step.retryPolicy?.maximumAttempts ?? 1) > 1 ||
              workflowRepeatsStep(parsed.workflow, stepId);
            if (
              fieldChange.kind === 'idempotency-changed' &&
              typeof fieldChange.previousValue === 'string' &&
              fieldChange.previousValue in step.arguments &&
              (typeof fieldChange.nextValue !== 'string' ||
                !(fieldChange.nextValue in step.arguments)) &&
              step.idempotency &&
              usesRepeatedCalls
            ) {
              directFailures.set(
                stepId,
                affectedUsage(
                  parsed,
                  step,
                  focus,
                  change,
                  `This step cannot run because repeated calls to ${change.operation_id} are no longer protected from doing the same write twice.`,
                ),
              );
            }
            if (
              fieldChange.kind === 'irreversibility-changed' &&
              fieldChange.previousValue === false &&
              fieldChange.nextValue === true &&
              step.irreversibleAfter !== true &&
              (usesCompensation || workflowRepeatsStep(parsed.workflow, stepId))
            ) {
              directFailures.set(
                stepId,
                affectedUsage(
                  parsed,
                  step,
                  focus,
                  change,
                  `This step cannot run because ${change.operation_id} can no longer be safely undone or repeated by this workflow.`,
                ),
              );
            }
            if (
              fieldChange.kind === 'compensation-changed' &&
              compensation &&
              usesCompensation &&
              compensationIdentity === fieldChange.previousValue &&
              compensationIdentity !== fieldChange.nextValue
            ) {
              directFailures.set(
                stepId,
                affectedUsage(
                  parsed,
                  step,
                  focus,
                  change,
                  `This step cannot run because the recovery call for ${change.operation_id} changed.`,
                ),
              );
              affectedRelationships.add(
                affectedRelationshipKey(
                  parsed.row.workflow_version_id,
                  stepId,
                  compensation.id,
                  'compensation',
                ),
              );
            }
            continue;
          }
          if (fieldChange.kind !== 'added-required' || !fieldChange.path) continue;
          const dataPaths = requestFields.get(fieldChange.path);
          if (!dataPaths || dataPaths.length === 0) {
            unresolved.add(`${change.from_capability_version_id}:${fieldChange.path}:request-path`);
            continue;
          }
          const statuses = dataPaths.map((path) => requestFieldStatus(step, path));
          if (statuses.includes('unknown')) {
            unresolved.add(
              `${change.from_capability_version_id}:${parsed.row.workflow_version_id}:${stepId}:${fieldChange.path}`,
            );
            continue;
          }
          if (!statuses.includes('missing')) continue;
          const field = dataPaths[0]!.join('.');
          directFailures.set(
            stepId,
            affectedUsage(
              parsed,
              step,
              focus,
              change,
              `This call does not provide the newly required ${field} field.`,
              { fieldPath: fieldChange.path },
            ),
          );
        }
      }

      for (const fieldChange of fieldChanges.success ? fieldChanges.data : []) {
        if (
          (fieldChange.kind !== 'removed' && fieldChange.kind !== 'retyped') ||
          !fieldChange.path
        ) {
          continue;
        }
        const dataPaths = responseFields.get(fieldChange.path);
        if (!dataPaths || dataPaths.length === 0) {
          if (!previousRequestFields.has(fieldChange.path)) {
            unresolved.add(
              `${change.from_capability_version_id}:${fieldChange.path}:response-path`,
            );
          }
          continue;
        }
        const field = dataPaths[0]!.join('.');
        for (const edge of workflowEdges) {
          if (edge.kind !== 'mapping' || !directStepIds.has(edge.fromStepId)) continue;
          if (
            !dataPaths.some((path) =>
              stepUsesResponsePath(
                parsed.workflow,
                edge.fromStepId,
                edge.toStepId,
                edge.label,
                path,
              ),
            )
          ) {
            continue;
          }
          if (fieldChange.kind === 'retyped') {
            const uses = dataPaths.map((path) =>
              retypedFieldUse(
                parsed.workflow,
                edge.fromStepId,
                edge.toStepId,
                edge.label,
                path,
                valueAtJsonPointer(change.to_capability_fragment, fieldChange.path!),
              ),
            );
            if (uses.includes('unknown')) {
              unresolved.add(
                `${change.from_capability_version_id}:${parsed.row.workflow_version_id}:${edge.toStepId}:${fieldChange.path}:receiving-type`,
              );
              continue;
            }
            if (!uses.includes('broken')) continue;
          }
          const source = parsed.steps.get(edge.fromStepId);
          const target = parsed.steps.get(edge.toStepId);
          if (!source || !target) {
            unresolved.add(
              `${change.from_capability_version_id}:${parsed.row.workflow_version_id}:${edge.fromStepId}:${edge.toStepId}`,
            );
            continue;
          }
          const path: ImpactPathHop[] = [
            {
              kind: 'data-flow',
              fromStepId: edge.fromStepId,
              toStepId: edge.toStepId,
              fromCapabilityVersionId: source.capabilityVersionId,
              toCapabilityVersionId: target.capabilityVersionId,
            },
          ];
          directFailures.set(
            edge.toStepId,
            affectedUsage(
              parsed,
              target,
              focus,
              change,
              fieldChange.kind === 'removed'
                ? `This call uses ${field} from ${edge.fromStepId}, but that response field is no longer available.`
                : `This call uses ${field} from ${edge.fromStepId}, but that response field changed type.`,
              { fieldPath: fieldChange.path, sourceStepId: edge.fromStepId, path },
            ),
          );
          affectedRelationships.add(
            affectedRelationshipKey(
              parsed.row.workflow_version_id,
              edge.fromStepId,
              edge.toStepId,
              'data-flow',
            ),
          );
        }
      }

      spreadFailureThroughLaterSteps(
        parsed,
        nextEdges,
        [...directFailures.values()],
        usages,
        affectedRelationships,
        (failed, target, sourceStepId, path) =>
          affectedUsage(
            parsed,
            target,
            focus,
            change,
            `This call cannot run because required earlier step ${sourceStepId} will fail.`,
            {
              ...(failed.evidence.fieldPath ? { fieldPath: failed.evidence.fieldPath } : {}),
              sourceStepId,
              path,
            },
          ),
      );
    }
  }

  const orderedUsages = [...usages.values()]
    .map((usage) => {
      if (!('fromCapabilityVersionId' in usage.evidence)) return usage;
      const blocked = blockedByWorkflowAndVersion.get(
        workflowCapabilityVersionKey(
          usage.workflowVersionId,
          usage.evidence.fromCapabilityVersionId,
        ),
      );
      const failedRun = failedRunByWorkflowAndStep.get(
        failedRunKey(usage.workflowVersionId, usage.stepId, usage.capabilityVersionId),
      );
      return {
        ...usage,
        currentState: {
          ...usage.currentState,
          quarantine: blocked
            ? blocked.lifted_at
              ? ('cleared' as const)
              : ('active' as const)
            : ('not-recorded' as const),
          ...(blocked?.lifted_at ? { quarantineClearedAt: blocked.lifted_at.toISOString() } : {}),
          ...(blocked
            ? {
                blockedWorkflowStart: {
                  id: blocked.id,
                  toCapabilityVersionId: blocked.to_capability_version_id,
                  blockedAt: blocked.quarantined_at.toISOString(),
                },
              }
            : {}),
          ...(failedRun
            ? {
                latestFailedRun: {
                  runId: failedRun.run_id,
                  failureType: failedRun.failure_type,
                  failedAt: failedRun.recorded_at.toISOString(),
                },
              }
            : {}),
        },
        evidence: usage.evidence,
      };
    })
    .sort(
      (left, right) =>
        left.workflowVersionId.localeCompare(right.workflowVersionId) ||
        left.stepId.localeCompare(right.stepId),
    );
  const usagesByIdentity = new Map<string, AffectedUsage[]>();
  for (const usage of orderedUsages) {
    const identity = identityByVersion.get(usage.capabilityVersionId.trim());
    if (!identity) {
      unresolved.add(`${usage.workflowVersionId}:${usage.stepId}:capability-pin`);
      continue;
    }
    const existing = usagesByIdentity.get(identity) ?? [];
    existing.push(usage);
    usagesByIdentity.set(identity, existing);
  }
  const visibleUsages = [...usagesByIdentity.values()].flat();
  const currentlyExposedUsages = visibleUsages.filter((usage) => usage.currentState.isActive);
  return {
    summary: {
      type: 'change' as const,
      id: focus.id,
      affectedWorkflowCount: new Set(visibleUsages.map((usage) => usage.workflowVersionId)).size,
      affectedStepCount: visibleUsages.length,
      currentlyExposedWorkflowCount: new Set(
        currentlyExposedUsages.map((usage) => usage.workflowVersionId),
      ).size,
      currentlyExposedStepCount: currentlyExposedUsages.length,
      incompleteAnalysisCount: unresolved.size,
      analysis: unresolved.size === 0 ? ('complete' as const) : ('partial' as const),
      recordedAt: discovery.rows[0].discovered_at.toISOString(),
      sources,
    },
    sources: new Set(sources.map((source) => source.capabilityIdentityId)),
    usagesByIdentity,
    affectedRelationships,
    notices:
      unresolved.size === 0
        ? []
        : [
            `Atlas could not complete ${unresolved.size} ${unresolved.size === 1 ? 'part' : 'parts'} of this impact analysis. Unresolved evidence is not shown as broken.`,
          ],
  };
}

function runtimeFieldSegments(fieldPath: string) {
  return fieldPath.startsWith('/')
    ? fieldPath
        .split('/')
        .slice(1)
        .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    : fieldPath.split('.').filter(Boolean);
}

function runtimeAffectedUsage(
  parsed: ParsedWorkflow,
  step: CapabilityStep,
  mismatch: RuntimeMismatchRow,
  reason: string,
  evidence: { sourceStepId?: string; path?: ImpactPathHop[] } = {},
): AffectedUsage {
  return {
    ...affectedUsageFields(parsed, step, reason),
    evidence: {
      runtimeMismatchId: mismatch.id,
      observationId: mismatch.observation_id,
      capabilityVersionId: mismatch.capability_version_id,
      status: mismatch.status_code,
      normalizedReason: mismatch.reason,
      fieldPath: mismatch.field_path,
      observedAt: mismatch.observed_at.toISOString(),
      path: evidence.path ?? [],
      ...evidence,
    },
  };
}

async function readRuntimeMismatchImpact(
  client: Pick<PoolClient, 'query'>,
  organizationId: string,
  environmentId: string,
  focus: Extract<CapabilityOverviewFocus, { type: 'runtime-mismatch' }>,
  workflows: readonly ParsedWorkflow[],
  identityByVersion: ReadonlyMap<string, string>,
) {
  const result = await client.query<RuntimeMismatchRow>(
    `SELECT mismatch.id, mismatch.capability_identity_id::text AS capability_identity_id,
            trim(mismatch.capability_version_id) AS capability_version_id,
            identity.service_id, mismatch.operation_id, mismatch.reason, mismatch.field_path,
            mismatch.status_code, mismatch.first_seen_at, mismatch.last_seen_at,
            mismatch.occurrence_count, mismatch.state, mismatch.recovered_at,
            observation.id AS observation_id, observation.observed_at
     FROM runtime_contract_mismatches mismatch
     JOIN capability_identities identity
       ON identity.id = mismatch.capability_identity_id
      AND identity.organization_id = mismatch.organization_id
     JOIN runtime_contract_mismatch_observations observation
       ON observation.id = mismatch.latest_observation_id
     WHERE mismatch.id = $1 AND mismatch.organization_id = $2
       AND mismatch.environment_id = $3`,
    [focus.id, organizationId, environmentId],
  );
  const mismatch = result.rows[0];
  if (!mismatch) {
    return {
      summary: {
        type: 'runtime-mismatch' as const,
        id: focus.id,
        affectedEndpointCount: 0,
        affectedWorkflowCount: 0,
        affectedStepCount: 0,
        currentlyExposedWorkflowCount: 0,
        currentlyExposedStepCount: 0,
        incompleteAnalysisCount: 1,
        analysis: 'unavailable' as const,
        sources: [],
        occurrenceCount: 0,
      },
      sources: new Set<string>(),
      usagesByIdentity: new Map<string, AffectedUsage[]>(),
      affectedRelationships: new Set<string>(),
      notices: ['Atlas could not find the selected polling failure in this environment.'],
    };
  }

  const usages = new Map<string, AffectedUsage>();
  const affectedRelationships = new Set<string>();
  const unresolved = new Set<string>();
  const fieldSegments = runtimeFieldSegments(mismatch.field_path);
  if (fieldSegments.length === 0) unresolved.add(`${mismatch.id}:field-path`);

  for (const parsed of workflows) {
    const workflowEdges = buildWorkflowGraph(parsed.workflow).edges;
    const nextEdges = workflowEdges.filter((edge) => edge.kind === 'next');
    const directFailures: AffectedUsage[] = [];
    for (const step of parsed.workflow.executable.steps) {
      if (
        !isCapabilityStep(step) ||
        step.capabilityVersionId.trim() !== mismatch.capability_version_id
      ) {
        continue;
      }
      // Provider errors name JSON-body fields without Atlas's transport argument wrapper.
      // Preserve explicitly qualified paths, while inspecting a mapped body when present.
      const requestPath =
        fieldSegments[0] && !(fieldSegments[0] in step.arguments) && 'body' in step.arguments
          ? ['body', ...fieldSegments]
          : fieldSegments;
      const status = requestFieldStatus(step, requestPath);
      if (status === 'unknown') {
        unresolved.add(`${parsed.row.workflow_version_id}:${step.id}:${mismatch.field_path}`);
        continue;
      }
      if (status === 'supplied') continue;
      const capabilityStep = parsed.steps.get(step.id)!;
      directFailures.push(
        runtimeAffectedUsage(
          parsed,
          capabilityStep,
          mismatch,
          `This call does not provide the required ${mismatch.field_path} field.`,
        ),
      );
    }
    spreadFailureThroughLaterSteps(
      parsed,
      nextEdges,
      directFailures,
      usages,
      affectedRelationships,
      (_failed, target, sourceStepId, path) =>
        runtimeAffectedUsage(
          parsed,
          target,
          mismatch,
          `This call cannot run because required earlier step ${sourceStepId} will fail.`,
          { sourceStepId, path },
        ),
    );
  }

  const orderedUsages = [...usages.values()].sort(
    (left, right) =>
      left.workflowVersionId.localeCompare(right.workflowVersionId) ||
      left.stepId.localeCompare(right.stepId),
  );
  const usagesByIdentity = new Map<string, AffectedUsage[]>();
  for (const usage of orderedUsages) {
    const identity = identityByVersion.get(usage.capabilityVersionId.trim());
    if (!identity) {
      unresolved.add(`${usage.workflowVersionId}:${usage.stepId}:capability-pin`);
      continue;
    }
    usagesByIdentity.set(identity, [...(usagesByIdentity.get(identity) ?? []), usage]);
  }
  const visibleUsages = [...usagesByIdentity.values()].flat();
  const currentlyExposedUsages = visibleUsages.filter((usage) => usage.currentState.isActive);
  return {
    summary: {
      type: 'runtime-mismatch' as const,
      id: mismatch.id,
      affectedEndpointCount: usagesByIdentity.size,
      affectedWorkflowCount: new Set(visibleUsages.map((usage) => usage.workflowVersionId)).size,
      affectedStepCount: visibleUsages.length,
      currentlyExposedWorkflowCount: new Set(
        currentlyExposedUsages.map((usage) => usage.workflowVersionId),
      ).size,
      currentlyExposedStepCount: currentlyExposedUsages.length,
      incompleteAnalysisCount: unresolved.size,
      analysis: unresolved.size === 0 ? ('complete' as const) : ('partial' as const),
      recordedAt: mismatch.first_seen_at.toISOString(),
      lastSeenAt: mismatch.last_seen_at.toISOString(),
      occurrenceCount: mismatch.occurrence_count,
      state: mismatch.state,
      ...(mismatch.recovered_at ? { recoveredAt: mismatch.recovered_at.toISOString() } : {}),
      sources: [
        {
          capabilityIdentityId: mismatch.capability_identity_id,
          capabilityVersionId: mismatch.capability_version_id,
          serviceId: mismatch.service_id,
          operationId: mismatch.operation_id,
        },
      ],
    },
    sources: new Set([mismatch.capability_identity_id]),
    usagesByIdentity,
    affectedRelationships: mismatch.state === 'active' ? affectedRelationships : new Set<string>(),
    notices:
      unresolved.size === 0
        ? []
        : [
            `Atlas could not complete ${unresolved.size} ${unresolved.size === 1 ? 'part' : 'parts'} of this impact analysis. Unresolved evidence is not shown as broken.`,
          ],
  };
}

async function readOverviewWithinSnapshot(
  client: Pick<PoolClient, 'query'>,
  organizationId: string,
  environmentId: string,
  focus?: CapabilityOverviewFocus,
) {
  const catalog = await readCapabilityCatalog(client, organizationId, environmentId);
  const workflows = await client.query<WorkflowRow>(
    `SELECT identity.workflow_id, identity.name AS workflow_name,
              version.workflow_version_id,
              CASE WHEN replacement.current_workflow_version_id IS NOT NULL THEN 'historical'
                   ELSE scoped.lifecycle_status END AS lifecycle_status,
              CASE WHEN replacement.current_workflow_version_id IS NOT NULL THEN false
                   ELSE scoped.is_active END AS is_active,
              replacement.current_workflow_version_id AS replacement_workflow_version_id,
              replacement.activated_at AS replacement_activated_at,
              version.compiled_workflow
       FROM workflow_environment_versions scoped
       JOIN workflow_versions version
         ON version.organization_id = scoped.organization_id
        AND version.workflow_version_id = scoped.workflow_version_id
        JOIN workflow_identities identity
         ON identity.organization_id = version.organization_id
        AND identity.workflow_id = version.workflow_id
        LEFT JOIN LATERAL (
          SELECT activation.current_workflow_version_id, activation.activated_at
          FROM workflow_activations activation
          WHERE activation.organization_id = scoped.organization_id
            AND activation.environment_id = scoped.environment_id
            AND activation.previous_workflow_version_id = scoped.workflow_version_id
            AND activation.rolled_back_at IS NULL
          ORDER BY activation.activated_at DESC, activation.id DESC
          LIMIT 1
        ) replacement ON true
        WHERE scoped.organization_id = $1 AND scoped.environment_id = $2
         AND (scoped.lifecycle_status IN ('approved-inactive', 'active') OR scoped.is_active)
         AND version.compiled_workflow IS NOT NULL
       ORDER BY identity.workflow_id, version.workflow_version_id`,
    [organizationId, environmentId],
  );
  const capabilityVersions = await client.query<CapabilityVersionRow>(
    `SELECT version.capability_version_id,
              version.capability_identity_id::text AS capability_identity_id
       FROM environment_capability_version_observations observed
       JOIN capability_versions version
         ON version.organization_id = observed.organization_id
        AND version.capability_version_id = observed.capability_version_id
       WHERE observed.organization_id = $1 AND observed.environment_id = $2
       ORDER BY version.capability_version_id`,
    [organizationId, environmentId],
  );

  let nodes = catalog
    .map((capability) => ({
      capabilityIdentityId: String(capability.capabilityIdentityId),
      capabilityVersionId: capability.capabilityVersionId,
      kind: capability.identity.kind,
      serviceId: capability.identity.serviceId,
      operationId: capability.identity.operationId,
      availability: capability.observation.availability,
      freshness: capability.observation.freshness,
      sourceResolution: capability.sourceResolution.status,
    }))
    .sort(
      (left, right) =>
        left.serviceId.localeCompare(right.serviceId) ||
        left.operationId.localeCompare(right.operationId) ||
        left.capabilityIdentityId.localeCompare(right.capabilityIdentityId),
    );
  const visibleIdentityIds = new Set(nodes.map((node) => node.capabilityIdentityId));
  const identityByVersion = new Map(
    capabilityVersions.rows.map((row) => [
      row.capability_version_id.trim(),
      row.capability_identity_id,
    ]),
  );
  const parsedWorkflows: ParsedWorkflow[] = [];
  let unreadableWorkflowCount = 0;
  for (const row of workflows.rows) {
    const parsed = versionedCompiledWorkflowVersionSchema.safeParse(row.compiled_workflow);
    if (!parsed.success) {
      unreadableWorkflowCount += 1;
      continue;
    }
    parsedWorkflows.push({
      row,
      workflow: parsed.data,
      steps: workflowCapabilitySteps(parsed.data),
    });
  }
  const workflowLifecyclesByIdentity = new Map<string, Set<WorkflowRow['lifecycle_status']>>();
  for (const parsed of parsedWorkflows) {
    for (const step of parsed.steps.values()) {
      const capabilityIdentityId = identityByVersion.get(step.capabilityVersionId);
      if (!capabilityIdentityId) continue;
      const lifecycles = workflowLifecyclesByIdentity.get(capabilityIdentityId) ?? new Set();
      lifecycles.add(parsed.row.lifecycle_status);
      workflowLifecyclesByIdentity.set(capabilityIdentityId, lifecycles);
    }
  }
  nodes = nodes.map((node) => ({
    ...node,
    workflowLifecycles: [
      ...(workflowLifecyclesByIdentity.get(node.capabilityIdentityId) ?? []),
    ].sort(),
  }));
  const impact = focus
    ? focus.type === 'change'
      ? await readDiscoveredChangeImpact(
          client,
          organizationId,
          environmentId,
          focus,
          parsedWorkflows,
          identityByVersion,
        )
      : await readRuntimeMismatchImpact(
          client,
          organizationId,
          environmentId,
          focus,
          parsedWorkflows,
          identityByVersion,
        )
    : null;
  if (impact) {
    const showLiveImpact =
      impact.summary.type !== 'runtime-mismatch' ||
      !('state' in impact.summary) ||
      impact.summary.state !== 'recovered';
    nodes = nodes.map((node) => {
      const usages = impact.usagesByIdentity.get(node.capabilityIdentityId) ?? [];
      const isSource = impact.sources.has(node.capabilityIdentityId);
      return {
        ...node,
        impact: {
          affected: showLiveImpact && usages.length > 0,
          isSource,
          affectedWorkflowCount: new Set(usages.map((usage) => usage.workflowVersionId)).size,
          usages,
        },
      };
    });
  }

  const relationships = [];
  let missingConnectionCount = 0;
  for (const parsed of parsedWorkflows) {
    for (const edge of buildWorkflowGraph(parsed.workflow).edges) {
      const kind = overviewRelationshipKind(edge.kind);
      if (!kind) continue;
      const sourceStep = parsed.steps.get(edge.fromStepId);
      const targetStep = parsed.steps.get(edge.toStepId);
      if (!sourceStep || !targetStep) continue;
      const sourceCapabilityIdentityId = identityByVersion.get(sourceStep.capabilityVersionId);
      const targetCapabilityIdentityId = identityByVersion.get(targetStep.capabilityVersionId);
      if (
        !sourceCapabilityIdentityId ||
        !targetCapabilityIdentityId ||
        !visibleIdentityIds.has(sourceCapabilityIdentityId) ||
        !visibleIdentityIds.has(targetCapabilityIdentityId)
      ) {
        missingConnectionCount += 1;
        continue;
      }
      const evidence = {
        workflowId: parsed.row.workflow_id,
        workflowName: parsed.row.workflow_name,
        workflowVersionId: parsed.row.workflow_version_id,
        sourceStepId: sourceStep.id,
        targetStepId: targetStep.id,
        sourceCapabilityVersionId: sourceStep.capabilityVersionId,
        targetCapabilityVersionId: targetStep.capabilityVersionId,
        workflowLifecycle: parsed.row.lifecycle_status,
        ...(edge.label ? { destinationField: edge.label } : {}),
      };
      relationships.push({
        id: `relationship-${sha256(
          canonicalJson({
            kind,
            sourceCapabilityIdentityId,
            targetCapabilityIdentityId,
            evidence,
          }),
        )}`,
        kind,
        sourceCapabilityIdentityId,
        targetCapabilityIdentityId,
        evidence,
        ...(impact?.affectedRelationships.has(
          affectedRelationshipKey(
            parsed.row.workflow_version_id,
            sourceStep.id,
            targetStep.id,
            kind,
          ),
        )
          ? {
              impact: {
                affected: true as const,
                workflowVersionIds: [parsed.row.workflow_version_id],
              },
            }
          : {}),
      });
    }
  }

  relationships.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.sourceCapabilityIdentityId.localeCompare(right.sourceCapabilityIdentityId) ||
      left.targetCapabilityIdentityId.localeCompare(right.targetCapabilityIdentityId) ||
      left.id.localeCompare(right.id),
  );

  const services = [...new Set(nodes.map((node) => node.serviceId))].sort().map((serviceId) => ({
    serviceId,
    capabilityIdentityIds: nodes
      .filter((node) => node.serviceId === serviceId)
      .map((node) => node.capabilityIdentityId),
  }));
  const notices = [];
  if (nodes.length === 0) {
    notices.push('Atlas has not ingested any capabilities for this environment.');
  }
  if (unreadableWorkflowCount > 0) {
    notices.push(
      `${unreadableWorkflowCount} approved ${unreadableWorkflowCount === 1 ? 'workflow' : 'workflows'} could not be read.`,
    );
  }
  if (missingConnectionCount > 0) {
    notices.push(
      `${missingConnectionCount} ${missingConnectionCount === 1 ? 'connection' : 'connections'} could not be shown because the pinned capability was not available in this environment.`,
    );
  }
  notices.push(...(impact?.notices ?? []));
  const status = nodes.length === 0 && !focus ? 'empty' : notices.length > 0 ? 'partial' : 'ready';
  const snapshot = {
    status,
    nodes,
    relationships,
    services,
    notices,
    ...(impact ? { impact: impact.summary } : {}),
  } as const;
  return capabilityOverviewSchema.parse({
    snapshotId: sha256(canonicalJson(snapshot)),
    ...snapshot,
  });
}

export async function readCapabilityOverview(
  pool: Pool,
  organizationId: string,
  environmentId: string,
  focus?: CapabilityOverviewFocus,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const overview = await readOverviewWithinSnapshot(client, organizationId, environmentId, focus);
    await client.query('COMMIT');
    return overview;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
