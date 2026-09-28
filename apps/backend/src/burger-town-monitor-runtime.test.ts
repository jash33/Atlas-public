import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { fetchPollingHttp } from './burger-town-monitor-runtime.js';
import type { PollingTarget } from './burger-town-monitor.js';

const target: PollingTarget = {
  definitionKey: 'burger-town:createPayment',
  revision: 3,
  capabilityVersionId: 'capability-payment',
  url: 'https://burger-town.test/__atlas/demo/createPayment',
  method: 'POST',
  requestBody: { fixture: 'burger-town-demo' },
  expectedStatus: 200,
  recognizedError: {
    status: 400,
    code: 'required_field_missing',
    codePath: ['code'],
    fieldPathPath: ['fieldPath'],
    fieldPath: 'extraLettuce',
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('Burger Town HTTP polling', () => {
  it('uses the prepared request and the same safety key every time', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchPollingHttp.send(target, new AbortController().signal);
    await fetchPollingHttp.send(target, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call).toEqual([
        target.url,
        expect.objectContaining({
          method: 'POST',
          redirect: 'manual',
          body: JSON.stringify(target.requestBody),
          headers: {
            'content-type': 'application/json',
            'idempotency-key': 'burger-town:createPayment:revision-3',
          },
        }),
      ]);
    }
  });
});
