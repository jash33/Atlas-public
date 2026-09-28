import { expect, it } from 'vite-plus/test';

import { capabilityInputFields } from './workflow-validation.js';

it('reads AsyncAPI operation input fields from the projected channel message', () => {
  const fields = capabilityInputFields({
    channel: {
      address: 'invoice.paid',
      messages: {
        invoicePaid: {
          payload: {
            type: 'object',
            required: ['paymentId', 'atlasWorkflowRunId'],
            properties: {
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
  });

  expect([...fields]).toEqual([
    ['paymentId', { required: true, schema: { type: 'string' } }],
    ['atlasWorkflowRunId', { required: true, schema: { type: 'string' } }],
  ]);
});
