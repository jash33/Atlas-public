import { describe, expect, it } from 'vitest';

import {
  buildWorkflowGraph,
  createGraphCompiledWorkflowVersion,
  graphExecutableWorkflowSchema,
  validateCompiledWorkflowStructure,
  verifyCompiledWorkflowVersionIntegrity,
  type GraphExecutableWorkflow,
} from './index.js';

function graph(): GraphExecutableWorkflow {
  return {
    irVersion: 3,
    startStepId: 'choose',
    inputSchema: { required: { ready: { type: 'boolean' } } },
    steps: [
      {
        id: 'done',
        kind: 'terminal',
        state: 'completed',
        output: { kind: 'object', fields: { ready: { source: 'input', path: ['ready'] } } },
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
        capabilityVersionId: 'orders.get@1',
        arguments: {},
        inputSchema: { required: {} },
        next: 'done',
      },
      { id: 'wait', kind: 'sleep', durationMs: 1_000, next: 'done' },
    ],
  };
}

describe('workflow graphs', () => {
  it('follows named routes regardless of step array order and pins only capabilities', async () => {
    const workflow = await createGraphCompiledWorkflowVersion('graph@1', 'org', graph());
    expect(workflow.executionRequirements.requiredCapabilityVersionIds).toEqual(['orders.get@1']);
    expect(await verifyCompiledWorkflowVersionIntegrity(workflow)).toEqual(workflow);
    expect(buildWorkflowGraph(workflow).edges.filter((edge) => edge.kind === 'next')).toEqual([
      { fromStepId: 'choose', toStepId: 'call', kind: 'next', label: 'True' },
      { fromStepId: 'choose', toStepId: 'wait', kind: 'next', label: 'Otherwise' },
      { fromStepId: 'call', toStepId: 'done', kind: 'next' },
      { fromStepId: 'wait', toStepId: 'done', kind: 'next' },
    ]);
  });

  it('rejects output references that only exist on one route into a join', () => {
    const executable = graph();
    executable.steps[0] = {
      id: 'done',
      kind: 'terminal',
      state: 'completed',
      output: { source: 'stepOutput', stepId: 'call', path: [] },
    };
    expect(validateCompiledWorkflowStructure(executable)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Output 'call' must be available on every route reaching this step",
        }),
      ]),
    );
  });

  it('rejects missing routes, cycles, unreachable nodes and missing Finish', () => {
    expect(
      validateCompiledWorkflowStructure({
        irVersion: 3,
        startStepId: 'wait',
        steps: [
          { id: 'wait', kind: 'sleep', durationMs: 1, next: 'wait' },
          { id: 'other', kind: 'sleep', durationMs: 1, next: 'missing' },
        ],
      }).map((issue) => issue.message),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('cycle'),
        expect.stringContaining('cannot be reached'),
        expect.stringContaining('reachable Finish'),
        expect.stringContaining('must point to an executable step'),
      ]),
    );
  });

  it('checks numeric condition types and object Finish outputs', () => {
    const executable = graph();
    executable.steps[1] = {
      id: 'choose',
      kind: 'condition',
      condition: {
        left: { source: 'input', path: ['ready'] },
        operator: 'greaterThan',
        right: { source: 'literal', value: 1 },
      },
      whenTrue: 'call',
      whenFalse: 'wait',
    };
    executable.steps[0] = {
      id: 'done',
      kind: 'terminal',
      state: 'completed',
      output: { source: 'literal', value: 4 },
    };
    expect(validateCompiledWorkflowStructure(executable).map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'Numeric comparisons need number values',
        'Finish must return an object',
      ]),
    );
  });

  it('bounds sleeps, requires comparison operands and excludes canvas fields from executable content', () => {
    expect(graphExecutableWorkflowSchema.safeParse({ ...graph(), positions: {} }).success).toBe(
      false,
    );
    expect(
      graphExecutableWorkflowSchema.safeParse({
        ...graph(),
        steps: [{ id: 'wait', kind: 'sleep', durationMs: 2_592_000_001, next: 'done' }],
      }).success,
    ).toBe(false);
    expect(
      graphExecutableWorkflowSchema.safeParse({
        ...graph(),
        steps: [
          {
            id: 'choose',
            kind: 'condition',
            condition: { left: { source: 'literal', value: 1 }, operator: 'equals' },
            whenTrue: 'done',
            whenFalse: 'done',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('hashes routing changes and ignores envelope identity when hashing execution', async () => {
    const first = await createGraphCompiledWorkflowVersion('graph@1', 'org', graph());
    const second = await createGraphCompiledWorkflowVersion('graph@2', 'org', graph());
    expect(second.irHash).toBe(first.irHash);
    const changed = graph();
    changed.steps[1] = {
      id: 'choose',
      kind: 'condition',
      condition: {
        left: { source: 'input', path: ['ready'] },
        operator: 'equals',
        right: { source: 'literal', value: true },
      },
      whenTrue: 'wait',
      whenFalse: 'call',
    };
    expect((await createGraphCompiledWorkflowVersion('graph@3', 'org', changed)).irHash).not.toBe(
      first.irHash,
    );
  });
});
