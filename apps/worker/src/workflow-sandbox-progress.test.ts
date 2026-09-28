import type { WorkflowSandboxProgressWire, WorkflowSandboxSuiteWire } from '@atlas/demo-estate';
import { createGraphCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { expect, it } from 'vite-plus/test';

import { InvalidWorkflowSandboxRequest } from './app.js';
import { createWorkflowSandboxRunner } from './workflow-sandbox.js';

async function progressSuite(): Promise<WorkflowSandboxSuiteWire> {
  const workflow = await createGraphCompiledWorkflowVersion('progress@1', 'org', {
    irVersion: 3,
    startStepId: 'call',
    steps: [
      {
        id: 'call',
        kind: 'capabilityCall',
        capabilityVersionId: 'call@1',
        arguments: {},
        inputSchema: { required: {} },
        next: 'done',
      },
      { id: 'done', kind: 'terminal', state: 'completed' },
    ],
  });
  return {
    organizationId: 'org',
    environmentId: 'development',
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    workflow,
    providerContracts: [
      {
        capabilityVersionId: 'call@1',
        serviceId: 'service',
        operationId: 'call',
        documentHash: 'a'.repeat(64),
        provider: 'test-provider',
        mode: 'local',
        method: 'post',
        path: '/call',
        requestSchema: null,
        responseSchema: null,
      },
    ],
    targetBindings: [
      {
        capabilityVersionId: 'call@1',
        targetKey: 'connected',
        targetRevision: 1,
        baseUrl: 'http://connected.test',
        hostname: 'connected.test',
        healthPath: '/health',
        controlPaths: { resources: '/resources', faults: '/faults', observations: '/observations' },
        secretAlias: null,
        testDataProfileKey: 'sample',
        testDataVersion: 1,
        inputs: {},
        targetState: { mode: 'replace', resources: [] },
        setupAssumptions: [{ path: ['setup', 'ready'], equals: true }],
      },
    ],
    tests: [
      {
        testId: 'happy-path',
        kind: 'happy-path',
        stepId: null,
        capabilityVersionId: null,
        expectation: 'Complete the workflow',
        requestSample: null,
        expectedResponseSchema: null,
      },
      {
        testId: 'static',
        kind: 'compatibility',
        stepId: 'call',
        capabilityVersionId: 'call@1',
        expectation: 'Check connected contract',
        requestSample: {},
        expectedResponseSchema: null,
      },
      {
        testId: 'fallback',
        kind: 'compatibility',
        stepId: 'legacy',
        capabilityVersionId: 'legacy@1',
        expectation: 'Check fallback contract',
        requestSample: {},
        expectedResponseSchema: null,
      },
    ],
  };
}

it('reports completed static and fallback checks while runtime setup and execution are still pending', async () => {
  const suite = await progressSuite();
  const progress: WorkflowSandboxProgressWire[] = [];
  const fallbackStarted = Promise.withResolvers<void>();
  const fallbackReady = Promise.withResolvers<void>();
  const resetStarted = Promise.withResolvers<void>();
  const resetReady = Promise.withResolvers<void>();
  const runtimeStarted = Promise.withResolvers<void>();
  const runtimeReady = Promise.withResolvers<void>();
  let resets = 0;
  let executions = 0;
  let fallbackRequest: unknown;
  const runner = createWorkflowSandboxRunner({
    organizationId: 'org',
    environmentId: 'development',
    fallbackRunnerBaseUrl: 'http://fallback.test',
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === 'fallback.test') {
        fallbackRequest = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        fallbackStarted.resolve();
        await fallbackReady.promise;
        return Response.json({
          outcomes: [
            { testId: 'fallback', status: 'failed', executionMethods: ['static-validation'] },
          ],
        });
      }
      if (url.pathname === '/resources' && ++resets === 2) {
        resetStarted.resolve();
        await resetReady.promise;
      }
      return Response.json({ setup: { ready: true } });
    },
    temporalRuntime: {
      async execute() {
        executions += 1;
        runtimeStarted.resolve();
        await runtimeReady.promise;
        return {
          temporalWorkflowId: 'sandbox',
          temporalRunId: 'run',
          result: { state: 'completed', visitedStepIds: ['call', 'done'] },
          observations: [
            {
              stepId: 'call',
              capabilityVersionId: 'call@1',
              serializedRequest: {},
              response: {},
              status: 200,
            },
          ],
          stepAttempts: [],
          temporalHistory: {
            scheduledActivities: 1,
            completedActivities: 1,
            failedActivities: 0,
            timedOutActivities: 0,
          },
        };
      },
    },
  });
  const result = runner.execute(suite, (update) => progress.push(update));
  await fallbackStarted.promise;
  expect(progress[0]).toEqual({ phase: 'preparing', completed: 0, total: 3 });
  expect(progress.at(-1)).toEqual({
    phase: 'running',
    completed: 1,
    total: 3,
    currentTest: { kind: 'compatibility', stepId: 'legacy' },
  });
  expect(fallbackRequest).toEqual(expect.objectContaining({ tests: [suite.tests[2]] }));
  fallbackReady.resolve();
  await resetStarted.promise;
  expect(executions).toBe(0);
  expect(progress.at(-1)).toEqual({
    phase: 'running',
    completed: 2,
    total: 3,
    currentTest: { kind: 'happy-path', stepId: null },
  });
  resetReady.resolve();
  await runtimeStarted.promise;
  expect(progress.at(-1)?.completed).toBe(2);
  runtimeReady.resolve();
  expect((await result).outcomes.map(({ testId, status }) => ({ testId, status }))).toEqual([
    { testId: 'happy-path', status: 'passed' },
    { testId: 'static', status: 'passed' },
    { testId: 'fallback', status: 'failed' },
  ]);
  expect(progress.at(-1)).toEqual({ phase: 'finalizing', completed: 3, total: 3 });
  expect(
    progress.every(
      (update, index) =>
        update.total === 3 && update.completed >= (progress[index - 1]?.completed ?? 0),
    ),
  ).toBe(true);
});

it('counts failed setup outcomes without claiming runtime checks executed', async () => {
  const suite = await progressSuite();
  const progress: WorkflowSandboxProgressWire[] = [];
  const runner = createWorkflowSandboxRunner({
    organizationId: 'org',
    environmentId: 'development',
    fallbackRunnerBaseUrl: 'http://unused.test',
    fetch: async () => new Response(null, { status: 503 }),
    temporalRuntime: {
      execute: async () => {
        throw new Error('Must not execute after failed setup');
      },
    },
  });
  const result = await runner.execute(suite, (update) => progress.push(update));
  expect(result.outcomes.every(({ status }) => status === 'failed')).toBe(true);
  expect(progress).toEqual([
    { phase: 'preparing', completed: 0, total: 3 },
    { phase: 'finalizing', completed: 3, total: 3 },
  ]);
});

it('does not report progress for an invalid suite', async () => {
  const progress: WorkflowSandboxProgressWire[] = [];
  const runner = createWorkflowSandboxRunner({
    organizationId: 'org',
    environmentId: 'development',
    fallbackRunnerBaseUrl: 'http://unused.test',
    fetch: async () => {
      throw new Error('Must not prepare invalid suite');
    },
    temporalRuntime: {
      execute: async () => {
        throw new Error('Must not execute invalid suite');
      },
    },
  });
  await expect(runner.execute({}, (update) => progress.push(update))).rejects.toBeInstanceOf(
    InvalidWorkflowSandboxRequest,
  );
  expect(progress).toEqual([]);
});
