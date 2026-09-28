import { describe, expect, it } from 'vite-plus/test';

import { inferMissingFieldMapping } from './planner-mapping-inference.js';

const shortPrompt =
  'When someone orders pickup, open a pickup order, start a ticket, add the burger, and send it to the kitchen.';

const openOrder = {
  stepId: 'open-order',
  operationId: 'createFulfillment',
  outputLeaves: [
    { path: ['id'], type: 'string' },
    { path: ['type'], type: 'string' },
  ],
};

describe('inferMissingFieldMapping', () => {
  it('works backward from a non-ID field to a unique compatible earlier output', () => {
    expect(
      inferMissingFieldMapping({
        field: 'customer_email',
        destinationType: 'string',
        developerRequest: 'Send a receipt',
        priorSteps: [
          {
            stepId: 'customer',
            operationId: 'getCustomer',
            outputLeaves: [{ path: ['contact', 'customer_email'], type: 'string' }],
          },
        ],
      }),
    ).toEqual({ kind: 'stepOutput', stepId: 'customer', path: ['contact', 'customer_email'] });
  });

  it('requires a runtime input when the earlier field has an incompatible type', () => {
    expect(
      inferMissingFieldMapping({
        field: 'fulfillment_id',
        destinationType: 'integer',
        developerRequest: shortPrompt,
        priorSteps: [openOrder],
      }),
    ).toEqual({ kind: 'input' });
  });

  it('keeps multiple compatible sources ambiguous instead of inventing a runtime input', () => {
    expect(
      inferMissingFieldMapping({
        field: 'email',
        destinationType: 'string',
        developerRequest: 'Send a receipt',
        priorSteps: ['buyer', 'seller'].map((stepId) => ({
          stepId,
          operationId: 'getContact',
          outputLeaves: [{ path: ['email'], type: 'string' }],
        })),
      }),
    ).toEqual({ kind: 'ambiguous' });
  });
  it('wires a unique prior id into a matching {noun}_id field', () => {
    expect(
      inferMissingFieldMapping({
        field: 'fulfillment_id',
        destinationType: 'string',
        destinationOperationId: 'createCheck',
        developerRequest: shortPrompt,
        priorSteps: [openOrder],
      }),
    ).toEqual({ kind: 'stepOutput', stepId: 'open-order', path: ['id'] });
  });

  it('uses a unique enum word from the request as a literal', () => {
    expect(
      inferMissingFieldMapping({
        field: 'type',
        destinationType: 'string',
        destinationEnumValues: ['pickup', 'delivery'],
        destinationOperationId: 'createFulfillment',
        developerRequest: shortPrompt,
        priorSteps: [],
      }),
    ).toEqual({ kind: 'literal', value: 'pickup' });
  });

  it('promotes an unmapped leftover field to a runtime input', () => {
    expect(
      inferMissingFieldMapping({
        field: 'server_id',
        destinationType: 'string',
        destinationOperationId: 'createCheck',
        developerRequest: shortPrompt,
        priorSteps: [openOrder],
      }),
    ).toEqual({ kind: 'input' });
  });

  it('wires from a provider recipe data-flow when the operation name does not contain the noun', () => {
    expect(
      inferMissingFieldMapping({
        field: 'fulfillment_id',
        destinationType: 'string',
        destinationOperationId: 'createCheck',
        developerRequest: shortPrompt,
        priorSteps: [
          {
            stepId: 'open-order',
            operationId: 'openPickup',
            outputLeaves: [{ path: ['id'], type: 'string' }],
          },
        ],
        recipeDataFlows: [
          {
            sourceOperationId: 'openPickup',
            targetOperationId: 'createCheck',
            destinationField: 'fulfillment_id',
          },
        ],
      }),
    ).toEqual({ kind: 'stepOutput', stepId: 'open-order', path: ['id'] });
  });

  it('does not pick a prior id when two producing operations match', () => {
    expect(
      inferMissingFieldMapping({
        field: 'fulfillment_id',
        destinationType: 'string',
        destinationOperationId: 'createCheck',
        developerRequest: shortPrompt,
        priorSteps: [
          openOrder,
          {
            stepId: 'other-fulfillment',
            operationId: 'createFulfillment',
            outputLeaves: [{ path: ['id'], type: 'string' }],
          },
        ],
      }),
    ).toEqual({ kind: 'ambiguous' });
  });
});
