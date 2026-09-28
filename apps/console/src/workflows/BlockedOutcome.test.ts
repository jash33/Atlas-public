import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import { BlockedOutcome } from './BlockedOutcome.js';

const failClosedLeaks = [
  'Validated draft',
  'Continue to proposal review',
  '.atlas.yaml',
  'Approve exact artifact',
  'backend-verified mappings',
];

describe('BlockedOutcome', () => {
  it('explains an unsupported request as a sentence and does not invent a draft', () => {
    const html = renderToStaticMarkup(
      createElement(BlockedOutcome, {
        identities: [{ operationId: 'getPayment', serviceId: 'payments' }],
        phase: 'unsupported',
        reason: 'No authorized capability can delete a bank account',
      }),
    );

    expect(html).toContain('No authorized capability can delete a bank account.');
    expect(html).not.toContain('Request is unsupported');
    expect(html).not.toContain('Drafting stopped');
    for (const leak of failClosedLeaks) {
      expect(html).not.toContain(leak);
    }
  });

  it('explains a manual-review stop as a sentence and hides codes until Technical details', () => {
    const html = renderToStaticMarkup(
      createElement(BlockedOutcome, {
        detail: 'The model response is not bound to the active intent and projection fingerprints',
        diagnostics: [
          {
            code: 'SOURCE_PATH_NOT_FOUND',
            path: 'executable.steps[get-payment].arguments.paymentId',
            message: "Source path 'paymentId' is absent from the pinned schema.",
          },
        ],
        identities: [{ operationId: 'PostPaymentIntents', serviceId: 'stripe' }],
        phase: 'manual_review',
        reason: 'capability-drift',
      }),
    );

    expect(html).toContain(
      'For the PostPaymentIntents API action, Atlas could not finish this draft because the approved API actions changed while it was working.',
    );
    expect(html).not.toContain('Drafting stopped · capability-drift');
    expect(html).toContain('Technical details');
    expect(html.indexOf('capability-drift')).toBeGreaterThan(html.indexOf('Technical details'));
    expect(html.indexOf('SOURCE_PATH_NOT_FOUND')).toBeGreaterThan(
      html.indexOf('Technical details'),
    );
    expect(html.indexOf('executable.steps[get-payment]')).toBeGreaterThan(
      html.indexOf('Technical details'),
    );
    for (const leak of failClosedLeaks) {
      expect(html).not.toContain(leak);
    }
  });
});
