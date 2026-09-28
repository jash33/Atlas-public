import { describe, expect, it, vi } from 'vite-plus/test';

import { createSandboxControlFetch } from './sandbox-control-fetch.js';
import { seedSandboxTarget } from './workflow-sandbox-provider.js';

function connectTimeout() {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connection timed out'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
}

describe('sandbox control transport', () => {
  it('recovers a seed request after one connection timeout', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(
      seedSandboxTarget(createSandboxControlFetch(request), 'http://provider', {
        mode: 'replace',
        resources: [],
      }),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
  });

  it('recovers a read-only observation request', async () => {
    const response = Response.json({ setup: { ready: true } });
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(connectTimeout())
      .mockResolvedValueOnce(response);
    await expect(createSandboxControlFetch(request)('http://provider/observations')).resolves.toBe(
      response,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('stops after one retry if the connection stays unavailable', async () => {
    const error = connectTimeout();
    const request = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(createSandboxControlFetch(request)('http://provider/observations')).rejects.toBe(
      error,
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not retry execution POSTs or ambiguous socket failures', async () => {
    const timeout = connectTimeout();
    const post = vi.fn<typeof fetch>().mockRejectedValue(timeout);
    await expect(
      createSandboxControlFetch(post)('http://provider/execute', { method: 'POST' }),
    ).rejects.toBe(timeout);
    expect(post).toHaveBeenCalledTimes(1);
    const reset = new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    const request = vi.fn<typeof fetch>().mockRejectedValue(reset);
    await expect(
      createSandboxControlFetch(request)('http://provider/faults', { method: 'PUT', body: '{}' }),
    ).rejects.toBe(reset);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not retry HTTP errors', async () => {
    const response = new Response(null, { status: 500 });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(createSandboxControlFetch(request)('http://provider/observations')).resolves.toBe(
      response,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
