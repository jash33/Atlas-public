import { describe, expect, it } from 'vite-plus/test';
import {
  createGraphCompiledWorkflowVersion,
  type GraphExecutableWorkflow,
} from '@atlas/workflow-ir';
import { compileWorkflowSource, renderWorkflowSource } from './workflow-source.js';
import { generateWorkflowSandboxTests } from './workflow-sandbox.js';
import { workflowEditorSaveSchema } from './workflow-editor-drafts.js';

const projection = { fingerprint: 'a'.repeat(64), capabilities: [] };
const context = { projection, organizationId: 'org_atlas', workflowVersionId: 'graph-test' };
const graph: GraphExecutableWorkflow = {
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
      whenTrue: 'format',
      whenFalse: 'wait',
    },
    {
      id: 'format',
      kind: 'transform',
      arguments: { message: { source: 'literal', value: 'Ready' } },
      responseSchema: { required: { message: { type: 'string' } } },
      next: 'done',
    },
    { id: 'wait', kind: 'sleep', durationMs: 1000, next: 'done' },
    {
      id: 'done',
      kind: 'terminal',
      state: 'completed',
      output: { kind: 'object', fields: { ready: { source: 'input', path: ['ready'] } } },
    },
  ],
};

describe('graph workflow compilation', () => {
  it('round trips manual blocks, connections, input mappings and Finish through YAML', async () => {
    const first = await compileWorkflowSource(graph, context);
    expect(first.success).toBe(true);
    if (!first.success) throw new Error('Expected compilation');
    const second = await compileWorkflowSource(
      renderWorkflowSource(first.workflow, projection),
      context,
    );
    expect(second.success).toBe(true);
    if (!second.success) throw new Error('Expected source compilation');
    expect(second.workflow.executable).toEqual(graph);
    expect(second.workflow.irHash).toBe(first.workflow.irHash);
    expect(second.workflow.executionRequirements.requiredCapabilityVersionIds).toEqual([]);
  });

  it('rejects data from a step that only runs on one incoming path', async () => {
    const unsafe = {
      ...graph,
      steps: graph.steps.map((step) =>
        step.id === 'done'
          ? { ...step, output: { source: 'stepOutput', stepId: 'format', path: [] } }
          : step,
      ),
    };
    const result = await compileWorkflowSource(unsafe, context);
    expect(result.success).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'LEGACY_IR_STRUCTURE_INVALID',
          message: expect.stringContaining('every route'),
        }),
      ]),
    );
  });

  it('rejects missing targets and graph cycles before saving an executable version', async () => {
    for (const target of ['missing', 'choose']) {
      const result = await compileWorkflowSource(
        {
          ...graph,
          steps: graph.steps.map((step) => (step.id === 'wait' ? { ...step, next: target } : step)),
        },
        context,
      );
      expect(result.success).toBe(false);
      expect(result.diagnostics.some((issue) => issue.code === 'LEGACY_IR_STRUCTURE_INVALID')).toBe(
        true,
      );
    }
  });

  it('generates checks for both If and Otherwise without fake provider capabilities', async () => {
    const workflow = await createGraphCompiledWorkflowVersion('graph-test', 'org_atlas', graph);
    const tests = generateWorkflowSandboxTests(workflow, []);
    expect(tests.map((test) => test.testId)).toEqual([
      'happy-path',
      'happy-path:choose:true',
      'happy-path:choose:false',
    ]);
    expect(tests[1]).toMatchObject({
      stepId: 'choose',
      capabilityVersionId: null,
      requestSample: { ready: true },
    });
    expect(tests[2]).toMatchObject({
      stepId: 'choose',
      capabilityVersionId: null,
      requestSample: { ready: false },
    });
  });
});

describe('working draft limits', () => {
  const input = {
    organizationId: 'org_atlas',
    environmentId: 'development',
    name: 'Untitled workflow',
    expectedRevision: null,
    document: {
      executable: { irVersion: 3, steps: [] },
      layout: {},
      labels: {},
      notes: [],
      trigger: { type: 'manual' },
    },
  };
  it('accepts incomplete definitions and rejects oversized or deeply nested content', () => {
    expect(workflowEditorSaveSchema.safeParse(input).success).toBe(true);
    expect(
      workflowEditorSaveSchema.safeParse({
        ...input,
        document: { ...input.document, executable: 'x'.repeat(300_000) },
      }).success,
    ).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(
      workflowEditorSaveSchema.safeParse({
        ...input,
        document: { ...input.document, executable: deep },
      }).success,
    ).toBe(false);
  });
});
