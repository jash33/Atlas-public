import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { diagramFromReviewGraph, type DiagramNode } from './diagram-model.js';
import type { DiagramPreview } from './diagram-preview.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';
import type { WorkflowReview } from './workflow.js';

const graphCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../shell.css'),
  'utf8',
);

const emptyTargets = { nodeMarkers: {}, edgeMarkers: {}, diagramMarkers: [] };
const closedDrawer = { capabilityVersionId: null, restoreFocusStepId: null };

const reviewGraph: WorkflowReview['graph'] = {
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
    {
      stepId: 'completed',
      kind: 'terminal',
      irreversible: false,
      retryPolicy: null,
      terminalState: 'completed',
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
    { fromStepId: 'settle-invoice', toStepId: 'completed', kind: 'next' },
  ],
};

function serverPreview(): Extract<DiagramPreview, { status: 'server' }> {
  return {
    status: 'server',
    graph: diagramFromReviewGraph(
      reviewGraph,
      [
        {
          stepId: 'load-payment',
          capabilityVersionId: 'payment.get@v1',
          secretReference: 'PAYMENTS_API_TOKEN',
          httpCall: { method: 'GET', path: '/payments/{paymentId}' },
          capabilityId: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
        },
        {
          stepId: 'settle-invoice',
          capabilityVersionId: 'billing.settle@v1',
          secretReference: 'BILLING_API_TOKEN',
          httpCall: { method: 'POST', path: '/invoices' },
          capabilityId: { kind: 'openapi', serviceId: 'billing', operationId: 'settleInvoice' },
        },
      ],
      [
        {
          capabilityVersionId: 'payment.get@v1',
          serviceId: 'payments',
          operationId: 'getPayment',
        },
        {
          capabilityVersionId: 'billing.settle@v1',
          serviceId: 'billing',
          operationId: 'settleInvoice',
        },
      ],
    ),
  };
}

function renderGraph(overrides: Partial<Parameters<typeof WorkflowDiagram>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(WorkflowDiagram, {
      drawer: closedDrawer,
      onCloseDrawer: vi.fn<() => void>(),
      onOpenNode: vi.fn<(node: DiagramNode) => void>(),
      preview: serverPreview(),
      targets: emptyTargets,
      ...overrides,
    }),
  );
}

describe('WorkflowDiagram', () => {
  it('preserves catalog labels and the graph canvas', () => {
    const html = renderGraph({
      title: 'Workflow graph',
      versionLabel: 'Version 1',
      validatedLabel: 'Approved',
    });

    expect(html).toContain('>Workflow graph<');
    expect(html).toContain('>Version 1<');
    expect(html).toContain('Approved');
    expect(html).toContain('aria-label="Workflow graph canvas"');
    expect(html).toContain('data-diagram-draggable="load-payment"');
  });

  it('shows the draft graph and controls while checks are incomplete', () => {
    const html = renderGraph({
      preview: { status: 'draft-preview', graph: serverPreview().graph },
    });

    expect(html).toContain('>Draft graph<');
    expect(html).toContain('Checks incomplete');
    expect(html).toContain('scroll to zoom');
    expect(html).toContain('aria-label="Draft graph canvas"');
    expect(html).toContain('data-diagram-draggable="load-payment"');
  });

  it('renders steps, order, mappings, and credentials without boundary messages', () => {
    const html = renderGraph();

    expect(html).toContain('aria-label="Workflow draft graph"');
    expect(html).toContain('>Draft graph<');
    expect(html).toContain('class="wf-d3-graph"');
    expect(html).toContain('<svg');
    expect(html).toContain('class="wf-d3-edge wf-d3-edge-next"');
    expect(html).toContain('class="wf-d3-edge wf-d3-edge-mapping"');
    expect(html).toContain('>then<');
    expect(html).toContain('>maps invoiceId<');
    expect(html).toContain('Load payment');
    expect(html).toContain('payments · getPayment');
    expect(html).toContain('Uses PAYMENTS_API_TOKEN');
    expect(html).toContain('Settle invoice');
    expect(html).toContain('Uses BILLING_API_TOKEN');
    expect(html).not.toContain('Irreversible boundary after this step');
    expect(html).not.toContain('wf-graph-nodes');
    expect(html).not.toContain('class="wf-graph-edges"');
    expect(html).not.toContain('sha256:');
    expect(html).not.toContain('fingerprint');
    expect(html).not.toContain('irHash');
  });

  it('exposes a pannable canvas with zoom controls and draggable steps', () => {
    const html = renderGraph();

    expect(html).toContain('class="wf-d3-viewport"');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Reset graph view"');
    expect(html).toContain('translate(0 0) scale(1)');
    expect(html).toContain('Drag steps · scroll to zoom');
    expect(html).toContain('data-diagram-draggable="load-payment"');
    expect(html).toContain('data-diagram-draggable="settle-invoice"');
    expect(html).toContain('marker-end=');
    expect(graphCss).toContain('.wf-d3-viewport');
    expect(graphCss).toContain('cursor: grab');
    expect(graphCss).toContain('touch-action: none');
  });

  it('marks inferred mappings separately from mappings the Author asked for', () => {
    const html = renderGraph({
      preview: {
        status: 'server',
        graph: diagramFromReviewGraph(
          {
            nodes: [
              {
                stepId: 'load-payment',
                kind: 'capabilityCall',
                irreversible: false,
                retryPolicy: null,
                terminalState: null,
              },
              {
                stepId: 'create-intent',
                kind: 'capabilityCall',
                irreversible: false,
                retryPolicy: null,
                terminalState: null,
              },
            ],
            edges: [
              { fromStepId: 'load-payment', toStepId: 'create-intent', kind: 'next' },
              {
                fromStepId: 'load-payment',
                toStepId: 'create-intent',
                kind: 'mapping',
                label: 'amount',
                origin: 'requested',
              },
              {
                fromStepId: 'load-payment',
                toStepId: 'create-intent',
                kind: 'mapping',
                label: 'currency',
                origin: 'requested',
              },
            ],
          },
          [],
          [],
          [
            { stepId: 'create-intent', destinationPath: ['amount'], origin: 'requested' },
            { stepId: 'create-intent', destinationPath: ['currency'], origin: 'requested' },
            { stepId: 'create-intent', destinationPath: ['Idempotency-Key'], origin: 'inferred' },
            { stepId: 'create-intent', destinationPath: ['receipt_email'], origin: 'inferred' },
          ],
        ),
      },
    });

    expect(html).toContain('wf-d3-edge-mapping-requested');
    expect(html).toContain('wf-d3-edge-mapping-inferred');
    expect(html).toContain('maps amount · you asked for this');
    expect(html).toContain('maps currency · you asked for this');
    expect(html).toContain('maps Idempotency-Key · Atlas inferred this');
    expect(html).toContain('maps receipt_email · Atlas inferred this');
    expect(html).toContain('Runtime input');
    expect(html).not.toContain('sha256:');
    expect(html).not.toContain('fingerprint');
    expect(html).not.toContain('irHash');
    expect(html).not.toContain('MAPPING_');
    expect(graphCss).toContain('.wf-d3-edge-mapping-requested');
    expect(graphCss).toContain('.wf-d3-edge-mapping-inferred');
  });

  it('hides the graph until a draft is ready to visualize', () => {
    expect(renderGraph({ preview: { status: 'hidden' } })).toBe('');
  });

  it('distinguishes invalid source, unsaved edits, and keyboard-reachable steps', () => {
    const invalid = renderGraph({
      preview: {
        status: 'invalid-yaml',
        detail: 'YAML could not form a workflow graph',
        line: 2,
        column: 11,
      },
    });
    const unsaved = renderGraph({
      preview: {
        status: 'unsaved-preview',
        banner: 'Unsaved preview - not validated',
        graph: serverPreview().graph,
      },
    });
    const keys = renderGraph();

    expect(invalid).toContain('role="alert"');
    expect(invalid).toContain('Invalid YAML — diagram replaced');
    expect(invalid).toContain('Line 2, column 11.');
    expect(unsaved).toContain('Unsaved preview - not validated');
    expect(keys).toContain('type="button"');
    expect(keys).toContain('data-diagram-step="load-payment"');
    expect(keys).not.toContain('tabindex="-1"');
  });

  it('marks the failed step on the graph in ordinary language', () => {
    const html = renderGraph({
      failedStep: {
        stepId: 'settle-invoice',
        message: 'billing · settleInvoice expects an idempotency key and none was provided.',
      },
    });

    expect(html).toContain('wf-graph-node-failed');
    expect(html).toContain(
      'billing · settleInvoice expects an idempotency key and none was provided.',
    );
    expect(html).toContain('wf-d3-graph');
    expect(html).not.toContain('irHash');
    expect(html).not.toContain('CAPABILITY_');
  });

  it('keeps inferred and requested mapping marks in empty, error, keyboard, and narrow-screen states', () => {
    const paymentPreview = {
      status: 'server' as const,
      graph: diagramFromReviewGraph(
        {
          nodes: [
            {
              stepId: 'load-payment',
              kind: 'capabilityCall',
              irreversible: false,
              retryPolicy: null,
              terminalState: null,
            },
            {
              stepId: 'create-intent',
              kind: 'capabilityCall',
              irreversible: false,
              retryPolicy: null,
              terminalState: null,
            },
          ],
          edges: [
            {
              fromStepId: 'load-payment',
              toStepId: 'create-intent',
              kind: 'mapping',
              label: 'amount',
              origin: 'requested',
            },
          ],
        },
        [
          { stepId: 'load-payment', capabilityVersionId: 'payment.get@v1' },
          { stepId: 'create-intent', capabilityVersionId: 'stripe.intent@v1' },
        ],
        [],
        [{ stepId: 'create-intent', destinationPath: ['Idempotency-Key'], origin: 'inferred' }],
      ),
    };
    const empty = renderGraph({ preview: { status: 'hidden' } });
    const failed = renderGraph({
      preview: paymentPreview,
      failedStep: {
        stepId: 'create-intent',
        message: 'Create intent could not start.',
      },
    });
    const keys = renderGraph({ preview: paymentPreview });
    const narrow = keys;

    expect(empty).toBe('');
    expect(failed).toContain('wf-d3-edge-mapping-requested');
    expect(failed).toContain('wf-d3-edge-mapping-inferred');
    expect(failed).toContain('wf-graph-node-failed');
    expect(keys).toContain('type="button"');
    expect(keys).toContain('data-diagram-step="load-payment"');
    expect(keys).not.toContain('tabindex="-1"');
    expect(keys).toContain('maps amount · you asked for this');
    expect(keys).toContain('maps Idempotency-Key · Atlas inferred this');
    expect(narrow).toContain('class="wf-d3-graph"');
    expect(graphCss).toMatch(
      /\.wf-compose-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    );
  });

  it('keeps the D3 graph from overflowing on a narrow screen', () => {
    const html = renderGraph();

    expect(html).toContain('class="wf-graph"');
    expect(html).toContain('class="wf-d3-graph"');
    expect(graphCss).toContain('.wf-d3-graph');
    expect(graphCss).toContain('.wf-compose-split');
    expect(graphCss).toMatch(
      /\.wf-compose-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    );
  });
});
