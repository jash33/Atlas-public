import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { explainCheckFailure, shouldRepairCheckFailure } from './check-failure.js';
import { CheckFailurePanel, CheckRunError } from './CheckFailurePanel.js';

const identities = [
  {
    capabilityVersionId: 'stripe.payment-intents@v1',
    serviceId: 'stripe',
    operationId: 'createPaymentIntent',
  },
];

describe('check failure explanation', () => {
  it('explains a missing idempotency key in ordinary language with a suggested fix', () => {
    const explanation = explainCheckFailure(
      [
        {
          status: 'failed',
          stepId: 'create-stripe-intent',
          capabilityVersionId: 'stripe.payment-intents@v1',
          detail: 'StripeIdempotencyKeyRequired',
        },
      ],
      { identities },
    );

    expect(explanation).toEqual({
      error: 'stripe · createPaymentIntent expects an idempotency key.',
      why: 'The draft did not provide one.',
      suggestedFix: 'Map the idempotency key from paymentId.',
      stepId: 'create-stripe-intent',
      graphMark: 'stripe · createPaymentIntent expects an idempotency key and none was provided.',
    });
    expect(explanation?.error).not.toMatch(/[A-Z]{2,}_[A-Z0-9_]+/);
    expect(JSON.stringify(explanation)).not.toContain('fingerprint');
    expect(JSON.stringify(explanation)).not.toContain('irHash');
  });

  it('keeps a generic failure as the exact error, why, and a suggested revision', () => {
    const explanation = explainCheckFailure([
      {
        status: 'failed',
        stepId: 'create-stripe-intent',
        detail: 'Stripe rejected the amount.',
      },
    ]);

    expect(explanation?.error).toBe(
      'Create stripe intent failed because Stripe rejected the amount.',
    );
    expect(explanation?.why).toBe(
      'A check on this version failed, so Atlas cannot approve it yet.',
    );
    expect(explanation?.suggestedFix).toBe('Revise Create stripe intent so the check can pass.');
    expect(explanation?.stepId).toBe('create-stripe-intent');
  });

  it('repairs a contract check once, then surfaces the failure', () => {
    expect(shouldRepairCheckFailure([{ status: 'failed', stepId: 'create-intent' }], 0)).toBe(true);
    expect(shouldRepairCheckFailure([{ status: 'failed', stepId: 'create-intent' }], 1)).toBe(
      false,
    );
    expect(shouldRepairCheckFailure([{ status: 'passed' }], 0)).toBe(false);
  });
});

describe('CheckFailurePanel', () => {
  it('shows the error, why, and an acceptible suggested fix', () => {
    const html = renderToStaticMarkup(
      createElement(CheckFailurePanel, {
        canDraft: true,
        explanation: {
          error: 'stripe · createPaymentIntent expects an idempotency key.',
          why: 'The draft did not provide one.',
          suggestedFix: 'Map the idempotency key from paymentId.',
          stepId: 'create-stripe-intent',
          graphMark:
            'stripe · createPaymentIntent expects an idempotency key and none was provided.',
        },
        onAcceptFix: vi.fn<(fix: string) => void>(),
      }),
    );

    expect(html).toContain('Checks found a problem');
    expect(html).toContain('stripe · createPaymentIntent expects an idempotency key.');
    expect(html).toContain('The draft did not provide one.');
    expect(html).toContain('Map the idempotency key from paymentId.');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('tabindex="-1"');
    expect(html).not.toContain('Run checks');
    expect(html).not.toContain('irHash');
    expect(html).not.toContain('fingerprint');
  });

  it('blocks operators from accepting a suggested fix', () => {
    const html = renderToStaticMarkup(
      createElement(CheckFailurePanel, {
        canDraft: false,
        explanation: {
          error: 'Create stripe intent failed because Stripe rejected the amount.',
          why: 'A check on this version failed, so Atlas cannot approve it yet.',
          suggestedFix: 'Revise Create stripe intent so the check can pass.',
          stepId: 'create-stripe-intent',
          graphMark: 'Create stripe intent failed.',
        },
        onAcceptFix: vi.fn<(fix: string) => void>(),
      }),
    );

    expect(html).toContain('Switch to Author or Admin to create a workflow');
    expect(html).not.toContain('>Revise Create stripe intent so the check can pass.<');
  });
});

describe('CheckRunError', () => {
  it('explains that checks never finished instead of treating the runner crash as a failed check', () => {
    const html = renderToStaticMarkup(
      createElement(CheckRunError, { error: 'The check runner could not be reached.' }),
    );

    expect(html).toContain('Checks could not run');
    expect(html).toContain('The check runner could not be reached.');
    expect(html).toContain('Atlas could not finish checks for this version.');
    expect(html).not.toContain('Checks found a problem');
    expect(html).not.toContain('Run checks');
  });
});
