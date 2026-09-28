import { describe, expect, it } from 'vite-plus/test';

import { diagramFromExecutable, diagramFromReviewGraph } from './diagram-model.js';
import type { WorkflowReview } from './workflow.js';

type ReviewGraph = WorkflowReview['graph'];

function graph(partial: Partial<ReviewGraph>): ReviewGraph {
  return { nodes: [], edges: [], ...partial };
}

describe('workflow diagram model', () => {
  it('presents consecutive next edges as sequential order, not as data dependence', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'load-payment',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'completed',
            kind: 'terminal',
            irreversible: false,
            retryPolicy: null,
            terminalState: 'completed',
          },
        ],
        edges: [{ fromStepId: 'load-payment', toStepId: 'completed', kind: 'next' }],
      }),
    );

    expect(model.edges).toEqual([
      { fromStepId: 'load-payment', toStepId: 'completed', kind: 'next', label: 'then' },
    ]);
    expect(
      model.nodes.map((node) => ({ id: node.stepId, constrainedBy: node.constrainedBy })),
    ).toEqual([
      { id: 'load-payment', constrainedBy: [] },
      { id: 'completed', constrainedBy: ['order'] },
    ]);
    expect(model.independentStepIds).toEqual([]);
  });

  it('marks Atlas-inferred mappings separately from mappings the Author asked for', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'load-payment',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'create-intent',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
        ],
        edges: [
          { fromStepId: 'load-payment', toStepId: 'create-intent', kind: 'next' },
          {
            fromStepId: 'load-payment',
            toStepId: 'create-intent',
            kind: 'mapping',
            label: 'amount',
            origin: 'requested',
          },
          {
            fromStepId: 'load-payment',
            toStepId: 'create-intent',
            kind: 'mapping',
            label: 'currency',
            origin: 'requested',
          },
        ],
      }),
      [],
      [],
      [
        { stepId: 'create-intent', destinationPath: ['amount'], origin: 'requested' },
        { stepId: 'create-intent', destinationPath: ['currency'], origin: 'requested' },
        { stepId: 'create-intent', destinationPath: ['Idempotency-Key'], origin: 'inferred' },
      ],
    );

    expect(model.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'mapping',
          mappingField: 'amount',
          origin: 'requested',
          label: 'maps amount · you asked for this',
        }),
        expect.objectContaining({
          kind: 'mapping',
          mappingField: 'currency',
          origin: 'requested',
          label: 'maps currency · you asked for this',
        }),
        expect.objectContaining({
          kind: 'mapping',
          mappingField: 'Idempotency-Key',
          origin: 'inferred',
          label: 'maps Idempotency-Key · Atlas inferred this',
        }),
      ]),
    );
    expect(model.edges.find((edge) => edge.mappingField === 'Idempotency-Key')?.fromStepId).toBe(
      'runtime-input',
    );
    expect(
      model.nodes.some((node) => node.stepId === 'runtime-input' && node.name === 'Runtime input'),
    ).toBe(true);
    expect(JSON.stringify(model)).not.toMatch(/fingerprint|irHash|sha256:/);
  });

  it('presents mapping edges as data dependence distinct from sequential order', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'load-payment',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'settle-invoice',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
        ],
        edges: [
          { fromStepId: 'load-payment', toStepId: 'settle-invoice', kind: 'next' },
          {
            fromStepId: 'load-payment',
            toStepId: 'settle-invoice',
            kind: 'mapping',
            label: 'invoiceId',
          },
        ],
      }),
    );

    expect(model.edges).toEqual([
      { fromStepId: 'load-payment', toStepId: 'settle-invoice', kind: 'next', label: 'then' },
      {
        fromStepId: 'load-payment',
        toStepId: 'settle-invoice',
        kind: 'mapping',
        label: 'maps invoiceId',
        mappingField: 'invoiceId',
      },
    ]);
    expect(model.nodes.map((node) => node.constrainedBy)).toEqual([[], ['order', 'data']]);
    expect(model.independentStepIds).toEqual([]);
  });

  it('presents steps with no order or data edge between them as independent', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'publish-invoice',
            kind: 'publishEvent',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'notify-ops',
            kind: 'notify',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
        ],
        edges: [],
      }),
    );

    expect(model.edges).toEqual([]);
    expect(model.nodes.map((node) => node.constrainedBy)).toEqual([[], []]);
    expect(model.independentStepIds).toEqual(['publish-invoice', 'notify-ops']);
  });

  it('keeps compensation visible without treating it as order or data dependence', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'settle-invoice',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'cancel-settlement',
            kind: 'compensation',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
        ],
        edges: [
          {
            fromStepId: 'settle-invoice',
            toStepId: 'cancel-settlement',
            kind: 'compensation',
          },
        ],
      }),
    );

    expect(model.edges).toEqual([
      {
        fromStepId: 'settle-invoice',
        toStepId: 'cancel-settlement',
        kind: 'compensation',
        label: 'compensates with',
      },
    ]);
    expect(model.nodes.map((node) => node.constrainedBy)).toEqual([[], []]);
    expect(model.independentStepIds).toEqual(['settle-invoice', 'cancel-settlement']);
  });

  it('keeps irreversible boundaries and bounded revalidation visible', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'load-payment',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'settle-invoice',
            kind: 'capabilityCall',
            irreversible: true,
            retryPolicy: null,
            terminalState: null,
          },
        ],
        edges: [
          { fromStepId: 'load-payment', toStepId: 'settle-invoice', kind: 'next' },
          {
            fromStepId: 'settle-invoice',
            toStepId: 'load-payment',
            kind: 'revalidation',
            maxRevalidations: 1,
          },
        ],
      }),
    );

    expect(model.nodes.find((node) => node.stepId === 'settle-invoice')?.irreversible).toBe(true);
    expect(model.edges).toEqual([
      { fromStepId: 'load-payment', toStepId: 'settle-invoice', kind: 'next', label: 'then' },
      {
        fromStepId: 'settle-invoice',
        toStepId: 'load-payment',
        kind: 'revalidation',
        label: 'revalidates from (max 1)',
        maxRevalidations: 1,
      },
    ]);
  });

  it('marks capability-backed nodes interactive and terminals as non-inspectable', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'load-payment',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'completed',
            kind: 'terminal',
            irreversible: false,
            retryPolicy: null,
            terminalState: 'completed',
          },
        ],
        edges: [{ fromStepId: 'load-payment', toStepId: 'completed', kind: 'next' }],
      }),
      [{ stepId: 'load-payment', capabilityVersionId: 'payment.get@v1' }],
    );

    expect(model.nodes).toEqual([
      expect.objectContaining({
        stepId: 'load-payment',
        capabilityVersionId: 'payment.get@v1',
        interactive: true,
      }),
      expect.objectContaining({
        stepId: 'completed',
        capabilityVersionId: null,
        interactive: false,
      }),
    ]);
  });

  it('derives the same supported graph from an unsaved executable', () => {
    const model = diagramFromExecutable({
      irVersion: 1,
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'load-version',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        {
          id: 'settle-invoice',
          kind: 'capabilityCall',
          capabilityVersionId: 'settle-version',
          arguments: {
            invoiceId: { source: 'stepOutput', stepId: 'load-payment', path: ['invoiceId'] },
          },
          irreversibleAfter: true,
          errorRouting: {
            rules: [],
            defaultAction: {
              kind: 'revalidateFrom',
              targetStepId: 'load-payment',
              maxRevalidations: 1,
              onExhausted: {
                kind: 'land',
                outcome: 'repair_required',
                reasonCode: 'REVALIDATION_EXHAUSTED',
              },
            },
          },
        },
        {
          id: 'cancel-settlement',
          kind: 'compensation',
          capabilityVersionId: 'cancel-version',
          compensatesStepId: 'settle-invoice',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });

    expect(model.nodes.map((node) => node.stepId)).toEqual([
      'load-payment',
      'settle-invoice',
      'cancel-settlement',
      'completed',
    ]);
    expect(model.nodes.find((node) => node.stepId === 'settle-invoice')).toEqual(
      expect.objectContaining({
        irreversible: true,
        capabilityVersionId: 'settle-version',
        interactive: true,
        constrainedBy: ['order', 'data'],
      }),
    );
    expect(model.nodes.find((node) => node.stepId === 'completed')?.interactive).toBe(false);
    expect(model.edges).toEqual(
      expect.arrayContaining([
        { fromStepId: 'load-payment', toStepId: 'settle-invoice', kind: 'next', label: 'then' },
        {
          fromStepId: 'load-payment',
          toStepId: 'settle-invoice',
          kind: 'mapping',
          label: 'maps invoiceId',
          mappingField: 'invoiceId',
        },
        {
          fromStepId: 'settle-invoice',
          toStepId: 'cancel-settlement',
          kind: 'compensation',
          label: 'compensates with',
        },
        {
          fromStepId: 'settle-invoice',
          toStepId: 'load-payment',
          kind: 'revalidation',
          label: 'revalidates from (max 1)',
          maxRevalidations: 1,
        },
      ]),
    );
    expect(model.independentStepIds).toEqual(['cancel-settlement']);
  });

  it('surfaces input-sourced inferred bindings from an executable without a prior-step edge', () => {
    const model = diagramFromExecutable(
      {
        irVersion: 1,
        steps: [
          {
            id: 'load-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'load-version',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          {
            id: 'create-intent',
            kind: 'capabilityCall',
            capabilityVersionId: 'intent-version',
            arguments: {
              amount: { source: 'stepOutput', stepId: 'load-payment', path: ['amount'] },
              currency: { source: 'stepOutput', stepId: 'load-payment', path: ['currency'] },
              'Idempotency-Key': { source: 'input', path: ['paymentId'] },
            },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      },
      [],
      [],
      [
        { stepId: 'create-intent', destinationPath: ['amount'], origin: 'requested' },
        { stepId: 'create-intent', destinationPath: ['currency'], origin: 'requested' },
        { stepId: 'create-intent', destinationPath: ['Idempotency-Key'], origin: 'inferred' },
      ],
    );

    expect(model.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromStepId: 'load-payment',
          toStepId: 'create-intent',
          kind: 'mapping',
          mappingField: 'amount',
          origin: 'requested',
          label: 'maps amount · you asked for this',
        }),
        expect.objectContaining({
          fromStepId: 'load-payment',
          toStepId: 'create-intent',
          kind: 'mapping',
          mappingField: 'currency',
          origin: 'requested',
          label: 'maps currency · you asked for this',
        }),
        expect.objectContaining({
          fromStepId: 'runtime-input',
          toStepId: 'create-intent',
          kind: 'mapping',
          mappingField: 'Idempotency-Key',
          origin: 'inferred',
          label: 'maps Idempotency-Key · Atlas inferred this',
        }),
      ]),
    );
    expect(
      model.edges.find((edge) => edge.mappingField === 'Idempotency-Key')?.fromStepId,
    ).not.toBe('load-payment');
  });

  it('labels steps with a readable name, API action, and credential instead of version IDs', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'load-payment',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
          {
            stepId: 'completed',
            kind: 'terminal',
            irreversible: false,
            retryPolicy: null,
            terminalState: 'completed',
          },
        ],
        edges: [{ fromStepId: 'load-payment', toStepId: 'completed', kind: 'next' }],
      }),
      [
        {
          stepId: 'load-payment',
          capabilityVersionId: 'payment.get@v1',
          secretReference: 'PAYMENTS_API_TOKEN',
          httpCall: { method: 'GET', path: '/payments/{paymentId}' },
          capabilityId: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
        },
      ],
      [
        {
          capabilityVersionId: 'payment.get@v1',
          serviceId: 'payments',
          operationId: 'getPayment',
        },
      ],
    );

    expect(model.nodes[0]).toEqual(
      expect.objectContaining({
        stepId: 'load-payment',
        name: 'Load payment',
        apiAction: 'payments · getPayment',
        credential: 'PAYMENTS_API_TOKEN',
        capabilityVersionId: 'payment.get@v1',
      }),
    );
    expect(model.nodes[1]).toEqual(
      expect.objectContaining({
        stepId: 'completed',
        name: 'Completed',
        apiAction: null,
        credential: null,
        capabilityVersionId: null,
      }),
    );
  });

  it('falls back to the step HTTP call when no reference identity is available', () => {
    const model = diagramFromReviewGraph(
      graph({
        nodes: [
          {
            stepId: 'getPayment',
            kind: 'capabilityCall',
            irreversible: false,
            retryPolicy: null,
            terminalState: null,
          },
        ],
        edges: [],
      }),
      [
        {
          stepId: 'getPayment',
          capabilityVersionId: 'payment.get@v1',
          secretReference: null,
          httpCall: { method: 'GET', path: '/payments/{paymentId}' },
          capabilityId: null,
        },
      ],
    );

    expect(model.nodes[0]).toEqual(
      expect.objectContaining({
        name: 'Get payment',
        apiAction: 'GET /payments/{paymentId}',
        credential: null,
      }),
    );
    expect(model.nodes[0]?.apiAction).not.toBe('payment.get@v1');
  });
});
