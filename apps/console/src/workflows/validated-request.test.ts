import { describe, expect, it } from 'vite-plus/test';

import {
  verifiedReferenceTooltip,
  verifiedRequestSegments,
  type VerifiedRequestAnnotation,
} from './validated-request.js';

const clarifiedRequest =
  'When a payment succeeds, read its payment record with getPayment using request field paymentId.';

const capability: VerifiedRequestAnnotation = {
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
};

const paymentId: VerifiedRequestAnnotation = {
  start: clarifiedRequest.indexOf('paymentId'),
  end: clarifiedRequest.indexOf('paymentId') + 'paymentId'.length,
  text: 'paymentId',
  kind: 'requestField',
  capabilityVersionId: 'cap-payments',
  direction: 'request',
  path: '/paymentId',
  evidence: {
    projectionFingerprint: 'b'.repeat(64),
    capabilityVersionId: 'cap-payments',
    path: '/paymentId',
    matchedTerms: ['paymentid'],
  },
};

describe('verified request presentation', () => {
  it('highlights only backend-verified phrases and builds tooltips from evidence', () => {
    const segments = verifiedRequestSegments(clarifiedRequest, [capability, paymentId]);

    expect(segments).toEqual([
      { type: 'text', value: 'When a payment succeeds, read its payment record with ' },
      {
        type: 'verified-reference',
        value: 'getPayment',
        annotation: capability,
        tooltip: {
          capabilityVersionId: 'cap-payments',
          kind: 'capability',
        },
      },
      { type: 'text', value: ' using request field ' },
      {
        type: 'verified-reference',
        value: 'paymentId',
        annotation: paymentId,
        tooltip: {
          capabilityVersionId: 'cap-payments',
          kind: 'requestField',
          direction: 'request',
          path: '/paymentId',
        },
      },
      { type: 'text', value: '.' },
    ]);

    expect(verifiedReferenceTooltip(capability)).toEqual({
      capabilityVersionId: 'cap-payments',
      kind: 'capability',
    });
    expect(verifiedReferenceTooltip(paymentId)).toEqual({
      capabilityVersionId: 'cap-payments',
      kind: 'requestField',
      direction: 'request',
      path: '/paymentId',
    });
  });

  it('identifies the capability service and shows a field path without requiring direction', () => {
    const identities = [
      {
        capabilityVersionId: 'cap-payments',
        serviceId: 'payments',
        operationId: 'getPayment',
      },
    ];
    const pathOnly = {
      start: paymentId.start,
      end: paymentId.end,
      text: paymentId.text,
      kind: paymentId.kind,
      capabilityVersionId: paymentId.capabilityVersionId,
      path: '/paymentId',
      evidence: paymentId.evidence,
    };

    expect(verifiedReferenceTooltip(capability, identities)).toEqual({
      capabilityVersionId: 'cap-payments',
      serviceId: 'payments',
      operationId: 'getPayment',
      kind: 'capability',
    });
    expect(verifiedReferenceTooltip(pathOnly, identities)).toEqual({
      capabilityVersionId: 'cap-payments',
      serviceId: 'payments',
      operationId: 'getPayment',
      kind: 'requestField',
      path: '/paymentId',
    });
  });

  it('drops annotations that lack verification evidence', () => {
    const unverified = {
      start: capability.start,
      end: capability.end,
      text: 'getPayment',
      kind: 'capability' as const,
      capabilityVersionId: 'cap-payments',
    };

    expect(verifiedRequestSegments(clarifiedRequest, [unverified])).toEqual([
      { type: 'text', value: clarifiedRequest },
    ]);
    expect(verifiedReferenceTooltip(unverified)).toBeNull();
  });

  it('does not treat a provisional live-index range as a verified highlight', () => {
    const provisional = {
      start: capability.start,
      end: capability.end,
      text: 'getPayment',
      kind: 'capability' as const,
      capabilityVersionId: 'cap-payments',
      source: 'live-index',
    };

    expect(verifiedRequestSegments(clarifiedRequest, [provisional])).toEqual([
      { type: 'text', value: clarifiedRequest },
    ]);
  });

  it('presents a verified workflow input separately from capability fields', () => {
    const text = 'Accept paymentId as a runtime input.';
    const runtimeInput = {
      start: text.indexOf('paymentId'),
      end: text.indexOf('paymentId') + 'paymentId'.length,
      text: 'paymentId',
      kind: 'runtimeInput' as const,
      inputName: 'paymentId',
      evidence: {
        intentFingerprint: 'a'.repeat(64),
        source: 'intentFrame.requiredInputs' as const,
      },
    };

    expect(verifiedRequestSegments(text, [runtimeInput])).toEqual([
      { type: 'text', value: 'Accept ' },
      {
        type: 'verified-reference',
        value: 'paymentId',
        annotation: runtimeInput,
        tooltip: { kind: 'runtimeInput', inputName: 'paymentId', label: 'Runtime input' },
      },
      { type: 'text', value: ' as a runtime input.' },
    ]);
  });
});
