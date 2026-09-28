import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { z } from 'zod';

const repairSchema = z.object({ repairedCapabilityVersionId: z.string().min(1) }).strict();

export function createProviderRepairGateway(
  providerUrl: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
) {
  return new Hono()
    .get('/health', (context) => context.json({ status: 'ok' }))
    .put('/__control/provider-conditions', async (context) => {
      const parsed = repairSchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return context.json({ error: 'invalid-provider-condition-repair' }, 400);
      const response = await fetchImplementation(
        new URL('/__control/provider-conditions', providerUrl),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...parsed.data, operationId: 'publishInvoicePaid' }),
        },
      );
      return response.ok
        ? context.body(null, 204)
        : context.json({ error: 'provider-condition-repair-failed' }, 502);
    });
}

if (process.argv[1]?.endsWith('provider-repair-gateway.js')) {
  const port = Number(process.env.PROVIDER_REPAIR_GATEWAY_PORT ?? 4200);
  const providerUrl = process.env.MOCK_SERVICES_URL ?? 'http://mock-services:4100';
  serve({ fetch: createProviderRepairGateway(providerUrl).fetch, port });
  console.log(`Atlas provider-repair gateway listening on http://localhost:${port}`);
}
