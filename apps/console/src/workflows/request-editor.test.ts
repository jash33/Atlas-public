import { describe, expect, it } from 'vite-plus/test';

import {
  applyReferenceIndex,
  createRequestEditor,
  handleSuggestionKey,
  interpretReferenceIndex,
  markAnnotationAsRuntimeInput,
  removeAnnotation,
  selectSuggestion,
  suggestionListbox,
  syncRequest,
  tooltipForAnnotation,
  type PlannerCapabilityReference,
  type ReferenceIndexOk,
  type Suggestion,
} from './request-editor.js';

const fingerprint = 'a'.repeat(64);

const paymentsIdentity = {
  kind: 'openapi' as const,
  serviceId: 'payments',
  operationId: 'getPayment',
};

const billingIdentity = {
  kind: 'openapi' as const,
  serviceId: 'billing',
  operationId: 'createInvoice',
};

const fixtureIndex: ReferenceIndexOk = {
  status: 'ok',
  fingerprint,
  references: [
    {
      capabilityVersionId: 'cap-payments',
      identity: paymentsIdentity,
      owner: 'payments-team',
      businessSemantics: { readsAuthoritativePayment: true },
      safety: { idempotencyField: null, compensatedBy: null, irreversibleAfter: false },
      provenance: {
        evidence: {
          kind: 'repository',
          repository: 'https://github.com/acme/payment-api',
          commit: '0123456789abcdef',
          path: 'openapi.json',
        },
      },
      searchTerms: ['payments', 'getpayment', 'get', 'payment', 'payments-team'],
      fields: [
        {
          capabilityVersionId: 'cap-payments',
          direction: 'request',
          path: '/paymentId',
          type: 'string',
          required: true,
          label: 'Payment Id',
          searchTerms: ['paymentid', 'payment', 'id', 'payment id'],
        },
        {
          capabilityVersionId: 'cap-payments',
          direction: 'response',
          path: '/paymentId',
          type: 'string',
          required: true,
          label: 'Payment Id',
          searchTerms: ['paymentid', 'payment', 'id', 'payment id'],
        },
      ],
    },
    {
      capabilityVersionId: 'cap-billing',
      identity: billingIdentity,
      owner: 'billing-team',
      businessSemantics: { recordsInvoice: true },
      safety: { idempotencyField: null, compensatedBy: null, irreversibleAfter: false },
      provenance: {
        evidence: {
          kind: 'repository',
          repository: 'https://github.com/acme/billing-api',
          commit: 'fedcba9876543210',
          path: 'openapi.json',
        },
      },
      searchTerms: ['billing', 'createinvoice', 'create', 'invoice', 'billing-team'],
      fields: [
        {
          capabilityVersionId: 'cap-billing',
          direction: 'request',
          path: '/paymentId',
          type: 'string',
          required: true,
          label: 'Payment Id',
          searchTerms: ['paymentid', 'payment', 'id', 'payment id'],
        },
        {
          capabilityVersionId: 'cap-billing',
          direction: 'request',
          path: '/customer/accountId',
          type: 'string',
          required: true,
          label: 'Account Id',
          searchTerms: ['accountid', 'account', 'id', 'account id'],
        },
        {
          capabilityVersionId: 'cap-billing',
          direction: 'response',
          path: '/lineItems/-/sku',
          type: 'string',
          required: false,
          label: 'Sku',
          searchTerms: ['sku'],
        },
      ],
    },
  ] satisfies PlannerCapabilityReference[],
};

function editorWithIndex(text = '', cursor = 0) {
  return applyReferenceIndex(createRequestEditor({ text, cursor }), fixtureIndex, {
    organizationId: 'org_atlas',
    environmentId: 'development',
  });
}

describe('request editor suggestions', () => {
  it('opens suggestions only for an @ mention with at least three query characters', () => {
    const ordinary = syncRequest(editorWithIndex(), 'pay', 3);
    expect(ordinary.suggestions).toEqual({
      capabilities: [],
      requestFields: [],
      responseFields: [],
    });
    expect(ordinary.list.open).toBe(false);

    const two = syncRequest(editorWithIndex(), '@pa', 3);
    expect(two.suggestions).toEqual({
      capabilities: [],
      requestFields: [],
      responseFields: [],
    });
    expect(two.list.open).toBe(false);

    const padded = syncRequest(editorWithIndex(), '  @pa', 5);
    expect(padded.suggestions).toEqual({
      capabilities: [],
      requestFields: [],
      responseFields: [],
    });

    const three = syncRequest(editorWithIndex(), '@pay', 4);
    expect(three.suggestions.capabilities).toEqual([
      {
        kind: 'capability',
        capabilityVersionId: 'cap-payments',
        identity: paymentsIdentity,
        owner: 'payments-team',
        label: 'getPayment',
      },
    ]);
    expect(three.suggestions.requestFields).toEqual([
      {
        kind: 'request-field',
        capabilityVersionId: 'cap-payments',
        identity: paymentsIdentity,
        owner: 'payments-team',
        label: 'Payment Id',
        direction: 'request',
        path: '/paymentId',
      },
      {
        kind: 'request-field',
        capabilityVersionId: 'cap-billing',
        identity: billingIdentity,
        owner: 'billing-team',
        label: 'Payment Id',
        direction: 'request',
        path: '/paymentId',
      },
    ]);
    expect(three.suggestions.responseFields).toEqual([
      {
        kind: 'response-field',
        capabilityVersionId: 'cap-payments',
        identity: paymentsIdentity,
        owner: 'payments-team',
        label: 'Payment Id',
        direction: 'response',
        path: '/paymentId',
      },
    ]);
    expect(three.list.open).toBe(true);
    expect(three.annotations).toEqual([]);
  });

  it('does not auto-bind a unique service name that is not the typed capability or field phrase', () => {
    const service = syncRequest(editorWithIndex(), '@payments', 9);
    expect(service.annotations).toEqual([]);
    expect(service.suggestions.capabilities).toEqual([
      {
        kind: 'capability',
        capabilityVersionId: 'cap-payments',
        identity: paymentsIdentity,
        owner: 'payments-team',
        label: 'getPayment',
      },
    ]);
  });

  it('auto-binds only a unique full token and leaves duplicate paymentId unbound', () => {
    const unique = syncRequest(editorWithIndex(), 'getPayment', 10);
    expect(unique.annotations).toEqual([
      {
        start: 0,
        end: 10,
        capabilityVersionId: 'cap-payments',
        kind: 'capability',
      },
    ]);
    expect(unique.suggestions).toEqual({
      capabilities: [],
      requestFields: [],
      responseFields: [],
    });
    expect(unique.list.open).toBe(false);

    const ambiguous = syncRequest(editorWithIndex(), '@paymentId', 10);
    expect(ambiguous.annotations).toEqual([]);
    expect(ambiguous.suggestions.requestFields).toEqual([
      {
        kind: 'request-field',
        capabilityVersionId: 'cap-payments',
        identity: paymentsIdentity,
        owner: 'payments-team',
        label: 'Payment Id',
        direction: 'request',
        path: '/paymentId',
      },
      {
        kind: 'request-field',
        capabilityVersionId: 'cap-billing',
        identity: billingIdentity,
        owner: 'billing-team',
        label: 'Payment Id',
        direction: 'request',
        path: '/paymentId',
      },
    ]);
    expect(ambiguous.suggestions.responseFields).toEqual([
      {
        kind: 'response-field',
        capabilityVersionId: 'cap-payments',
        identity: paymentsIdentity,
        owner: 'payments-team',
        label: 'Payment Id',
        direction: 'response',
        path: '/paymentId',
      },
    ]);
    expect(ambiguous.list.open).toBe(true);
  });

  it('records an explicit paymentId choice without injecting markup into the request text', () => {
    const billingPaymentId: Suggestion = {
      kind: 'request-field',
      capabilityVersionId: 'cap-billing',
      identity: billingIdentity,
      owner: 'billing-team',
      label: 'Payment Id',
      direction: 'request',
      path: '/paymentId',
    };
    const selected = selectSuggestion(syncRequest(editorWithIndex(), '@pay', 4), billingPaymentId);
    expect(selected.text).toBe('@paymentId  ');
    expect(selected.cursor).toBe(12);
    expect(selected.annotations).toEqual([
      {
        start: 0,
        end: 10,
        capabilityVersionId: 'cap-billing',
        kind: 'request-field',
        direction: 'request',
        path: '/paymentId',
      },
    ]);
    expect(selected.list.open).toBe(false);
    expect(selected.text.includes('<')).toBe(false);
  });

  it('lets the user reclassify or remove an incorrect capability-field grounding', () => {
    const billingPaymentId: Suggestion = {
      kind: 'request-field',
      capabilityVersionId: 'cap-billing',
      identity: billingIdentity,
      owner: 'billing-team',
      label: 'Payment Id',
      direction: 'request',
      path: '/paymentId',
    };
    const selected = selectSuggestion(
      syncRequest(editorWithIndex(), '@paymentId', 10),
      billingPaymentId,
    );

    const runtimeInput = markAnnotationAsRuntimeInput(selected, selected.annotations[0]!);
    expect(runtimeInput.annotations).toEqual([
      { start: 0, end: 10, kind: 'runtime-input', inputName: 'paymentId' },
    ]);
    expect(tooltipForAnnotation(runtimeInput, runtimeInput.annotations[0]!)).toEqual({
      kind: 'runtime-input',
      inputName: 'paymentId',
      label: 'Runtime input',
    });

    const removed = removeAnnotation(selected, selected.annotations[0]!);
    expect(removed.annotations).toEqual([]);
    expect(syncRequest(removed, removed.text, removed.cursor).annotations).toEqual([]);
  });

  it('drops or recomputes annotations when edited text no longer matches', () => {
    const bound = syncRequest(editorWithIndex(), 'getPayment', 10);
    const edited = syncRequest(bound, 'getPaymen', 9);
    expect(edited.annotations).toEqual([]);

    const prefixed = syncRequest(bound, 'Use getPayment', 14);
    expect(prefixed.annotations).toEqual([
      {
        start: 4,
        end: 14,
        capabilityVersionId: 'cap-payments',
        kind: 'capability',
      },
    ]);
    expect(prefixed.text.slice(4, 14)).toBe('getPayment');
  });

  it('keeps an explicit paymentId bind through surrounding edits and drops it after a conflicting paste', () => {
    const billingPaymentId: Suggestion = {
      kind: 'request-field',
      capabilityVersionId: 'cap-billing',
      identity: billingIdentity,
      owner: 'billing-team',
      label: 'Payment Id',
      direction: 'request',
      path: '/paymentId',
    };
    const selected = selectSuggestion(
      syncRequest(editorWithIndex(), '@paymentId', 10),
      billingPaymentId,
    );
    const surrounded = syncRequest(selected, 'Accept @paymentId now', 21);
    expect(surrounded.annotations).toEqual([
      {
        start: 7,
        end: 17,
        capabilityVersionId: 'cap-billing',
        kind: 'request-field',
        direction: 'request',
        path: '/paymentId',
      },
    ]);
    expect(surrounded.text.slice(7, 17)).toBe('@paymentId');

    const pasted = syncRequest(selected, 'createInvoice', 13);
    expect(pasted.annotations).toEqual([
      {
        start: 0,
        end: 13,
        capabilityVersionId: 'cap-billing',
        kind: 'capability',
      },
    ]);
  });

  it('auto-binds a unique spaced field label as a phrase', () => {
    const phrase = syncRequest(editorWithIndex(), 'Account Id', 10);
    expect(phrase.annotations).toEqual([
      {
        start: 0,
        end: 10,
        capabilityVersionId: 'cap-billing',
        kind: 'request-field',
        direction: 'request',
        path: '/customer/accountId',
      },
    ]);
  });

  it('binds a unique nested field and drops an overlapping phrase when a new selection wins', () => {
    const nested = syncRequest(editorWithIndex(), 'accountId', 9);
    expect(nested.annotations).toEqual([
      {
        start: 0,
        end: 9,
        capabilityVersionId: 'cap-billing',
        kind: 'request-field',
        direction: 'request',
        path: '/customer/accountId',
      },
    ]);

    const overlapping = selectSuggestion(syncRequest(editorWithIndex(), '@getPayment', 11), {
      kind: 'request-field',
      capabilityVersionId: 'cap-billing',
      identity: billingIdentity,
      owner: 'billing-team',
      label: 'Payment Id',
      direction: 'request',
      path: '/paymentId',
    });
    expect(overlapping.text).toBe('@paymentId  ');
    expect(overlapping.annotations).toEqual([
      {
        start: 0,
        end: 10,
        capabilityVersionId: 'cap-billing',
        kind: 'request-field',
        direction: 'request',
        path: '/paymentId',
      },
    ]);
  });

  it('clears the prior index and provisional bindings when org, environment, or fingerprint changes', () => {
    const billingPaymentId: Suggestion = {
      kind: 'request-field',
      capabilityVersionId: 'cap-billing',
      identity: billingIdentity,
      owner: 'billing-team',
      label: 'Payment Id',
      direction: 'request',
      path: '/paymentId',
    };
    const bound = selectSuggestion(
      syncRequest(editorWithIndex(), '@paymentId', 10),
      billingPaymentId,
    );
    expect(bound.annotations).toHaveLength(1);

    const otherEnv = applyReferenceIndex(bound, fixtureIndex, {
      organizationId: 'org_atlas',
      environmentId: 'production',
    });
    expect(otherEnv.annotations).toEqual([]);
    expect(otherEnv.environmentId).toBe('production');

    const rebound = selectSuggestion(syncRequest(otherEnv, '@paymentId', 10), billingPaymentId);
    const otherOrg = applyReferenceIndex(rebound, fixtureIndex, {
      organizationId: 'org_other',
      environmentId: 'production',
    });
    expect(otherOrg.annotations).toEqual([]);

    const stale = applyReferenceIndex(
      rebound,
      { status: 'stale', fingerprint: 'b'.repeat(64) },
      {
        organizationId: 'org_atlas',
        environmentId: 'production',
      },
    );
    expect(stale.annotations).toEqual([]);
    expect(stale.suggestions).toEqual({
      capabilities: [],
      requestFields: [],
      responseFields: [],
    });
    expect(stale.indexStatus).toBe('stale');
    expect(stale.fingerprint).toBe('b'.repeat(64));

    const nextFingerprint = applyReferenceIndex(
      rebound,
      { ...fixtureIndex, fingerprint: 'c'.repeat(64) },
      { organizationId: 'org_atlas', environmentId: 'production' },
    );
    expect(nextFingerprint.annotations).toEqual([]);
    expect(nextFingerprint.fingerprint).toBe('c'.repeat(64));
  });

  it('does not keep suggestions from a previous fingerprint after the index becomes unavailable', () => {
    const open = syncRequest(editorWithIndex(), '@pay', 4);
    expect(open.list.open).toBe(true);
    const unavailable = applyReferenceIndex(
      open,
      { status: 'unavailable' },
      {
        organizationId: 'org_atlas',
        environmentId: 'development',
      },
    );
    expect(unavailable.suggestions).toEqual({
      capabilities: [],
      requestFields: [],
      responseFields: [],
    });
    expect(unavailable.list.open).toBe(false);
    expect(unavailable.indexStatus).toBe('unavailable');
    expect(interpretReferenceIndex({ error: 'organizationId-required' })).toEqual({
      status: 'invalid',
      error: 'organizationId-required',
    });
  });

  it('updates suggestions when the cursor moves onto another token', () => {
    const startOfToken = syncRequest(editorWithIndex('@pay @paymentId', 4), '@pay @paymentId', 4);
    expect(startOfToken.suggestions.requestFields.map((field) => field.path)).toEqual([
      '/paymentId',
      '/paymentId',
    ]);
    const moved = syncRequest(editorWithIndex('@pay @paymentId', 4), '@pay @paymentId', 15);
    expect(moved.suggestions.requestFields).toEqual([
      {
        kind: 'request-field',
        capabilityVersionId: 'cap-payments',
        identity: paymentsIdentity,
        owner: 'payments-team',
        label: 'Payment Id',
        direction: 'request',
        path: '/paymentId',
      },
      {
        kind: 'request-field',
        capabilityVersionId: 'cap-billing',
        identity: billingIdentity,
        owner: 'billing-team',
        label: 'Payment Id',
        direction: 'request',
        path: '/paymentId',
      },
    ]);
    expect(moved.list.open).toBe(true);
  });
});

describe('request editor suggestion list', () => {
  it('opens, navigates, selects, and dismisses from the keyboard', () => {
    const open = syncRequest(editorWithIndex(), '@pay', 4);
    const box = suggestionListbox(open);
    expect(box).toEqual({
      id: 'wf-capability-suggestions',
      role: 'listbox',
      'aria-expanded': true,
      'aria-activedescendant': 'wf-suggestion-0',
      options: [
        {
          id: 'wf-suggestion-0',
          role: 'option',
          'aria-selected': true,
          suggestion: {
            kind: 'capability',
            capabilityVersionId: 'cap-payments',
            identity: paymentsIdentity,
            owner: 'payments-team',
            label: 'getPayment',
          },
        },
        {
          id: 'wf-suggestion-1',
          role: 'option',
          'aria-selected': false,
          suggestion: {
            kind: 'request-field',
            capabilityVersionId: 'cap-payments',
            identity: paymentsIdentity,
            owner: 'payments-team',
            label: 'Payment Id',
            direction: 'request',
            path: '/paymentId',
          },
        },
        {
          id: 'wf-suggestion-2',
          role: 'option',
          'aria-selected': false,
          suggestion: {
            kind: 'request-field',
            capabilityVersionId: 'cap-billing',
            identity: billingIdentity,
            owner: 'billing-team',
            label: 'Payment Id',
            direction: 'request',
            path: '/paymentId',
          },
        },
        {
          id: 'wf-suggestion-3',
          role: 'option',
          'aria-selected': false,
          suggestion: {
            kind: 'response-field',
            capabilityVersionId: 'cap-payments',
            identity: paymentsIdentity,
            owner: 'payments-team',
            label: 'Payment Id',
            direction: 'response',
            path: '/paymentId',
          },
        },
      ],
    });

    const down = handleSuggestionKey(open, 'ArrowDown');
    expect(suggestionListbox(down)['aria-activedescendant']).toBe('wf-suggestion-1');
    expect(suggestionListbox(down).options[1]?.['aria-selected']).toBe(true);

    const wrap = handleSuggestionKey(
      handleSuggestionKey(handleSuggestionKey(down, 'ArrowDown'), 'ArrowDown'),
      'ArrowDown',
    );
    expect(suggestionListbox(wrap)['aria-activedescendant']).toBe('wf-suggestion-0');

    const up = handleSuggestionKey(open, 'ArrowUp');
    expect(suggestionListbox(up)['aria-activedescendant']).toBe('wf-suggestion-3');

    const dismissed = handleSuggestionKey(down, 'Escape');
    expect(dismissed.list.open).toBe(false);
    expect(suggestionListbox(dismissed)['aria-expanded']).toBe(false);
    expect(dismissed.text).toBe('@pay');
    expect(dismissed.annotations).toEqual([]);

    const chosen = handleSuggestionKey(down, 'Enter');
    expect(chosen.text).toBe('@paymentId  ');
    expect(chosen.cursor).toBe(12);
    expect(chosen.annotations).toEqual([
      {
        start: 0,
        end: 10,
        capabilityVersionId: 'cap-payments',
        kind: 'request-field',
        direction: 'request',
        path: '/paymentId',
      },
    ]);

    const tabbed = handleSuggestionKey(down, 'Tab');
    expect(tabbed.text).toBe('@paymentId  ');
    expect(tabbed.annotations[0]).toMatchObject({ capabilityVersionId: 'cap-payments' });
  });

  it('derives tooltip copy from trusted reference metadata', () => {
    const bound = syncRequest(editorWithIndex(), 'getPayment', 10);
    expect(tooltipForAnnotation(bound, bound.annotations[0]!)).toEqual({
      capabilityVersionId: 'cap-payments',
      serviceId: 'payments',
      operationId: 'getPayment',
      owner: 'payments-team',
      provenanceSummary: 'https://github.com/acme/payment-api @ 0123456789abcdef · openapi.json',
    });

    const nested = syncRequest(editorWithIndex(), 'accountId', 9);
    expect(tooltipForAnnotation(nested, nested.annotations[0]!)).toEqual({
      capabilityVersionId: 'cap-billing',
      serviceId: 'billing',
      operationId: 'createInvoice',
      owner: 'billing-team',
      direction: 'request',
      path: '/customer/accountId',
      provenanceSummary: 'https://github.com/acme/billing-api @ fedcba9876543210 · openapi.json',
    });
  });
});
