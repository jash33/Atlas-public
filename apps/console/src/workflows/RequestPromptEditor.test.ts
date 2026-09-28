import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import { RequestPromptEditor } from './RequestPromptEditor.js';
import { createRequestEditor, type RequestEditor } from './request-editor.js';

describe('RequestPromptEditor', () => {
  it('offers the focused capability reference for keyboard inspection with verified context', () => {
    const base = createRequestEditor({ text: 'getPayment', cursor: 4 });
    const editor: RequestEditor = {
      ...base,
      annotations: [
        {
          start: 0,
          end: 10,
          kind: 'response-field',
          capabilityVersionId: 'cap-payments',
          direction: 'response',
          path: '/paymentId',
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

    const html = renderToStaticMarkup(
      createElement(RequestPromptEditor, {
        canDraft: true,
        editor,
        onEditorChange: () => undefined,
        onOpenCapability: () => undefined,
      }),
    );

    expect(html).toContain('<strong>Response field</strong>');
    expect(html).toContain('wf-ref-identified-reference');
    expect(html).toContain('Owner: payments-team');
    expect(html).toContain('response /paymentId');
    expect(html).toContain('aria-label="Open payments · getPayment capability details"');
    expect(html).toContain('payments');
    expect(html).toContain('getPayment');
    expect(html).not.toContain('cap-payments');
  });

  it('marks the prompt as busy while Atlas prepares the request', () => {
    const editor = createRequestEditor({ text: 'Send a receipt', cursor: 14 });

    const html = renderToStaticMarkup(
      createElement(RequestPromptEditor, {
        canDraft: true,
        editor,
        isLoading: true,
        onEditorChange: () => undefined,
      }),
    );

    expect(html).toContain('aria-busy="true"');
  });

  it('does not open reference information when selection leaves the caret at the bubble end', () => {
    const base = createRequestEditor({ text: '@getPayment', cursor: 11 });
    const editor: RequestEditor = {
      ...base,
      annotations: [
        {
          start: 0,
          end: 11,
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

    const html = renderToStaticMarkup(
      createElement(RequestPromptEditor, {
        canDraft: true,
        editor,
        onEditorChange: () => undefined,
      }),
    );

    expect(html).not.toContain('class="wf-ref-tooltip"');
  });

  it('shows runtime-input styling and lets the user remove its grounding', () => {
    const base = createRequestEditor({ text: 'paymentId', cursor: 4 });
    const runtimeInput = {
      start: 0,
      end: 9,
      kind: 'runtime-input' as const,
      inputName: 'paymentId',
    };
    const editor: RequestEditor = {
      ...base,
      annotations: [runtimeInput],
      explicit: [runtimeInput],
    };

    const html = renderToStaticMarkup(
      createElement(RequestPromptEditor, {
        canDraft: true,
        editor,
        onEditorChange: () => undefined,
      }),
    );

    expect(html).toContain('wf-ref-runtime-input');
    expect(html).toContain('wf-ref-identified-input');
    expect(html).toContain('<strong>Runtime input</strong>');
    expect(html).toContain('aria-label="Remove grounding for paymentId"');
    expect(html).not.toContain('capability details');
  });
});
