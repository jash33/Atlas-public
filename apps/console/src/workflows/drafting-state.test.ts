import { describe, expect, it } from 'vite-plus/test';

import {
  cancelDraft,
  canReviseDraftRequest,
  createDraftingState,
  editRequest,
  environmentActionForAnswer,
  receiveDraftResponse,
  reviseRequest,
  submitClarificationAnswer,
  submitDraft,
  submitDraftRevision,
} from './drafting-state.js';

describe('drafting state machine', () => {
  it('offers request revision only when changing intent can resolve the outcome', () => {
    expect(canReviseDraftRequest('clarification-exhausted')).toBe(true);
    expect(canReviseDraftRequest('ambiguity')).toBe(true);
    expect(canReviseDraftRequest('repair-exhausted')).toBe(false);
    expect(canReviseDraftRequest('validation-policy-invalid')).toBe(false);
  });

  it('starts in editing and does not reveal validated evidence', () => {
    const state = createDraftingState();

    expect(state.phase).toBe('editing');
    expect(state.revealEvidence).toBe(false);
    expect(state.revealValidated).toBe(false);
    expect(state.transcript).toEqual([]);
    expect(state.originalRequest).toBeUndefined();
    expect(state.clarifiedRequest).toBeUndefined();
  });

  it('enters drafting on submit and hides any earlier planning result', () => {
    const submitted = submitDraft(createDraftingState(), 'Read the payment record.');

    expect(submitted.phase).toBe('drafting');
    expect(submitted.request).toBe('Read the payment record.');
    expect(submitted.requestId).toBeGreaterThan(0);
    expect(submitted.revealEvidence).toBe(false);
    expect(submitted.revealValidated).toBe(false);
    expect(submitted.transcript).toEqual([]);
    expect(submitted.clarifiedRequest).toBeUndefined();
    expect(submitted.originalRequest).toBeUndefined();
  });

  it('cancels an active attempt and invalidates any late response', () => {
    const drafting = submitDraft(createDraftingState(), 'Read the payment record.');
    const cancelled = cancelDraft(drafting);

    expect(cancelled.phase).toBe('editing');
    expect(cancelled.request).toBe('Read the payment record.');
    expect(cancelled.requestId).toBeGreaterThan(drafting.requestId);

    const stale = receiveDraftResponse(cancelled, drafting.requestId, {
      status: 'unsupported',
      reason: 'This response arrived after cancellation.',
    });
    expect(stale).toBe(cancelled);
  });

  it('restores the prior clarification when its answer is cancelled', () => {
    const drafting = submitDraft(createDraftingState(), 'Read a payment.');
    const asked = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'clarification_required',
      reason: 'missing-business-fact',
      question: 'Which payment should Atlas read?',
      suggestedAnswers: ['The current payment', 'The invoice payment', 'The latest payment'],
      continuation: 'cont.token',
    });
    const answering = submitClarificationAnswer(asked, 'The current payment');
    const cancelled = cancelDraft(answering, asked);

    expect(cancelled.phase).toBe('clarification_required');
    expect(cancelled.question).toBe('Which payment should Atlas read?');
    expect(cancelled.requestId).toBeGreaterThan(answering.requestId);
  });

  it('retains the reviewed workflow context while clarifying a corrective prompt', () => {
    const revisionContext = {
      previousRequest: 'Read a payment record.',
      draft: { workflowVersionId: 'payment-read@1', executable: { steps: [] } },
    };
    const drafting = submitDraftRevision(
      createDraftingState('Read a payment record.'),
      'I actually meant to notify operations after reading it.',
      revisionContext,
    );

    const asked = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'clarification_required',
      reason: 'missing-business-fact',
      question: 'Which notification operation should Atlas use?',
      suggestedAnswers: ['Use notifyOperations', 'Keep the current workflow', 'Stop drafting'],
      continuation: 'cont.token',
    });
    const answering = submitClarificationAnswer(asked, 'Use notifyOperations');

    expect(answering.revisionContext).toEqual(revisionContext);
    expect(answering.request).toBe('I actually meant to notify operations after reading it.');
  });

  it('renders a clarification question and resumes the same request with a continuation', () => {
    const drafting = submitDraft(createDraftingState(), 'Settle a payment somehow.');
    const asked = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'clarification_required',
      reason: 'missing-business-fact',
      question: 'Which payment field should the workflow read?',
      questionAnnotations: [
        {
          start: 6,
          end: 13,
          text: 'payment',
          kind: 'capability',
          capabilityVersionId: 'cap-get-payment',
          evidence: {
            projectionFingerprint: 'b'.repeat(64),
            capabilityVersionId: 'cap-get-payment',
            matchedTerms: ['payment'],
          },
        },
      ],
      suggestedAnswers: [
        'Use the getPayment request field paymentId',
        'Use the workflow input paymentId',
        'Use the payment record id',
      ],
      suggestedAnswerAnnotations: [
        {
          answer: 'Use the getPayment request field paymentId',
          annotations: [
            {
              start: 8,
              end: 18,
              text: 'getPayment',
              kind: 'capability',
              capabilityVersionId: 'cap-get-payment',
              evidence: {
                projectionFingerprint: 'b'.repeat(64),
                capabilityVersionId: 'cap-get-payment',
                matchedTerms: ['getpayment'],
              },
            },
          ],
        },
      ],
      suggestedAnswerActions: [
        {
          answer: 'Use the payment record id',
          action: 'change-environment',
          environmentId: 'production',
        },
      ],
      intentFrame: { summary: 'Read a payment using getPayment and paymentId.' },
      interpretedRequest: 'Read a payment using getPayment and paymentId.',
      interpretedRequestAnnotations: [
        {
          start: 21,
          end: 31,
          text: 'getPayment',
          kind: 'capability',
          capabilityVersionId: 'cap-get-payment',
          evidence: {
            projectionFingerprint: 'b'.repeat(64),
            capabilityVersionId: 'cap-get-payment',
            matchedTerms: ['getpayment'],
          },
        },
      ],
      validation: {
        diagnostics: [
          {
            code: 'SOURCE_PATH_NOT_FOUND',
            path: 'executable.steps[get-payment].arguments.paymentId',
            message: "Source path 'paymentId' is absent from the pinned schema.",
          },
        ],
      },
      continuation: 'cont.token',
    });

    expect(asked.phase).toBe('clarification_required');
    expect(asked.question).toBe('Which payment field should the workflow read?');
    expect(asked.questionAnnotations?.[0]?.text).toBe('payment');
    expect(asked.suggestedAnswers).toEqual([
      'Use the getPayment request field paymentId',
      'Use the workflow input paymentId',
      'Use the payment record id',
    ]);
    expect(asked.suggestedAnswerAnnotations?.[0]?.annotations[0]?.text).toBe('getPayment');
    expect(asked.suggestedAnswerActions?.[0]).toEqual({
      answer: 'Use the payment record id',
      action: 'change-environment',
      environmentId: 'production',
    });
    expect(environmentActionForAnswer(asked, 'Use the payment record id')).toEqual({
      answer: 'Use the payment record id',
      action: 'change-environment',
      environmentId: 'production',
    });
    expect(asked.interpretedRequest).toBe('Read a payment using getPayment and paymentId.');
    expect(asked.interpretedRequestAnnotations?.[0]?.text).toBe('getPayment');
    expect(asked.reason).toBe('missing-business-fact');
    expect(asked.continuation).toBe('cont.token');
    expect(asked.validation?.diagnostics?.[0]?.code).toBe('SOURCE_PATH_NOT_FOUND');
    expect(asked.request).toBe('Settle a payment somehow.');
    expect(asked.transcript).toEqual([
      { question: 'Which payment field should the workflow read?' },
    ]);
    expect(asked.revealEvidence).toBe(false);
    expect(asked.revealValidated).toBe(false);

    const answering = submitClarificationAnswer(
      asked,
      'Use the getPayment request field paymentId',
    );
    expect(answering.phase).toBe('drafting');
    expect(answering.request).toBe('Settle a payment somehow.');
    expect(answering.continuation).toBe('cont.token');
    expect(answering.answer).toBe('Use the getPayment request field paymentId');
    expect(answering.requestId).toBeGreaterThan(asked.requestId);
    expect(answering.transcript).toEqual([
      {
        question: 'Which payment field should the workflow read?',
        answer: 'Use the getPayment request field paymentId',
      },
    ]);
    expect(answering.revealEvidence).toBe(false);
  });

  it('reveals evidence only after a verified validated response', () => {
    const originalRequest = 'When a payment succeeds, read its payment record.';
    const clarifiedRequest =
      'When a payment succeeds, read its payment record with getPayment using request field paymentId.';
    const drafting = submitDraft(createDraftingState(), originalRequest);
    const validated = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'validated',
      originalRequest,
      clarifiedRequest,
      annotations: [
        {
          start: clarifiedRequest.indexOf('getPayment'),
          end: clarifiedRequest.indexOf('getPayment') + 'getPayment'.length,
          text: 'getPayment',
          kind: 'capability',
          capabilityVersionId: 'cap-payments',
          evidence: {
            projectionFingerprint: 'b'.repeat(64),
            capabilityVersionId: 'cap-payments',
            matchedTerms: ['getpayment'],
          },
        },
      ],
      intentFingerprint: 'a'.repeat(64),
      projectionFingerprint: 'b'.repeat(64),
      draft: { workflowVersionId: 'payment-read@1' },
    });

    expect(validated.phase).toBe('validated');
    expect(validated.revealEvidence).toBe(true);
    expect(validated.revealValidated).toBe(true);
    expect(validated.originalRequest).toBe(originalRequest);
    expect(validated.clarifiedRequest).toBe(clarifiedRequest);
    expect(validated.request).toBe(originalRequest);
    expect(validated.annotations).toEqual([
      {
        start: clarifiedRequest.indexOf('getPayment'),
        end: clarifiedRequest.indexOf('getPayment') + 'getPayment'.length,
        text: 'getPayment',
        kind: 'capability',
        capabilityVersionId: 'cap-payments',
        evidence: {
          projectionFingerprint: 'b'.repeat(64),
          capabilityVersionId: 'cap-payments',
          matchedTerms: ['getpayment'],
        },
      },
    ]);
    expect(validated.projectionFingerprint).toBe('b'.repeat(64));
    expect(validated.draft).toEqual({ workflowVersionId: 'payment-read@1' });
  });

  it('binds a clicked mapping suggestion to its deterministic candidate', () => {
    const drafting = submitDraft(createDraftingState(), 'Create a payment intent.');
    const asked = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'clarification_required',
      reason: 'duplicate-field-candidates',
      question: 'Which source should provide destination field amount?',
      suggestedAnswers: ['Use get-payment output amount.value'],
      suggestedAnswerSelections: [
        {
          answer: 'Use get-payment output amount.value',
          candidateId: 'amount<-step:get-payment:amount.value:convert',
          destinationPath: ['amount'],
        },
      ],
      mapping: {
        intentFingerprint: 'a'.repeat(64),
        projectionFingerprint: 'b'.repeat(64),
        sourceSteps: [{ stepId: 'get-payment', capabilityVersionId: 'cap-get-payment' }],
        destinationCapabilityVersionId: 'cap-create-intent',
        destinationStepId: 'create-intent',
        history: [],
      },
      continuation: 'cont.token',
    });

    const answering = submitClarificationAnswer(asked, 'Use get-payment output amount.value');

    expect(answering.mapping?.selections).toEqual({
      amount: 'amount<-step:get-payment:amount.value:convert',
    });
  });

  it('preserves resolved mappings across an unrelated follow-up question', () => {
    const drafting = submitDraft(createDraftingState(), 'Create a payment intent.');
    const mapping = {
      intentFingerprint: 'a'.repeat(64),
      projectionFingerprint: 'b'.repeat(64),
      sourceSteps: [{ stepId: 'get-payment', capabilityVersionId: 'cap-get-payment' }],
      destinationCapabilityVersionId: 'cap-create-intent',
      destinationStepId: 'create-intent',
      history: [],
      selections: { amount: 'amount<-step:get-payment:amount.value:convert' },
    };
    const withMapping = { ...drafting, mapping };
    const asked = receiveDraftResponse(withMapping, withMapping.requestId, {
      status: 'clarification_required',
      reason: 'missing-business-fact',
      question: 'Which response field contains the currency?',
      suggestedAnswers: ['currency', 'amount.currency', 'currency.code'],
      continuation: 'next.token',
    });

    expect(asked.mapping).toEqual(mapping);
  });

  it('refuses validated when a cited annotation does not bind to the clarified request', () => {
    const drafting = submitDraft(createDraftingState(), 'Read the payment.');
    const refused = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'validated',
      originalRequest: 'Read the payment.',
      clarifiedRequest: 'Read the payment with getPayment.',
      annotations: [
        {
          start: 0,
          end: 10,
          text: 'getPayment',
          kind: 'capability',
          capabilityVersionId: 'cap-payments',
          evidence: {
            projectionFingerprint: 'b'.repeat(64),
            capabilityVersionId: 'cap-payments',
            matchedTerms: ['getpayment'],
          },
        },
      ],
      intentFingerprint: 'a'.repeat(64),
      projectionFingerprint: 'b'.repeat(64),
      draft: { workflowVersionId: 'payment-read@1' },
    });

    expect(refused.phase).toBe('manual_review');
    expect(refused.reason).toBe('unresolved-reference');
    expect(refused.revealEvidence).toBe(false);
    expect(refused.revealValidated).toBe(false);
  });

  it('refuses validated when clarified text is present without verified annotations', () => {
    const drafting = submitDraft(createDraftingState(), 'Read the payment.');
    const refused = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'validated',
      originalRequest: 'Read the payment.',
      clarifiedRequest: 'Read the payment with getPayment.',
      annotations: [
        {
          start: 22,
          end: 32,
          text: 'getPayment',
          kind: 'capability',
          capabilityVersionId: 'cap-payments',
        },
      ],
      intentFingerprint: 'a'.repeat(64),
      projectionFingerprint: 'b'.repeat(64),
      draft: { workflowVersionId: 'payment-read@1' },
    });

    expect(refused.phase).not.toBe('validated');
    expect(refused.revealEvidence).toBe(false);
    expect(refused.revealValidated).toBe(false);
  });

  it('returns to editing and hides evidence when the request text changes after validation', () => {
    const originalRequest = 'When a payment succeeds, read its payment record.';
    const drafting = submitDraft(createDraftingState(), originalRequest);
    const validated = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'validated',
      originalRequest,
      clarifiedRequest: `${originalRequest} with getPayment.`,
      annotations: [],
      intentFingerprint: 'a'.repeat(64),
      projectionFingerprint: 'b'.repeat(64),
      draft: { workflowVersionId: 'payment-read@1' },
    });

    const sameText = editRequest(validated, originalRequest);
    expect(sameText.phase).toBe('validated');
    expect(sameText.revealEvidence).toBe(true);

    const edited = editRequest(validated, `${originalRequest} Also notify operations.`);
    expect(edited.phase).toBe('editing');
    expect(edited.request).toBe(`${originalRequest} Also notify operations.`);
    expect(edited.revealEvidence).toBe(false);
    expect(edited.revealValidated).toBe(false);
    expect(edited.clarifiedRequest).toBeUndefined();
    expect(edited.originalRequest).toBeUndefined();
    expect(edited.annotations).toBeUndefined();
    expect(edited.draft).toBeUndefined();
  });

  it('ignores a stale response from an earlier draft attempt', () => {
    const first = submitDraft(createDraftingState(), 'Read the payment.');
    const second = submitDraft(first, 'Create a Stripe payment intent.');
    const stale = receiveDraftResponse(second, first.requestId, {
      status: 'validated',
      originalRequest: 'Read the payment.',
      clarifiedRequest: 'Read the payment with getPayment.',
      annotations: [],
      intentFingerprint: 'a'.repeat(64),
      projectionFingerprint: 'b'.repeat(64),
      draft: { workflowVersionId: 'stale@1' },
    });

    expect(stale.phase).toBe('drafting');
    expect(stale.request).toBe('Create a Stripe payment intent.');
    expect(stale.revealEvidence).toBe(false);
    expect(stale.draft).toBeUndefined();
  });

  it('blocks unsupported intent with a concrete reason and a revise path', () => {
    const drafting = submitDraft(createDraftingState(), 'Book a flight to Paris.');
    const blocked = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'unsupported',
      reason: 'The request is outside the supported capability set',
    });

    expect(blocked.phase).toBe('unsupported');
    expect(blocked.reason).toBe('The request is outside the supported capability set');
    expect(blocked.revealEvidence).toBe(false);
    expect(blocked.revealValidated).toBe(false);

    const revised = reviseRequest(blocked);
    expect(revised.phase).toBe('editing');
    expect(revised.request).toBe('Book a flight to Paris.');
    expect(revised.reason).toBeUndefined();
    expect(revised.revealEvidence).toBe(false);
  });

  it('blocks manual review with a concrete reason and a revise path', () => {
    const drafting = submitDraft(createDraftingState(), 'Settle a payment somehow.');
    const blocked = receiveDraftResponse(drafting, drafting.requestId, {
      status: 'manual_review',
      reason: 'clarification-exhausted',
      detail: 'Three clarification rounds did not produce a grounded request',
    });

    expect(blocked.phase).toBe('manual_review');
    expect(blocked.reason).toBe('clarification-exhausted');
    expect(blocked.detail).toBe('Three clarification rounds did not produce a grounded request');
    expect(blocked.revealEvidence).toBe(false);

    const revised = reviseRequest(blocked);
    expect(revised.phase).toBe('editing');
    expect(revised.request).toBe('Settle a payment somehow.');
    expect(revised.detail).toBeUndefined();
  });

  it('keeps six clarification turns in one transcript and exhausts the seventh', () => {
    const questions = [
      'Which payment should the workflow read?',
      'Which capability creates the payment intent?',
      'Which event should the workflow publish?',
      'Which team should be notified?',
      'Which identifier should be included?',
      'Which failure behavior should apply?',
      'Which optional detail should be omitted?',
    ];
    let state = submitDraft(createDraftingState(), 'Settle a payment somehow.');

    for (const [index, question] of questions.slice(0, 6).entries()) {
      state = receiveDraftResponse(state, state.requestId, {
        status: 'clarification_required',
        reason: 'missing-business-fact',
        question,
        suggestedAnswers: [`${question} A`, `${question} B`, `${question} C`],
        continuation: `cont.${index + 1}`,
      });
      expect(state.phase).toBe('clarification_required');
      expect(state.question).toBe(question);
      state = submitClarificationAnswer(state, `Answer ${index + 1}`);
    }

    expect(state.transcript).toHaveLength(6);

    const exhausted = receiveDraftResponse(state, state.requestId, {
      status: 'clarification_required',
      reason: 'missing-business-fact',
      question: questions[6]!,
      suggestedAnswers: ['The payment', 'The invoice', 'The shipment'],
      continuation: 'cont.7',
    });
    expect(exhausted.phase).toBe('manual_review');
    expect(exhausted.reason).toBe('clarification-exhausted');
    expect(exhausted.revealEvidence).toBe(false);

    const retry = submitDraft(exhausted, 'Settle a payment somehow.');
    expect(retry.phase).toBe('drafting');
    expect(retry.transcript).toEqual([]);
    expect(retry.revealEvidence).toBe(false);
    expect(retry.clarifiedRequest).toBeUndefined();
  });
});
