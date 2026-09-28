import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { diagramFromReviewGraph, type DiagramNode } from './diagram-model.js';
import { WorkflowCompose } from './WorkflowCompose.js';
import { createRequestEditor, type RequestEditor } from './request-editor.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';

const composeCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../shell.css'),
  'utf8',
);

function editorWithText(text: string, cursor = text.length): RequestEditor {
  return createRequestEditor({ text, cursor });
}

function highlightedEditor(): RequestEditor {
  const base = createRequestEditor({ text: 'getPayment', cursor: 4 });
  return {
    ...base,
    annotations: [
      {
        start: 0,
        end: 10,
        kind: 'capability',
        capabilityVersionId: 'cap-payments',
      },
    ],
    index: {
      status: 'ok',
      fingerprint: 'a'.repeat(64),
      references: [
        {
          capabilityVersionId: 'cap-payments',
          identity: {
            kind: 'openapi',
            serviceId: 'payments',
            operationId: 'getPayment',
          },
          owner: 'payments-team',
          businessSemantics: null,
          safety: { idempotencyField: null, compensatedBy: null, irreversibleAfter: false },
          provenance: null,
          searchTerms: ['getpayment'],
          fields: [],
        },
      ],
    },
  };
}

function renderCompose(overrides: Partial<Parameters<typeof WorkflowCompose>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(WorkflowCompose, {
      canDraft: true,
      editor: editorWithText('Send a receipt'),
      onDraft: vi.fn<() => void>(),
      onEditorChange: vi.fn<(editor: RequestEditor) => void>(),
      onNameChange: vi.fn<(name: string) => void>(),
      onOpenCapability: vi.fn<(capabilityVersionId: string) => void>(),
      workflowName: 'Send receipt',
      ...overrides,
    }),
  );
}

describe('WorkflowCompose', () => {
  it('keeps Load draft and Start over beside the editor tabs, directly above the prompt', () => {
    const html = renderCompose({
      onModeChange: vi.fn<(mode: 'ai' | 'builder') => void>(),
      onStartOver: vi.fn<() => void>(),
      loadDraftAction: createElement('button', { type: 'button' }, 'Load draft'),
    });
    expect(html.slice(0, html.indexOf('</header>'))).not.toContain('Start over');
    expect(html).toMatch(
      /class="wf-authoring-controls"[\s\S]*<nav[\s\S]*Describe with AI[\s\S]*Build manually[\s\S]*<\/nav><div class="wf-authoring-actions"><button[^>]*>Load draft<\/button><button[^>]*>Start over<\/button><\/div><\/div><section/,
    );
  });

  it('opens Create Workflow on a name, a plain-language prompt, and Draft', () => {
    const html = renderCompose();

    expect(html).toContain('>Create Workflow<');
    expect(html).toContain('for="workflow-name"');
    expect(html).toContain('>Workflow name<');
    expect(html).toContain('id="workflow-name"');
    expect(html).toContain('for="workflow-prompt"');
    expect(html).toContain('>What should this workflow do?<');
    expect(html).toContain('id="workflow-prompt"');
    expect(html).toContain('>Draft<');
    expect(html).not.toContain('Draft and validate');
    expect(html).not.toContain('wf-capability-marquee');
    expect(html).not.toContain('Available capabilities you can use in this workflow');
    expect(html).not.toContain(' view');
    expect(html).not.toContain('author view');
    expect(html).not.toContain('Choose a demo scenario');
    expect(html).not.toContain('Run static demo workflow');
    expect(html).not.toContain('Launch approved workflow');
    expect(html).not.toContain('wf-compose-split');
    expect(html).not.toContain('wf-d3-graph');
    expect(html).not.toContain('Draft graph');
    expect(html).not.toContain('wf-graph-nodes');
  });

  it('distinguishes empty, busy, and error compose states', () => {
    const empty = renderCompose({ editor: editorWithText(''), workflowName: '' });
    const busy = renderCompose({ isBusy: true });
    const failed = renderCompose({ error: 'Workflow drafting failed' });

    expect(empty).toContain('disabled=""');
    expect(empty).toContain('>Draft<');
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('disabled=""');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Workflow drafting failed');
  });

  it('keeps compose keyboard-reachable and mentioned API actions inspectable', () => {
    const html = renderCompose({ editor: highlightedEditor() });

    expect(html).toContain('for="workflow-name"');
    expect(html).toContain('for="workflow-prompt"');
    expect(html).toContain('id="workflow-name"');
    expect(html).toContain('id="workflow-prompt"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('tabindex="-1"');
    expect(html).toContain('wf-ref-identified-reference');
    expect(html).toContain('<strong>Capability</strong>');
    expect(html).toContain('aria-label="Open payments · getPayment capability details"');
  });

  it('lets an operator inspect compose without drafting', () => {
    const html = renderCompose({ canDraft: false, workflowName: '', editor: editorWithText('') });

    expect(html).toContain('disabled=""');
    expect(html).toContain('>Draft<');
    expect(html).toContain('Switch to Author or Admin to create a workflow');
    expect(html).not.toContain('author view');
    expect(html).not.toContain('Operators cannot draft.');
    expect(html).not.toContain('control plane');
  });

  it('keeps the compose fields from overflowing on a narrow screen', () => {
    const html = renderCompose();

    expect(html).toContain('class="wf-studio wf-compose"');
    expect(composeCss).toContain('.wf-compose');
    expect(composeCss).toContain('.wf-compose .wf-conversation input');
    expect(composeCss).toMatch(/\.wf-compose[\s\S]*min-width:\s*0/);
    expect(composeCss).toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.wf-compose[\s\S]*min-width:\s*0/,
    );
  });

  it('stacks the D3 graph under the prompt after a draft validates', () => {
    const html = renderCompose({
      graph: createElement(
        'section',
        { 'aria-label': 'Workflow draft graph', className: 'wf-graph' },
        createElement('svg', { className: 'wf-d3-graph' }, 'Load payment'),
      ),
    });
    const conversationAt = html.indexOf('class="wf-conversation"');
    const graphAt = html.indexOf('wf-d3-graph');

    expect(html).toContain('class="wf-studio wf-compose wf-compose-split"');
    expect(html).toContain('aria-label="Workflow draft graph"');
    expect(html).toContain('wf-d3-graph');
    expect(conversationAt).toBeGreaterThan(-1);
    expect(graphAt).toBeGreaterThan(conversationAt);
    expect(composeCss).toContain('.wf-compose-split');
    expect(composeCss).toMatch(
      /\.wf-compose-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    );
    expect(composeCss).not.toMatch(
      /\.wf-compose-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/,
    );
  });

  it('keeps empty, busy, error, and keyboard compose states in the stacked layout', () => {
    const empty = renderCompose({
      editor: editorWithText(''),
      graph: createElement('svg', { className: 'wf-d3-graph' }),
      workflowName: '',
    });
    const busy = renderCompose({
      graph: createElement('svg', { className: 'wf-d3-graph' }),
      isBusy: true,
    });
    const failed = renderCompose({
      error: 'Workflow drafting failed',
      graph: createElement('svg', { className: 'wf-d3-graph' }),
    });
    const keys = renderCompose({
      editor: highlightedEditor(),
      graph: createElement('svg', { className: 'wf-d3-graph' }),
    });

    expect(empty).toContain('wf-compose-split');
    expect(empty).toContain('disabled=""');
    expect(busy).toContain('aria-busy="true"');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Workflow drafting failed');
    expect(keys).toContain('for="workflow-name"');
    expect(keys).toContain('for="workflow-prompt"');
    expect(keys).toContain('type="button"');
    expect(keys).not.toContain('tabindex="-1"');
  });

  it('keeps inferred mapping marks visible in empty, busy, error, keyboard, stacked, and narrow states', () => {
    const graph = createElement(WorkflowDiagram, {
      drawer: { capabilityVersionId: null, restoreFocusStepId: null },
      onCloseDrawer: vi.fn<() => void>(),
      onOpenNode: vi.fn<(node: DiagramNode) => void>(),
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
          [
            { stepId: 'load-payment', capabilityVersionId: 'payment.get@v1' },
            { stepId: 'create-intent', capabilityVersionId: 'stripe.intent@v1' },
          ],
          [],
          [
            { stepId: 'create-intent', destinationPath: ['amount'], origin: 'requested' },
            { stepId: 'create-intent', destinationPath: ['currency'], origin: 'requested' },
            { stepId: 'create-intent', destinationPath: ['Idempotency-Key'], origin: 'inferred' },
          ],
        ),
      },
      targets: { nodeMarkers: {}, edgeMarkers: {}, diagramMarkers: [] },
    });
    const empty = renderCompose({ editor: editorWithText(''), graph, workflowName: '' });
    const busy = renderCompose({ graph, isBusy: true });
    const failed = renderCompose({ error: 'Workflow drafting failed', graph });
    const keys = renderCompose({ editor: highlightedEditor(), graph });

    for (const html of [empty, busy, failed, keys]) {
      expect(html).toContain('wf-compose-split');
      expect(html).toContain('wf-d3-edge-mapping-requested');
      expect(html).toContain('wf-d3-edge-mapping-inferred');
      expect(html).toContain('maps amount · you asked for this');
      expect(html).toContain('maps Idempotency-Key · Atlas inferred this');
    }
    expect(empty).toContain('disabled=""');
    expect(busy).toContain('aria-busy="true"');
    expect(failed).toContain('role="alert"');
    expect(keys).toContain('type="button"');
    expect(keys).not.toContain('tabindex="-1"');
    expect(composeCss).toContain('.wf-d3-edge-mapping-requested');
    expect(composeCss).toContain('.wf-d3-edge-mapping-inferred');
    expect(composeCss).toMatch(
      /\.wf-compose-split\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    );
  });
});
