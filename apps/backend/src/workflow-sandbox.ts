import {
  isCapabilityStep,
  versionedCompiledWorkflowVersionSchema,
  verifyCompiledWorkflowVersionIntegrity,
  type VersionedCompiledWorkflowVersion,
  type GraphExecutableWorkflow,
  type GraphStep,
  type ResponseValueSchema,
} from '@atlas/workflow-ir';
import {
  workflowSandboxRuntimeVersion,
  workflowSandboxTargetEvidence,
  workflowSandboxWorkerVersion,
  type WorkflowSandboxExecutionMethod,
  type WorkflowSandboxOutcomeWire,
  type WorkflowSandboxProgressWire,
  type WorkflowSandboxProviderContractWire,
  type WorkflowSandboxTestKind,
  type WorkflowSandboxTestWire,
} from '@atlas/demo-estate';
import type { Pool } from 'pg';
import { z } from 'zod';
import { canonicalJson, sha256 } from './capability-versioning.js';
import { recordWorkflowLifecycle } from './workflow-catalog.js';
import {
  InvalidSandboxTarget,
  defaultConnectedSandboxSelections,
  resolveSandboxTargetBindings,
  sandboxTargetSelectionSchema,
  type WorkflowSandboxTargetBinding,
} from './capability-sandbox-targets.js';

export const workflowSandboxRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    draft: z.unknown(),
    targetSelections: z.array(sandboxTargetSelectionSchema).default([]),
  })
  .strict();

export const workflowSandboxReadinessQuerySchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    workflowVersionId: z.string().min(1),
    irHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type WorkflowSandboxTest = Readonly<WorkflowSandboxTestWire>;
export type WorkflowProviderContract = Readonly<WorkflowSandboxProviderContractWire>;

export interface WorkflowSandboxSetupBinding {
  readonly workflowVersionId: string;
  readonly irHash: string;
  readonly capabilityVersions: ReadonlyArray<{
    readonly capabilityVersionId: string;
    readonly sourceDocumentHash: string;
    readonly secretAlias: string | null;
  }>;
  readonly suiteFingerprint: string;
  readonly targets: ReadonlyArray<ReturnType<typeof publicTargetBinding>>;
  readonly workerVersion: string;
  readonly runtimeVersion: string;
  readonly executionMethods: readonly WorkflowSandboxExecutionMethod[];
  readonly environmentId: string;
  readonly testedAt: string;
}

export interface WorkflowSandboxStaleDiagnostic {
  readonly part: 'artifact' | 'contract' | 'target' | 'test-data' | 'runtime' | 'execution-method';
  readonly message: string;
}

export function sandboxSetupStaleDiagnostics(
  completed: WorkflowSandboxSetupBinding,
  current: WorkflowSandboxSetupBinding,
): WorkflowSandboxStaleDiagnostic[] {
  const rerun = 'Rerun the generated tests before approval.';
  const diagnostics: WorkflowSandboxStaleDiagnostic[] = [];
  if (
    completed.workflowVersionId !== current.workflowVersionId ||
    completed.irHash !== current.irHash ||
    completed.suiteFingerprint !== current.suiteFingerprint
  ) {
    diagnostics.push({
      part: 'artifact',
      message: `The workflow artifact changed, or the generated test suite changed. ${rerun}`,
    });
  }
  if (canonicalJson(completed.capabilityVersions) !== canonicalJson(current.capabilityVersions)) {
    diagnostics.push({
      part: 'contract',
      message: `A capability version or source document changed. ${rerun}`,
    });
  }
  const completedTargets = completed.targets.map(
    ({ testDataProfileKey: _key, testDataVersion: _version, ...target }) => target,
  );
  const currentTargets = current.targets.map(
    ({ testDataProfileKey: _key, testDataVersion: _version, ...target }) => target,
  );
  if (canonicalJson(completedTargets) !== canonicalJson(currentTargets)) {
    diagnostics.push({
      part: 'target',
      message: `A provider target configuration changed. ${rerun}`,
    });
  }
  const testData = (binding: WorkflowSandboxSetupBinding) =>
    binding.targets.map(({ capabilityVersionId, testDataProfileKey, testDataVersion }) => ({
      capabilityVersionId,
      testDataProfileKey,
      testDataVersion,
    }));
  if (canonicalJson(testData(completed)) !== canonicalJson(testData(current))) {
    diagnostics.push({ part: 'test-data', message: `A test-data profile changed. ${rerun}` });
  }
  if (
    completed.workerVersion !== current.workerVersion ||
    completed.runtimeVersion !== current.runtimeVersion
  ) {
    diagnostics.push({
      part: 'runtime',
      message: `The worker or runtime version changed. ${rerun}`,
    });
  }
  if (canonicalJson(completed.executionMethods) !== canonicalJson(current.executionMethods)) {
    diagnostics.push({
      part: 'execution-method',
      message: `The test execution method changed. ${rerun}`,
    });
  }
  return diagnostics;
}

export interface WorkflowSandboxExecutor {
  execute(input: {
    readonly organizationId: string;
    readonly environmentId: string;
    readonly workflowVersionId: string;
    readonly irHash: string;
    readonly workflow: VersionedCompiledWorkflowVersion;
    readonly providerContracts: readonly WorkflowProviderContract[];
    readonly tests: readonly WorkflowSandboxTest[];
    readonly targetBindings: readonly WorkflowSandboxTargetBinding[];
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: WorkflowSandboxProgressWire) => void;
  }): Promise<ReadonlyArray<WorkflowSandboxOutcomeWire>>;
}

export class WorkflowSandboxExecutionFailed extends Error {}

export class WorkflowSandboxTestsUnavailable extends Error {
  constructor(
    readonly readinessStatus: 'missing' | 'queued' | 'running' | 'failed' | 'unavailable' | 'stale',
  ) {
    super(`Workflow sandbox tests are ${readinessStatus}`);
  }
}

interface ContractRow {
  capability_version_id: string;
  service_id: string;
  operation_id: string;
  document_hash: string;
  secret_alias: string | null;
  idempotency_field: string | null;
  business_semantics: Record<string, unknown>;
  connection_mode: string | null;
  capability_fragment: Record<string, unknown>;
}

function test(
  kind: WorkflowSandboxTestKind,
  expectation: string,
  stepId: string | null = null,
  capabilityVersionId: string | null = null,
  requestSample: Record<string, unknown> | null = null,
  expectedResponseSchema: unknown = null,
  failureErrorType?: string,
): WorkflowSandboxTest {
  return {
    testId: [kind, stepId, capabilityVersionId, failureErrorType].filter(Boolean).join(':'),
    kind,
    stepId,
    capabilityVersionId,
    expectation,
    requestSample,
    expectedResponseSchema,
    ...(failureErrorType ? { failureErrorType } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resolveSchema(fragment: Record<string, unknown>, value: unknown): unknown {
  const schema = objectValue(value);
  if (!schema) return value;
  if (typeof schema.$ref === 'string') {
    const referenced = objectValue(fragment.references)?.[schema.$ref];
    return referenced === undefined ? schema : resolveSchema(fragment, referenced);
  }
  return Object.fromEntries(
    Object.entries(schema).map(([key, child]) => [
      key,
      Array.isArray(child)
        ? child.map((item) => resolveSchema(fragment, item))
        : resolveSchema(fragment, child),
    ]),
  );
}

function schemaSample(schemaValue: unknown, propertyName = ''): unknown {
  const schema = objectValue(schemaValue);
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'object' || objectValue(schema.properties)) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.fromEntries(
      Object.entries(objectValue(schema.properties) ?? {})
        .filter(([name]) => required.has(name))
        .map(([name, child]) => [name, schemaSample(child, name)]),
    );
  }
  if (schema.type === 'array') return [schemaSample(schema.items, propertyName)];
  if (schema.type === 'integer' || schema.type === 'number') {
    return propertyName.toLowerCase().includes('version') ? 1 : 100;
  }
  if (schema.type === 'boolean') return true;
  const name = propertyName.toLowerCase();
  if (name === 'paymentid') return 'pay_sandbox';
  if (name === 'invoiceid') return 'inv_sandbox';
  if (name === 'currency') return 'USD';
  if (name === 'email') return 'sandbox@example.com';
  if (name === 'channel') return 'C_SANDBOX';
  if (name.includes('idempotency') || name === 'eventid' || name === 'client_msg_id') {
    return 'atlas-sandbox-key';
  }
  if (name === 'eventtype') return 'invoice.paid';
  if (name === 'atlasworkflowrunid') return 'sandbox-run';
  if (name === 'firstname') return 'Atlas';
  if (name === 'lastname') return 'Sandbox';
  if (name === 'text') return 'Atlas sandbox test';
  return 'atlas-test';
}

export function generateWorkflowSandboxTests(
  workflow: VersionedCompiledWorkflowVersion,
  contracts: readonly (WorkflowProviderContract & {
    secretAlias?: string | null;
    idempotencyField?: string | null;
  })[],
): WorkflowSandboxTest[] {
  const activities = workflow.executable.steps.filter(isCapabilityStep);
  const forwardActivities = activities.filter((step) => step.kind !== 'compensation');
  const contractByVersion = new Map(
    contracts.map((contract) => [contract.capabilityVersionId, contract]),
  );
  const tests = [test('happy-path', 'The workflow completes using the configured test targets.')];
  if (workflow.executable.irVersion === 3) {
    for (const step of workflow.executable.steps) {
      if (step.kind !== 'condition') continue;
      for (const outcome of [true, false]) {
        tests.push({
          ...test(
            'happy-path',
            `Condition '${step.id}' follows its ${outcome ? 'If' : 'Otherwise'} route.`,
            step.id,
            null,
            conditionRouteSample(workflow.executable, step.id, outcome),
          ),
          testId: `happy-path:${step.id}:${outcome}`,
        });
      }
    }
  }

  for (const step of activities) {
    const isForwardActivity = step.kind !== 'compensation';
    const contract = contractByVersion.get(step.capabilityVersionId);
    const requestSample = (schemaSample(contract?.requestSchema) ?? {}) as Record<string, unknown>;
    const expectedResponseSchema = contract?.responseSchema ?? step.responseSchema ?? null;
    if (isForwardActivity) {
      tests.push(
        test(
          'contract-mapping',
          'The generated request and provider response conform to the pinned schema.',
          step.id,
          step.capabilityVersionId,
          requestSample,
          expectedResponseSchema,
        ),
      );
    }
    if (contract?.secretAlias) {
      tests.push(
        test(
          'authentication',
          'The provider rejects missing credentials and accepts the configured secret reference.',
          step.id,
          step.capabilityVersionId,
          requestSample,
          expectedResponseSchema,
        ),
      );
    }
    if (isForwardActivity && step.retryPolicy) {
      tests.push(
        test(
          'retry',
          'A transient provider failure follows the bounded retry policy.',
          step.id,
          step.capabilityVersionId,
          requestSample,
          expectedResponseSchema,
        ),
        test(
          'rate-limit',
          'Rate limiting follows the bounded retry policy.',
          step.id,
          step.capabilityVersionId,
          requestSample,
          expectedResponseSchema,
        ),
        test(
          'timeout',
          'A provider timeout lands through the declared failure policy.',
          step.id,
          step.capabilityVersionId,
          requestSample,
          expectedResponseSchema,
        ),
      );
    }
    if (isForwardActivity && (step.idempotency || contract?.idempotencyField)) {
      tests.push(
        test(
          'duplicate-event',
          'Repeating the same business event does not repeat the provider side effect.',
          step.id,
          step.capabilityVersionId,
          requestSample,
          expectedResponseSchema,
        ),
      );
    }
    tests.push(
      test(
        'compatibility',
        'The pinned capability fragment remains compatible with the generated request and response.',
        step.id,
        step.capabilityVersionId,
        requestSample,
        expectedResponseSchema,
      ),
    );
  }
  for (const step of forwardActivities.slice(1)) {
    const contract = contractByVersion.get(step.capabilityVersionId);
    const routedErrorTypes = step.errorRouting?.rules.flatMap(({ errorTypes }) => errorTypes) ?? [];
    let unmatchedFailureType = 'SandboxUnmatchedFailure';
    while (routedErrorTypes.includes(unmatchedFailureType)) unmatchedFailureType += '_';
    const failureErrorTypes = step.errorRouting
      ? [...routedErrorTypes, unmatchedFailureType]
      : ['SandboxPartialFailure'];
    for (const failureErrorType of new Set(failureErrorTypes)) {
      tests.push(
        test(
          'partial-failure',
          'A later provider failure preserves or compensates earlier effects as declared.',
          step.id,
          step.capabilityVersionId,
          (schemaSample(contract?.requestSchema) ?? {}) as Record<string, unknown>,
          contract?.responseSchema ?? step.responseSchema ?? null,
          failureErrorType,
        ),
      );
    }
  }
  return tests;
}

function conditionRouteSample(
  workflow: GraphExecutableWorkflow,
  conditionId: string,
  outcome: boolean,
) {
  const steps = new Map(workflow.steps.map((step) => [step.id, step]));
  type Decision = { step: Extract<GraphStep, { kind: 'condition' }>; outcome: boolean };
  let remainingVisits = 1024;
  const findRoute = (
    id: string,
    seen: Set<string>,
    decisions: Decision[],
  ): Decision[] | undefined => {
    if (--remainingVisits < 0 || seen.has(id)) return undefined;
    const step = steps.get(id);
    if (!step) return undefined;
    if (step.id === conditionId && step.kind === 'condition')
      return [...decisions, { step, outcome }];
    const visited = new Set([...seen, id]);
    if (step.kind === 'condition') {
      return (
        findRoute(step.whenTrue, visited, [...decisions, { step, outcome: true }]) ??
        findRoute(step.whenFalse, visited, [...decisions, { step, outcome: false }])
      );
    }
    return 'next' in step ? findRoute(step.next, visited, decisions) : undefined;
  };
  const sample: Record<string, unknown> = {};
  for (const decision of findRoute(workflow.startStepId, new Set(), []) ?? []) {
    const { left, right, operator } = decision.step.condition;
    if (!('source' in left) || left.source !== 'input' || left.path.length === 0) continue;
    if (operator !== 'exists' && (!right || !('source' in right) || right.source !== 'literal'))
      continue;
    const literal =
      right && 'source' in right && right.source === 'literal' ? right.value : undefined;
    let value: unknown;
    if (operator === 'exists') value = decision.outcome ? 'atlas-test' : null;
    else if (operator === 'greaterThan' && typeof literal === 'number')
      value = literal + (decision.outcome ? 1 : -1);
    else if (operator === 'lessThan' && typeof literal === 'number')
      value = literal + (decision.outcome ? -1 : 1);
    else if (operator === 'equals' || operator === 'notEquals') {
      const equal = operator === 'equals' ? decision.outcome : !decision.outcome;
      value = equal
        ? literal
        : typeof literal === 'boolean'
          ? !literal
          : typeof literal === 'number'
            ? literal + 1
            : typeof literal === 'string'
              ? `${literal}-other`
              : literal === null
                ? 'atlas-test'
                : null;
    } else continue;
    const first = left.path[0]!;
    const fieldSchema = workflow.inputSchema?.required[first];
    if (left.path.length > 1 && sample[first] === undefined && fieldSchema)
      sample[first] = graphInputSample(fieldSchema);
    let container = sample;
    for (const segment of left.path.slice(0, -1)) {
      const existing = Object.hasOwn(container, segment)
        ? objectValue(container[segment])
        : undefined;
      const child = existing ?? {};
      Object.defineProperty(container, segment, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      container = child;
    }
    Object.defineProperty(container, left.path.at(-1)!, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return sample;
}

function graphInputSample(schema: ResponseValueSchema): unknown {
  if (schema.type === 'object')
    return Object.fromEntries(
      Object.entries(schema.required).map(([field, child]) => [field, graphInputSample(child)]),
    );
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return true;
  if (schema.type === 'number' || schema.type === 'integer') return 100;
  if (schema.type === 'null') return null;
  return 'atlas-test';
}

async function readProviderContracts(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  workflow: VersionedCompiledWorkflowVersion,
) {
  const capabilityVersionIds = workflow.executionRequirements.requiredCapabilityVersionIds;
  if (capabilityVersionIds.length === 0) return [];
  const result = await pool.query<ContractRow>(
    `SELECT version.capability_version_id, identity.service_id, identity.operation_id,
            source.document_hash, annotation.secret_alias, annotation.idempotency_field,
            annotation.business_semantics, version.capability_fragment,
            source.document #>> '{x-atlas-connection,mode}' AS connection_mode
     FROM capability_versions version
     JOIN capability_identities identity ON identity.id = version.capability_identity_id
     JOIN source_documents source ON source.id = version.source_document_id
     JOIN manifest_annotations annotation ON annotation.id = version.manifest_annotation_id
     WHERE version.organization_id = $1 AND version.capability_version_id = ANY($2::text[])
     ORDER BY identity.service_id, identity.operation_id`,
    [organizationId, capabilityVersionIds],
  );
  if (result.rows.length !== capabilityVersionIds.length) {
    throw new TypeError('Every workflow capability must resolve to a registered provider contract');
  }
  return result.rows.map((row) => {
    const sourceType = row.business_semantics.sourceType;
    const defaultMode = row.connection_mode ?? row.business_semantics.defaultConnectionMode;
    const fragment = row.capability_fragment;
    const operation = objectValue(fragment.operation);
    const requestBody = objectValue(operation?.requestBody);
    const requestContent = objectValue(requestBody?.content);
    const requestMedia = objectValue(requestContent && Object.values(requestContent)[0]);
    const responses = objectValue(operation?.responses);
    const successResponse = responses
      ? Object.entries(responses).find(([status]) => /^2\d\d$/.test(status))?.[1]
      : undefined;
    const responseContent = objectValue(objectValue(successResponse)?.content);
    const responseMedia = objectValue(responseContent && Object.values(responseContent)[0]);
    const asyncPayload = objectValue(objectValue(fragment.message)?.payload);
    const bodySchema = resolveSchema(
      fragment,
      objectValue(requestMedia)?.schema ?? asyncPayload ?? null,
    );
    const parameters = [
      ...(Array.isArray(fragment.pathParameters) ? fragment.pathParameters : []),
      ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
    ];
    const parameterProperties = Object.fromEntries(
      parameters.flatMap((parameter) => {
        const value = objectValue(parameter);
        return typeof value?.name === 'string'
          ? [[value.name, resolveSchema(fragment, value.schema)] as const]
          : [];
      }),
    );
    const resolvedBody = objectValue(bodySchema);
    const requestSchema = {
      type: 'object',
      properties: {
        ...parameterProperties,
        ...(objectValue(resolvedBody?.properties) ?? {}),
      },
      required: [
        ...Object.keys(parameterProperties),
        ...(Array.isArray(resolvedBody?.required) ? resolvedBody.required : []),
      ],
    };
    const responseSchema = resolveSchema(fragment, objectValue(responseMedia)?.schema ?? null);
    return {
      capabilityVersionId: row.capability_version_id.trim(),
      serviceId: row.service_id,
      operationId: row.operation_id,
      documentHash: row.document_hash.trim(),
      provider:
        typeof row.business_semantics.provider === 'string'
          ? row.business_semantics.provider
          : row.service_id,
      mode:
        sourceType === 'third-party' && defaultMode === 'official-test'
          ? ('official-test' as const)
          : sourceType === 'third-party'
            ? ('contract-faithful-rehearsal' as const)
            : ('local' as const),
      method: typeof fragment.method === 'string' ? fragment.method : 'post',
      path:
        typeof fragment.path === 'string'
          ? fragment.path
          : typeof objectValue(fragment.channel)?.address === 'string'
            ? `/events/${String(objectValue(fragment.channel)?.address)}`
            : null,
      requestSchema,
      responseSchema,
      secretAlias: row.secret_alias,
      idempotencyField: row.idempotency_field,
    };
  });
}

function publicProviderContracts(
  contracts: readonly (WorkflowProviderContract & {
    secretAlias?: string | null;
    idempotencyField?: string | null;
  })[],
) {
  return contracts.map(({ secretAlias: _secret, ...contract }) => contract);
}

function legacyExecutionMethodsForTest(
  generated: WorkflowSandboxTest,
): WorkflowSandboxExecutionMethod[] {
  if (generated.kind === 'compatibility') return ['static-validation'];
  // Old rows predate observed method evidence. Never infer live connectivity from configuration.
  return ['local-test-service'];
}

function sandboxSuiteFingerprint(
  providerContracts: readonly WorkflowProviderContract[],
  tests: readonly WorkflowSandboxTest[],
  targetBindings: readonly ReturnType<typeof publicTargetBinding>[] = [],
) {
  return sha256(canonicalJson({ providerContracts, tests, targetBindings }));
}

export async function runWorkflowSandboxTests(
  pool: Pool,
  executor: WorkflowSandboxExecutor,
  request: Omit<z.infer<typeof workflowSandboxRequestSchema>, 'targetSelections'> & {
    readonly targetSelections?: z.infer<typeof workflowSandboxRequestSchema>['targetSelections'];
  },
  testedBy: string,
  signal?: AbortSignal,
  onProgress?: (progress: WorkflowSandboxProgressWire) => void,
) {
  signal?.throwIfAborted();
  onProgress?.({ phase: 'preparing', completed: 0, total: 0 });
  const parsed = versionedCompiledWorkflowVersionSchema.parse(request.draft);
  const workflow = await verifyCompiledWorkflowVersionIntegrity(parsed);
  if (workflow.executionRequirements.organizationId !== request.organizationId) {
    throw new TypeError('Workflow organization does not match the sandbox test scope');
  }
  const contracts = await readProviderContracts(pool, request.organizationId, workflow);
  const targetBindings = await resolveSandboxTargetBindings(
    pool,
    request.organizationId,
    request.environmentId,
    request.targetSelections?.length
      ? request.targetSelections
      : await defaultConnectedSandboxSelections(
          pool,
          request.organizationId,
          request.environmentId,
          workflow.executionRequirements.requiredCapabilityVersionIds,
        ),
  );
  const workflowCapabilities = new Set(workflow.executionRequirements.requiredCapabilityVersionIds);
  if (
    targetBindings.some(({ capabilityVersionId }) => !workflowCapabilities.has(capabilityVersionId))
  ) {
    throw new TypeError('Sandbox target does not belong to the compiled workflow');
  }
  const tests = generateWorkflowSandboxTests(workflow, contracts);
  signal?.throwIfAborted();
  onProgress?.({ phase: 'preparing', completed: 0, total: tests.length });
  onProgress?.({ phase: 'running', completed: 0, total: tests.length });
  const outcomes = await executor.execute({
    organizationId: request.organizationId,
    environmentId: request.environmentId,
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    workflow,
    providerContracts: contracts,
    tests,
    targetBindings,
    ...(signal ? { signal } : {}),
    ...(onProgress
      ? {
          onProgress: (progress: WorkflowSandboxProgressWire) => {
            // Finalizing means the backend has checked the complete runner evidence.
            if (progress.phase !== 'finalizing') onProgress(progress);
          },
        }
      : {}),
  });
  signal?.throwIfAborted();
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.testId, outcome]));
  if (
    outcomes.length !== tests.length ||
    outcomeById.size !== outcomes.length ||
    tests.some(({ testId }) => !outcomeById.has(testId))
  ) {
    throw new TypeError('Workflow check runner returned incomplete or unexpected results');
  }
  for (const outcome of outcomes) {
    const generated = tests.find(({ testId }) => testId === outcome.testId)!;
    const expectedTargetEvidence = targetBindings
      .filter(
        ({ capabilityVersionId }) =>
          generated.kind === 'happy-path' || generated.capabilityVersionId === capabilityVersionId,
      )
      .map(workflowSandboxTargetEvidence);
    if (
      expectedTargetEvidence.length > 0 &&
      generated.kind !== 'compatibility' &&
      outcome.status === 'passed' &&
      (!outcome.executionMethods.includes('remote-sandbox') ||
        !outcome.temporalWorkflowId ||
        !outcome.temporalRunId ||
        canonicalJson(outcome.targetEvidence ?? []) !== canonicalJson(expectedTargetEvidence))
    ) {
      throw new TypeError('Remote sandbox passed without exact worker and Temporal evidence');
    }
  }
  const providerContracts = publicProviderContracts(contracts);
  const completedTests = tests.map((generated) => ({
    ...generated,
    ...outcomeById.get(generated.testId)!,
  }));
  const status = completedTests.every((result) => result.status === 'passed')
    ? ('passed' as const)
    : ('failed' as const);
  const publicTargetBindings = targetBindings.map(publicTargetBinding);
  const suiteFingerprint = sandboxSuiteFingerprint(providerContracts, tests, publicTargetBindings);
  const runtimeBinding = completedTests[0]!;
  if (
    completedTests.some(
      ({ workerVersion, runtimeVersion }) =>
        workerVersion !== runtimeBinding.workerVersion ||
        runtimeVersion !== runtimeBinding.runtimeVersion,
    )
  ) {
    throw new TypeError('Workflow check runner returned inconsistent worker or runtime versions');
  }
  const testedAt = new Date().toISOString();
  onProgress?.({ phase: 'finalizing', completed: tests.length, total: tests.length });
  const setupBinding: WorkflowSandboxSetupBinding = {
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    capabilityVersions: contracts.map(({ capabilityVersionId, documentHash, secretAlias }) => ({
      capabilityVersionId,
      sourceDocumentHash: documentHash,
      secretAlias: secretAlias ?? null,
    })),
    suiteFingerprint,
    targets: publicTargetBindings,
    workerVersion: runtimeBinding.workerVersion,
    runtimeVersion: runtimeBinding.runtimeVersion,
    executionMethods: [
      ...new Set(completedTests.flatMap(({ executionMethods }) => executionMethods)),
    ].sort(),
    environmentId: request.environmentId,
    testedAt,
  };
  const inserted = await pool.query<{ id: string; tested_at: Date }>(
    `INSERT INTO workflow_sandbox_test_runs
      (organization_id, environment_id, workflow_version_id, ir_hash, suite_fingerprint, status,
       provider_contracts, tests, target_bindings, tested_by, tested_at, setup_binding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, tested_at`,
    [
      request.organizationId,
      request.environmentId,
      workflow.workflowVersionId,
      workflow.irHash,
      suiteFingerprint,
      status,
      JSON.stringify(providerContracts),
      JSON.stringify(completedTests),
      JSON.stringify(publicTargetBindings),
      testedBy,
      testedAt,
      JSON.stringify(setupBinding),
    ],
  );
  if (signal?.aborted) {
    await pool.query('DELETE FROM workflow_sandbox_test_runs WHERE id = $1', [
      inserted.rows[0]!.id,
    ]);
    signal.throwIfAborted();
  }
  await recordWorkflowLifecycle(pool, {
    organizationId: request.organizationId,
    environmentId: request.environmentId,
    workflowVersionId: workflow.workflowVersionId,
    status: status === 'failed' ? 'blocked' : 'awaiting-approval',
    observedAt: testedAt,
  });
  return {
    testRunId: inserted.rows[0]!.id,
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    suiteFingerprint,
    status,
    providerContracts,
    tests: completedTests,
    targetBindings: publicTargetBindings,
    setupBinding,
    testedBy,
    testedAt: inserted.rows[0]!.tested_at.toISOString(),
  };
}

function publicTargetBinding(binding: WorkflowSandboxTargetBinding) {
  const {
    inputs: _inputs,
    setupAssumptions: _assumptions,
    targetState: _targetState,
    baseUrl: _baseUrl,
    ...publicBinding
  } = binding;
  return publicBinding;
}

export async function readWorkflowSandboxReadiness(
  pool: Pick<Pool, 'query'>,
  query: z.infer<typeof workflowSandboxReadinessQuerySchema>,
) {
  const automatic = await pool.query<{
    id: string;
    status: 'queued' | 'running' | 'passed' | 'failed' | 'unavailable';
    trigger: 'capability-rediscovery' | 'expiration';
    trigger_detail: Record<string, unknown>;
    unavailable_reason: string | null;
    queued_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
  }>(
    `SELECT id, status, trigger, trigger_detail, unavailable_reason,
            queued_at, started_at, completed_at
     FROM workflow_sandbox_retest_jobs
     WHERE organization_id = $1 AND environment_id = $2
       AND workflow_version_id = $3 AND ir_hash = $4
       AND status IN ('queued', 'running', 'unavailable')
       AND NOT EXISTS (
         SELECT 1 FROM workflow_sandbox_test_runs run
         WHERE run.organization_id = workflow_sandbox_retest_jobs.organization_id
           AND run.environment_id = workflow_sandbox_retest_jobs.environment_id
           AND run.workflow_version_id = workflow_sandbox_retest_jobs.workflow_version_id
           AND run.ir_hash = workflow_sandbox_retest_jobs.ir_hash
           AND run.tested_at > workflow_sandbox_retest_jobs.queued_at
       )
     ORDER BY queued_at DESC, id DESC LIMIT 1`,
    [query.organizationId, query.environmentId, query.workflowVersionId, query.irHash],
  );
  const automaticRun = automatic.rows[0];
  if (automaticRun && ['queued', 'running', 'unavailable'].includes(automaticRun.status)) {
    return {
      ready: false,
      status: automaticRun.status as 'queued' | 'running' | 'unavailable',
      suiteFingerprint: null,
      testRunId: null,
      providerContracts: [],
      tests: [],
      targetBindings: [],
      setupBinding: null,
      staleDiagnostics: [],
      testedBy: null,
      testedAt: null,
      automaticRetest: {
        jobId: automaticRun.id,
        trigger: automaticRun.trigger,
        triggerDetail: automaticRun.trigger_detail,
        queuedAt: automaticRun.queued_at.toISOString(),
        startedAt: automaticRun.started_at?.toISOString() ?? null,
        completedAt: automaticRun.completed_at?.toISOString() ?? null,
        unavailableReason: automaticRun.unavailable_reason,
      },
    };
  }
  const exact = await pool.query<{
    id: string;
    status: 'passed' | 'failed';
    provider_contracts: WorkflowProviderContract[];
    tests: Array<
      WorkflowSandboxTest & {
        status: 'passed' | 'failed';
        detail?: string;
        executionMethods?: WorkflowSandboxExecutionMethod[];
      }
    >;
    tested_by: string;
    tested_at: Date;
    suite_fingerprint: string;
    target_bindings: ReturnType<typeof publicTargetBinding>[];
    setup_binding: WorkflowSandboxSetupBinding | null;
    stale_at: Date | null;
    stale_trigger: Record<string, unknown> | null;
  }>(
    `SELECT id, status, suite_fingerprint, provider_contracts, tests, target_bindings, setup_binding,
            stale_at, stale_trigger, tested_by, tested_at
     FROM workflow_sandbox_test_runs
     WHERE organization_id = $1 AND environment_id = $2
       AND workflow_version_id = $3 AND ir_hash = $4
     ORDER BY tested_at DESC, id DESC LIMIT 1`,
    [query.organizationId, query.environmentId, query.workflowVersionId, query.irHash],
  );
  const run = exact.rows[0];
  if (run) {
    return {
      ready: run.status === 'passed' && !run.stale_at,
      status: run.stale_at ? ('stale' as const) : run.status,
      suiteFingerprint: run.suite_fingerprint.trim(),
      testRunId: run.id,
      providerContracts: run.provider_contracts,
      tests: run.tests.map((testResult) => ({
        ...testResult,
        executionMethods: testResult.executionMethods ?? legacyExecutionMethodsForTest(testResult),
      })),
      targetBindings: run.target_bindings,
      setupBinding: run.setup_binding,
      staleDiagnostics: run.stale_at
        ? [
            {
              part: 'contract' as const,
              message:
                'Capability rediscovery or the result expiration policy made this result stale. Atlas queued new generated tests.',
            },
          ]
        : [],
      staleTrigger: run.stale_trigger,
      testedBy: run.tested_by,
      testedAt: run.tested_at.toISOString(),
    };
  }
  const otherArtifact = await pool.query(
    `SELECT 1 FROM workflow_sandbox_test_runs
     WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3
     LIMIT 1`,
    [query.organizationId, query.environmentId, query.workflowVersionId],
  );
  return {
    ready: false,
    status: otherArtifact.rows[0] ? ('stale' as const) : ('missing' as const),
    suiteFingerprint: null,
    testRunId: null,
    providerContracts: [],
    tests: [],
    targetBindings: [],
    setupBinding: null,
    staleDiagnostics: otherArtifact.rows[0]
      ? [
          {
            part: 'artifact' as const,
            message: 'The workflow artifact changed. Rerun the generated tests before approval.',
          },
        ]
      : [],
    testedBy: null,
    testedAt: null,
  };
}

export function workflowRequiresSandboxTests(workflow: VersionedCompiledWorkflowVersion) {
  return (
    workflow.executable.irVersion === 3 ||
    workflow.executable.steps.some((step) => step.kind !== 'terminal')
  );
}

export async function requirePassingWorkflowSandboxTests(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string },
  workflow: VersionedCompiledWorkflowVersion,
) {
  if (!workflowRequiresSandboxTests(workflow)) return;
  const readiness = await readWorkflowSandboxReadinessForArtifact(pool, scope, workflow);
  if (!readiness.ready) {
    throw new WorkflowSandboxTestsUnavailable(
      readiness.status === 'passed' ? 'failed' : readiness.status,
    );
  }
}

export async function readWorkflowSandboxReadinessForArtifact(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string },
  workflow: VersionedCompiledWorkflowVersion,
) {
  const readiness = await readWorkflowSandboxReadiness(pool, {
    ...scope,
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
  });
  if (!readiness.ready) return readiness;
  if (!readiness.setupBinding) {
    return {
      ...readiness,
      ready: false as const,
      status: 'stale' as const,
      staleDiagnostics: [
        {
          part: 'runtime' as const,
          message:
            'The historical result does not identify its worker and runtime. Rerun the generated tests before approval.',
        },
      ],
    };
  }
  if (readiness.suiteFingerprint !== readiness.setupBinding.suiteFingerprint) {
    return {
      ...readiness,
      ready: false as const,
      status: 'stale' as const,
      staleDiagnostics: [
        {
          part: 'artifact' as const,
          message:
            'The stored generated-suite fingerprint no longer matches its setup binding. Rerun the generated tests before approval.',
        },
      ],
    };
  }
  const contracts = await readProviderContracts(pool, scope.organizationId, workflow);
  const providerContracts = publicProviderContracts(contracts);
  const tests = generateWorkflowSandboxTests(workflow, contracts);
  try {
    const latestSelections = await Promise.all(
      readiness.targetBindings.map(async (binding) => {
        const [target, profile] = await Promise.all([
          pool.query<{ revision: number }>(
            `SELECT revision FROM capability_sandbox_target_revisions
             WHERE organization_id = $1 AND capability_version_id = $2 AND target_key = $3
             ORDER BY revision DESC LIMIT 1`,
            [scope.organizationId, binding.capabilityVersionId, binding.targetKey],
          ),
          pool.query<{ version: number }>(
            `SELECT version FROM capability_test_data_profile_versions
             WHERE organization_id = $1 AND capability_version_id = $2 AND profile_key = $3
             ORDER BY version DESC LIMIT 1`,
            [scope.organizationId, binding.capabilityVersionId, binding.testDataProfileKey],
          ),
        ]);
        return {
          ...workflowSandboxTargetEvidence(binding),
          targetRevision: target.rows[0]?.revision ?? binding.targetRevision,
          testDataVersion: profile.rows[0]?.version ?? binding.testDataVersion,
        };
      }),
    );
    const currentBindings = await resolveSandboxTargetBindings(
      pool,
      scope.organizationId,
      scope.environmentId,
      latestSelections,
    );
    const expectedFingerprint = sandboxSuiteFingerprint(
      providerContracts,
      tests,
      readiness.targetBindings,
    );
    const currentTargets = currentBindings.map(publicTargetBinding);
    const currentExecutionMethods = [
      ...new Set(
        tests.map(({ kind, capabilityVersionId }) => {
          if (kind === 'compatibility') return 'static-validation' as const;
          const usesRemoteTarget = currentTargets.some(
            (target) => kind === 'happy-path' || target.capabilityVersionId === capabilityVersionId,
          );
          return usesRemoteTarget ? ('remote-sandbox' as const) : ('local-test-service' as const);
        }),
      ),
    ].sort();
    const currentSetup: WorkflowSandboxSetupBinding = {
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      capabilityVersions: contracts.map(({ capabilityVersionId, documentHash, secretAlias }) => ({
        capabilityVersionId,
        sourceDocumentHash: documentHash,
        secretAlias: secretAlias ?? null,
      })),
      suiteFingerprint: expectedFingerprint,
      targets: currentTargets,
      workerVersion: workflowSandboxWorkerVersion,
      runtimeVersion: workflowSandboxRuntimeVersion,
      executionMethods: currentExecutionMethods,
      environmentId: scope.environmentId,
      testedAt: readiness.setupBinding.testedAt,
    };
    const staleDiagnostics = sandboxSetupStaleDiagnostics(readiness.setupBinding, currentSetup);
    return staleDiagnostics.length === 0
      ? readiness
      : {
          ...readiness,
          ready: false as const,
          status: 'stale' as const,
          staleDiagnostics,
        };
  } catch (error) {
    if (error instanceof InvalidSandboxTarget) {
      return {
        ...readiness,
        ready: false as const,
        status: 'stale' as const,
        staleDiagnostics: [
          {
            part: 'target' as const,
            message:
              'A provider target or test-data profile changed. Rerun the generated tests before approval.',
          },
        ],
      };
    }
    throw error;
  }
}
