import { describe, expect, it } from 'vite-plus/test';

import { clarificationDiagram } from './clarification-diagram.js';

const fingerprint = 'b'.repeat(64);

describe('clarificationDiagram', () => {
  const identities = [
    {
      capabilityVersionId: 'get-payment',
      serviceId: 'payments',
      operationId: 'getPayment',
    },
    {
      capabilityVersionId: 'create-intent',
      serviceId: 'stripe',
      operationId: 'PostPaymentIntents',
    },
  ];

  it('shows the grounded workflow sequence and highlights the questioned step', () => {
    const diagram = clarificationDiagram({
      identities,
      mapping: {
        intentFingerprint: 'a'.repeat(64),
        projectionFingerprint: fingerprint,
        sourceSteps: [{ stepId: 'get-payment-step', capabilityVersionId: 'get-payment' }],
        destinationCapabilityVersionId: 'create-intent',
        destinationStepId: 'create-intent-step',
        history: [],
      },
      selection: {
        answer: 'Use getPayment response amount',
        candidateId: 'amount<-step:get-payment-step:amount.value:convert',
        destinationPath: ['amount'],
      },
    });

    expect(diagram.nodes.map(({ label }) => label)).toEqual(['getPayment', 'PostPaymentIntents']);
    expect(diagram.nodes.find(({ focus }) => focus)?.label).toBe('PostPaymentIntents');
    expect(diagram.nodes.find(({ source }) => source)?.label).toBe('getPayment');
    expect(diagram.focusLabel).toBe('PostPaymentIntents /amount');
    expect(diagram.sourceLabel).toBe('getPayment /amount/value');
  });

  it('shows a verified workflow-input mapping as the source', () => {
    const shared = {
      identities,
    };
    const runtimeInput = clarificationDiagram({
      ...shared,
      mapping: {
        intentFingerprint: 'a'.repeat(64),
        projectionFingerprint: fingerprint,
        sourceSteps: [],
        destinationCapabilityVersionId: 'create-intent',
        destinationStepId: 'create-intent-step',
        history: [],
      },
      selection: {
        answer: 'Use workflow input amount',
        candidateId: 'amount<-input:amount',
        destinationPath: ['amount'],
      },
    });

    expect(runtimeInput.nodes[0]?.label).toBe('Workflow input');
  });
});
