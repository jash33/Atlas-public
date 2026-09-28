import { serve } from '@hono/node-server';
import { createMockServicesApp } from '@atlas/mock-services';
import { describe, expect, it } from 'vite-plus/test';

import { invokeSandboxProvider, matchesPinnedSchema } from './workflow-sandbox-provider.js';

describe('sandbox provider observations', () => {
  it('records the Stripe idempotency header on the serialized provider request', async () => {
    const providerServer = serve({ fetch: createMockServicesApp().fetch, port: 0 });
    try {
      const address = providerServer.address();
      if (!address || typeof address === 'string') throw new Error('Provider did not bind a port');
      const providerBaseUrl = `http://127.0.0.1:${address.port}`;
      const observations: Parameters<typeof invokeSandboxProvider>[4] = [];
      const requestSchema = {
        type: 'object',
        required: ['amount', 'currency', 'Idempotency-Key'],
        properties: {
          amount: { type: 'integer' },
          currency: { type: 'string', minLength: 3, maxLength: 3 },
          'Idempotency-Key': { type: 'string', minLength: 1 },
        },
      };
      await expect(
        invokeSandboxProvider(
          fetch,
          providerBaseUrl,
          {
            capabilityVersionId: 'stripe.create@v1',
            serviceId: 'stripe',
            operationId: 'PostPaymentIntents',
            documentHash: 'b'.repeat(64),
            provider: 'Stripe',
            mode: 'contract-faithful-rehearsal',
            method: 'post',
            path: '/v1/payment_intents',
            requestSchema,
            responseSchema: {
              type: 'object',
              required: ['id', 'object', 'amount', 'currency', 'livemode', 'status'],
            },
          },
          {
            stepId: 'create_stripe_payment_intent',
            capabilityVersionId: 'stripe.create@v1',
            input: {
              amount: 100,
              currency: 'USD',
              idempotencyKey: 'pay_sandbox',
            },
          },
          observations,
        ),
      ).resolves.toMatchObject({ object: 'payment_intent', amount: 100 });
      expect(observations).toEqual([
        expect.objectContaining({
          stepId: 'create_stripe_payment_intent',
          status: 200,
          serializedRequest: {
            amount: 100,
            currency: 'USD',
            'Idempotency-Key': 'pay_sandbox',
          },
        }),
      ]);
      expect(matchesPinnedSchema(observations[0]?.serializedRequest, requestSchema)).toBe(true);
    } finally {
      providerServer.close();
    }
  });
});
