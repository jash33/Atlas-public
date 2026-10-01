import { stepFetch } from './step-fetch.js';
import {
  workflowSandboxProviderModes,
  workflowSandboxRuntimeVersion,
  workflowSandboxTargetEvidence,
  workflowSandboxTestKinds,
  workflowSandboxWorkerVersion,
  type WorkflowSandboxOutcomeWire,
  type WorkflowSandboxProgressWire,
  type WorkflowSandboxProviderContractWire,
  type WorkflowSandboxSuiteWire,
  type WorkflowSandboxTargetBindingWire,
  type WorkflowSandboxTargetEvidenceWire,
  type WorkflowSandboxTestWire,
} from '@atlas/demo-estate';
import { StepActivityError, type SecretProvider, type StepActivities } from '@atlas/runtime-ports';
import {
  createTemporalWorker,
  INTERPRETER_WORKFLOW,
  type EncryptedDataConverter,
  type StepAttempt,
} from '@atlas/temporal-adapter';
import {
  DEFAULT_STEP_MAXIMUM_ATTEMPTS,
  verifyCompiledWorkflowVersionIntegrity,
  versionedCompiledWorkflowVersionSchema,
  isCapabilityStep,
  type FailureAction,
  type JsonValue,
  type VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import { z } from 'zod';
import { InvalidWorkflowSandboxRequest } from './app.js';
import { createSandboxControlFetch } from './sandbox-control-fetch.js';

import {
  invokeSandboxProvider,
  matchesPinnedSchema,
  sampleWorkflowInput,
  seedSandboxTarget,
  type StepObservation,
} from './workflow-sandbox-provider.js';

const suiteSchema = z.object({
  organizationId: z.string().min(1),
  environmentId: z.string().min(1),
  workflowVersionId: z.string().min(1),
  irHash: z.string().regex(/^[a-f0-9]{64}$/),
  workflow: versionedCompiledWorkflowVersionSchema,
  providerContracts: z.array(
    z.object({
      capabilityVersionId: z.string().min(1),
      serviceId: z.string().min(1),
      operationId: z.string().min(1),
      documentHash: z.string().regex(/^[a-f0-9]{64}$/),
      provider: z.string().min(1),
      mode: z.enum(workflowSandboxProviderModes),
      method: z.string().nullable(),
      path: z.string().nullable(),
      requestSchema: z.unknown(),
      responseSchema: z.unknown(),
      idempotencyField: z.string().nullable().optional(),
    }),
  ),
  tests: z.array(
    z.object({
      testId: z.string().min(1),
      kind: z.enum(workflowSandboxTestKinds),
      stepId: z.string().nullable(),
      capabilityVersionId: z.string().nullable(),
      expectation: z.string().min(1),
      requestSample: z.record(z.string(), z.unknown()).nullable(),
      expectedResponseSchema: z.unknown(),
      failureErrorType: z.string().min(1).optional(),
    }),
  ),
  targetBindings: z
    .array(
      z.object({
        capabilityVersionId: z.string().min(1),
        targetKey: z.string().min(1),
        targetRevision: z.number().int().positive(),
        baseUrl: z.string().url(),
        hostname: z.string().min(1),
        healthPath: z.string().startsWith('/'),
        controlPaths: z.object({
          resources: z.string().startsWith('/'),
          faults: z.string().startsWith('/'),
          observations: z.string().startsWith('/'),
        }),
        secretAlias: z.string().min(1).nullable(),
        testDataProfileKey: z.string().min(1),
        testDataVersion: z.number().int().positive(),
        inputs: z.record(z.string(), z.unknown()),
        targetState: z
          .object({
            mode: z.enum(['replace', 'merge']),
            resources: z.array(
              z
                .object({
                  service: z.string().min(1),
                  collection: z.string().min(1),
                  id: z.string().min(1),
                  document: z.unknown(),
                })
                .strict(),
            ),
          })
          .strict(),
        setupAssumptions: z
          .array(
            z.object({
              path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).min(1),
              equals: z.unknown(),
            }),
          )
          .min(1),
      }),
    )
    .default([]),
});

const sandboxInterpreterResultSchema = z.object({
  visitedStepIds: z.array(z.string()).optional(),
  state: z.enum(['completed', 'validation_failed', 'manual_review', 'repair_required']),
  failure: z
    .object({
      bucket: z.enum(['retryable-transient', 'permanent-validation', 'permanent-operational']),
      type: z.string().min(1),
      stepId: z.string().min(1),
    })
    .optional(),
});

type SandboxInterpreterResult = z.infer<typeof sandboxInterpreterResultSchema>;
type TemporalHistorySummary = NonNullable<WorkflowSandboxOutcomeWire['temporalHistory']>;
type UnboundWorkflowSandboxOutcome = Omit<
  WorkflowSandboxOutcomeWire,
  'workerVersion' | 'runtimeVersion'
>;
type SandboxControlTarget = Pick<
  WorkflowSandboxTargetBindingWire,
  'baseUrl' | 'hostname' | 'controlPaths'
>;

const localTargetState = {
  mode: 'replace',
  resources: [
    {
      service: 'payments',
      collection: 'payments',
      id: 'pay_sandbox',
      document: {
        paymentId: 'pay_sandbox',
        invoiceId: 'inv_sandbox',
        status: 'succeeded',
        amount: { value: 100, currency: 'USD' },
        paidAt: '2026-08-16T12:00:00.000Z',
      },
    },
    {
      service: 'billing',
      collection: 'invoices',
      id: 'inv_sandbox',
      document: {
        invoiceId: 'inv_sandbox',
        version: 1,
        status: 'open',
        outstandingBalance: { value: 100, currency: 'USD' },
        customerId: 'customer_sandbox',
      },
    },
  ],
} satisfies WorkflowSandboxTargetBindingWire['targetState'];

function localControlTarget(baseUrl: string): SandboxControlTarget {
  return {
    baseUrl,
    hostname: new URL(baseUrl).hostname,
    controlPaths: {
      resources: '/__control/resources',
      faults: '/__control/faults',
      observations: '/__control/observations',
    },
  };
}

interface TemporalSandboxExecution {
  readonly temporalWorkflowId: string;
  readonly temporalRunId: string;
  readonly result: SandboxInterpreterResult;
  readonly executionError?: true;
  readonly observations: readonly StepObservation[];
  readonly stepAttempts: readonly StepAttempt[];
  readonly temporalHistory: TemporalHistorySummary;
  readonly targetEvidence?: readonly WorkflowSandboxTargetEvidenceWire[];
}

export interface WorkflowSandboxTemporalRuntime {
  execute(input: {
    readonly workflow: VersionedCompiledWorkflowVersion;
    readonly workflowInput: Readonly<Record<string, JsonValue>>;
    readonly providerContracts: readonly WorkflowSandboxProviderContractWire[];
    readonly targetBindings?: readonly WorkflowSandboxTargetBindingWire[];
    readonly activityTimeout?: { readonly stepId: string; readonly startToCloseTimeout: string };
  }): Promise<TemporalSandboxExecution>;
}

export async function createWorkflowSandboxTemporalRuntime(options: {
  readonly connection: Parameters<typeof createTemporalWorker>[0]['connection'];
  readonly workflowClient: {
    start(
      workflowType: string,
      options: {
        workflowId: string;
        taskQueue: string;
        args: unknown[];
      },
    ): Promise<{
      readonly firstExecutionRunId: string;
      result(): Promise<unknown>;
      fetchHistory(): Promise<unknown>;
    }>;
  };
  readonly namespace: string;
  readonly taskQueue: string;
  readonly dataConverter: EncryptedDataConverter;
  readonly providerBaseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly secretProvider?: SecretProvider;
}): Promise<{
  worker: Awaited<ReturnType<typeof createTemporalWorker>>;
  runtime: WorkflowSandboxTemporalRuntime;
}> {
  const sessions = new Map<
    string,
    {
      contracts: ReadonlyMap<string, WorkflowSandboxProviderContractWire>;
      targets: ReadonlyMap<string, WorkflowSandboxTargetBindingWire>;
      observations: StepObservation[];
      stepAttempts: StepAttempt[];
    }
  >();
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const activities: StepActivities = {
    async invokeStep(invocation, context) {
      const session = invocation.runId ? sessions.get(invocation.runId) : undefined;
      if (!session) throw new StepActivityError('UnknownSandboxExecution');
      const contract = session.contracts.get(invocation.capabilityVersionId);
      if (!contract) throw new StepActivityError('UnknownSandboxCapability');
      const target = session.targets.get(invocation.capabilityVersionId);
      const authorization = target?.secretAlias
        ? await options.secretProvider?.getSecret(target.secretAlias)
        : undefined;
      if (target?.secretAlias && !authorization)
        throw new StepActivityError('SandboxTargetSecretMissing');
      return invokeSandboxProvider(
        stepFetch(fetchImplementation, context),
        target?.baseUrl ?? options.providerBaseUrl,
        contract,
        invocation,
        session.observations,
        target
          ? { ...(authorization ? { authorization } : {}), expectedHostname: target.hostname }
          : undefined,
      );
    },
  };
  const worker = await createTemporalWorker({
    connection: options.connection,
    namespace: options.namespace,
    taskQueue: options.taskQueue,
    dataConverter: options.dataConverter,
    activities,
    stepAttemptReporter: {
      async recordStepAttempt(attempt) {
        sessions.get(attempt.runId)?.stepAttempts.push(attempt);
      },
    },
  });

  return {
    worker,
    runtime: {
      async execute(input: Parameters<WorkflowSandboxTemporalRuntime['execute']>[0]) {
        const targetBindings = input.targetBindings ?? [];
        const temporalWorkflowId = `atlas:sandbox:${input.workflow.workflowVersionId}:${crypto.randomUUID()}`;
        const observations: StepObservation[] = [];
        const stepAttempts: StepAttempt[] = [];
        sessions.set(temporalWorkflowId, {
          contracts: new Map(
            input.providerContracts.map((contract) => [contract.capabilityVersionId, contract]),
          ),
          targets: new Map(targetBindings.map((target) => [target.capabilityVersionId, target])),
          observations,
          stepAttempts,
        });
        try {
          const handle = await options.workflowClient.start(INTERPRETER_WORKFLOW, {
            workflowId: temporalWorkflowId,
            taskQueue: options.taskQueue,
            args: [
              {
                workflow: input.workflow,
                input: input.workflowInput,
                ...(input.workflow.executable.irVersion === 3 ? { sandboxTimers: true } : {}),
              },
            ],
          });
          let result: SandboxInterpreterResult = {
            state: 'repair_required',
            failure: {
              bucket: 'permanent-operational',
              type: 'TemporalExecutionFailed',
              stepId: 'workflow',
            },
          };
          let executionError: true | undefined;
          try {
            result = sandboxInterpreterResultSchema.parse(await handle.result());
          } catch {
            executionError = true;
          }
          const temporalHistory = summarizeTemporalHistory(await handle.fetchHistory());
          return {
            temporalWorkflowId,
            temporalRunId: handle.firstExecutionRunId,
            result,
            ...(executionError ? { executionError } : {}),
            observations,
            stepAttempts,
            temporalHistory,
            targetEvidence: targetBindings.map(workflowSandboxTargetEvidence),
          };
        } finally {
          sessions.delete(temporalWorkflowId);
        }
      },
    } satisfies WorkflowSandboxTemporalRuntime,
  };
}

export function createWorkflowSandboxRunner(options: {
  readonly organizationId: string;
  readonly environmentId: string;
  readonly fallbackRunnerBaseUrl: string;
  readonly temporalRuntime: WorkflowSandboxTemporalRuntime;
  readonly fetch?: typeof globalThis.fetch;
  readonly secretProvider?: SecretProvider;
  readonly workerVersion?: string;
  readonly runtimeVersion?: string;
}) {
  const fetchImplementation = createSandboxControlFetch(options.fetch ?? globalThis.fetch);
  const runtimeIdentity = {
    workerVersion: options.workerVersion ?? workflowSandboxWorkerVersion,
    runtimeVersion: options.runtimeVersion ?? workflowSandboxRuntimeVersion,
  };
  const bindRuntimeIdentity = (outcomes: UnboundWorkflowSandboxOutcome[]) => ({
    outcomes: outcomes.map((outcome) => ({ ...outcome, ...runtimeIdentity })),
  });
  return {
    async execute(
      rawSuite: unknown,
      onProgress?: (progress: WorkflowSandboxProgressWire) => void,
    ): Promise<{ outcomes: WorkflowSandboxOutcomeWire[] }> {
      const parsedSuite = suiteSchema.safeParse(rawSuite);
      if (!parsedSuite.success) throw new InvalidWorkflowSandboxRequest();
      const suite = parsedSuite.data;
      let workflow: VersionedCompiledWorkflowVersion;
      try {
        workflow = await verifyCompiledWorkflowVersionIntegrity(suite.workflow);
      } catch {
        throw new InvalidWorkflowSandboxRequest();
      }
      if (
        suite.organizationId !== options.organizationId ||
        suite.environmentId !== options.environmentId ||
        workflow.executionRequirements.organizationId !== suite.organizationId ||
        workflow.workflowVersionId !== suite.workflowVersionId ||
        workflow.irHash !== suite.irHash
      ) {
        throw new InvalidWorkflowSandboxRequest();
      }

      let completed = 0;
      const report = (
        phase: WorkflowSandboxProgressWire['phase'],
        test?: WorkflowSandboxTestWire,
      ) =>
        onProgress?.({
          phase,
          completed,
          total: suite.tests.length,
          ...(test ? { currentTest: { kind: test.kind, stepId: test.stepId } } : {}),
        });
      report('preparing');

      const targetFailure = await validateRemoteTargets(
        suite.targetBindings,
        fetchImplementation,
        options.secretProvider,
      );
      if (targetFailure) {
        const result = bindRuntimeIdentity(
          suite.tests.map((test) => {
            const relevantTargets = suite.targetBindings.filter(
              ({ capabilityVersionId }) =>
                test.kind === 'happy-path' || test.capabilityVersionId === capabilityVersionId,
            );
            return {
              testId: test.testId,
              status: 'failed' as const,
              executionMethods:
                test.kind === 'compatibility'
                  ? (['static-validation'] as const)
                  : relevantTargets.length > 0
                    ? (['remote-sandbox'] as const)
                    : (['local-test-service'] as const),
              detail: targetFailure,
              ...(relevantTargets.length === 0
                ? {}
                : {
                    targetEvidence: relevantTargets.map(workflowSandboxTargetEvidence),
                  }),
            };
          }),
        );
        completed = result.outcomes.length;
        report('finalizing');
        return result;
      }
      const runtimeTests = suite.tests.filter((test) => test.kind !== 'compatibility');
      const connectedCapabilities = new Set(
        suite.targetBindings.map(({ capabilityVersionId }) => capabilityVersionId),
      );
      const connectedStaticTests = suite.tests.filter(
        (test) =>
          test.kind === 'compatibility' &&
          test.capabilityVersionId !== null &&
          connectedCapabilities.has(test.capabilityVersionId),
      );
      const connectedStaticOutcomes: UnboundWorkflowSandboxOutcome[] = connectedStaticTests.map(
        (test) => {
          report('running', test);
          const contract = suite.providerContracts.find(
            ({ capabilityVersionId }) => capabilityVersionId === test.capabilityVersionId,
          );
          const passed =
            contract !== undefined &&
            matchesPinnedSchema(test.requestSample, contract.requestSchema) &&
            JSON.stringify(test.expectedResponseSchema) === JSON.stringify(contract.responseSchema);
          completed += 1;
          report('running');
          return {
            testId: test.testId,
            status: passed ? 'passed' : 'failed',
            executionMethods: ['static-validation'],
            detail: passed
              ? 'The generated request and expected response match the connected capability pinned schemas.'
              : 'The generated shapes are not compatible with the connected capability pinned schemas.',
          };
        },
      );
      const fallbackTests = suite.tests.filter(
        (test) =>
          test.kind === 'compatibility' &&
          (test.capabilityVersionId === null ||
            !connectedCapabilities.has(test.capabilityVersionId)),
      );
      const fallbackOutcomes: UnboundWorkflowSandboxOutcome[] = [];
      for (const test of fallbackTests) {
        report('running', test);
        const outcomes = await runFallbackChecks(
          fetchImplementation,
          options.fallbackRunnerBaseUrl,
          { ...suite, tests: [test] },
        );
        const outcome = outcomes[0];
        if (
          outcomes.length !== 1 ||
          outcome?.testId !== test.testId ||
          !['passed', 'failed'].includes(outcome.status)
        ) {
          throw new TypeError('Fallback sandbox returned invalid results');
        }
        fallbackOutcomes.push(outcome);
        completed += 1;
        report('running');
      }
      const runtimeOutcomes: UnboundWorkflowSandboxOutcome[] = [];
      const hasProviders = workflow.executable.steps.some(isCapabilityStep);
      for (const test of runtimeTests) {
        report('running', test);
        const selectedTarget = suite.targetBindings.find(
          ({ capabilityVersionId }) =>
            test.kind === 'happy-path' || capabilityVersionId === test.capabilityVersionId,
        );
        const controlTarget = selectedTarget ?? localControlTarget(options.fallbackRunnerBaseUrl);
        const seedTargets: Array<{
          control: SandboxControlTarget;
          state: Readonly<WorkflowSandboxTargetBindingWire['targetState']>;
        }> = !hasProviders
          ? []
          : test.kind === 'happy-path'
            ? [
                ...(workflow.executable.steps.some(
                  (step) =>
                    isCapabilityStep(step) && !connectedCapabilities.has(step.capabilityVersionId),
                )
                  ? [
                      {
                        control: localControlTarget(options.fallbackRunnerBaseUrl),
                        state: localTargetState,
                      },
                    ]
                  : []),
                ...suite.targetBindings.map((binding) => ({
                  control: binding,
                  state: binding.targetState,
                })),
              ]
            : [
                {
                  control: controlTarget,
                  state: selectedTarget?.targetState ?? localTargetState,
                },
              ];
        for (const { control, state } of seedTargets) {
          await seedSandboxTarget(
            fetchImplementation,
            control.baseUrl,
            state,
            control.controlPaths.resources,
            control.hostname,
          );
        }
        try {
          runtimeOutcomes.push(
            await executeRuntimeCheck(
              options.temporalRuntime,
              workflow,
              suite.providerContracts,
              suite.targetBindings,
              test,
              fetchImplementation,
              controlTarget,
            ),
          );
        } catch (error) {
          // Only fixed test-kind labels and allowlisted transport codes; never provider payloads.
          const cause = error instanceof Error ? error.cause : undefined;
          const code =
            cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
          console.error('workflow-sandbox-check-failed', {
            kind: test.kind,
            transportCode:
              typeof code === 'string' &&
              [
                'ECONNRESET',
                'ECONNREFUSED',
                'ETIMEDOUT',
                'EAI_AGAIN',
                'ENOTFOUND',
                'UND_ERR_SOCKET',
                'UND_ERR_CONNECT_TIMEOUT',
              ].includes(code)
                ? code
                : null,
          });
          throw error;
        } finally {
          const contract = suite.providerContracts.find(
            ({ capabilityVersionId }) => capabilityVersionId === test.capabilityVersionId,
          );
          if (
            contract &&
            test.stepId &&
            ['retry', 'rate-limit', 'timeout', 'partial-failure'].includes(test.kind)
          ) {
            await injectProviderFault(fetchImplementation, controlTarget, {
              operationId: contract.operationId,
              stepId: test.stepId,
              mode: 'none',
            });
          }
        }
        completed += 1;
        report('running');
      }
      const byId = new Map(
        [...runtimeOutcomes, ...connectedStaticOutcomes, ...fallbackOutcomes].map((outcome) => [
          outcome.testId,
          outcome,
        ]),
      );
      report('finalizing');
      return bindRuntimeIdentity(suite.tests.map(({ testId }) => byId.get(testId)!));
    },
  };
}

async function executeRuntimeCheck(
  runtime: WorkflowSandboxTemporalRuntime,
  workflow: VersionedCompiledWorkflowVersion,
  contracts: readonly WorkflowSandboxProviderContractWire[],
  targetBindings: readonly WorkflowSandboxTargetBindingWire[],
  test: WorkflowSandboxTestWire,
  fetchImplementation: typeof globalThis.fetch,
  controlTarget: SandboxControlTarget,
): Promise<UnboundWorkflowSandboxOutcome> {
  const workflowInput = Object.assign(
    { atlasWorkflowRunId: 'sandbox-run' },
    sampleWorkflowInput(workflow),
    ...targetBindings.map(({ inputs }) => inputs),
    ...(test.kind === 'happy-path'
      ? []
      : targetBindings
          .filter((target) => target.capabilityVersionId === test.capabilityVersionId)
          .map(({ inputs }) => inputs)),
    ...(test.kind === 'happy-path' && test.stepId && test.requestSample
      ? [test.requestSample]
      : []),
  ) as Readonly<Record<string, JsonValue>>;
  const execute = () =>
    runtime.execute({
      workflow,
      workflowInput,
      providerContracts: contracts,
      targetBindings,
      ...(test.kind === 'timeout'
        ? {
            activityTimeout: {
              stepId: test.stepId!,
              startToCloseTimeout: '25 milliseconds',
            },
          }
        : {}),
    });
  const targetContract = contracts.find(
    ({ capabilityVersionId }) => capabilityVersionId === test.capabilityVersionId,
  );
  const providerState = () =>
    workflow.executable.steps.some(isCapabilityStep)
      ? providerSummary(fetchImplementation, controlTarget)
      : Promise.resolve(summarizeProviderObservations({}, []));

  if (test.kind === 'retry' || test.kind === 'rate-limit' || test.kind === 'timeout') {
    if (!targetContract || !test.stepId) return invalidRuntimeTest(test);
    const step = workflow.executable.steps.find(({ id }) => id === test.stepId);
    if (!step || !isCapabilityStep(step) || step.kind === 'compensation') {
      return invalidRuntimeTest(test);
    }
    const errorType =
      test.kind === 'retry'
        ? 'TransientDownstream'
        : test.kind === 'rate-limit'
          ? 'RateLimited'
          : 'ActivityTimeout';
    const expectedAttempts =
      test.kind !== 'timeout' && step.retryPolicy?.nonRetryableErrorTypes.includes(errorType)
        ? 1
        : (step.retryPolicy?.maximumAttempts ?? DEFAULT_STEP_MAXIMUM_ATTEMPTS);
    await injectProviderFault(fetchImplementation, controlTarget, {
      operationId: targetContract.operationId,
      stepId: test.stepId,
      mode: test.kind === 'retry' ? 'transient' : test.kind,
      ...(test.kind === 'retry' ? { failures: Math.max(1, expectedAttempts - 1) } : {}),
    });
    const execution = await execute();
    const expectedStatus = test.kind === 'rate-limit' ? 429 : test.kind === 'timeout' ? 504 : 503;
    const attempts = summarizeAttempts(execution.observations);
    const targetAttempts =
      test.kind === 'timeout'
        ? attempts
            .filter(({ stepId }) => stepId === test.stepId)
            .map((attempt) => ({ ...attempt, status: 408 }))
        : attempts.filter(({ stepId }) => stepId === test.stepId);
    const transientIsRetryable = !step.retryPolicy?.nonRetryableErrorTypes.includes(errorType);
    const transientCanRecover = transientIsRetryable && expectedAttempts > 1;
    const parked = execution.result.state !== 'completed';
    const passed =
      targetAttempts.length === expectedAttempts &&
      (test.kind === 'retry'
        ? transientCanRecover
          ? execution.executionError === undefined &&
            execution.result.state === 'completed' &&
            targetAttempts.slice(0, -1).every(({ status }) => status === expectedStatus) &&
            isSuccessStatus(targetAttempts.at(-1)?.status)
          : parked && targetAttempts[0]?.status === expectedStatus
        : test.kind === 'timeout'
          ? parked
          : parked && targetAttempts.every(({ status }) => status === expectedStatus));
    return runtimeOutcome(
      test,
      execution,
      await providerState(),
      {
        passed,
        detail: passed
          ? `Temporal stopped after ${expectedAttempts} provider ${test.kind} attempts.`
          : (skippedTargetDetail(workflow, test, execution) ??
            `Temporal did not honor the declared ${test.kind} retry behavior.`),
      },
      targetAttempts,
    );
  }

  if (test.kind === 'duplicate-event') {
    const first = await execute();
    const stateAfterFirst = await readProviderObservations(fetchImplementation, controlTarget);
    const second = await execute();
    const stateAfterSecond = await readProviderObservations(fetchImplementation, controlTarget);
    const passed =
      first.result.state === 'completed' &&
      second.result.state === 'completed' &&
      !skippedTargetDetail(workflow, test, first) &&
      !skippedTargetDetail(workflow, test, second) &&
      providerEffectFingerprint(stateAfterFirst) === providerEffectFingerprint(stateAfterSecond);
    return runtimeOutcome(
      test,
      second,
      summarizeProviderObservations(stateAfterSecond, compensationOrder(workflow, second)),
      {
        passed,
        detail: passed
          ? 'Temporal repeated the same business event without an additional provider side effect.'
          : (skippedTargetDetail(workflow, test, second) ??
            'Repeating the business event changed provider state or side-effect counts.'),
      },
    );
  }

  if (test.kind === 'partial-failure') {
    const failingStep = workflow.executable.steps.find(({ id }) => id === test.stepId);
    if (!failingStep || !isCapabilityStep(failingStep) || failingStep.kind === 'compensation') {
      return invalidRuntimeTest(test);
    }
    const target = contracts.find(
      ({ capabilityVersionId }) => capabilityVersionId === failingStep.capabilityVersionId,
    );
    if (!target) return invalidRuntimeTest(test);
    const providerStateBefore = await readProviderObservations(fetchImplementation, controlTarget);
    await injectProviderFault(fetchImplementation, controlTarget, {
      operationId: target.operationId,
      stepId: failingStep.id,
      mode: 'permanent',
      errorType: test.failureErrorType ?? 'SandboxPartialFailure',
    });
    const execution = await execute();
    const providerState = await readProviderObservations(fetchImplementation, controlTarget);
    const observedCompensationOrder = compensationOrder(workflow, execution);
    const expectation = partialFailureExpectation(
      workflow,
      failingStep.id,
      test.failureErrorType ?? 'SandboxPartialFailure',
      execution,
    );
    const passed = partialFailureMatches(
      expectation,
      execution,
      observedCompensationOrder,
      providerStateBefore,
      providerState,
      failingStep.id,
      test.failureErrorType ?? 'SandboxPartialFailure',
    );
    return runtimeOutcome(
      test,
      execution,
      summarizeProviderObservations(providerState, observedCompensationOrder),
      {
        passed,
        detail: passed
          ? `Temporal produced the declared ${expectation.kind} outcome (${execution.result.state}).`
          : (skippedTargetDetail(workflow, test, execution) ??
            `The real runtime rejected the declared ${expectation.kind} outcome (observed ${execution.result.state}).`),
      },
    );
  }

  const execution = await execute();
  if (test.kind === 'happy-path') {
    const expectedOrder =
      workflow.executable.irVersion === 3
        ? (execution.result.visitedStepIds ?? []).filter((id) => {
            const step = workflow.executable.steps.find((candidate) => candidate.id === id);
            return step && isCapabilityStep(step) && step.kind !== 'compensation';
          })
        : workflow.executable.steps
            .filter((step) => isCapabilityStep(step) && step.kind !== 'compensation')
            .map(({ id }) => id);
    const observedOrder =
      workflow.executable.irVersion === 3
        ? execution.observations
            .map(({ stepId }) => stepId)
            .filter((id, index, ids) => index === 0 || ids[index - 1] !== id)
        : completedStepOrder(execution.observations);
    const completed =
      execution.executionError === undefined &&
      (workflow.executable.irVersion === 3
        ? validCompletedGraphRoute(workflow, execution)
        : execution.result.state === 'completed');
    const branchDetail = missingConditionRouteDetail(workflow, test, execution);
    const passed =
      completed &&
      !branchDetail &&
      validCompletedGraphRoute(workflow, execution) &&
      JSON.stringify(observedOrder) === JSON.stringify(expectedOrder);
    const channelUrlDetail = eventChannelUsedAsUrlDetail(execution.observations, contracts);
    return runtimeOutcome(test, execution, await providerState(), {
      passed,
      detail: execution.executionError
        ? 'Temporal failed before producing a valid interpreter result.'
        : completed
          ? passed
            ? `Temporal completed the compiled workflow: ${(workflow.executable.irVersion === 3 ? (execution.result.visitedStepIds ?? []) : expectedOrder).join(' -> ')}.${workflow.executable.irVersion === 3 && workflow.executable.steps.some((step) => step.kind === 'sleep') ? ' Sleep timers were accelerated for this check.' : ''}`
            : (branchDetail ??
              `Temporal completed, but the observed route or provider steps differed from the compiled workflow (observed: ${observedOrder.join(' -> ') || 'none'}).`)
          : (channelUrlDetail ??
            (execution.result.failure
              ? `Temporal stopped at ${execution.result.failure.stepId} (${execution.result.state}).`
              : `Temporal did not complete the workflow (observed ${execution.result.state}).`)),
    });
  }
  const observation = [...execution.observations]
    .reverse()
    .find(({ stepId }) => stepId === test.stepId);
  const passed =
    execution.executionError === undefined &&
    execution.result.state === 'completed' &&
    observation !== undefined &&
    observation.status >= 200 &&
    observation.status < 300 &&
    matchesPinnedSchema(observation.serializedRequest, targetContract?.requestSchema) &&
    matchesPinnedSchema(observation.response, test.expectedResponseSchema);
  return runtimeOutcome(test, execution, await providerState(), {
    passed,
    detail: passed
      ? 'The serialized provider request and observed response matched the pinned schemas through Temporal.'
      : (skippedTargetDetail(workflow, test, execution) ??
        'The real Temporal execution produced an incompatible provider request or response.'),
  });
}

function missingConditionRouteDetail(
  workflow: VersionedCompiledWorkflowVersion,
  test: WorkflowSandboxTestWire,
  execution: TemporalSandboxExecution,
): string | undefined {
  if (workflow.executable.irVersion !== 3 || !test.stepId || test.kind !== 'happy-path')
    return undefined;
  const condition = workflow.executable.steps.find((step) => step.id === test.stepId);
  if (condition?.kind !== 'condition')
    return 'The condition check does not identify an If / Otherwise block.';
  const route = test.testId.endsWith(':true')
    ? condition.whenTrue
    : test.testId.endsWith(':false')
      ? condition.whenFalse
      : undefined;
  const visited = execution.result.visitedStepIds ?? [];
  const index = visited.indexOf(condition.id);
  return route && index >= 0 && visited[index + 1] === route
    ? undefined
    : `The test input did not reach the requested route from '${condition.id}'. Supply test inputs or provider data that select this route.`;
}

function skippedTargetDetail(
  workflow: VersionedCompiledWorkflowVersion,
  test: WorkflowSandboxTestWire,
  execution: TemporalSandboxExecution,
): string | undefined {
  if (
    workflow.executable.irVersion !== 3 ||
    !test.stepId ||
    execution.result.visitedStepIds?.includes(test.stepId)
  )
    return undefined;
  return `The test input skipped '${test.stepId}'. Add inputs to this capability's test-data profile that reach its condition route.`;
}

function validCompletedGraphRoute(
  workflow: VersionedCompiledWorkflowVersion,
  execution: TemporalSandboxExecution,
): boolean {
  const graph = workflow.executable;
  if (graph.irVersion !== 3) return true;
  const visited = execution.result.visitedStepIds ?? [];
  if (visited[0] !== graph.startStepId) return false;
  const steps = new Map(graph.steps.map((step) => [step.id, step]));
  for (const [index, id] of visited.entries()) {
    const step = steps.get(id);
    if (!step || step.kind === 'compensation') return false;
    const next = visited[index + 1];
    if (step.kind === 'terminal')
      return index === visited.length - 1 && step.state === execution.result.state;
    if (next === undefined) return false;
    if (
      step.kind === 'condition'
        ? next === step.whenTrue || next === step.whenFalse
        : next === step.next
    )
      continue;
    if (!isCapabilityStep(step)) return false;
    const actions = [
      step.errorRouting?.defaultAction,
      ...(step.errorRouting?.rules.map((rule) => rule.action) ?? []),
    ];
    if (
      !actions.some((action) => action?.kind === 'revalidateFrom' && action.targetStepId === next)
    )
      return false;
  }
  return false;
}

function invalidRuntimeTest(test: WorkflowSandboxTestWire): UnboundWorkflowSandboxOutcome {
  return {
    testId: test.testId,
    status: 'failed',
    executionMethods: ['local-test-service'],
    detail: 'The generated runtime check does not identify an executable provider step.',
  };
}

function eventChannelUsedAsUrlDetail(
  observations: readonly StepObservation[],
  contracts: readonly WorkflowSandboxProviderContractWire[],
) {
  const failed = [...observations].reverse().find(({ status }) => status < 200 || status >= 300);
  if (!failed || failed.status !== 404) return undefined;
  const contract = contracts.find(
    ({ capabilityVersionId }) => capabilityVersionId === failed.capabilityVersionId,
  );
  const path = contract?.path;
  if (typeof path !== 'string' || path.startsWith('/')) return undefined;
  return `Atlas used the event channel ${path} as a URL instead of calling /events/${path}.`;
}

// Event publishes answer 202 Accepted; any 2xx is a successful provider attempt.
function isSuccessStatus(status: number | undefined) {
  return status !== undefined && status >= 200 && status < 300;
}

function completedStepOrder(observations: readonly StepObservation[]) {
  const order: string[] = [];
  for (const { stepId, status } of observations) {
    if (status < 200 || status >= 300) continue;
    if (order.at(-1) !== stepId) order.push(stepId);
  }
  return order;
}

function summarizeAttempts(observations: readonly StepObservation[]) {
  const attempts = new Map<string, number>();
  return observations.map(({ stepId, status }) => {
    const attempt = (attempts.get(stepId) ?? 0) + 1;
    attempts.set(stepId, attempt);
    return { stepId, attempt, status };
  });
}

function summarizeTemporalHistory(history: unknown): TemporalHistorySummary {
  const events = arrayRecords(recordValue(history)?.events);
  return {
    scheduledActivities: events.filter((event) => event.activityTaskScheduledEventAttributes)
      .length,
    completedActivities: events.filter((event) => event.activityTaskCompletedEventAttributes)
      .length,
    failedActivities: events.filter((event) => event.activityTaskFailedEventAttributes).length,
    timedOutActivities: events.filter((event) => event.activityTaskTimedOutEventAttributes).length,
  };
}

async function injectProviderFault(
  fetchImplementation: typeof globalThis.fetch,
  target: SandboxControlTarget,
  fault: {
    operationId: string;
    stepId: string;
    mode: 'transient' | 'rate-limit' | 'timeout' | 'permanent' | 'none';
    errorType?: string;
    failures?: number;
  },
) {
  const response = await fetchImplementation(targetControlUrl(target, target.controlPaths.faults), {
    method: 'PUT',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fault),
  });
  denyControlRedirect(response, 'fault injection');
  if (!response.ok) throw new Error(`Provider fault injection failed (${response.status})`);
}

type ProviderObservations = Readonly<Record<string, unknown>>;

async function readProviderObservations(
  fetchImplementation: typeof globalThis.fetch,
  target: SandboxControlTarget,
): Promise<ProviderObservations> {
  const response = await fetchImplementation(
    targetControlUrl(target, target.controlPaths.observations),
    {
      redirect: 'manual',
    },
  );
  denyControlRedirect(response, 'observations');
  if (!response.ok) throw new Error(`Provider observations failed (${response.status})`);
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TypeError('Provider returned invalid observations');
  }
  return body as ProviderObservations;
}

async function providerSummary(
  fetchImplementation: typeof globalThis.fetch,
  target: SandboxControlTarget,
) {
  return summarizeProviderObservations(
    await readProviderObservations(fetchImplementation, target),
    [],
  );
}

function targetControlUrl(target: SandboxControlTarget, path: string) {
  const url = new URL(path, `${target.baseUrl.replace(/\/$/, '')}/`);
  if (url.hostname !== target.hostname) throw new Error('Sandbox target control host mismatch');
  return url;
}

function denyControlRedirect(response: Response, operation: string) {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    throw new Error(
      `Sandbox target ${operation} redirect denied${location ? ` (${location})` : ''}`,
    );
  }
}

function providerEffectFingerprint(observations: ProviderObservations) {
  const billingMutations = arrayRecords(observations.billingMutations).filter(
    (mutation) => mutation.replayed !== true && recordValue(mutation.outcome)?.kind === 'applied',
  ).length;
  return JSON.stringify({
    billingMutations,
    sideEffects: arrayLength(observations.sideEffects),
    durableState: observations.durableState,
    invoices: arrayRecords(observations.invoices).map(({ status, version }) => ({
      status,
      version,
    })),
    publishedEvents: arrayLength(observations.publishedEvents),
    notifications: arrayLength(observations.notifications),
    stripePaymentIntents: arrayLength(observations.stripePaymentIntents),
    slackMessages: arrayLength(observations.slackMessages),
    hubspotContacts: arrayLength(observations.hubspotContacts),
    mappingDemoBillingRequests: arrayLength(observations.mappingDemoBillingRequests),
  });
}

function summarizeProviderObservations(
  observations: ProviderObservations,
  observedCompensationOrder: string[],
): NonNullable<WorkflowSandboxOutcomeWire['providerObservations']> {
  const billingMutations = arrayRecords(observations.billingMutations).map((mutation) => ({
    operationId: typeof mutation.operationId === 'string' ? mutation.operationId : 'unknown',
    outcome:
      typeof recordValue(mutation.outcome)?.kind === 'string'
        ? String(recordValue(mutation.outcome)!.kind)
        : 'unknown',
    replayed: mutation.replayed === true,
  }));
  const sideEffectCount =
    arrayLength(observations.sideEffects) +
    billingMutations.filter(({ outcome, replayed }) => outcome === 'applied' && !replayed).length +
    arrayLength(observations.publishedEvents) +
    arrayLength(observations.notifications) +
    arrayLength(observations.stripePaymentIntents) +
    arrayLength(observations.slackMessages) +
    arrayLength(observations.hubspotContacts) +
    arrayLength(observations.mappingDemoBillingRequests);
  return {
    sideEffectCount,
    invoiceStates: arrayRecords(observations.invoices).flatMap((invoice) =>
      typeof invoice.status === 'string' && typeof invoice.version === 'number'
        ? [{ status: invoice.status, version: invoice.version }]
        : [],
    ),
    billingMutations,
    compensationOrder: observedCompensationOrder,
  };
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayLength(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function compensationOrder(
  workflow: VersionedCompiledWorkflowVersion,
  execution: TemporalSandboxExecution,
) {
  const compensationIds = new Set(
    workflow.executable.steps.flatMap((step) => (step.kind === 'compensation' ? [step.id] : [])),
  );
  return execution.observations
    .filter(({ stepId, status }) => compensationIds.has(stepId) && status >= 200 && status < 300)
    .map(({ stepId }) => stepId);
}

type PartialFailureExpectation = {
  kind: 'compensateThenLand' | 'preserveAndLand' | 'land' | 'revalidateFrom';
  outcome?: SandboxInterpreterResult['state'];
  compensationOrder: string[];
  revalidationTarget?: string;
  maxRevalidations?: number;
};

function partialFailureExpectation(
  workflow: VersionedCompiledWorkflowVersion,
  failingStepId: string,
  failureErrorType: string,
  execution: TemporalSandboxExecution,
): PartialFailureExpectation {
  const failingIndex = workflow.executable.steps.findIndex(({ id }) => id === failingStepId);
  const failingStep = workflow.executable.steps[failingIndex]!;
  if (isCapabilityStep(failingStep)) {
    const action =
      failingStep.errorRouting?.rules.find(({ errorTypes }) =>
        errorTypes.includes(failureErrorType),
      )?.action ?? failingStep.errorRouting?.defaultAction;
    if (action) {
      const terminalAction = exhaustedFailureAction(action);
      return {
        kind: action.kind,
        outcome: terminalAction.outcome,
        compensationOrder:
          terminalAction.kind === 'compensateThenLand'
            ? expectedCompensationOrder(workflow, failingIndex, execution)
            : [],
        ...(action.kind === 'revalidateFrom'
          ? {
              revalidationTarget: action.targetStepId,
              maxRevalidations: action.maxRevalidations,
            }
          : {}),
      };
    }
  }
  const expected = expectedCompensationOrder(workflow, failingIndex, execution);
  return {
    kind: expected.length > 0 ? 'compensateThenLand' : 'preserveAndLand',
    compensationOrder: expected,
  };
}

function exhaustedFailureAction(action: FailureAction) {
  let current = action;
  while (current.kind === 'revalidateFrom') current = current.onExhausted;
  return current;
}

function expectedCompensationOrder(
  workflow: VersionedCompiledWorkflowVersion,
  failingIndex: number,
  execution: TemporalSandboxExecution,
) {
  const attemptedIds = attemptedProviderIds(workflow, failingIndex, execution);
  if (
    workflow.executable.steps.some(
      (step) =>
        attemptedIds.includes(step.id) && isCapabilityStep(step) && step.irreversibleAfter === true,
    )
  )
    return [];
  return attemptedIds
    .flatMap((id) =>
      workflow.executable.steps
        .filter((step) => step.kind === 'compensation' && step.compensatesStepId === id)
        .map((step) => step.id),
    )
    .reverse();
}

function attemptedProviderIds(
  workflow: VersionedCompiledWorkflowVersion,
  failingIndex: number,
  execution: TemporalSandboxExecution,
): string[] {
  if (workflow.executable.irVersion !== 3)
    return workflow.executable.steps
      .slice(0, failingIndex + 1)
      .filter((step) => isCapabilityStep(step) && step.kind !== 'compensation')
      .map((step) => step.id);
  const ids: string[] = [];
  const graph = workflow.executable;
  const steps = new Map(graph.steps.map((step) => [step.id, step]));
  const visited = execution.result.visitedStepIds ?? [];
  // A recovery jump discards downstream compensation entries before rerunning.
  const discardFrom = (start: string) => {
    const reachable = new Set<string>();
    const pending = [start];
    while (pending.length) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      const step = steps.get(id);
      if (step?.kind === 'condition') pending.push(step.whenTrue, step.whenFalse);
      else if (step && 'next' in step) pending.push(step.next);
    }
    for (let index = ids.length - 1; index >= 0; index -= 1)
      if (reachable.has(ids[index]!)) ids.splice(index, 1);
  };
  const attempts = [...execution.observations];
  for (const [index, id] of visited.entries()) {
    const step = steps.get(id);
    if (!step || !isCapabilityStep(step) || step.kind === 'compensation') continue;
    let attempted = false;
    while (attempts[0]?.stepId === id) {
      const observation = attempts.shift()!;
      attempted = true;
      if (isSuccessStatus(observation.status)) {
        break;
      }
    }
    if (attempted) ids.push(id);
    const next = visited[index + 1];
    if (next && next !== step.next) discardFrom(next);
  }
  return ids;
}

function partialFailureMatches(
  expectation: PartialFailureExpectation,
  execution: TemporalSandboxExecution,
  observedCompensationOrder: string[],
  providerStateBefore: ProviderObservations,
  providerStateAfter: ProviderObservations,
  failingStepId: string,
  failureErrorType: string,
) {
  if (execution.executionError) return false;
  if (
    execution.result.failure?.stepId !== failingStepId ||
    execution.result.failure.type !== failureErrorType
  ) {
    return false;
  }
  if (expectation.outcome && execution.result.state !== expectation.outcome) return false;
  if (execution.result.state === 'completed') return false;
  const observedScheduledActivities = execution.stepAttempts.filter(
    ({ attempt }) => attempt === 1,
  ).length;
  if (expectation.kind === 'revalidateFrom') {
    const revalidations = execution.stepAttempts.filter(
      ({ stepId, attempt }) => stepId === expectation.revalidationTarget && attempt === 1,
    ).length;
    return (
      revalidations === (expectation.maxRevalidations ?? 0) + 1 &&
      JSON.stringify(observedCompensationOrder) === JSON.stringify(expectation.compensationOrder) &&
      execution.temporalHistory.scheduledActivities >= observedScheduledActivities &&
      providerFailureStateMatches(expectation, providerStateBefore, providerStateAfter)
    );
  }
  const compensationOrderMatches =
    JSON.stringify(observedCompensationOrder) === JSON.stringify(expectation.compensationOrder);
  return (
    compensationOrderMatches &&
    execution.temporalHistory.scheduledActivities >= observedScheduledActivities &&
    providerFailureStateMatches(expectation, providerStateBefore, providerStateAfter)
  );
}

function providerFailureStateMatches(
  expectation: PartialFailureExpectation,
  before: ProviderObservations,
  after: ProviderObservations,
) {
  if (expectation.compensationOrder.length > 0) {
    return providerDurableStateFingerprint(before) === providerDurableStateFingerprint(after);
  }
  const beforeEffects = summarizeProviderObservations(before, []).sideEffectCount;
  const afterEffects = summarizeProviderObservations(after, []).sideEffectCount;
  return (
    beforeEffects === afterEffects ||
    providerEffectFingerprint(before) !== providerEffectFingerprint(after)
  );
}

function providerDurableStateFingerprint(observations: ProviderObservations) {
  return JSON.stringify({
    durableState: observations.durableState,
    invoices: arrayRecords(observations.invoices).map(({ invoiceId, status }) => ({
      invoiceId,
      status,
    })),
    publishedEvents: arrayLength(observations.publishedEvents),
    notifications: arrayLength(observations.notifications),
    stripePaymentIntents: arrayLength(observations.stripePaymentIntents),
    slackMessages: arrayLength(observations.slackMessages),
    hubspotContacts: arrayLength(observations.hubspotContacts),
    mappingDemoBillingRequests: arrayLength(observations.mappingDemoBillingRequests),
  });
}

function runtimeOutcome(
  test: WorkflowSandboxTestWire,
  execution: TemporalSandboxExecution,
  providerObservations: NonNullable<WorkflowSandboxOutcomeWire['providerObservations']>,
  result: { passed: boolean; detail: string },
  attempts = summarizeAttempts(execution.observations),
): UnboundWorkflowSandboxOutcome {
  const passed = result.passed;
  const relevantTargetEvidence = (execution.targetEvidence ?? []).filter(
    ({ capabilityVersionId }) =>
      test.kind === 'happy-path' || test.capabilityVersionId === capabilityVersionId,
  );
  return {
    testId: test.testId,
    status: passed ? 'passed' : 'failed',
    executionMethods: [relevantTargetEvidence.length > 0 ? 'remote-sandbox' : 'local-test-service'],
    detail: result.detail,
    temporalWorkflowId: execution.temporalWorkflowId,
    temporalRunId: execution.temporalRunId,
    terminalOutcome: execution.result.state,
    attempts,
    temporalHistory: execution.temporalHistory,
    providerObservations,
    ...(relevantTargetEvidence.length === 0 ? {} : { targetEvidence: relevantTargetEvidence }),
  };
}

async function validateRemoteTargets(
  targets: readonly WorkflowSandboxTargetBindingWire[],
  fetchImplementation: typeof globalThis.fetch,
  secretProvider?: SecretProvider,
) {
  for (const target of targets) {
    if (target.secretAlias) {
      if (!secretProvider) {
        return `Sandbox target '${target.targetKey}' requires worker secret alias '${target.secretAlias}', but no worker secret provider is configured.`;
      }
      try {
        await secretProvider.getSecret(target.secretAlias);
      } catch {
        return `Sandbox target '${target.targetKey}' is missing worker secret alias '${target.secretAlias}'.`;
      }
    }
    let url: URL;
    try {
      url = new URL(target.healthPath, `${target.baseUrl.replace(/\/$/, '')}/`);
    } catch {
      return `Sandbox target '${target.targetKey}' has invalid connection metadata.`;
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.hostname !== target.hostname ||
      url.username ||
      url.password
    ) {
      return `Sandbox target '${target.targetKey}' violates its validated network boundary.`;
    }
    try {
      const response = await fetchImplementation(url, { redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        return `Sandbox target '${target.targetKey}' health redirect was denied by the validated network boundary.`;
      }
      if (!response.ok) {
        return `Sandbox target '${target.targetKey}' health check failed (${response.status}).`;
      }
    } catch {
      return `Sandbox target '${target.targetKey}' is unreachable from the customer worker.`;
    }
    try {
      await seedSandboxTarget(
        fetchImplementation,
        target.baseUrl,
        target.targetState,
        target.controlPaths.resources,
        target.hostname,
      );
      const observations = await readProviderObservations(fetchImplementation, target);
      const unmetAssumption = target.setupAssumptions.find(
        ({ path, equals }) =>
          JSON.stringify(valueAtPath(observations, path)) !== JSON.stringify(equals),
      );
      if (unmetAssumption) {
        return `Sandbox target '${target.targetKey}' does not satisfy test-data profile '${target.testDataProfileKey}' version ${target.testDataVersion} at '${unmetAssumption.path.join('.')}'.`;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown control failure';
      return `Sandbox target '${target.targetKey}' cannot apply or validate test-data profile '${target.testDataProfileKey}' version ${target.testDataVersion}: ${reason}.`;
    }
  }
  return undefined;
}

function valueAtPath(value: unknown, path: readonly (string | number)[]) {
  return path.reduce<unknown>((current, segment) => {
    if (typeof segment === 'number') return Array.isArray(current) ? current[segment] : undefined;
    return current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[segment]
      : undefined;
  }, value);
}

async function runFallbackChecks(
  fetchImplementation: typeof globalThis.fetch,
  baseUrl: string,
  suite: WorkflowSandboxSuiteWire,
) {
  if (suite.tests.length === 0) return [];
  const response = await fetchImplementation(
    new URL('/__control/workflow-sandbox-tests', `${baseUrl.replace(/\/$/, '')}/`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(suite),
    },
  );
  if (!response.ok) throw new Error(`Fallback sandbox checks failed (${response.status})`);
  const body = (await response.json()) as { outcomes?: UnboundWorkflowSandboxOutcome[] };
  if (!Array.isArray(body.outcomes))
    throw new TypeError('Fallback sandbox returned invalid results');
  return body.outcomes;
}
