import { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StepActivityError, UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE } from '@atlas/runtime-ports';
import {
  createCompiledWorkflowVersion,
  createTransformationCompiledWorkflowVersion,
  createGraphCompiledWorkflowVersion,
  type CompiledWorkflowVersion,
} from '@atlas/workflow-ir';

import {
  createEncryptedDataConverter,
  createTemporalWorker,
  INTERPRETER_WORKFLOW,
  replayTemporalHistory,
  type StepAttempt,
} from './index.js';

const taskQueue = 'issue-20-interpreter';
const dataConverter = createEncryptedDataConverter(Buffer.alloc(32, 80).toString('base64'));
let environment: TestWorkflowEnvironment;

function hardcodedWorkflow(): CompiledWorkflowVersion {
  return {
    workflowVersionId: 'payment-to-billing@1',
    irHash: 'ea5e065d9cfc298ab279c4a5618514b98ce45b665a4c238e674911e428d99a19',
    executionRequirements: {
      organizationId: 'org_atlas_demo',
      workflowVersionId: 'payment-to-billing@1',
      irHash: 'ea5e065d9cfc298ab279c4a5618514b98ce45b665a4c238e674911e428d99a19',
      requiredCapabilityVersionIds: ['billing.settle@v1', 'payment.get@v1'],
    },
    executable: {
      irVersion: 1,
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'payment.get@v1',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          result: 'payment',
        },
        {
          id: 'settle-invoice',
          kind: 'capabilityCall',
          capabilityVersionId: 'billing.settle@v1',
          arguments: {
            invoiceId: {
              source: 'stepOutput',
              stepId: 'load-payment',
              path: ['invoiceId'],
            },
          },
        },
      ],
    },
  };
}

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createTimeSkipping({ client: { dataConverter } });
}, 60_000);

afterAll(async () => {
  await environment.teardown();
});

describe('generic Temporal interpreter', () => {
  it('reports a fast completion durably and retries the same outcome', async () => {
    const workflow = await createCompiledWorkflowVersion('reported@1', 'org_atlas_demo', {
      irVersion: 1,
      steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
    });
    const events: unknown[] = [];
    let completionAttempts = 0;
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep() {
          throw new Error('No steps expected');
        },
      },
      runReporter: {
        async recordRunStarted(input) {
          events.push({ event: 'started', ...input });
        },
        async recordRunOutcome(input) {
          events.push({ event: 'ended', ...input });
          if (++completionAttempts === 1) throw new Error('Backend temporarily unavailable');
        },
      },
    });
    const handle = await environment.client.workflow.start(INTERPRETER_WORKFLOW, {
      workflowId: 'reported-fast-completion',
      taskQueue,
      args: [{ workflow, input: {}, lifecycle: { workflowName: 'Fast workflow' } }],
    });
    await expect(worker.runUntil(handle.result())).resolves.toEqual({ state: 'completed' });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ event: 'started', workflowName: 'Fast workflow' });
    expect(events[1]).toMatchObject({
      event: 'ended',
      state: 'completed',
      durationMs: expect.any(Number),
    });
    expect(events[2]).toEqual(events[1]);
    await replayTemporalHistory(await handle.fetchHistory(), dataConverter);
  }, 30_000);

  it('delivers a pending completion after replacing the worker without repeating execution', async () => {
    const events: unknown[] = [];
    const effects: string[] = [];
    let reportAttempted!: () => void;
    const firstReport = new Promise<void>((resolve) => {
      reportAttempted = resolve;
    });
    const activities = {
      async invokeStep(invocation: { stepId: string }) {
        effects.push(invocation.stepId);
        return { invoiceId: 'inv_reporting_restart' };
      },
    };
    const firstWorker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      maxCachedWorkflows: 0,
      activities,
      runReporter: {
        async recordRunStarted(input) {
          events.push({ event: 'started', ...input });
        },
        async recordRunOutcome(input) {
          events.push({ event: 'ended', ...input });
          reportAttempted();
          throw new Error('Backend temporarily unavailable');
        },
      },
    });
    const firstWorkerRun = firstWorker.runUntil(firstReport);
    const handle = await environment.client.workflow.start(INTERPRETER_WORKFLOW, {
      workflowId: 'pending-completion-after-restart',
      taskQueue,
      args: [
        {
          workflow: hardcodedWorkflow(),
          input: { paymentId: 'pay_reporting_restart' },
          lifecycle: { workflowName: 'Reported payment' },
        },
      ],
    });
    await firstWorkerRun;
    const replacementWorker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities,
      runReporter: {
        async recordRunStarted(input) {
          events.push({ event: 'started', ...input });
        },
        async recordRunOutcome(input) {
          events.push({ event: 'ended', ...input });
        },
      },
    });
    await expect(replacementWorker.runUntil(handle.result())).resolves.toEqual({
      state: 'completed',
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ event: 'started' });
    expect(events[2]).toEqual(events[1]);
    expect(effects).toEqual(['load-payment', 'settle-invoice']);
    await replayTemporalHistory(await handle.fetchHistory(), dataConverter);
  }, 30_000);

  it('recovers and compensates graph steps in execution order rather than array order', async () => {
    const calls: string[] = [];
    const workflow = await createGraphCompiledWorkflowVersion(
      'graph-recovery@1',
      'org_atlas_demo',
      {
        irVersion: 3,
        startStepId: 'load',
        steps: [
          { id: 'done', kind: 'terminal', state: 'completed' },
          {
            id: 'undo-load',
            kind: 'compensation',
            compensatesStepId: 'load',
            capabilityVersionId: 'undo@1',
            arguments: { version: { source: 'stepOutput', stepId: 'load', path: ['version'] } },
            inputSchema: { required: { version: { type: 'number' } } },
          },
          {
            id: 'save',
            kind: 'capabilityCall',
            capabilityVersionId: 'save@1',
            inputSchema: { required: { version: { type: 'number' } } },
            arguments: { version: { source: 'stepOutput', stepId: 'load', path: ['version'] } },
            next: 'done',
            retryPolicy: {
              initialInterval: '1 millisecond',
              maximumInterval: '1 millisecond',
              backoffCoefficient: 1,
              maximumAttempts: 1,
              nonRetryableErrorTypes: ['Stale'],
            },
            errorRouting: {
              rules: [],
              defaultAction: {
                kind: 'revalidateFrom',
                targetStepId: 'load',
                maxRevalidations: 1,
                onExhausted: {
                  kind: 'compensateThenLand',
                  outcome: 'manual_review',
                  reasonCode: 'still-stale',
                },
              },
            },
          },
          {
            id: 'load',
            kind: 'capabilityCall',
            capabilityVersionId: 'load@1',
            inputSchema: { required: {} },
            arguments: {},
            responseSchema: { required: { version: { type: 'number' } } },
            next: 'save',
          },
        ],
      },
    );
    let version = 0;
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          calls.push(invocation.stepId);
          if (invocation.stepId === 'load') return { version: ++version };
          expect(invocation.input).toEqual({ version });
          if (invocation.stepId === 'save') throw new StepActivityError('Stale');
          return {};
        },
      },
    });
    const handle = await environment.client.workflow.start(INTERPRETER_WORKFLOW, {
      workflowId: 'graph-recovery',
      taskQueue,
      args: [{ workflow, input: {} }],
    });
    await expect(worker.runUntil(handle.result())).resolves.toEqual({
      state: 'manual_review',
      failure: { bucket: 'permanent-operational', type: 'Stale', stepId: 'save' },
      visitedStepIds: ['load', 'save', 'load', 'save'],
    });
    expect(calls).toEqual(['load', 'save', 'load', 'save', 'undo-load']);
    await replayTemporalHistory(await handle.fetchHistory(), dataConverter);
  }, 30_000);

  it.each([true, false])(
    'executes and replays the selected graph route (ready=%s)',
    async (ready) => {
      const calls: string[] = [];
      const workflow = await createGraphCompiledWorkflowVersion(
        `graph-${ready}@1`,
        'org_atlas_demo',
        {
          irVersion: 3,
          startStepId: 'prepare',
          inputSchema: { required: { ready: { type: 'boolean' }, name: { type: 'string' } } },
          steps: [
            {
              id: 'done',
              kind: 'terminal',
              state: 'completed',
              output: { source: 'stepOutput', stepId: 'prepare', path: [] },
            },
            {
              id: 'prepare',
              kind: 'transform',
              arguments: {
                greeting: {
                  kind: 'call',
                  function: 'uppercase',
                  arguments: [{ source: 'input', path: ['name'] }],
                },
              },
              responseSchema: { required: { greeting: { type: 'string' } } },
              next: 'choose',
            },
            {
              id: 'choose',
              kind: 'condition',
              condition: {
                left: { source: 'input', path: ['ready'] },
                operator: 'equals',
                right: { source: 'literal', value: true },
              },
              whenTrue: 'call',
              whenFalse: 'wait',
            },
            {
              id: 'call',
              kind: 'capabilityCall',
              capabilityVersionId: 'greet@1',
              inputSchema: { required: { greeting: { type: 'string' } } },
              arguments: {
                greeting: { source: 'stepOutput', stepId: 'prepare', path: ['greeting'] },
              },
              next: 'done',
            },
            { id: 'wait', kind: 'sleep', durationMs: 3_600_000, next: 'done' },
          ],
        },
      );
      const worker = await createTemporalWorker({
        connection: environment.nativeConnection,
        taskQueue,
        dataConverter,
        activities: {
          async invokeStep(invocation) {
            calls.push(invocation.stepId);
            expect(invocation.input).toEqual({ greeting: 'ATLAS' });
            return { ignored: true };
          },
        },
      });
      const handle = await environment.client.workflow.start(INTERPRETER_WORKFLOW, {
        workflowId: `graph-selected-route-${ready}`,
        taskQueue,
        args: [{ workflow, input: { ready, name: 'Atlas' }, returnFinalOutput: true }],
      });
      await expect(worker.runUntil(handle.result())).resolves.toEqual({
        state: 'completed',
        output: { greeting: 'ATLAS' },
        visitedStepIds: ['prepare', 'choose', ready ? 'call' : 'wait', 'done'],
      });
      expect(calls).toEqual(ready ? ['call'] : []);
      const history = await handle.fetchHistory();
      expect(
        history.events?.some(
          (event) =>
            event.timerStartedEventAttributes !== null &&
            event.timerStartedEventAttributes !== undefined,
        ),
      ).toBe(!ready);
      await replayTemporalHistory(history, dataConverter);
    },
    30_000,
  );

  it('returns the complete fifth capability response for an API workflow', async () => {
    const calls: string[] = [];
    const workflow = await createTransformationCompiledWorkflowVersion(
      'api-five@1',
      'org_atlas_demo',
      {
        irVersion: 2,
        steps: [
          ...Array.from({ length: 5 }, (_, index) => ({
            id: `step-${index + 1}`,
            kind: 'capabilityCall' as const,
            capabilityVersionId: `capability-${index + 1}@v1`,
            arguments: {},
            inputSchema: { required: {} },
          })),
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      },
    );
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          calls.push(invocation.stepId);
          if (invocation.stepId === 'step-5') expect(invocation.outputProjection).toBeUndefined();
          return { from: invocation.stepId, details: { receipt: 'receipt-5' } };
        },
      },
    });
    const handle = await environment.client.workflow.start(INTERPRETER_WORKFLOW, {
      workflowId: 'api-five-final-response',
      taskQueue,
      args: [{ workflow, input: {}, returnFinalOutput: true }],
    });
    await expect(worker.runUntil(handle.result())).resolves.toEqual({
      state: 'completed',
      output: { from: 'step-5', details: { receipt: 'receipt-5' } },
    });
    expect(calls).toEqual(['step-1', 'step-2', 'step-3', 'step-4', 'step-5']);
    await replayTemporalHistory(await handle.fetchHistory(), dataConverter);
  }, 30_000);

  it('executes a hardcoded two-step IR to completed', async () => {
    const effects: string[] = [];
    const approvedHosts: Array<readonly string[] | undefined> = [];
    const workflow = hardcodedWorkflow();
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          effects.push(`${invocation.stepId}:${JSON.stringify(invocation.input)}`);
          approvedHosts.push(invocation.approvedHostnames);
          return invocation.stepId === 'load-payment' ? { invoiceId: 'inv_1' } : {};
        },
      },
    });

    const result = await worker.runUntil(
      environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
        workflowId: 'payment-pay_1',
        taskQueue,
        args: [{ workflow, input: { paymentId: 'pay_1' } }],
      }),
    );

    expect(result).toEqual({ state: 'completed' });
    expect(effects).toEqual([
      'load-payment:{"paymentId":"pay_1"}',
      'settle-invoice:{"invoiceId":"inv_1"}',
    ]);
    expect(approvedHosts).toEqual([undefined, undefined]);
  }, 15_000);

  it('survives worker replacement mid-run without repeating completed steps', async () => {
    const effects: string[] = [];
    const workflowId = 'payment-pay_replay';
    let markFirstStepCompleted!: () => void;
    const firstStepCompleted = new Promise<void>((resolve) => {
      markFirstStepCompleted = resolve;
    });
    const firstWorker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      maxCachedWorkflows: 0,
      activities: {
        async invokeStep(invocation) {
          if (invocation.stepId === 'load-payment') {
            effects.push(invocation.stepId);
            markFirstStepCompleted();
            return { invoiceId: 'inv_replay' };
          }
          throw new Error('Replacement worker required for the remaining step');
        },
      },
    });

    const firstWorkerRun = firstWorker.runUntil(firstStepCompleted);
    const handle = await environment.client.workflow.start(INTERPRETER_WORKFLOW, {
      workflowId,
      taskQueue,
      args: [{ workflow: hardcodedWorkflow(), input: { paymentId: 'pay_replay' } }],
    });
    await firstWorkerRun;

    const replacementWorker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          effects.push(invocation.stepId);
          return {};
        },
      },
    });
    const replacementWorkerRun = replacementWorker.run();
    let result;
    try {
      result = await handle.result();
    } finally {
      replacementWorker.shutdown();
      await replacementWorkerRun.catch(() => undefined);
    }
    expect(result).toEqual({ state: 'completed' });
    expect(effects).toEqual(['load-payment', 'settle-invoice']);

    const history = await handle.fetchHistory();
    await replayTemporalHistory(history, dataConverter);

    expect(effects).toEqual(['load-payment', 'settle-invoice']);
  }, 30_000);

  it('evaluates an IR v2 payment mapping before scheduling and replays deterministically', async () => {
    const effects: string[] = [];
    const outputProjections: Array<readonly (readonly string[])[] | undefined> = [];
    const workflow = await createTransformationCompiledWorkflowVersion(
      'transformed-payment-to-billing@1',
      'org_atlas_demo',
      {
        irVersion: 2,
        steps: [
          {
            id: 'load-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payment.get@v1',
            inputSchema: { required: { paymentId: { type: 'string' } } },
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
            result: 'payment',
          },
          {
            id: 'settle-invoice',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.settle@v1',
            inputSchema: {
              required: {
                invoice: {
                  type: 'object',
                  required: {
                    reference: { type: 'string' },
                    amount: {
                      type: 'object',
                      required: {
                        currency: { type: 'string' },
                        units: { type: 'number' },
                      },
                    },
                  },
                },
              },
            },
            arguments: {
              invoice: {
                kind: 'object',
                fields: {
                  reference: {
                    kind: 'call',
                    function: 'uppercase',
                    arguments: [
                      { source: 'stepOutput', stepId: 'load-payment', path: ['invoiceId'] },
                    ],
                  },
                  amount: {
                    kind: 'object',
                    fields: {
                      currency: {
                        kind: 'call',
                        function: 'uppercase',
                        arguments: [
                          { source: 'stepOutput', stepId: 'load-payment', path: ['currency'] },
                        ],
                      },
                      units: {
                        kind: 'call',
                        function: 'divide',
                        arguments: [
                          { source: 'stepOutput', stepId: 'load-payment', path: ['amountCents'] },
                          { source: 'literal', value: 100 },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    );
    const workflowId = 'transformed-payment-pay_1';
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          effects.push(`${invocation.stepId}:${JSON.stringify(invocation.input)}`);
          outputProjections.push(invocation.outputProjection);
          return invocation.stepId === 'load-payment'
            ? {
                invoiceId: 'inv_1',
                currency: 'usd',
                amountCents: 1250,
                restrictedToken: 'restricted-history-value',
                largeDocument: 'x'.repeat(512 * 1_024),
              }
            : {};
        },
      },
    });
    const handle = await environment.client.workflow.start(INTERPRETER_WORKFLOW, {
      workflowId,
      taskQueue,
      args: [{ workflow, input: { paymentId: 'pay_1' } }],
    });

    await expect(worker.runUntil(handle.result())).resolves.toEqual({ state: 'completed' });
    expect(effects).toEqual([
      'load-payment:{"paymentId":"pay_1"}',
      'settle-invoice:{"invoice":{"reference":"INV_1","amount":{"currency":"USD","units":12.5}}}',
    ]);
    expect(outputProjections[0]).toEqual([['amountCents'], ['currency'], ['invoiceId']]);
    expect(outputProjections[1]).toEqual([]);

    const history = await handle.fetchHistory();
    expect(JSON.stringify(history)).not.toContain('restricted-history-value');
    await replayTemporalHistory(history, dataConverter);
    expect(effects).toHaveLength(2);
  }, 30_000);

  it('lands a provider failure as a reported result and unwinds completed compensations', async () => {
    const effects: string[] = [];
    const retryPolicy = {
      initialInterval: '1 millisecond',
      backoffCoefficient: 1,
      maximumInterval: '1 millisecond',
      maximumAttempts: 2,
      nonRetryableErrorTypes: ['AuthenticationFailed'],
      failureBuckets: { AuthenticationFailed: 'permanent-operational' as const },
    };
    const workflow = await createCompiledWorkflowVersion(
      'compensated-settlement@1',
      'org_atlas_demo',
      {
        irVersion: 1,
        steps: [
          {
            id: 'begin-settlement',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.begin@v1',
            arguments: { invoiceId: { source: 'input', path: ['invoiceId'] } },
            retryPolicy,
          },
          {
            id: 'cancel-settlement',
            kind: 'compensation',
            compensatesStepId: 'begin-settlement',
            capabilityVersionId: 'billing.cancel@v1',
            arguments: {
              settlementId: {
                source: 'stepOutput',
                stepId: 'begin-settlement',
                path: ['settlementId'],
              },
            },
            retryPolicy,
          },
          {
            id: 'mark-paid',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.mark@v1',
            arguments: { invoiceId: { source: 'input', path: ['invoiceId'] } },
            retryPolicy,
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      },
    );
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          effects.push(`${invocation.stepId}:${JSON.stringify(invocation.input)}`);
          if (invocation.stepId === 'mark-paid') {
            throw new StepActivityError('AuthenticationFailed');
          }
          return { settlementId: 'settle_1' };
        },
      },
    });

    const result = await worker.runUntil(
      environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
        workflowId: 'compensated-settlement-inv_1',
        taskQueue,
        args: [{ workflow, input: { invoiceId: 'inv_1' } }],
      }),
    );

    expect(result).toEqual({
      state: 'repair_required',
      failure: {
        bucket: 'permanent-operational',
        type: 'AuthenticationFailed',
        stepId: 'mark-paid',
      },
    });
    expect(effects).toEqual([
      'begin-settlement:{"invoiceId":"inv_1"}',
      'mark-paid:{"invoiceId":"inv_1"}',
      'cancel-settlement:{"settlementId":"settle_1"}',
    ]);
  }, 15_000);

  it('honors declared error routing instead of the default saga unwind', async () => {
    const effects: string[] = [];
    const singleAttempt = {
      initialInterval: '1 millisecond',
      backoffCoefficient: 1,
      maximumInterval: '1 millisecond',
      maximumAttempts: 1,
      nonRetryableErrorTypes: [],
    };
    const workflow = await createCompiledWorkflowVersion('routed-settlement@1', 'org_atlas_demo', {
      irVersion: 1,
      steps: [
        {
          id: 'begin-settlement',
          kind: 'capabilityCall',
          capabilityVersionId: 'billing.begin@v1',
          arguments: { invoiceId: { source: 'input', path: ['invoiceId'] } },
          retryPolicy: singleAttempt,
        },
        {
          id: 'cancel-settlement',
          kind: 'compensation',
          compensatesStepId: 'begin-settlement',
          capabilityVersionId: 'billing.cancel@v1',
          arguments: { invoiceId: { source: 'input', path: ['invoiceId'] } },
          retryPolicy: singleAttempt,
        },
        {
          id: 'mark-paid',
          kind: 'capabilityCall',
          capabilityVersionId: 'billing.mark@v1',
          arguments: { invoiceId: { source: 'input', path: ['invoiceId'] } },
          retryPolicy: singleAttempt,
          errorRouting: {
            rules: [
              {
                errorTypes: ['InvoiceVersionStale'],
                action: {
                  kind: 'revalidateFrom',
                  targetStepId: 'begin-settlement',
                  maxRevalidations: 1,
                  onExhausted: {
                    kind: 'preserveAndLand',
                    outcome: 'manual_review',
                    reasonCode: 'revalidation-exhausted',
                  },
                },
              },
            ],
            defaultAction: {
              kind: 'land',
              outcome: 'repair_required',
              reasonCode: 'unexpected-failure',
            },
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          effects.push(invocation.stepId);
          if (invocation.stepId === 'mark-paid') throw new StepActivityError('InvoiceVersionStale');
          return {};
        },
      },
    });

    const result = await worker.runUntil(
      environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
        workflowId: 'routed-settlement-inv_1',
        taskQueue,
        args: [{ workflow, input: { invoiceId: 'inv_1' } }],
      }),
    );

    expect(result).toEqual({
      state: 'manual_review',
      failure: {
        bucket: 'retryable-transient',
        type: 'InvoiceVersionStale',
        stepId: 'mark-paid',
      },
    });
    expect(effects).toEqual(['begin-settlement', 'mark-paid', 'begin-settlement', 'mark-paid']);
  }, 15_000);

  it('fails fast without retries when the worker has no binding for a capability', async () => {
    const effects: string[] = [];
    const workflow = await createCompiledWorkflowVersion('unbound-capability@1', 'org_atlas_demo', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'payment.get@v-unbound',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          retryPolicy: {
            initialInterval: '1 millisecond',
            backoffCoefficient: 1,
            maximumInterval: '1 millisecond',
            maximumAttempts: 3,
            nonRetryableErrorTypes: [],
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          effects.push(invocation.stepId);
          throw new StepActivityError(
            UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE,
            `No HTTP binding for ${invocation.capabilityVersionId}`,
          );
        },
      },
    });

    const result = await worker.runUntil(
      environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
        workflowId: 'unbound-capability-pay_1',
        taskQueue,
        args: [{ workflow, input: { paymentId: 'pay_1' } }],
      }),
    );

    expect(result).toEqual({
      state: 'repair_required',
      failure: {
        bucket: 'permanent-operational',
        type: UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE,
        stepId: 'get-payment',
      },
    });
    expect(effects).toEqual(['get-payment']);
  }, 15_000);

  it('uses the generic fallback for a malformed provider failure type', async () => {
    const attempts: StepAttempt[] = [];
    const workflow = await createCompiledWorkflowVersion(
      'malformed-provider-failure@1',
      'org_atlas_demo',
      {
        irVersion: 1,
        steps: [
          {
            id: 'get-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payment.get@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
            retryPolicy: {
              initialInterval: '1 millisecond',
              backoffCoefficient: 1,
              maximumInterval: '1 millisecond',
              maximumAttempts: 1,
              nonRetryableErrorTypes: [],
            },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      },
    );
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep() {
          throw new StepActivityError(' ');
        },
      },
      stepAttemptReporter: {
        async recordStepAttempt(attempt) {
          attempts.push(attempt);
        },
      },
    });

    const result = await worker.runUntil(
      environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
        workflowId: 'malformed-provider-failure-pay_1',
        taskQueue,
        args: [{ workflow, input: { paymentId: 'pay_1' } }],
      }),
    );

    expect(result).toEqual({
      state: 'repair_required',
      failure: {
        bucket: 'retryable-transient',
        type: 'UnknownOperationalFailure',
        stepId: 'get-payment',
      },
    });
    expect(attempts).toEqual([
      expect.objectContaining({
        stepId: 'get-payment',
        status: 'failed',
        failureType: 'UnknownOperationalFailure',
        redactedInput: { paymentId: '[REDACTED]' },
      }),
    ]);
  }, 15_000);

  it('does not schedule a capability when a transformed payload fails its pinned schema', async () => {
    const effects: string[] = [];
    const workflow = await createTransformationCompiledWorkflowVersion(
      'invalid-transformed-payment@1',
      'org_atlas_demo',
      {
        irVersion: 2,
        steps: [
          {
            id: 'settle-invoice',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.settle@v1',
            inputSchema: { required: { amount: { type: 'number' } } },
            arguments: { amount: { source: 'literal', value: 'not-a-number' } },
          },
        ],
      },
    );
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          effects.push(invocation.stepId);
          return {};
        },
      },
    });

    await expect(
      worker.runUntil(
        environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
          workflowId: 'invalid-transformed-payment-pay_1',
          taskQueue,
          args: [{ workflow, input: {} }],
        }),
      ),
    ).rejects.toThrow('Workflow execution failed');
    expect(effects).toEqual([]);
  }, 15_000);
});
