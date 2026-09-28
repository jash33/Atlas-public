import { expect, it, vi } from 'vite-plus/test';

import { createProviderRepairGateway } from './provider-repair-gateway.js';

it('forwards only a validated provider-condition repair to the customer service', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const app = createProviderRepairGateway('http://mock-services:4100', fetch);

  const response = await app.request('/__control/provider-conditions', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ repairedCapabilityVersionId: 'content-hash' }),
  });

  expect(response.status).toBe(204);
  expect(fetch).toHaveBeenCalledWith(
    new URL('http://mock-services:4100/__control/provider-conditions'),
    expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({
        repairedCapabilityVersionId: 'content-hash',
        operationId: 'publishInvoicePaid',
      }),
    }),
  );
  expect((await app.request('/payments/pay_1')).status).toBe(404);
});

it('rejects malformed repair requests without forwarding them', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const app = createProviderRepairGateway('http://mock-services:4100', fetch);

  const response = await app.request('/__control/provider-conditions', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

  expect(response.status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
