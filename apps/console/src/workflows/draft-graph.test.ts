import { describe, expect, it } from 'vite-plus/test';

import { draftGraphNodeWidth, layoutDraftGraph } from './draft-graph.js';
import { diagramFromReviewGraph } from './diagram-model.js';
import type { WorkflowReview } from './workflow.js';

const twoStepGraph = diagramFromReviewGraph({
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
} satisfies WorkflowReview['graph']);

describe('draft graph layout', () => {
  it('places steps left to right and draws D3 paths for order and mappings', () => {
    const layout = layoutDraftGraph(twoStepGraph);

    expect(layout.nodes.map((node) => node.stepId)).toEqual(['load-payment', 'settle-invoice']);
    expect(layout.nodes[0]?.x).toBeLessThan(layout.nodes[1]?.x ?? 0);
    expect(layout.edges[0]?.path.startsWith('M')).toBe(true);
    expect(layout.edges.find((edge) => edge.kind === 'mapping')?.label).toBe('maps invoiceId');
    expect(layout.edges.find((edge) => edge.kind === 'next')?.label).toBe('then');
    expect(layout.edges.find((edge) => edge.kind === 'mapping')?.labelY).not.toBe(
      layout.edges.find((edge) => edge.kind === 'next')?.labelY,
    );
  });

  it('moves a step and keeps order and mapping edges attached to it', () => {
    const layout = layoutDraftGraph(twoStepGraph);
    const from = layout.nodes[0];
    if (!from) throw new Error('expected a load-payment node');
    const moved = layoutDraftGraph(twoStepGraph, {
      'load-payment': { x: from.x + 40, y: from.y + 80 },
    });
    const movedFrom = moved.nodes[0];
    const nextPath = moved.edges.find((edge) => edge.kind === 'next')?.path ?? '';
    const mappingPath = moved.edges.find((edge) => edge.kind === 'mapping')?.path ?? '';

    expect(movedFrom?.x).toBe(from.x + 40);
    expect(movedFrom?.y).toBe(from.y + 80);
    expect(moved.nodes[1]?.x).toBe(layout.nodes[1]?.x);
    expect(moved.nodes[1]?.y).toBe(layout.nodes[1]?.y);
    expect(nextPath).not.toBe(layout.edges.find((edge) => edge.kind === 'next')?.path);
    expect(mappingPath).not.toBe(layout.edges.find((edge) => edge.kind === 'mapping')?.path);
    expect(nextPath.startsWith(`M${from.x + 40 + draftGraphNodeWidth},`)).toBe(true);
    expect(mappingPath).toContain(String(from.x + 40 + draftGraphNodeWidth));
    expect(moved.edges.find((edge) => edge.kind === 'next')?.labelY).toBeGreaterThan(
      layout.edges.find((edge) => edge.kind === 'next')?.labelY ?? 0,
    );
  });
});
