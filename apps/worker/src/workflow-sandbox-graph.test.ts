import { expect, it } from 'vite-plus/test';

import { createGraphCompiledWorkflowVersion } from '@atlas/workflow-ir';
import {
  createWorkflowSandboxRunner,
  type WorkflowSandboxTemporalRuntime,
} from './workflow-sandbox.js';

const history = {
  scheduledActivities: 0,
  completedActivities: 0,
  failedActivities: 0,
  timedOutActivities: 0,
};

it('accepts a graph route that intentionally finishes in manual review', async () => {
  const workflow = await createGraphCompiledWorkflowVersion('review@1', 'org', {
    irVersion: 3,
    startStepId: 'review',
    steps: [{ id: 'review', kind: 'terminal', state: 'manual_review' }],
  });
  const runner = createWorkflowSandboxRunner({
    organizationId: 'org',
    environmentId: 'development',
    fallbackRunnerBaseUrl: 'http://unused-provider',
    fetch: async () => {
      throw new Error('Builtin checks must not call providers');
    },
    temporalRuntime: {
      async execute() {
        return {
          temporalWorkflowId: 'workflow',
          temporalRunId: 'run',
          result: { state: 'manual_review', visitedStepIds: ['review'] },
          observations: [],
          stepAttempts: [],
          temporalHistory: history,
        };
      },
    },
  });
  const result = await runner.execute({
    organizationId: 'org',
    environmentId: 'development',
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    workflow,
    providerContracts: [],
    tests: [
      {
        testId: 'happy-path',
        kind: 'happy-path',
        stepId: null,
        capabilityVersionId: null,
        expectation: 'Finish in review',
        requestSample: null,
        expectedResponseSchema: null,
      },
    ],
  });
  expect(result.outcomes[0]?.status).toBe('passed');
});

async function builtinsWorkflow() {
  return createGraphCompiledWorkflowVersion('builder@1', 'org', {
    irVersion: 3,
    startStepId: 'choose',
    inputSchema: { required: { ready: { type: 'boolean' } } },
    steps: [
      {
        id: 'choose',
        kind: 'condition',
        condition: {
          left: { source: 'input', path: ['ready'] },
          operator: 'equals',
          right: { source: 'literal', value: true },
        },
        whenTrue: 'done',
        whenFalse: 'wait',
      },
      { id: 'wait', kind: 'sleep', durationMs: 3_600_000, next: 'done' },
      { id: 'done', kind: 'terminal', state: 'completed' },
    ],
  });
}

it('checks builtins and both condition routes without contacting a provider', async () => {
  const workflow = await builtinsWorkflow();
  const inputs: unknown[] = [];
  const runner = createWorkflowSandboxRunner({
    organizationId: 'org',
    environmentId: 'development',
    fallbackRunnerBaseUrl: 'http://unused-provider',
    fetch: async () => {
      throw new Error('Builtin checks must not call providers');
    },
    temporalRuntime: {
      async execute(input) {
        inputs.push(input.workflowInput.ready);
        return {
          temporalWorkflowId: 'workflow',
          temporalRunId: 'run',
          result: {
            state: 'completed',
            visitedStepIds: input.workflowInput.ready
              ? ['choose', 'done']
              : ['choose', 'wait', 'done'],
          },
          observations: [],
          stepAttempts: [],
          temporalHistory: history,
        };
      },
    },
  });
  const result = await runner.execute({
    organizationId: 'org',
    environmentId: 'development',
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    workflow,
    providerContracts: [],
    tests: [true, false].map((ready) => ({
      testId: `happy-path:choose:${ready}`,
      kind: 'happy-path',
      stepId: 'choose',
      capabilityVersionId: null,
      expectation: 'Exercise the condition route',
      requestSample: { ready },
      expectedResponseSchema: null,
    })),
  });
  expect(inputs).toEqual([true, false]);
  expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['passed', 'passed']);
  expect(result.outcomes[1]?.detail).toContain('Sleep timers were accelerated');
});

it('rejects missing route evidence and a condition sample that selects the other path', async () => {
  const workflow = await builtinsWorkflow();
  const results = [undefined, ['choose', 'done']];
  const runner = createWorkflowSandboxRunner({
    organizationId: 'org',
    environmentId: 'development',
    fallbackRunnerBaseUrl: 'http://unused-provider',
    fetch: async () => {
      throw new Error('Builtin checks must not call providers');
    },
    temporalRuntime: {
      async execute() {
        const visitedStepIds = results.shift();
        return {
          temporalWorkflowId: 'workflow',
          temporalRunId: 'run',
          result: { state: 'completed', ...(visitedStepIds ? { visitedStepIds } : {}) },
          observations: [],
          stepAttempts: [],
          temporalHistory: history,
        };
      },
    },
  });
  const result = await runner.execute({
    organizationId: 'org',
    environmentId: 'development',
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    workflow,
    providerContracts: [],
    tests: [
      {
        testId: 'happy-path',
        kind: 'happy-path',
        stepId: null,
        capabilityVersionId: null,
        expectation: 'Complete',
        requestSample: null,
        expectedResponseSchema: null,
      },
      {
        testId: 'happy-path:choose:false',
        kind: 'happy-path',
        stepId: 'choose',
        capabilityVersionId: null,
        expectation: 'Otherwise',
        requestSample: { ready: false },
        expectedResponseSchema: null,
      },
    ],
  });
  expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'failed']);
  expect(result.outcomes[1]?.detail).toContain('did not reach the requested route');
});

it('does not mark a skipped capability duplicate-event check as passed', async () => {
  const workflow = await createGraphCompiledWorkflowVersion('branch@1', 'org', {
    irVersion: 3,
    startStepId: 'choose',
    steps: [
      {
        id: 'choose',
        kind: 'condition',
        condition: {
          left: { source: 'literal', value: false },
          operator: 'equals',
          right: { source: 'literal', value: true },
        },
        whenTrue: 'call',
        whenFalse: 'done',
      },
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
  const temporalRuntime: WorkflowSandboxTemporalRuntime = {
    async execute() {
      return {
        temporalWorkflowId: 'workflow',
        temporalRunId: 'run',
        result: { state: 'completed', visitedStepIds: ['choose', 'done'] },
        observations: [],
        stepAttempts: [],
        temporalHistory: history,
      };
    },
  };
  const runner = createWorkflowSandboxRunner({
    organizationId: 'org',
    environmentId: 'development',
    fallbackRunnerBaseUrl: 'http://provider',
    fetch: async () => Response.json({}),
    temporalRuntime,
  });
  const result = await runner.execute({
    organizationId: 'org',
    environmentId: 'development',
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    workflow,
    providerContracts: [],
    tests: [
      {
        testId: 'duplicate:call',
        kind: 'duplicate-event',
        stepId: 'call',
        capabilityVersionId: 'call@1',
        expectation: 'No duplicate side effects',
        requestSample: null,
        expectedResponseSchema: null,
      },
    ],
  });
  expect(result.outcomes[0]?.status).toBe('failed');
  expect(result.outcomes[0]?.detail).toContain("skipped 'call'");
});
