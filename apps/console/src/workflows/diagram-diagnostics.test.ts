import { describe, expect, it } from 'vite-plus/test';

import { diagramEdgeKey, targetDiagramDiagnostics } from './diagram-diagnostics.js';
import { diagramFromReviewGraph } from './diagram-model.js';
import type { Diagnostic, WorkflowReview } from './workflow.js';

const graph: WorkflowReview['graph'] = {
  nodes: [
    {
      stepId: 'load-payment',
      kind: 'capabilityCall',
      irreversible: false,
      retryPolicy: null,
      terminalState: null,
    },
    {
      stepId: 'settle-invoice',
      kind: 'capabilityCall',
      irreversible: true,
      retryPolicy: null,
      terminalState: null,
    },
  ],
  edges: [
    { fromStepId: 'load-payment', toStepId: 'settle-invoice', kind: 'next' },
    {
      fromStepId: 'load-payment',
      toStepId: 'settle-invoice',
      kind: 'mapping',
      label: 'invoiceId',
    },
  ],
};

function diagnostic(partial: Partial<Diagnostic> & Pick<Diagnostic, 'code' | 'path'>): Diagnostic {
  return {
    kind: 'compileError',
    message: 'blocked',
    ...partial,
  };
}

describe('diagram diagnostic targeting', () => {
  it('omits the run-checks reminder but keeps failed checks visible', () => {
    const targeted = targetDiagramDiagnostics(
      [
        diagnostic({
          code: 'SANDBOX_TESTS_MISSING',
          path: 'sandboxTests',
          message: 'Run the generated workflow checks for this exact workflow artifact.',
        }),
        diagnostic({ code: 'SANDBOX_TESTS_FAILED', path: 'sandboxTests' }),
      ],
      graph,
    );
    expect(targeted.nodeMarkers).toEqual({});
    expect(targeted.edgeMarkers).toEqual({});
    expect(targeted.diagramMarkers).toEqual([
      expect.objectContaining({ code: 'SANDBOX_TESTS_FAILED', severity: 'error' }),
    ]);
  });

  it('places a diagnostic on the step when the path names that step', () => {
    const targeted = targetDiagramDiagnostics(
      [
        diagnostic({
          code: 'CAPABILITY_NOT_FOUND_IN_PROJECTION',
          path: 'executable.steps[load-payment].capabilityVersionId',
          message: 'Capability is not in the planner projection.',
        }),
      ],
      graph,
    );

    expect(targeted.nodeMarkers).toEqual({
      'load-payment': [
        expect.objectContaining({
          code: 'CAPABILITY_NOT_FOUND_IN_PROJECTION',
          severity: 'error',
        }),
      ],
    });
    expect(targeted.edgeMarkers).toEqual({});
    expect(targeted.diagramMarkers).toEqual([]);
  });

  it('places a mapping diagnostic on the matching mapping edge', () => {
    const targeted = targetDiagramDiagnostics(
      [
        diagnostic({
          code: 'MAPPING_TYPE_MISMATCH',
          path: 'executable.steps[settle-invoice].arguments.invoiceId',
          message: 'invoiceId does not match the capability input.',
        }),
      ],
      graph,
    );

    expect(targeted.edgeMarkers).toEqual({
      'mapping:load-payment:settle-invoice:invoiceId': [
        expect.objectContaining({ code: 'MAPPING_TYPE_MISMATCH', severity: 'error' }),
      ],
    });
    expect(targeted.nodeMarkers).toEqual({});
    expect(targeted.diagramMarkers).toEqual([]);
    const rendered = diagramFromReviewGraph(graph).edges.find((edge) => edge.kind === 'mapping');
    expect(rendered && diagramEdgeKey(rendered)).toBe(
      'mapping:load-payment:settle-invoice:invoiceId',
    );
  });

  it('keeps index paths and identity fields at diagram level, including warnings', () => {
    const targeted = targetDiagramDiagnostics(
      [
        diagnostic({
          kind: 'warning',
          code: 'RISK',
          path: 'steps[0]',
          message: 'Review the retry limit',
        }),
        diagnostic({
          code: 'IR_HASH_MISMATCH',
          path: 'irHash',
          message: 'Artifact identity does not match the executable.',
        }),
      ],
      graph,
    );

    expect(targeted.nodeMarkers).toEqual({});
    expect(targeted.edgeMarkers).toEqual({});
    expect(targeted.diagramMarkers).toEqual([
      expect.objectContaining({ code: 'RISK', severity: 'warning', path: 'steps[0]' }),
      expect.objectContaining({ code: 'IR_HASH_MISMATCH', severity: 'error', path: 'irHash' }),
    ]);
  });
});
