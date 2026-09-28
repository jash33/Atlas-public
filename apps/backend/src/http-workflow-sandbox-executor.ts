import {
  workflowSandboxExecutionMethods,
  workflowSandboxTestKinds,
  type WorkflowSandboxOutcomeWire,
  type WorkflowSandboxSuiteWire,
} from '@atlas/demo-estate';
import { z } from 'zod';

import {
  WorkflowSandboxTestsUnavailable,
  WorkflowSandboxExecutionFailed,
  type WorkflowSandboxExecutor,
} from './workflow-sandbox.js';

const responseSchema = z.object({
  outcomes: z.array(
    z.object({
      testId: z.string().min(1),
      status: z.enum(['passed', 'failed']),
      workerVersion: z.string().min(1),
      runtimeVersion: z.string().min(1),
      executionMethods: z.array(z.enum(workflowSandboxExecutionMethods)).min(1),
      detail: z.string().optional(),
      temporalWorkflowId: z.string().min(1).optional(),
      temporalRunId: z.string().min(1).optional(),
      terminalOutcome: z
        .enum(['completed', 'validation_failed', 'manual_review', 'repair_required'])
        .optional(),
      attempts: z
        .array(
          z.object({
            stepId: z.string().min(1),
            attempt: z.number().int().positive(),
            status: z.number().int(),
          }),
        )
        .optional(),
      temporalHistory: z
        .object({
          scheduledActivities: z.number().int().nonnegative(),
          completedActivities: z.number().int().nonnegative(),
          failedActivities: z.number().int().nonnegative(),
          timedOutActivities: z.number().int().nonnegative(),
        })
        .optional(),
      providerObservations: z
        .object({
          sideEffectCount: z.number().int().nonnegative(),
          invoiceStates: z.array(
            z.object({ status: z.string().min(1), version: z.number().int().nonnegative() }),
          ),
          billingMutations: z.array(
            z.object({
              operationId: z.string().min(1),
              outcome: z.string().min(1),
              replayed: z.boolean(),
            }),
          ),
          compensationOrder: z.array(z.string().min(1)),
        })
        .optional(),
      targetEvidence: z
        .array(
          z.object({
            capabilityVersionId: z.string().min(1),
            targetKey: z.string().min(1),
            targetRevision: z.number().int().positive(),
            testDataProfileKey: z.string().min(1),
            testDataVersion: z.number().int().positive(),
          }),
        )
        .optional(),
    }),
  ),
});

const progressSchema = z.object({
  phase: z.enum(['preparing', 'running', 'finalizing']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  currentTest: z
    .object({
      kind: z.enum(workflowSandboxTestKinds),
      stepId: z.string().min(1).nullable(),
    })
    .optional(),
});

async function readWorkerStream(
  response: Response,
  input: Parameters<WorkflowSandboxExecutor['execute']>[0],
): Promise<unknown> {
  if (!response.body) throw new WorkflowSandboxTestsUnavailable('unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let completed = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      input.signal?.throwIfAborted();
      const chunk = await reader.read();
      input.signal?.throwIfAborted();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      // Bound a damaged stream without retaining provider payloads in diagnostics.
      if (pending.length > 4 * 1024 * 1024)
        throw new WorkflowSandboxTestsUnavailable('unavailable');
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1 || (chunk.done && pending.length > 0)) {
        const line = end === -1 ? pending : pending.slice(0, end);
        pending = end === -1 ? '' : pending.slice(end + 1);
        if (!line.trim()) continue;
        const event: unknown = JSON.parse(line);
        if (!event || typeof event !== 'object' || !('type' in event))
          throw new WorkflowSandboxTestsUnavailable('unavailable');
        if (event.type === 'result') return event;
        if (event.type === 'error' && 'error' in event) {
          if (event.error === 'invalid-workflow-sandbox-test')
            throw new TypeError('Provider sandbox test runner rejected the suite');
          if (event.error === 'workflow-sandbox-execution-failed')
            throw new WorkflowSandboxExecutionFailed(
              'The worker could not complete sandbox execution',
            );
        }
        if (event.type !== 'progress' || !('progress' in event))
          throw new WorkflowSandboxTestsUnavailable('unavailable');
        const parsed = progressSchema.safeParse(event.progress);
        if (!parsed.success) throw new WorkflowSandboxTestsUnavailable('unavailable');
        const progress = parsed.data;
        if (
          progress.total !== input.tests.length ||
          progress.completed < completed ||
          progress.completed > progress.total ||
          (progress.currentTest &&
            !input.tests.some(
              (test) =>
                test.kind === progress.currentTest!.kind &&
                test.stepId === progress.currentTest!.stepId,
            ))
        )
          throw new WorkflowSandboxTestsUnavailable('unavailable');
        completed = progress.completed;
        input.onProgress?.({
          phase: progress.phase,
          completed,
          total: progress.total,
          ...(progress.currentTest ? { currentTest: progress.currentTest } : {}),
        });
      }
      if (chunk.done) throw new WorkflowSandboxTestsUnavailable('unavailable');
    }
  } finally {
    input.signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createHttpWorkflowSandboxExecutor(
  baseUrl: string | Readonly<Record<string, string>>,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): WorkflowSandboxExecutor {
  return {
    async execute(input) {
      const suite: WorkflowSandboxSuiteWire = {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workflowVersionId: input.workflowVersionId,
        irHash: input.irHash,
        workflow: input.workflow,
        providerContracts: [...input.providerContracts],
        tests: [...input.tests],
        targetBindings: input.targetBindings.map((binding) => ({
          ...binding,
          controlPaths: { ...binding.controlPaths },
          inputs: { ...binding.inputs },
          targetState: { ...binding.targetState },
          setupAssumptions: binding.setupAssumptions.map((assumption) => ({
            ...assumption,
            path: [...assumption.path],
          })),
        })),
      };
      const selectedBaseUrl = typeof baseUrl === 'string' ? baseUrl : baseUrl[input.environmentId];
      if (!selectedBaseUrl) {
        throw new Error(`No sandbox worker is configured for '${input.environmentId}'`);
      }
      let response: Response;
      try {
        response = await fetchImplementation(`${selectedBaseUrl}/v1/workflow-sandbox-tests`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
          body: JSON.stringify(suite),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch (error) {
        if (input.signal?.aborted) throw error;
        throw new WorkflowSandboxTestsUnavailable('unavailable');
      }
      if (!response.ok) {
        console.error('workflow-sandbox-worker-http-failed', { status: response.status });
        if (response.status === 500) {
          throw new WorkflowSandboxExecutionFailed(
            'The worker could not complete sandbox execution',
          );
        }
        if (response.status === 400) {
          throw new TypeError('Provider sandbox test runner rejected the suite');
        }
        throw new WorkflowSandboxTestsUnavailable('unavailable');
      }
      let body: unknown;
      try {
        body = response.headers.get('content-type')?.includes('application/x-ndjson')
          ? await readWorkerStream(response, input)
          : await response.json();
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason;
        if (error instanceof WorkflowSandboxExecutionFailed) throw error;
        if (
          error instanceof TypeError &&
          error.message === 'Provider sandbox test runner rejected the suite'
        )
          throw error;
        console.error('workflow-sandbox-worker-response-invalid', { category: 'invalid-json' });
        throw new WorkflowSandboxTestsUnavailable('unavailable');
      }
      const parsed = responseSchema.safeParse(body);
      if (!parsed.success) {
        console.error('workflow-sandbox-worker-response-invalid', {
          issues: parsed.error.issues.map(({ code, path }) => ({ code, path })),
        });
        throw new WorkflowSandboxTestsUnavailable('unavailable');
      }
      return parsed.data.outcomes.map<WorkflowSandboxOutcomeWire>((outcome) => ({
        testId: outcome.testId,
        status: outcome.status,
        workerVersion: outcome.workerVersion,
        runtimeVersion: outcome.runtimeVersion,
        executionMethods: outcome.executionMethods,
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
        ...(outcome.temporalWorkflowId === undefined
          ? {}
          : { temporalWorkflowId: outcome.temporalWorkflowId }),
        ...(outcome.temporalRunId === undefined ? {} : { temporalRunId: outcome.temporalRunId }),
        ...(outcome.terminalOutcome === undefined
          ? {}
          : { terminalOutcome: outcome.terminalOutcome }),
        ...(outcome.attempts === undefined ? {} : { attempts: outcome.attempts }),
        ...(outcome.temporalHistory === undefined
          ? {}
          : { temporalHistory: outcome.temporalHistory }),
        ...(outcome.providerObservations === undefined
          ? {}
          : { providerObservations: outcome.providerObservations }),
        ...(outcome.targetEvidence === undefined ? {} : { targetEvidence: outcome.targetEvidence }),
      }));
    },
  };
}
