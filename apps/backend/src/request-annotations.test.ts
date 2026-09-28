import { expect, it } from 'vite-plus/test';

import {
  verifiedReferencesInText,
  verifyDraftRequestAnnotations,
  verifyProposedAnnotations,
} from './request-annotations.js';

const getPaymentFragment = {
  method: 'get',
  path: '/payments/{paymentId}',
  pathParameters: [],
  operation: {
    operationId: 'getPayment',
    parameters: [
      {
        name: 'paymentId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
        },
      },
    },
  },
  references: {
    '#/components/schemas/Payment': {
      type: 'object',
      required: ['paymentId'],
      properties: { paymentId: { type: 'string' } },
    },
  },
};

const lookupRiskFragment = {
  method: 'get',
  path: '/payment-risk/{paymentId}',
  pathParameters: [],
  operation: {
    operationId: 'lookupPaymentRisk',
    parameters: [
      {
        name: 'paymentId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['risk'],
              properties: { risk: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const annotation = {
  owner: 'payments-team',
  businessSemantics: { readsAuthoritativePayment: true },
  idempotencyField: null,
  compensatedBy: null,
  irreversibleAfter: false,
};

const projection = {
  fingerprint: 'a'.repeat(64),
  capabilities: [
    {
      capabilityVersionId: 'cap-get-payment',
      identity: { kind: 'openapi' as const, serviceId: 'payments', operationId: 'getPayment' },
      fragment: getPaymentFragment,
      annotation,
    },
    {
      capabilityVersionId: 'cap-lookup-risk',
      identity: {
        kind: 'openapi' as const,
        serviceId: 'partner-risk',
        operationId: 'lookupPaymentRisk',
      },
      fragment: lookupRiskFragment,
      annotation: { ...annotation, owner: 'partner-risk-team' },
    },
  ],
};

it('links uniquely resolvable humanized capability and field names', () => {
  expect(
    verifiedReferencesInText({
      projection,
      text: 'Use Get Payment with Payment ID.',
      context: 'What identifier should Get Payment use for lookup?',
    }),
  ).toEqual([
    expect.objectContaining({
      text: 'Get Payment',
      kind: 'capability',
      capabilityVersionId: 'cap-get-payment',
    }),
    expect.objectContaining({
      text: 'Payment ID',
      kind: 'requestField',
      capabilityVersionId: 'cap-get-payment',
      direction: 'request',
      path: '/paymentId',
    }),
  ]);
});

it('links a uniquely resolvable service name when Atlas paraphrases an operation', () => {
  expect(
    verifiedReferencesInText({
      projection,
      text: 'Retrieve the record from the Payments service.',
      context: 'Retrieve a payment with getPayment.',
    }),
  ).toEqual([
    expect.objectContaining({
      text: 'Payments',
      kind: 'capability',
      capabilityVersionId: 'cap-get-payment',
    }),
  ]);
});

it('drops overlapping model annotation ranges and recovers grounded references', () => {
  const clarifiedRequest = 'Retrieve the authoritative payment using payments.getPayment.';

  expect(
    verifyDraftRequestAnnotations({
      projection,
      originalRequest: 'Retrieve a payment record from the Internal Payment API.',
      clarifiedRequest,
      proposed: [
        {
          start: 0,
          end: 4,
          text: 'When',
          kind: 'capability',
          capabilityVersionId: 'cap-get-payment',
        },
        {
          start: 0,
          end: 4,
          text: 'When',
          kind: 'capability',
          capabilityVersionId: 'cap-get-payment',
        },
      ],
    }),
  ).toMatchObject({
    status: 'verified',
    annotations: expect.arrayContaining([
      expect.objectContaining({
        text: 'getPayment',
        kind: 'capability',
        capabilityVersionId: 'cap-get-payment',
      }),
    ]),
  });
});

it('recovers grounded references when the model omits annotations from a clarified request', () => {
  const clarifiedRequest = 'Retrieve the authoritative payment using payments.getPayment.';

  expect(
    verifyProposedAnnotations({
      projection,
      originalRequest: 'Retrieve a payment record from the Internal Payment API.',
      clarifiedRequest,
      proposed: [],
    }),
  ).toMatchObject({
    status: 'verified',
    annotations: expect.arrayContaining([
      expect.objectContaining({
        text: 'getPayment',
        kind: 'capability',
        capabilityVersionId: 'cap-get-payment',
      }),
    ]),
  });
});

it('accepts a grounded capability citation whose display text paraphrases the operation', () => {
  const clarifiedRequest = 'Retrieve its payment record from the Internal Payment API.';
  const text = 'Internal Payment API';
  const start = clarifiedRequest.indexOf(text);

  expect(
    verifyProposedAnnotations({
      projection,
      originalRequest: clarifiedRequest,
      clarifiedRequest,
      proposed: [
        {
          start,
          end: start + text.length,
          text,
          kind: 'capability',
          capabilityVersionId: 'cap-get-payment',
        },
      ],
    }),
  ).toMatchObject({
    status: 'verified',
    annotations: [
      expect.objectContaining({
        text,
        kind: 'capability',
        capabilityVersionId: 'cap-get-payment',
      }),
    ],
  });
});

it('accepts uniquely re-resolvable capability and field ranges', () => {
  const clarifiedRequest = 'Read getPayment request field paymentId.';
  const result = verifyProposedAnnotations({
    projection,
    originalRequest: 'Read the payment record.',
    clarifiedRequest,
    proposed: [
      {
        start: clarifiedRequest.indexOf('getPayment'),
        end: clarifiedRequest.indexOf('getPayment') + 'getPayment'.length,
        text: 'getPayment',
        kind: 'capability',
        capabilityVersionId: 'cap-get-payment',
      },
      {
        start: clarifiedRequest.indexOf('paymentId'),
        end: clarifiedRequest.indexOf('paymentId') + 'paymentId'.length,
        text: 'paymentId',
        kind: 'requestField',
        capabilityVersionId: 'cap-get-payment',
        direction: 'request',
        path: '/paymentId',
      },
    ],
  });

  expect(result).toMatchObject({
    status: 'verified',
    annotations: [
      {
        text: 'getPayment',
        kind: 'capability',
        capabilityVersionId: 'cap-get-payment',
        evidence: {
          projectionFingerprint: 'a'.repeat(64),
          capabilityVersionId: 'cap-get-payment',
        },
      },
      {
        text: 'paymentId',
        kind: 'requestField',
        path: '/paymentId',
        evidence: { path: '/paymentId', capabilityVersionId: 'cap-get-payment' },
      },
    ],
  });
});

it('rejects invented capability ids and overlapping ranges', () => {
  const clarifiedRequest = 'Use inventedCapability then getPayment.';
  expect(
    verifyProposedAnnotations({
      projection,
      originalRequest: 'Read the payment.',
      clarifiedRequest,
      proposed: [
        {
          start: 4,
          end: 4 + 'inventedCapability'.length,
          text: 'inventedCapability',
          kind: 'capability',
          capabilityVersionId: 'invented',
        },
      ],
    }),
  ).toMatchObject({ status: 'rejected', reason: 'unknown-capability' });

  const overlap = verifyProposedAnnotations({
    projection,
    originalRequest: 'Read the payment.',
    clarifiedRequest: 'getPayment',
    proposed: [
      {
        start: 0,
        end: 10,
        text: 'getPayment',
        kind: 'capability',
        capabilityVersionId: 'cap-get-payment',
      },
      {
        start: 0,
        end: 10,
        text: 'getPayment',
        kind: 'capability',
        capabilityVersionId: 'cap-get-payment',
      },
    ],
  });
  expect(overlap).toMatchObject({ status: 'rejected', reason: 'malformed-annotation' });
});

it('rejects HTML and model-owned annotation fields', () => {
  expect(
    verifyProposedAnnotations({
      projection,
      originalRequest: 'Read the payment.',
      clarifiedRequest: 'Read <b>getPayment</b>.',
      proposed: [],
    }),
  ).toMatchObject({ status: 'rejected', reason: 'html-not-allowed' });

  expect(
    verifyProposedAnnotations({
      projection,
      originalRequest: 'Read the payment.',
      clarifiedRequest: 'Read getPayment.',
      proposed: [
        {
          start: 5,
          end: 15,
          text: 'getPayment',
          kind: 'capability',
          capabilityVersionId: 'cap-get-payment',
          tooltip: 'Trusted payment API',
          evidence: { invented: true },
        },
      ],
    }),
  ).toMatchObject({ status: 'rejected', reason: 'malformed-annotation' });
});

it('asks for clarification when paymentId has multiple valid candidates', () => {
  const clarifiedRequest = 'Map the paymentId into the next step.';
  const start = clarifiedRequest.indexOf('paymentId');
  expect(
    verifyProposedAnnotations({
      projection,
      originalRequest: 'Read the payment and check risk using paymentId.',
      clarifiedRequest,
      proposed: [
        {
          start,
          end: start + 'paymentId'.length,
          text: 'paymentId',
          kind: 'requestField',
          capabilityVersionId: 'cap-get-payment',
        },
      ],
    }),
  ).toMatchObject({
    status: 'clarification_required',
    reason: 'duplicate-field-candidates',
  });
});
