import { ActivityFailure, ApplicationFailure } from '@temporalio/common';
import { proxyActivities, workflowInfo, sleep, CancellationScope } from '@temporalio/workflow';

import {
  DEFAULT_STEP_MAXIMUM_ATTEMPTS,
  validateWorkflowInput,
  validateCompiledWorkflowStructure,
  WORKFLOW_STEP_START_TO_CLOSE_TIMEOUT,
} from '@atlas/workflow-ir';
import type {
  CompiledStep,
  FailureAction,
  JsonValue,
  ResponseSchema,
  RetryPolicy,
  TransformationExpression,
  TransformationStep,
  ValueReference,
  VersionedCompiledWorkflowVersion,
  GraphStep,
  GraphExecutableWorkflow,
  CapabilityStep,
} from '@atlas/workflow-ir';
import {
  UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE,
  type DriftSignal,
  type StepActivities,
} from '@atlas/runtime-ports';
import {
  evaluateTransformationArguments,
  TransformationEvaluationError,
  evaluateGraphCondition,
  evaluateTransformationExpression,
} from '@atlas/transformation-runtime';

export interface InterpreterInput {
  readonly lifecycle?: { readonly workflowName: string };
  /** Used only by the worker's internal checks; keeps durable timer commands. */
  readonly sandboxTimers?: boolean;
  readonly returnFinalOutput?: boolean;
  readonly workflow: VersionedCompiledWorkflowVersion;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly approvedHostnames?: readonly string[];
}

export type InterpreterFailureBucket =
  | 'retryable-transient'
  | 'permanent-validation'
  | 'permanent-operational';

export interface InterpreterFailure {
  readonly bucket: InterpreterFailureBucket;
  readonly type: string;
  readonly stepId: string;
}

export interface InterpreterResult {
  readonly visitedStepIds?: readonly string[];
  readonly output?: Readonly<Record<string, JsonValue>>;
  readonly state: Extract<CompiledStep, { kind: 'terminal' }>['state'];
  readonly failure?: InterpreterFailure;
  readonly driftSignals?: readonly DriftSignal[];
}

export interface RunStarted {
  readonly runId: string;
  readonly workflowName: string;
  readonly occurredAt: string;
}

export interface WorkflowRunOutcome extends RunStarted {
  readonly durationMs: number;
  readonly state: InterpreterResult['state'];
  readonly failure?: InterpreterFailure;
}

export interface RunReporter {
  recordRunStarted(input: RunStarted): Promise<void>;
  recordRunOutcome(input: WorkflowRunOutcome): Promise<void>;
}

type AnyStep = CompiledStep | TransformationStep | GraphStep;
type ActivityStep = CapabilityStep;
type CompensationStep = Extract<AnyStep, { kind: 'compensation' }>;
type StepOutputs = Record<string, Readonly<Record<string, JsonValue>>>;

interface StableIdActivities {
  deriveStableId(namespace: string, parts: readonly JsonValue[]): Promise<string>;
}

interface DriftActivities {
  emitDriftSignal(signal: DriftSignal): Promise<void>;
}

function readPath(value: JsonValue | undefined, path: readonly string[]): JsonValue {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new TypeError(`Cannot read ${path.join('.')} from workflow context`);
    }
    current = current[segment];
  }
  if (current === undefined) {
    throw new TypeError(`Workflow context has no value at ${path.join('.')}`);
  }
  return current;
}

function resolveReference(
  reference: ValueReference,
  input: Readonly<Record<string, JsonValue>>,
  outputs: Readonly<StepOutputs>,
): JsonValue {
  switch (reference.source) {
    case 'input':
      return readPath(input, reference.path);
    case 'stepOutput':
      return readPath(outputs[reference.stepId], reference.path);
    case 'literal':
      return reference.value;
  }
}

function resolveArguments(
  step: Exclude<CompiledStep, { kind: 'terminal' }>,
  input: Readonly<Record<string, JsonValue>>,
  outputs: Readonly<StepOutputs>,
): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(step.arguments).map(([name, reference]) => [
      name,
      resolveReference(reference, input, outputs),
    ]),
  );
}

function resolveTransformationArguments(
  step: Exclude<TransformationStep, { kind: 'terminal' }>,
  input: Readonly<Record<string, JsonValue>>,
  outputs: Readonly<StepOutputs>,
) {
  try {
    const transformed = evaluateTransformationArguments(step.arguments, {
      input,
      stepOutputs: outputs,
    });
    const issues = validateWorkflowInput(transformed, step.inputSchema);
    if (issues.length > 0) {
      throw new TransformationEvaluationError(
        'TRANSFORM_POLICY_VIOLATION',
        `Transformed payload failed its pinned input schema at ${issues[0]!.path}: ${issues[0]!.message}`,
      );
    }
    return transformed;
  } catch (error) {
    if (error instanceof TransformationEvaluationError) {
      throw ApplicationFailure.nonRetryable(error.message, error.code);
    }
    throw error;
  }
}

function resolveStepInput(
  interpreterInput: InterpreterInput,
  step: ActivityStep,
  outputs: Readonly<StepOutputs>,
) {
  return interpreterInput.workflow.executable.irVersion === 1
    ? resolveArguments(
        step as Exclude<CompiledStep, { kind: 'terminal' }>,
        interpreterInput.input,
        outputs,
      )
    : resolveTransformationArguments(
        step as Exclude<TransformationStep, { kind: 'terminal' }>,
        interpreterInput.input,
        outputs,
      );
}

type OutputProjection = readonly (readonly string[])[];

function stepOutputProjection(
  interpreterInput: InterpreterInput,
  step: ActivityStep,
  stepIndex: number,
): OutputProjection | undefined {
  const next = interpreterInput.workflow.executable.steps
    .slice(stepIndex + 1)
    .find((candidate) => candidate.kind !== 'compensation');
  // The API caller needs the complete final response, including fields no later step reads.
  if (interpreterInput.returnFinalOutput && (!next || next.kind === 'terminal')) return undefined;
  return interpreterInput.workflow.executable.irVersion === 2
    ? collectOutputProjection(
        step.id,
        interpreterInput.workflow.executable.steps.slice(stepIndex + 1),
      )
    : undefined;
}

async function invokeActivityStep(
  interpreterInput: InterpreterInput,
  step: ActivityStep,
  outputs: Readonly<StepOutputs>,
  outputProjection: OutputProjection | undefined,
) {
  const resolvedInput = resolveStepInput(interpreterInput, step, outputs);
  const idempotencyKey = step.idempotency
    ? await stableIdActivities().deriveStableId('atlas.idempotency', [
        step.id,
        resolveReference(step.idempotency.businessKey, interpreterInput.input, outputs),
      ])
    : undefined;
  return activitiesWithRetryPolicy(step.retryPolicy).invokeStep({
    runId: workflowInfo().workflowId,
    stepId: step.id,
    capabilityVersionId: step.capabilityVersionId,
    input: idempotencyKey === undefined ? resolvedInput : { ...resolvedInput, idempotencyKey },
    ...(interpreterInput.approvedHostnames
      ? { approvedHostnames: interpreterInput.approvedHostnames }
      : {}),
    ...(outputProjection ? { outputProjection } : {}),
  });
}

export async function interpretCompiledWorkflow(
  interpreterInput: InterpreterInput,
): Promise<InterpreterResult> {
  // Existing and sandbox executions have no lifecycle setting. Their command history
  // remains unchanged; new production runs persist reporting as retried activities.
  if (!interpreterInput.lifecycle) return executeWorkflow(interpreterInput);
  const reporter = proxyActivities<RunReporter>({
    startToCloseTimeout: '30 seconds',
    retry: { initialInterval: '1 second', maximumInterval: '30 seconds' },
  });
  const startedAt = workflowInfo().startTime.getTime();
  const identity = {
    runId: workflowInfo().workflowId,
    workflowName: interpreterInput.lifecycle.workflowName,
  };
  await reporter.recordRunStarted({ ...identity, occurredAt: new Date(startedAt).toISOString() });
  let result: InterpreterResult;
  try {
    result = await executeWorkflow(interpreterInput);
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      reporter.recordRunOutcome({
        ...identity,
        state: 'repair_required',
        occurredAt: new Date().toISOString(),
        durationMs: Math.max(0, Date.now() - startedAt),
      }),
    );
    throw error;
  }
  await reporter.recordRunOutcome({
    ...identity,
    state: result.state,
    ...(result.failure ? { failure: result.failure } : {}),
    occurredAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  return result;
}

async function executeWorkflow(interpreterInput: InterpreterInput): Promise<InterpreterResult> {
  if (interpreterInput.workflow.executable.irVersion === 3) {
    return interpretGraphWorkflow(interpreterInput, interpreterInput.workflow.executable);
  }
  const steps: readonly (CompiledStep | TransformationStep)[] =
    interpreterInput.workflow.executable.steps;
  const outputs: StepOutputs = {};
  const compensationsByStep = new Map<string, CompensationStep[]>();
  for (const step of steps) {
    if (step.kind !== 'compensation') continue;
    const compensations = compensationsByStep.get(step.compensatesStepId) ?? [];
    compensations.push(step);
    compensationsByStep.set(step.compensatesStepId, compensations);
  }
  // Compensations for completed steps, in completion order; unwound last-in, first-out.
  let sagaStack: CompensationStep[] = [];
  const driftSignals: DriftSignal[] = [];
  const revalidations = new Map<string, number>();
  let compensationDisabled = false;

  let stepIndex = 0;
  let finalOutput: Readonly<Record<string, JsonValue>> | undefined;
  while (stepIndex < steps.length) {
    const step = steps[stepIndex]!;
    if (step.kind === 'terminal') {
      return withDrift(
        {
          state: step.state,
          ...(step.state === 'completed' &&
          interpreterInput.returnFinalOutput &&
          finalOutput !== undefined
            ? { output: finalOutput }
            : {}),
        },
        driftSignals,
      );
    }
    if (step.kind === 'compensation') {
      stepIndex += 1;
      continue;
    }

    const outputProjection = stepOutputProjection(interpreterInput, step, stepIndex);
    let result: Readonly<Record<string, JsonValue>>;
    try {
      result = await invokeActivityStep(interpreterInput, step, outputs, outputProjection);
    } catch (error) {
      if (!isActivityFailure(error)) throw error;
      const failureType = applicationFailureType(error);
      const routed = await routeFailure({
        interpreterInput,
        steps,
        step,
        failureType,
        outputs,
        sagaStack,
        compensationDisabled,
        revalidations,
      });
      if (routed.kind === 'revalidate') {
        stepIndex = routed.fromIndex;
        sagaStack = routed.sagaStack;
        continue;
      }
      return withDrift(routed.result, driftSignals);
    }

    if (step.irreversibleAfter) compensationDisabled = true;
    if (
      step.responseSchema &&
      !matchesResponseSchema(result, narrowToProjection(step.responseSchema, outputProjection))
    ) {
      const driftSignal = { stepId: step.id, capabilityVersionId: step.capabilityVersionId };
      await driftActivities().emitDriftSignal(driftSignal);
      driftSignals.push(driftSignal);
      const routed = await routeFailure({
        interpreterInput,
        steps,
        step,
        failureType: 'ResponseSchemaMismatch',
        outputs,
        sagaStack,
        compensationDisabled,
        revalidations,
      });
      if (routed.kind === 'revalidate') {
        stepIndex = routed.fromIndex;
        sagaStack = routed.sagaStack;
        continue;
      }
      return withDrift(routed.result, driftSignals);
    }

    outputs[step.id] = result;
    finalOutput = result;
    sagaStack.push(...(compensationsByStep.get(step.id) ?? []));
    stepIndex += 1;
  }

  return withDrift(
    {
      state: 'completed',
      ...(interpreterInput.returnFinalOutput && finalOutput !== undefined
        ? { output: finalOutput }
        : {}),
    },
    driftSignals,
  );
}

async function interpretGraphWorkflow(
  interpreterInput: InterpreterInput,
  executable: GraphExecutableWorkflow,
): Promise<InterpreterResult> {
  const issues = validateCompiledWorkflowStructure(executable);
  if (issues.length)
    throw ApplicationFailure.nonRetryable(issues[0]!.message, 'InvalidWorkflowGraph');
  const steps = executable.steps;
  const byId = new Map(steps.map((step) => [step.id, step]));
  const outputs: StepOutputs = {};
  const compensationsByStep = new Map<string, CompensationStep[]>();
  for (const step of steps) {
    if (step.kind !== 'compensation') continue;
    compensationsByStep.set(step.compensatesStepId, [
      ...(compensationsByStep.get(step.compensatesStepId) ?? []),
      step,
    ]);
  }
  let sagaStack: CompensationStep[] = [];
  const driftSignals: DriftSignal[] = [];
  const visitedStepIds: string[] = [];
  const revalidations = new Map<string, number>();
  let compensationDisabled = false;
  let current = executable.startStepId;
  let finalOutput: Readonly<Record<string, JsonValue>> | undefined;
  const context = { input: interpreterInput.input, stepOutputs: outputs };
  const finish = (result: InterpreterResult) =>
    withDrift({ ...result, visitedStepIds }, driftSignals);
  while (true) {
    const step = byId.get(current)!;
    visitedStepIds.push(step.id);
    if (step.kind === 'terminal') {
      if (step.output) {
        const value = evaluateBuiltin(() =>
          evaluateTransformationExpression(step.output!, context),
        );
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw ApplicationFailure.nonRetryable(
            'Finish output must be an object',
            'TRANSFORM_POLICY_VIOLATION',
          );
        }
        finalOutput = value;
      }
      return finish({
        state: step.state,
        ...(step.state === 'completed' &&
        interpreterInput.returnFinalOutput &&
        finalOutput !== undefined
          ? { output: finalOutput }
          : {}),
      });
    }
    if (step.kind === 'condition') {
      current = evaluateBuiltin(() => evaluateGraphCondition(step.condition, context))
        ? step.whenTrue
        : step.whenFalse;
      continue;
    }
    if (step.kind === 'sleep') {
      await sleep(interpreterInput.sandboxTimers ? Math.min(step.durationMs, 1) : step.durationMs);
      current = step.next;
      continue;
    }
    if (step.kind === 'transform') {
      const result = evaluateBuiltin(() =>
        evaluateTransformationArguments(step.arguments, context),
      );
      const failures = validateWorkflowInput(result, step.responseSchema);
      if (failures.length)
        throw ApplicationFailure.nonRetryable(
          `Transform output failed its schema: ${failures[0]!.message}`,
          'TRANSFORM_POLICY_VIOLATION',
        );
      outputs[step.id] = result;
      finalOutput = result;
      current = step.next;
      continue;
    }
    if (step.kind === 'compensation')
      throw ApplicationFailure.nonRetryable(
        'Compensation cannot be an ordinary route',
        'InvalidWorkflowGraph',
      );
    let result: Readonly<Record<string, JsonValue>>;
    let failureType: string | undefined;
    try {
      // Graph inputs can read any guaranteed ancestor, regardless of array order.
      result = await invokeActivityStep(interpreterInput, step, outputs, undefined);
      if (step.irreversibleAfter) compensationDisabled = true;
      if (step.responseSchema && !matchesResponseSchema(result, step.responseSchema)) {
        const signal = { stepId: step.id, capabilityVersionId: step.capabilityVersionId };
        await driftActivities().emitDriftSignal(signal);
        driftSignals.push(signal);
        failureType = 'ResponseSchemaMismatch';
      }
    } catch (error) {
      if (!isActivityFailure(error)) throw error;
      failureType = applicationFailureType(error);
    }
    if (failureType) {
      const routed = await routeFailure({
        interpreterInput,
        steps,
        step,
        failureType,
        outputs,
        sagaStack,
        compensationDisabled,
        revalidations,
      });
      if (routed.kind === 'revalidate') {
        current = steps[routed.fromIndex]!.id;
        sagaStack = routed.sagaStack;
        finalOutput = Object.values(outputs).at(-1);
        continue;
      }
      return finish(routed.result);
    }
    outputs[step.id] = result!;
    finalOutput = result!;
    sagaStack.push(...(compensationsByStep.get(step.id) ?? []));
    current = step.next;
  }
}

function evaluateBuiltin<T>(evaluate: () => T): T {
  try {
    return evaluate();
  } catch (error) {
    if (error instanceof TransformationEvaluationError)
      throw ApplicationFailure.nonRetryable(error.message, error.code);
    throw error;
  }
}

function withDrift(result: InterpreterResult, driftSignals: readonly DriftSignal[]) {
  return driftSignals.length > 0 ? { ...result, driftSignals } : result;
}

type RoutedFailure =
  | { readonly kind: 'terminal'; readonly result: InterpreterResult }
  | {
      readonly kind: 'revalidate';
      readonly fromIndex: number;
      readonly sagaStack: CompensationStep[];
    };

async function routeFailure(context: {
  readonly interpreterInput: InterpreterInput;
  readonly steps: readonly AnyStep[];
  readonly step: ActivityStep;
  readonly failureType: string;
  readonly outputs: StepOutputs;
  readonly sagaStack: CompensationStep[];
  readonly compensationDisabled: boolean;
  readonly revalidations: Map<string, number>;
}): Promise<RoutedFailure> {
  const { step, failureType } = context;
  const routing = step.errorRouting;
  const action =
    routing?.rules.find(({ errorTypes }) => errorTypes.includes(failureType))?.action ??
    routing?.defaultAction;
  if (!action) {
    return {
      kind: 'terminal',
      result: await legacyTerminalFailure(context),
    };
  }
  return applyFailureAction(context, action);
}

async function applyFailureAction(
  context: Parameters<typeof routeFailure>[0],
  action: FailureAction,
): Promise<RoutedFailure> {
  const { step, failureType } = context;
  if (action.kind === 'revalidateFrom') {
    const key = `${step.id}->${action.targetStepId}`;
    const used = context.revalidations.get(key) ?? 0;
    const targetIndex = context.steps.findIndex(({ id }) => id === action.targetStepId);
    if (used < action.maxRevalidations && targetIndex >= 0) {
      context.revalidations.set(key, used + 1);
      const rerunIds =
        context.interpreterInput.workflow.executable.irVersion === 3
          ? graphDescendants(context.interpreterInput.workflow.executable, action.targetStepId)
          : new Set(
              context.steps
                .slice(targetIndex)
                .flatMap((candidate) =>
                  candidate.kind === 'terminal' || candidate.kind === 'compensation'
                    ? []
                    : [candidate.id],
                ),
            );
      for (const stepId of rerunIds) delete context.outputs[stepId];
      return {
        kind: 'revalidate',
        fromIndex: targetIndex,
        sagaStack: context.sagaStack.filter(
          ({ compensatesStepId }) => !rerunIds.has(compensatesStepId),
        ),
      };
    }
    return applyFailureAction(context, action.onExhausted);
  }

  const bucket = failureBucket(step, failureType);
  if (action.kind === 'compensateThenLand' && !context.compensationDisabled) {
    try {
      await unwindSaga(context.sagaStack, context.interpreterInput, context.outputs);
    } catch {
      return {
        kind: 'terminal',
        result: {
          state: 'repair_required',
          failure: { bucket: 'permanent-operational', type: 'CompensationFailed', stepId: step.id },
        },
      };
    }
  }
  return {
    kind: 'terminal',
    result: { state: action.outcome, failure: { bucket, type: failureType, stepId: step.id } },
  };
}

function graphDescendants(executable: GraphExecutableWorkflow, start: string): Set<string> {
  const steps = new Map(executable.steps.map((step) => [step.id, step]));
  const found = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    if (found.has(id)) continue;
    found.add(id);
    const step = steps.get(id);
    if (step?.kind === 'condition') pending.push(step.whenTrue, step.whenFalse);
    else if (step && 'next' in step) pending.push(step.next);
  }
  return found;
}

async function legacyTerminalFailure(
  context: Parameters<typeof routeFailure>[0],
): Promise<InterpreterResult> {
  const { step, failureType } = context;
  if (!context.compensationDisabled) {
    try {
      await unwindSaga(context.sagaStack, context.interpreterInput, context.outputs);
    } catch {
      return {
        state: 'repair_required',
        failure: { bucket: 'permanent-operational', type: 'CompensationFailed', stepId: step.id },
      };
    }
  }
  const bucket = failureBucket(step, failureType);
  const state =
    context.compensationDisabled || bucket !== 'permanent-validation'
      ? 'repair_required'
      : 'validation_failed';
  return { state, failure: { bucket, type: failureType, stepId: step.id } };
}

function failureBucket(step: ActivityStep, failureType: string): InterpreterFailureBucket {
  const nonRetryable =
    failureType === 'ResponseSchemaMismatch' ||
    failureType === UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE ||
    (step.retryPolicy?.nonRetryableErrorTypes.includes(failureType) ?? false);
  return nonRetryable
    ? (step.retryPolicy?.failureBuckets?.[failureType] ?? 'permanent-operational')
    : 'retryable-transient';
}

async function unwindSaga(
  sagaStack: readonly CompensationStep[],
  interpreterInput: InterpreterInput,
  outputs: Readonly<StepOutputs>,
) {
  for (const compensation of [...sagaStack].reverse()) {
    const input = resolveStepInput(interpreterInput, compensation, outputs);
    const idempotencyKey = compensation.idempotency
      ? await stableIdActivities().deriveStableId('atlas.idempotency', [
          compensation.id,
          resolveReference(compensation.idempotency.businessKey, interpreterInput.input, outputs),
        ])
      : undefined;
    const result = await activitiesWithRetryPolicy(compensation.retryPolicy).invokeStep({
      runId: workflowInfo().workflowId,
      stepId: compensation.id,
      capabilityVersionId: compensation.capabilityVersionId,
      input: idempotencyKey === undefined ? input : { ...input, idempotencyKey },
      ...(interpreterInput.approvedHostnames
        ? { approvedHostnames: interpreterInput.approvedHostnames }
        : {}),
    });
    if (
      compensation.responseSchema &&
      !matchesResponseSchema(result, compensation.responseSchema)
    ) {
      await driftActivities().emitDriftSignal({
        stepId: compensation.id,
        capabilityVersionId: compensation.capabilityVersionId,
      });
      throw ApplicationFailure.nonRetryable(
        'Compensation response failed its pinned schema',
        'ResponseSchemaMismatch',
      );
    }
  }
}

// Only provider (activity) failures are routed; argument or schema evaluation errors fail the run.
function isActivityFailure(error: unknown) {
  return error instanceof ActivityFailure;
}

function applicationFailureType(error: unknown): string {
  let current = error;
  while (current instanceof Error) {
    if (current instanceof ApplicationFailure && current.type) return current.type;
    current = current.cause;
  }
  return 'UnknownOperationalFailure';
}

function matchesResponseSchema(
  result: Readonly<Record<string, JsonValue>>,
  responseSchema: ResponseSchema,
) {
  return validateWorkflowInput(result, responseSchema).length === 0;
}

// The worker projects irVersion 2 outputs down to the paths later steps read, so only that
// slice of the declared response contract can be checked here.
function narrowToProjection(
  responseSchema: ResponseSchema,
  projection: OutputProjection | undefined,
): ResponseSchema {
  if (!projection || projection.some((path) => path.length === 0)) return responseSchema;
  return { required: narrowRequired(responseSchema.required, projection) };
}

function narrowRequired(
  required: ResponseSchema['required'],
  projection: OutputProjection,
): ResponseSchema['required'] {
  const narrowed: Record<string, ResponseSchema['required'][string]> = {};
  for (const [field, schema] of Object.entries(required)) {
    const remaining = projection.filter(([head]) => head === field).map((path) => path.slice(1));
    if (remaining.length === 0) continue;
    narrowed[field] =
      schema.type === 'object' && remaining.every((path) => path.length > 0)
        ? { ...schema, required: narrowRequired(schema.required, remaining) }
        : schema;
  }
  return narrowed;
}

// Retrying a write requires an explicit policy checked against provider duplicate protection.
// Omitting the policy must not introduce retries that approval never checked.
const defaultRetryPolicy: RetryPolicy = {
  initialInterval: '1 second',
  backoffCoefficient: 2,
  maximumInterval: '10 seconds',
  maximumAttempts: DEFAULT_STEP_MAXIMUM_ATTEMPTS,
  nonRetryableErrorTypes: [],
};

function activitiesWithRetryPolicy(
  retryPolicy: RetryPolicy = defaultRetryPolicy,
): Pick<StepActivities, 'invokeStep'> {
  return proxyActivities<Pick<StepActivities, 'invokeStep'>>({
    startToCloseTimeout: WORKFLOW_STEP_START_TO_CLOSE_TIMEOUT,
    retry: {
      initialInterval: retryPolicy.initialInterval,
      backoffCoefficient: retryPolicy.backoffCoefficient,
      maximumInterval: retryPolicy.maximumInterval,
      maximumAttempts: retryPolicy.maximumAttempts,
      nonRetryableErrorTypes: [
        ...new Set([
          ...retryPolicy.nonRetryableErrorTypes,
          UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE,
        ]),
      ],
    },
  });
}

function stableIdActivities(): StableIdActivities {
  return proxyActivities<StableIdActivities>({
    startToCloseTimeout: '5 seconds',
    retry: { maximumAttempts: 1 },
  });
}

function driftActivities(): DriftActivities {
  return proxyActivities<DriftActivities>({
    startToCloseTimeout: '5 seconds',
    retry: { maximumAttempts: 3 },
  });
}

function collectOutputProjection(
  stepId: string,
  remainingSteps: readonly TransformationStep[],
): readonly (readonly string[])[] {
  const paths = new Map<string, readonly string[]>();
  const visit = (expression: TransformationExpression) => {
    if ('source' in expression) {
      if (expression.source === 'stepOutput' && expression.stepId === stepId) {
        paths.set(JSON.stringify(expression.path), expression.path);
      }
      return;
    }
    if (expression.kind === 'variable') return;
    if (expression.kind === 'object') {
      Object.values(expression.fields).forEach(visit);
      return;
    }
    if (expression.kind === 'array') {
      expression.items.forEach(visit);
      return;
    }
    if (expression.kind === 'map') {
      visit(expression.items);
      visit(expression.body);
      return;
    }
    if (expression.kind === 'call') {
      expression.arguments.forEach(visit);
      return;
    }
    visit(expression.condition);
    visit(expression.then);
    visit(expression.else);
  };
  for (const remainingStep of remainingSteps) {
    if (remainingStep.kind !== 'terminal') Object.values(remainingStep.arguments).forEach(visit);
  }
  return [...paths.values()].sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
}
