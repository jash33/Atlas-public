import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import { RequestInterpretation } from './RequestInterpretation.js';

describe('RequestInterpretation', () => {
  it('shows Atlas corrected request beneath the original composer with grounded references', () => {
    const text = 'Read the payment using getPayment.';
    const start = text.indexOf('getPayment');
    const html = renderToStaticMarkup(
      createElement(RequestInterpretation, {
        annotations: [
          {
            start,
            end: start + 'getPayment'.length,
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
        identities: [
          {
            capabilityVersionId: 'cap-get-payment',
            serviceId: 'payments',
            operationId: 'getPayment',
          },
        ],
        interpretedRequest: text,
      }),
    );

    expect(html).toContain('Atlas interpretation');
    expect(html).toContain('<mark');
    expect(html).toContain('payments · getPayment');
  });

  it('styles workflow inputs separately and labels them as runtime inputs', () => {
    const text = 'Accept paymentId as a runtime input.';
    const start = text.indexOf('paymentId');
    const html = renderToStaticMarkup(
      createElement(RequestInterpretation, {
        annotations: [
          {
            start,
            end: start + 'paymentId'.length,
            text: 'paymentId',
            kind: 'runtimeInput',
            inputName: 'paymentId',
            evidence: {
              intentFingerprint: 'a'.repeat(64),
              source: 'intentFrame.requiredInputs',
            },
          },
        ],
        interpretedRequest: text,
      }),
    );

    expect(html).toContain('wf-ref-runtime-input');
    expect(html).toContain('aria-label="Runtime input: paymentId"');
  });
});
