import { describe, expect, it } from 'vite-plus/test';
import { draftRequestBody, referenceHintsForDraft } from './draft-request.js';
import { createDraftingState } from './drafting-state.js';
import { createRequestEditor } from './request-editor.js';

describe('draft request construction', () => {
  it('sends structured capability and runtime-input hints with the request', () => {
    const text = '@getPayment  using paymentId.';
    const referenceHints = referenceHintsForDraft(
      {
        ...createRequestEditor({ text, cursor: 28 }),
        annotations: [
          {
            start: 0,
            end: 11,
            kind: 'capability',
            capabilityVersionId: 'cap-get-payment',
          },
          {
            start: 19,
            end: 28,
            kind: 'runtime-input',
            inputName: 'paymentId',
          },
        ],
      },
      text,
    );
    expect(referenceHints).toEqual({
      references: [
        {
          start: 0,
          end: 11,
          text: '@getPayment',
          kind: 'capability' as const,
          capabilityVersionId: 'cap-get-payment',
        },
        {
          start: 19,
          end: 28,
          text: 'paymentId',
          kind: 'runtimeInput',
          inputName: 'paymentId',
        },
      ],
    });
  });

  it('selects initial, revision, repair, and continuation payloads from session state', () => {
    const scope = {
      organizationId: 'org',
      environmentId: 'development',
      workflowVersionId: 'flow@2',
    };
    const state = createDraftingState('Read the payment.');
    const editor = createRequestEditor({ text: state.request });
    expect(draftRequestBody(scope, state, editor)).toEqual({ ...scope, request: state.request });
    const revisionContext = {
      previousRequest: 'Read a record.',
      draft: { workflowVersionId: 'flow@1' },
    };
    const revision = { ...state, revisionContext };
    expect(draftRequestBody(scope, revision, editor)).toMatchObject({ revisionContext });
    const repair = {
      ...revision,
      sandboxRepair: { tests: [{ status: 'failed' as const, stepId: 'read' }] },
    };
    expect(draftRequestBody(scope, repair, editor)).toMatchObject({
      sandboxRepair: repair.sandboxRepair,
    });
    const continuation = draftRequestBody(
      scope,
      { ...repair, continuation: 'bound-context', answer: 'Use paymentId' },
      editor,
    );
    expect(continuation).toMatchObject({
      continuation: 'bound-context',
      answer: 'Use paymentId',
      revisionContext,
    });
    expect(continuation).not.toHaveProperty('sandboxRepair');
  });
});
