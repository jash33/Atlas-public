import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import {
  builderCapabilitiesFromProjection,
  builderIssues,
  createBuilderDocument,
} from './builder-model.js';
import {
  lastKnownDefinitionMessage,
  type CapabilityObservation,
} from './capability-definition-status.js';
import { BuilderCapabilityField } from './WorkflowBuilderFields.js';
import { RequestPromptEditor } from './RequestPromptEditor.js';
import { ReferencedText } from './ReferencedText.js';
import {
  applyReferenceIndex,
  createRequestEditor,
  handleSuggestionKey,
  syncRequest,
  type ReferenceIndexOk,
} from './request-editor.js';
import { verifiedReferenceTooltip, type VerifiedRequestAnnotation } from './validated-request.js';

function observation(
  reason: string,
  freshness: CapabilityObservation['freshness'] = 'stale',
): CapabilityObservation {
  return {
    availability: 'available',
    freshness,
    reason,
    lastObservedAt: '2026-09-19T12:00:00.000Z',
    statusChangedAt: '2026-09-20T12:00:00.000Z',
  };
}

function projection(status?: CapabilityObservation) {
  return {
    capabilities: [
      {
        capabilityVersionId: 'read-v1',
        identity: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
        fragment: {
          operation: {
            summary: 'Read a payment',
            parameters: [{ name: 'paymentId', required: true, schema: { type: 'string' } }],
          },
        },
        ...(status ? { observation: status } : {}),
      },
    ],
  };
}

function referenceIndex(status: CapabilityObservation): ReferenceIndexOk {
  return {
    status: 'ok',
    fingerprint: 'a'.repeat(64),
    references: [
      {
        capabilityVersionId: 'read-v1',
        identity: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
        owner: 'payments-team',
        businessSemantics: null,
        safety: { idempotencyField: null, compensatedBy: null, irreversibleAfter: false },
        provenance: null,
        searchTerms: ['get', 'getpayment'],
        fields: [],
        observation: status,
      },
    ],
  };
}

describe('last known capability definitions in workflow creation', () => {
  it.each(['discovery-failed', 'observation-stale'])(
    'keeps %s capabilities in the manual picker with their input fields',
    (reason) => {
      const status = observation(reason);
      const capabilities = builderCapabilitiesFromProjection(projection(status));
      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]).toMatchObject({
        capabilityVersionId: 'read-v1',
        inputSchema: { required: { paymentId: { type: 'string' } } },
        observation: status,
      });
      const html = renderToStaticMarkup(
        createElement(BuilderCapabilityField, {
          capabilities,
          capabilityVersionId: 'read-v1',
          disabled: false,
          onSelect: () => undefined,
        }),
      );
      const select = html.match(/<select\b[^>]*>/)?.[0];
      const option = html.match(/<option\b[^>]*value="read-v1"[^>]*>/)?.[0];
      expect(select).toBeDefined();
      expect(option).toBeDefined();
      expect(select).not.toContain('disabled');
      expect(option).not.toContain('disabled');
      expect(option).toContain('selected');
      expect(html).toContain('payments / getPayment · Last known definition');
      expect(html).toContain(lastKnownDefinitionMessage);
      expect(html).not.toContain('unavailable');
    },
  );

  it('does not turn discovery status into a blocking builder issue or executable field', () => {
    const capabilities = builderCapabilitiesFromProjection(
      projection(observation('discovery-failed')),
    );
    const document = createBuilderDocument(
      {
        irVersion: 1,
        inputSchema: { required: { paymentId: { type: 'string' } } },
        steps: [
          {
            id: 'read',
            kind: 'capabilityCall',
            capabilityVersionId: 'read-v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          { id: 'finish', kind: 'terminal', state: 'completed' },
        ],
      },
      capabilities,
    );
    expect(builderIssues(document)).toEqual([]);
    expect(JSON.stringify(document.executable)).not.toContain('observation');
  });

  it.each([undefined, observation('observed', 'fresh')])(
    'leaves current or older projections without a last-known warning',
    (status) => {
      const html = renderToStaticMarkup(
        createElement(BuilderCapabilityField, {
          capabilities: builderCapabilitiesFromProjection(projection(status)),
          capabilityVersionId: 'read-v1',
          disabled: false,
          onSelect: () => undefined,
        }),
      );
      expect(html).not.toContain('Last known definition');
      expect(html).not.toContain(lastKnownDefinitionMessage);
      expect(html).not.toContain('unavailable');
    },
  );

  it('keeps stale AI references searchable and selectable, then explains the saved definition', () => {
    const editor = applyReferenceIndex(
      createRequestEditor({ text: '@get', cursor: 4 }),
      referenceIndex(observation('discovery-failed')),
      { organizationId: 'org_atlas', environmentId: 'development' },
    );
    expect(editor.indexStatus).toBe('ok');
    expect(editor.suggestions.capabilities).toHaveLength(1);
    expect(editor.list.open).toBe(true);
    const suggestions = renderToStaticMarkup(
      createElement(RequestPromptEditor, {
        editor,
        canDraft: true,
        onEditorChange: () => undefined,
      }),
    );
    expect(suggestions).toContain('role="option"');
    expect(suggestions).toContain('Last known definition');
    expect(suggestions).not.toContain('aria-disabled="true"');
    expect(suggestions).not.toContain('Suggestions are hidden');
    const selected = handleSuggestionKey(editor, 'Enter');
    expect(selected.annotations).toContainEqual(
      expect.objectContaining({ kind: 'capability', capabilityVersionId: 'read-v1' }),
    );
    const focused = syncRequest(selected, selected.text, 3);
    const tooltip = renderToStaticMarkup(
      createElement(RequestPromptEditor, {
        editor: focused,
        canDraft: true,
        onEditorChange: () => undefined,
      }),
    );
    expect(tooltip).toContain(lastKnownDefinitionMessage);
  });

  it('carries the last-known status into generated AI reference details', () => {
    const annotation: VerifiedRequestAnnotation = {
      start: 0,
      end: 10,
      text: 'getPayment',
      kind: 'capability',
      capabilityVersionId: 'read-v1',
      evidence: {
        projectionFingerprint: 'a'.repeat(64),
        capabilityVersionId: 'read-v1',
        matchedTerms: ['getpayment'],
      },
    };
    const identities = [
      {
        capabilityVersionId: 'read-v1',
        serviceId: 'payments',
        operationId: 'getPayment',
        observation: observation('discovery-failed'),
      },
    ];
    expect(verifiedReferenceTooltip(annotation, identities)).toMatchObject({
      observation: identities[0]?.observation,
    });
    const html = renderToStaticMarkup(
      createElement(ReferencedText, { text: 'getPayment', annotations: [annotation], identities }),
    );
    expect(html).toContain(
      'aria-label="Capability: payments · getPayment · Last known definition"',
    );
    expect(html).toContain('role="button"');
  });
});
