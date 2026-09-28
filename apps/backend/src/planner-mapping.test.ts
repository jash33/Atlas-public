import { describe, expect, it } from 'vite-plus/test';

import { transformationExpressionSchema } from '@atlas/workflow-ir';

import {
  planApiMappings,
  planProjectedApiMappings,
  type MappingSchema,
} from './planner-mapping.js';

const fingerprints = {
  intentFingerprint: 'a'.repeat(64),
  projectionFingerprint: 'b'.repeat(64),
  activeProjectionFingerprint: 'b'.repeat(64),
};

function object(required: Record<string, MappingSchema>): MappingSchema {
  return { type: 'object', required };
}

describe('planApiMappings', () => {
  it('maps an integer runtime input to an integer capability field but refuses a general number', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: { required: { quantity: { type: 'integer' as const } } },
      capabilities: [
        {
          capabilityVersionId: 'items.add@1',
          fragment: {
            operation: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['quantity'],
                      properties: { quantity: { type: 'integer' } },
                    },
                  },
                },
              },
            },
            references: {},
          },
        },
      ],
    };
    const input = {
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'items.add@1',
        destinationStepId: 'add',
      },
    };
    expect(planProjectedApiMappings(input).status).toBe('ready');
    expect(
      planProjectedApiMappings({
        ...input,
        projection,
        workflowInputSchema: { required: { quantity: { type: 'number' } } },
      }).status,
    ).toBe('impossible');
  });

  it('validates a proposed fixed enum value and rejects invalid enums or unauthorized inputs', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: { required: { location_id: { type: 'string' as const } } },
      capabilities: [
        {
          capabilityVersionId: 'fulfillment@1',
          fragment: {
            method: 'post',
            path: '/fulfillments',
            operation: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['type', 'location_id'],
                      properties: {
                        type: { type: 'string', enum: ['pickup', 'delivery'] },
                        location_id: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
            references: {},
          },
        },
      ],
    };
    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'fulfillment@1',
        destinationStepId: 'create',
      },
      proposedArguments: {
        type: { source: 'literal', value: 'pickup' },
        location_id: { source: 'input', path: ['location_id'] },
      },
    });
    expect(result.status).toBe('ready');
    expect(result.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['type'],
          expression: { source: 'literal', value: 'pickup' },
        }),
      ]),
    );
    const invalid = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'fulfillment@1',
        destinationStepId: 'create',
      },
      proposedArguments: { type: { source: 'literal', value: 'invented-mode' } },
    });
    expect(invalid.status).toBe('impossible');
    const unknownInput = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: { required: {} },
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'fulfillment@1',
        destinationStepId: 'create',
      },
      proposedArguments: {
        type: { source: 'literal', value: 'pickup' },
        location_id: { source: 'input', path: ['not_authorized'] },
      },
    });
    expect(unknownInput.status).toBe('impossible');
    expect(unknownInput.resolvedMappings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ destinationPath: ['location_id'] })]),
    );
  });

  it('maps the Atlas run id to a capability-declared idempotency field', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'stripe-payment-intent@1',
          annotation: { idempotencyField: 'Idempotency-Key' },
          fragment: {
            path: '/payment_intents',
            method: 'post',
            operation: {
              parameters: [
                {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: true,
                  schema: {
                    type: 'string',
                    'x-atlas-data-classification': 'internal',
                  },
                },
              ],
              responses: { '200': { description: 'Created' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'stripe-payment-intent@1',
        destinationStepId: 'create-payment-intent',
      },
    });

    expect(result.status).toBe('ready');
    expect('idempotencyField' in result && result.idempotencyField).toBe('Idempotency-Key');
    expect(result.resolvedMappings).toEqual([
      expect.objectContaining({
        destinationPath: ['Idempotency-Key'],
        expression: { source: 'input', path: ['atlasWorkflowRunId'] },
      }),
    ]);
  });

  it('maps an unstated idempotency field from the unique business input', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          paymentId: { type: 'string', classification: 'internal' },
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'payments.get@v1',
          identity: { serviceId: 'payments', operationId: 'getPayment' },
          fragment: {
            path: '/payments/{paymentId}',
            method: 'get',
            operation: {
              parameters: [
                {
                  name: 'paymentId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
                },
              ],
              responses: {
                '200': {
                  description: 'Payment',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['amount', 'currency', 'invoiceId'],
                        properties: {
                          amount: { type: 'number' },
                          currency: { type: 'string' },
                          invoiceId: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            references: {},
          },
        },
        {
          capabilityVersionId: 'stripe-payment-intent@1',
          identity: { serviceId: 'stripe', operationId: 'PostPaymentIntents' },
          annotation: { idempotencyField: 'Idempotency-Key' },
          fragment: {
            path: '/payment_intents',
            method: 'post',
            operation: {
              parameters: [
                {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: true,
                  schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
                },
              ],
              requestBody: {
                required: true,
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: {
                      type: 'object',
                      required: ['amount', 'currency'],
                      properties: {
                        amount: { type: 'number' },
                        currency: { type: 'string' },
                      },
                    },
                  },
                },
              },
              responses: { '200': { description: 'Created' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [{ stepId: 'get-payment', capabilityVersionId: 'payments.get@v1' }],
        destinationCapabilityVersionId: 'stripe-payment-intent@1',
        destinationStepId: 'create-payment-intent',
      },
    });

    expect(result.status).toBe('ready');
    expect(result.requiredQuestions).toEqual([]);
    expect(result.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['amount'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['amount'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['currency'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['currency'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['Idempotency-Key'],
          expression: { source: 'input', path: ['paymentId'] },
          origin: 'inferred',
        }),
      ]),
    );
  });

  it('maps provider idempotency from the Atlas run id when several caller strings are present', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          paymentId: { type: 'string', classification: 'internal' },
          invoiceId: { type: 'string', classification: 'internal' },
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'stripe-payment-intent@1',
          annotation: { idempotencyField: 'Idempotency-Key' },
          fragment: {
            path: '/payment_intents',
            method: 'post',
            operation: {
              parameters: [
                {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: true,
                  schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
                },
              ],
              responses: { '200': { description: 'Created' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'stripe-payment-intent@1',
        destinationStepId: 'create-payment-intent',
      },
    });

    expect(result.status).toBe('ready');
    expect(result.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['Idempotency-Key'],
          expression: { source: 'input', path: ['atlasWorkflowRunId'] },
        }),
      ]),
    );
  });

  it('fails closed when an unstated required field has no compatible source', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'notify-ops@1',
          identity: { serviceId: 'operations', operationId: 'notifyPaymentOperations' },
          fragment: {
            path: '/operations/payment-notifications',
            method: 'post',
            operation: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['invoiceId'],
                      properties: { invoiceId: { type: 'string' } },
                    },
                  },
                },
              },
              responses: { '200': { description: 'Notified' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'notify-ops@1',
        destinationStepId: 'notify',
      },
    });

    expect(result.status).toBe('impossible');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_REQUIRED_DESTINATION_FIELD',
          destinationPath: ['invoiceId'],
        }),
      ]),
    );
  });

  it('maps an unstated required field from a unique prior-step output', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          paymentId: { type: 'string', classification: 'internal' },
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'payments.get@v1',
          identity: { serviceId: 'payments', operationId: 'getPayment' },
          fragment: {
            path: '/payments/{paymentId}',
            method: 'get',
            operation: {
              parameters: [
                {
                  name: 'paymentId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
                },
              ],
              responses: {
                '200': {
                  description: 'Payment',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['invoiceId'],
                        properties: { invoiceId: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
            references: {},
          },
        },
        {
          capabilityVersionId: 'notify-ops@1',
          identity: { serviceId: 'operations', operationId: 'notifyPaymentOperations' },
          annotation: { idempotencyField: 'idempotencyKey' },
          fragment: {
            path: '/operations/payment-notifications',
            method: 'post',
            operation: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['invoiceId', 'paymentId', 'atlasWorkflowRunId', 'idempotencyKey'],
                      properties: {
                        invoiceId: { type: 'string' },
                        paymentId: { type: 'string' },
                        atlasWorkflowRunId: { type: 'string' },
                        idempotencyKey: { type: 'string' },
                      },
                    },
                  },
                },
              },
              responses: { '200': { description: 'Notified' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      allowClassificationDowngrade: true,
      request: {
        sourceSteps: [{ stepId: 'get-payment', capabilityVersionId: 'payments.get@v1' }],
        destinationCapabilityVersionId: 'notify-ops@1',
        destinationStepId: 'notify',
      },
    });

    expect(result.status).toBe('ready');
    expect(result.requiredQuestions).toEqual([]);
    expect(result.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['invoiceId'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['invoiceId'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['paymentId'],
          expression: { source: 'input', path: ['paymentId'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['atlasWorkflowRunId'],
          expression: { source: 'input', path: ['atlasWorkflowRunId'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['idempotencyKey'],
          expression: { source: 'input', path: ['paymentId'] },
          origin: 'inferred',
        }),
      ]),
    );
  });

  it('marks prompt-named destinations as requested and other unique mappings as inferred', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          paymentId: { type: 'string', classification: 'internal' },
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'payments.get@v1',
          fragment: {
            path: '/payments/{paymentId}',
            method: 'get',
            operation: {
              parameters: [
                {
                  name: 'paymentId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
                },
              ],
              responses: {
                '200': {
                  description: 'Payment',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['invoiceId', 'amount', 'currency'],
                        properties: {
                          invoiceId: { type: 'string' },
                          amount: { type: 'number' },
                          currency: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            references: {},
          },
        },
        {
          capabilityVersionId: 'stripe-payment-intent@1',
          identity: { serviceId: 'stripe', operationId: 'PostPaymentIntents' },
          annotation: { idempotencyField: 'Idempotency-Key' },
          fragment: {
            path: '/payment_intents',
            method: 'post',
            operation: {
              parameters: [
                {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: true,
                  schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
                },
              ],
              requestBody: {
                required: true,
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: {
                      type: 'object',
                      required: ['amount', 'currency', 'invoiceId'],
                      properties: {
                        amount: { type: 'number' },
                        currency: { type: 'string' },
                        invoiceId: { type: 'string' },
                      },
                    },
                  },
                },
              },
              responses: { '200': { description: 'Created' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [{ stepId: 'get-payment', capabilityVersionId: 'payments.get@v1' }],
        destinationCapabilityVersionId: 'stripe-payment-intent@1',
        destinationStepId: 'create-payment-intent',
        statedDestinationPaths: [['amount'], ['currency']],
      },
    });

    expect(result.status).toBe('ready');
    expect(result.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['amount'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['amount'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['currency'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['currency'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['invoiceId'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['invoiceId'] },
          origin: 'inferred',
        }),
        expect.objectContaining({
          destinationPath: ['Idempotency-Key'],
          expression: { source: 'input', path: ['paymentId'] },
          origin: 'inferred',
        }),
      ]),
    );
  });

  it('maps an annotated idempotency field from a unique prior-step string when no business input exists', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'receipts.get@v1',
          fragment: {
            path: '/receipts/{receiptId}',
            method: 'get',
            operation: {
              parameters: [
                {
                  name: 'receiptId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              responses: {
                '200': {
                  description: 'Receipt',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['receiptId'],
                        properties: { receiptId: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
            references: {},
          },
        },
        {
          capabilityVersionId: 'billing.mark@1',
          identity: { serviceId: 'billing', operationId: 'markInvoicePaid' },
          annotation: { idempotencyField: 'idempotencyKey' },
          fragment: {
            path: '/invoices/paid',
            method: 'post',
            operation: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['idempotencyKey'],
                      properties: { idempotencyKey: { type: 'string' } },
                    },
                  },
                },
              },
              responses: { '200': { description: 'Paid' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [{ stepId: 'get-receipt', capabilityVersionId: 'receipts.get@v1' }],
        destinationCapabilityVersionId: 'billing.mark@1',
        destinationStepId: 'mark-paid',
      },
    });

    expect(result.status).toBe('ready');
    expect(result.requiredQuestions).toEqual([]);
    expect(result.resolvedMappings).toEqual([
      expect.objectContaining({
        destinationPath: ['idempotencyKey'],
        expression: { source: 'stepOutput', stepId: 'get-receipt', path: ['receiptId'] },
        origin: 'inferred',
      }),
    ]);
  });

  it('asks once when several prior-step strings could fill an annotated field', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'receipts.get@v1',
          fragment: {
            path: '/receipts/{receiptId}',
            method: 'get',
            operation: {
              parameters: [
                {
                  name: 'receiptId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
              responses: {
                '200': {
                  description: 'Receipt',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['receiptId', 'invoiceId'],
                        properties: {
                          receiptId: { type: 'string' },
                          invoiceId: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            references: {},
          },
        },
        {
          capabilityVersionId: 'billing.mark@1',
          annotation: { idempotencyField: 'idempotencyKey' },
          fragment: {
            path: '/invoices/paid',
            method: 'post',
            operation: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['idempotencyKey'],
                      properties: { idempotencyKey: { type: 'string' } },
                    },
                  },
                },
              },
              responses: { '200': { description: 'Paid' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [{ stepId: 'get-receipt', capabilityVersionId: 'receipts.get@v1' }],
        destinationCapabilityVersionId: 'billing.mark@1',
        destinationStepId: 'mark-paid',
      },
    });

    expect(result.status).toBe('clarification_required');
    expect(result.requiredQuestions).toEqual([
      expect.objectContaining({ destinationPath: ['idempotencyKey'] }),
    ]);
    expect(result.requiredQuestions).toHaveLength(1);
  });

  it('does not invent a mapping for a differently named required field without a unique compatible source', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          paymentId: { type: 'string', classification: 'internal' },
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'notify-ops@1',
          identity: { serviceId: 'operations', operationId: 'notifyPaymentOperations' },
          fragment: {
            path: '/operations/alerts',
            method: 'post',
            operation: {
              requestBody: {
                required: true,
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['channel'],
                      properties: { channel: { type: 'string' } },
                    },
                  },
                },
              },
              responses: { '200': { description: 'Notified' } },
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'notify-ops@1',
        destinationStepId: 'notify',
      },
    });

    expect(result.status).toBe('impossible');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'MISSING_REQUIRED_DESTINATION_FIELD',
          destinationPath: ['channel'],
        }),
      ]),
    );
  });

  it('maps Slack, notify, and billing annotated idempotency fields the same way', () => {
    const workflowInputSchema = {
      required: {
        paymentId: { type: 'string', classification: 'internal' },
        atlasWorkflowRunId: { type: 'string', classification: 'internal' },
      },
    } as const;

    for (const [capabilityVersionId, idempotencyField, fragment] of [
      [
        'slack.post@1',
        'client_msg_id',
        {
          path: '/api/chat.postMessage',
          method: 'post',
          operation: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['channel', 'text', 'client_msg_id'],
                    properties: {
                      channel: { type: 'string' },
                      text: { type: 'string' },
                      client_msg_id: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: { '200': { description: 'Sent' } },
          },
          references: {},
        },
      ],
      [
        'notify-ops@1',
        'idempotencyKey',
        {
          path: '/operations/notify',
          method: 'post',
          operation: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['idempotencyKey'],
                    properties: { idempotencyKey: { type: 'string' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'Notified' } },
          },
          references: {},
        },
      ],
      [
        'billing.begin@1',
        'idempotencyKey',
        {
          path: '/invoices/settlement',
          method: 'post',
          operation: {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['idempotencyKey'],
                    properties: { idempotencyKey: { type: 'string' } },
                  },
                },
              },
            },
            responses: { '200': { description: 'Started' } },
          },
          references: {},
        },
      ],
    ] as const) {
      const projection = {
        fingerprint: fingerprints.projectionFingerprint,
        workflowInputSchema,
        capabilities: [
          {
            capabilityVersionId,
            annotation: { idempotencyField },
            fragment,
          },
        ],
      } as const;

      const result = planProjectedApiMappings({
        intentFingerprint: fingerprints.intentFingerprint,
        projection,
        workflowInputSchema: projection.workflowInputSchema,
        activeProjectionFingerprint: projection.fingerprint,
        allowClassificationDowngrade: true,
        request: {
          sourceSteps: [],
          destinationCapabilityVersionId: capabilityVersionId,
          destinationStepId: 'call',
        },
      });

      expect(result.resolvedMappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            destinationPath: [idempotencyField],
            expression: { source: 'input', path: ['paymentId'] },
          }),
        ]),
      );
    }
  });

  it('maps provider idempotency from the Atlas run id when several caller strings are present', () => {
    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection: {
        fingerprint: fingerprints.projectionFingerprint,
        capabilities: [
          {
            capabilityVersionId: 'checks.create@1',
            annotation: { idempotencyField: 'idempotency_key' },
            fragment: {
              operation: {
                requestBody: {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['server_id', 'idempotency_key'],
                        properties: {
                          server_id: { type: 'string' },
                          idempotency_key: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
              references: {},
            },
          },
        ],
      },
      workflowInputSchema: {
        required: {
          location_id: { type: 'string' },
          server_id: { type: 'string' },
          item_id: { type: 'string' },
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      activeProjectionFingerprint: fingerprints.projectionFingerprint,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'checks.create@1',
        destinationStepId: 'create-check',
      },
      allowClassificationDowngrade: true,
    });

    expect(result.status).toBe('ready');
    expect(result.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['idempotency_key'],
          expression: { source: 'input', path: ['atlasWorkflowRunId'] },
        }),
      ]),
    );
  });

  it('materializes trusted event metadata without asking the developer', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'publish-invoice-paid@1',
          identity: { serviceId: 'events', operationId: 'publishInvoicePaid' },
          annotation: { idempotencyField: 'idempotencyKey' },
          fragment: {
            channel: {
              messages: {
                invoicePaid: {
                  payload: {
                    type: 'object',
                    required: ['eventId', 'eventType', 'atlasWorkflowRunId'],
                    properties: {
                      eventId: { type: 'string' },
                      eventType: { type: 'string', const: 'invoice.paid' },
                      atlasWorkflowRunId: {
                        type: 'string',
                        'x-atlas-data-classification': 'public',
                      },
                    },
                  },
                },
              },
            },
            operation: {
              action: 'send',
              messages: [{ $ref: '#/channels/invoicePaid/messages/invoicePaid' }],
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      allowClassificationDowngrade: true,
      request: {
        sourceSteps: [],
        destinationCapabilityVersionId: 'publish-invoice-paid@1',
        destinationStepId: 'publish-invoice-paid',
      },
    });

    expect(result.status).toBe('ready');
    expect(result.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['eventId'],
          expression: { source: 'input', path: ['atlasWorkflowRunId'] },
        }),
        expect.objectContaining({
          destinationPath: ['eventType'],
          expression: { source: 'literal', value: 'invoice.paid' },
        }),
        expect.objectContaining({
          destinationPath: ['atlasWorkflowRunId'],
          expression: { source: 'input', path: ['atlasWorkflowRunId'] },
        }),
      ]),
    );
  });

  it('maps unstated event payload fields from unique sources and schema constants', () => {
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema: {
        required: {
          paymentId: { type: 'string', classification: 'internal' },
          atlasWorkflowRunId: { type: 'string', classification: 'internal' },
        },
      },
      capabilities: [
        {
          capabilityVersionId: 'payments.get@v1',
          fragment: {
            path: '/payments/{paymentId}',
            method: 'get',
            operation: {
              parameters: [
                {
                  name: 'paymentId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
                },
              ],
              responses: {
                '200': {
                  description: 'Payment',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['invoiceId', 'paymentId'],
                        properties: {
                          invoiceId: { type: 'string' },
                          paymentId: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
            references: {},
          },
        },
        {
          capabilityVersionId: 'publish-invoice-paid@1',
          identity: { serviceId: 'events', operationId: 'publishInvoicePaid' },
          annotation: { idempotencyField: 'idempotencyKey' },
          fragment: {
            channel: {
              messages: {
                invoicePaid: {
                  payload: {
                    type: 'object',
                    required: [
                      'eventId',
                      'eventType',
                      'invoiceId',
                      'paymentId',
                      'atlasWorkflowRunId',
                    ],
                    properties: {
                      eventId: { type: 'string' },
                      eventType: { type: 'string', const: 'invoice.paid' },
                      invoiceId: { type: 'string' },
                      paymentId: { type: 'string' },
                      atlasWorkflowRunId: {
                        type: 'string',
                        'x-atlas-data-classification': 'public',
                      },
                    },
                  },
                },
              },
            },
            operation: {
              action: 'send',
              messages: [{ $ref: '#/channels/invoicePaid/messages/invoicePaid' }],
            },
            references: {},
          },
        },
      ],
    } as const;

    const result = planProjectedApiMappings({
      intentFingerprint: fingerprints.intentFingerprint,
      projection,
      workflowInputSchema: projection.workflowInputSchema,
      activeProjectionFingerprint: projection.fingerprint,
      allowClassificationDowngrade: true,
      request: {
        sourceSteps: [{ stepId: 'get-payment', capabilityVersionId: 'payments.get@v1' }],
        destinationCapabilityVersionId: 'publish-invoice-paid@1',
        destinationStepId: 'publish-invoice-paid',
      },
    });

    expect(result.status).toBe('ready');
    expect(result.requiredQuestions).toEqual([]);
    expect(result.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['eventId'],
          expression: { source: 'input', path: ['atlasWorkflowRunId'] },
          origin: 'inferred',
        }),
        expect.objectContaining({
          destinationPath: ['eventType'],
          expression: { source: 'literal', value: 'invoice.paid' },
          origin: 'inferred',
        }),
        expect.objectContaining({
          destinationPath: ['invoiceId'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['invoiceId'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['paymentId'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['paymentId'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['atlasWorkflowRunId'],
          expression: { source: 'input', path: ['atlasWorkflowRunId'] },
          origin: 'requested',
        }),
      ]),
    );
  });

  it('drafts the payment prompt path without asking for unstated required fields', () => {
    const workflowInputSchema = {
      required: {
        paymentId: { type: 'string', classification: 'internal' },
        atlasWorkflowRunId: { type: 'string', classification: 'internal' },
      },
    } as const;
    const getPayment = {
      capabilityVersionId: 'payments.get@v1',
      identity: { serviceId: 'payments', operationId: 'getPayment' },
      fragment: {
        path: '/payments/{paymentId}',
        method: 'get',
        operation: {
          parameters: [
            {
              name: 'paymentId',
              in: 'path',
              required: true,
              schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
            },
          ],
          responses: {
            '200': {
              description: 'Payment',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['amount', 'currency', 'invoiceId', 'paymentId'],
                    properties: {
                      amount: { type: 'number' },
                      currency: { type: 'string' },
                      invoiceId: { type: 'string' },
                      paymentId: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        references: {},
      },
    } as const;
    const stripeIntent = {
      capabilityVersionId: 'stripe-payment-intent@1',
      identity: { serviceId: 'stripe', operationId: 'PostPaymentIntents' },
      annotation: { idempotencyField: 'Idempotency-Key' },
      fragment: {
        path: '/payment_intents',
        method: 'post',
        operation: {
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  required: ['amount', 'currency'],
                  properties: {
                    amount: { type: 'number' },
                    currency: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Created' } },
        },
        references: {},
      },
    } as const;
    const publishInvoicePaid = {
      capabilityVersionId: 'publish-invoice-paid@1',
      identity: { serviceId: 'events', operationId: 'publishInvoicePaid' },
      annotation: { idempotencyField: 'idempotencyKey' },
      fragment: {
        channel: {
          messages: {
            invoicePaid: {
              payload: {
                type: 'object',
                required: ['eventId', 'eventType', 'invoiceId', 'paymentId', 'atlasWorkflowRunId'],
                properties: {
                  eventId: { type: 'string' },
                  eventType: { type: 'string', const: 'invoice.paid' },
                  invoiceId: { type: 'string' },
                  paymentId: { type: 'string' },
                  atlasWorkflowRunId: { type: 'string' },
                },
              },
            },
          },
        },
        operation: {
          action: 'send',
          messages: [{ $ref: '#/channels/invoicePaid/messages/invoicePaid' }],
        },
        references: {},
      },
    } as const;
    const notifyOps = {
      capabilityVersionId: 'notify-ops@1',
      identity: { serviceId: 'operations', operationId: 'notifyPaymentOperations' },
      annotation: { idempotencyField: 'idempotencyKey' },
      fragment: {
        path: '/operations/payment-notifications',
        method: 'post',
        operation: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['invoiceId', 'paymentId', 'atlasWorkflowRunId', 'idempotencyKey'],
                  properties: {
                    invoiceId: { type: 'string' },
                    paymentId: { type: 'string' },
                    atlasWorkflowRunId: { type: 'string' },
                    idempotencyKey: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Notified' } },
        },
        references: {},
      },
    } as const;
    const capabilities = [getPayment, stripeIntent, publishInvoicePaid, notifyOps];
    const projection = {
      fingerprint: fingerprints.projectionFingerprint,
      workflowInputSchema,
      capabilities,
    };
    const sourceSteps = [
      { stepId: 'get-payment', capabilityVersionId: 'payments.get@v1' },
      { stepId: 'create-payment-intent', capabilityVersionId: 'stripe-payment-intent@1' },
      { stepId: 'publish-invoice-paid', capabilityVersionId: 'publish-invoice-paid@1' },
    ];

    const destinations: Array<{
      destinationStepId: string;
      destinationCapabilityVersionId: string;
      statedDestinationPaths?: readonly (readonly string[])[];
    }> = [
      { destinationStepId: 'get-payment', destinationCapabilityVersionId: 'payments.get@v1' },
      {
        destinationStepId: 'create-payment-intent',
        destinationCapabilityVersionId: 'stripe-payment-intent@1',
        statedDestinationPaths: [['amount'], ['currency']],
      },
      {
        destinationStepId: 'publish-invoice-paid',
        destinationCapabilityVersionId: 'publish-invoice-paid@1',
      },
      { destinationStepId: 'notify', destinationCapabilityVersionId: 'notify-ops@1' },
    ];
    const results = destinations.map((destination, index) =>
      planProjectedApiMappings({
        intentFingerprint: fingerprints.intentFingerprint,
        projection,
        workflowInputSchema: projection.workflowInputSchema,
        activeProjectionFingerprint: projection.fingerprint,
        allowClassificationDowngrade: true,
        request: {
          sourceSteps: sourceSteps.slice(0, index),
          destinationCapabilityVersionId: destination.destinationCapabilityVersionId,
          destinationStepId: destination.destinationStepId,
          ...(destination.statedDestinationPaths
            ? { statedDestinationPaths: destination.statedDestinationPaths }
            : {}),
        },
      }),
    );

    expect(results.map(({ status, requiredQuestions }) => ({ status, requiredQuestions }))).toEqual(
      [
        { status: 'ready', requiredQuestions: [] },
        { status: 'ready', requiredQuestions: [] },
        { status: 'ready', requiredQuestions: [] },
        { status: 'ready', requiredQuestions: [] },
      ],
    );
    expect(results[1]?.resolvedMappings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['amount'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['amount'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['currency'],
          expression: { source: 'stepOutput', stepId: 'get-payment', path: ['currency'] },
          origin: 'requested',
        }),
        expect.objectContaining({
          destinationPath: ['Idempotency-Key'],
          expression: { source: 'input', path: ['paymentId'] },
          origin: 'inferred',
        }),
      ]),
    );
  });

  it('resolves a unique exact field match deterministically', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [{ source: 'input', schema: object({ customerId: { type: 'string' } }) }],
      destination: object({ customerId: { type: 'string' } }),
    });

    expect(result).toMatchObject({ status: 'ready', candidateMappings: [], requiredQuestions: [] });
    expect(result.resolvedMappings).toEqual([
      expect.objectContaining({
        destinationPath: ['customerId'],
        expression: { source: 'input', path: ['customerId'] },
      }),
    ]);
  });

  it('resolves a nested value wrapper when its parent names the destination field', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'stepOutput',
          stepId: 'get-payment',
          schema: object({
            amount: object({
              value: { type: 'integer' },
              currency: { type: 'string' },
            }),
          }),
        },
      ],
      destination: object({ amount: { type: 'integer' } }),
    });

    expect(result).toMatchObject({ status: 'ready', candidateMappings: [], requiredQuestions: [] });
    expect(result.resolvedMappings).toEqual([
      expect.objectContaining({
        destinationPath: ['amount'],
        expression: {
          source: 'stepOutput',
          stepId: 'get-payment',
          path: ['amount', 'value'],
        },
      }),
    ]);
  });

  it('does not treat a generic identifier as a candidate for a specific identifier', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'input',
          schema: object({ id: { type: 'string' }, paymentId: { type: 'string' } }),
        },
      ],
      destination: object({ paymentId: { type: 'string' } }),
    });

    expect(result).toMatchObject({ status: 'ready', candidateMappings: [], requiredQuestions: [] });
    expect(result.resolvedMappings).toEqual([
      expect.objectContaining({
        destinationPath: ['paymentId'],
        expression: { source: 'input', path: ['paymentId'] },
      }),
    ]);
  });

  it('prefers one authoritative step output over the matching workflow input', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        { source: 'input', schema: object({ paymentId: { type: 'string' } }) },
        {
          source: 'stepOutput',
          stepId: 'get-payment',
          schema: object({ paymentId: { type: 'string' } }),
        },
      ],
      destination: object({ paymentId: { type: 'string' } }),
    });

    expect(result.status).toBe('ready');
    expect(result.resolvedMappings).toEqual([
      expect.objectContaining({
        expression: {
          source: 'stepOutput',
          stepId: 'get-payment',
          path: ['paymentId'],
        },
      }),
    ]);
  });

  it('proposes and explains a cents-to-decimal currency transform', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'stepOutput',
          stepId: 'read-charge',
          schema: object({ amountCents: { type: 'integer', unit: 'cents' } }),
        },
      ],
      destination: object({ amount: { type: 'number', unit: 'decimal-currency' } }),
    });

    expect(result.status).toBe('clarification_required');
    expect(result.candidateMappings).toEqual([
      expect.objectContaining({
        destinationPath: ['amount'],
        conversion: 'Divide cents by 100 to produce decimal currency.',
        expression: {
          kind: 'call',
          function: 'divide',
          arguments: [
            { source: 'stepOutput', stepId: 'read-charge', path: ['amountCents'] },
            { source: 'literal', value: 100 },
          ],
        },
      }),
    ]);
  });

  it('requires confirmation for declared lowercase-to-uppercase conversion', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'stepOutput',
          stepId: 'read-charge',
          schema: object({ currency: { type: 'string', case: 'lower' } }),
        },
      ],
      destination: object({ currency: { type: 'string', case: 'upper' } }),
    });

    expect(result).toMatchObject({ status: 'clarification_required' });
    expect(result.candidateMappings[0]?.expression).toEqual({
      kind: 'call',
      function: 'uppercase',
      arguments: [{ source: 'stepOutput', stepId: 'read-charge', path: ['currency'] }],
    });
  });

  it('offers a semantically related nested field only as a clarification candidate', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'stepOutput',
          stepId: 'read-customer',
          schema: object({
            customer: object({ notification_email: { type: 'string' } }),
          }),
        },
      ],
      destination: object({ notification: object({ address: { type: 'string' } }) }),
    });

    expect(result).toMatchObject({
      status: 'clarification_required',
      requiredQuestions: [{ destinationPath: ['notification', 'address'] }],
    });
    expect(result.candidateMappings[0]?.expression).toEqual({
      source: 'stepOutput',
      stepId: 'read-customer',
      path: ['customer', 'notification_email'],
    });
  });

  it('stops on ambiguous source fields and resolves a selected validated candidate', () => {
    const request = {
      ...fingerprints,
      sources: [
        {
          source: 'stepOutput' as const,
          stepId: 'billing',
          schema: object({ id: { type: 'string' } }),
        },
        {
          source: 'stepOutput' as const,
          stepId: 'customer',
          schema: object({ id: { type: 'string' } }),
        },
      ],
      destination: object({ id: { type: 'string' } }),
    };
    const ambiguous = planApiMappings(request);

    expect(ambiguous.status).toBe('clarification_required');
    expect(ambiguous.candidateMappings).toHaveLength(2);
    expect(ambiguous.requiredQuestions[0]?.question).toBe(
      'What should Atlas use for request field id?',
    );

    const selected = planApiMappings({
      ...request,
      selections: { id: ambiguous.candidateMappings[1]!.candidateId },
    });
    expect(selected.status).toBe('ready');
    expect(selected.resolvedMappings[0]?.expression).toEqual({
      source: 'stepOutput',
      stepId: 'customer',
      path: ['id'],
    });
  });

  it('names the destination capability and request field in mapping questions', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'stepOutput',
          stepId: 'get-payment',
          schema: object({ amount: { type: 'number' } }),
        },
        {
          source: 'stepOutput',
          stepId: 'get-invoice',
          schema: object({ amount: { type: 'number' } }),
        },
      ],
      destination: object({ amount: { type: 'number' } }),
      destinationCapability: { serviceId: 'stripe', operationId: 'PostPaymentIntents' },
    });

    expect(result.requiredQuestions[0]?.question).toBe(
      'What should Atlas use for the PostPaymentIntents request field amount in the Stripe API?',
    );
  });

  it('does not let an incompatible sibling block an authorized compatible candidate', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        { source: 'stepOutput', stepId: 'wrong', schema: object({ id: { type: 'number' } }) },
        { source: 'stepOutput', stepId: 'right', schema: object({ id: { type: 'string' } }) },
      ],
      destination: object({ id: { type: 'string' } }),
    });

    expect(result.status).toBe('ready');
    expect(result.resolvedMappings[0]?.expression).toEqual({
      source: 'stepOutput',
      stepId: 'right',
      path: ['id'],
    });
  });

  it('validates an automatic exact match before resolving it', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'input',
          schema: object({ id: { type: 'string', classification: 'confidential' } }),
        },
      ],
      destination: object({ id: { type: 'string', classification: 'public' } }),
    });

    expect(result.status).toBe('impossible');
    expect(result.resolvedMappings).toEqual([]);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'TRANSFORM_CLASSIFICATION_DOWNGRADE' }),
      ]),
    );
  });

  it('reports impossible required mappings and enum mismatches', () => {
    const result = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'input',
          schema: object({ state: { type: 'string', enumValues: ['pending', 'paid'] } }),
        },
      ],
      destination: object({
        state: { type: 'string', enumValues: ['open', 'closed'] },
        accountId: { type: 'string' },
      }),
    });

    expect(result.status).toBe('impossible');
    expect(result.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(['ENUM_MISMATCH', 'MISSING_REQUIRED_DESTINATION_FIELD']),
    );
  });

  it('detects incompatible units and flags lossy transforms for explicit selection', () => {
    const incompatible = planApiMappings({
      ...fingerprints,
      sources: [
        { source: 'input', schema: object({ weight: { type: 'number', unit: 'kilograms' } }) },
      ],
      destination: object({ weight: { type: 'number', unit: 'meters' } }),
    });
    expect(incompatible.status).toBe('impossible');
    expect(incompatible.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'INCOMPATIBLE_UNITS' })]),
    );

    const lossy = planApiMappings({
      ...fingerprints,
      sources: [
        {
          source: 'input',
          schema: object({ amount: { type: 'number', unit: 'decimal-currency' } }),
        },
      ],
      destination: object({ amountCents: { type: 'number', unit: 'cents' } }),
    });
    expect(lossy.status).toBe('clarification_required');
    expect(lossy.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'LOSSY_TRANSFORM' })]),
    );
    expect(lossy.candidateMappings[0]?.conversion).toContain('lossy');
  });

  it('fails closed on projection drift and expressions outside the bounded AST', () => {
    expect(
      planApiMappings({
        ...fingerprints,
        activeProjectionFingerprint: 'c'.repeat(64),
        sources: [],
        destination: object({ id: { type: 'string' } }),
      }),
    ).toMatchObject({ status: 'manual_review', diagnostics: [{ code: 'PROJECTION_DRIFT' }] });

    const ambiguous = planApiMappings({
      ...fingerprints,
      sources: [
        { source: 'stepOutput', stepId: 'one', schema: object({ id: { type: 'string' } }) },
        { source: 'stepOutput', stepId: 'two', schema: object({ id: { type: 'string' } }) },
      ],
      destination: object({ id: { type: 'string' } }),
    });
    expect(
      ambiguous.candidateMappings.every(
        ({ expression }) => transformationExpressionSchema.safeParse(expression).success,
      ),
    ).toBe(true);
    expect(
      transformationExpressionSchema.safeParse({
        kind: 'call',
        function: 'eval',
        arguments: [],
      }).success,
    ).toBe(false);
  });
});
