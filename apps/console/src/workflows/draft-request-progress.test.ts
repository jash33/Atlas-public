import { afterEach, expect, it, vi } from 'vite-plus/test';
import { followDraftRequest, type DraftRequestProgress } from './draft-request-progress.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.useRealTimers();
});

it('uses the customer session without sending a demo token when recovering a draft', async () => {
  vi.stubEnv('VITE_ATLAS_AUTH_MODE', 'customer');
  vi.resetModules();
  const { followDraftRequest: followCustomerDraft } = await import('./draft-request-progress.js');
  const result = { httpStatus: 200, body: { status: 'validated' } };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ requestId: 'one', status: 'completed', result }));
  vi.stubGlobal('fetch', fetch);
  expect(
    await followCustomerDraft({
      url: '/v1/draft-requests/one',
      token: 'demo-token',
      signal: new AbortController().signal,
      onProgress: vi.fn<() => void>(),
      onConnectionChange: vi.fn<() => void>(),
    }),
  ).toEqual(result);
  expect(fetch.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
});

it('reconnects to the same request and returns its final result', async () => {
  vi.useFakeTimers();
  const result = { httpStatus: 200, body: { status: 'validated' } };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(
      Response.json({ requestId: 'one', status: 'running', stage: 'understanding' }),
    )
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(Response.json({ requestId: 'one', status: 'completed', result }));
  vi.stubGlobal('fetch', fetch);
  const onConnectionChange = vi.fn<() => void>();
  const pending = followDraftRequest({
    url: '/one',
    token: 'test',
    body: {},
    signal: new AbortController().signal,
    onProgress: vi.fn<() => void>(),
    onConnectionChange,
  });
  await vi.runAllTimersAsync();
  expect(await pending).toEqual(result);
  expect(fetch.mock.calls.map(([url, options]) => [url, options?.method])).toEqual([
    ['/one', 'PUT'],
    ['/one', 'PUT'],
    ['/one', 'GET'],
    ['/one', 'GET'],
  ]);
  expect(onConnectionChange).toHaveBeenCalledWith(true);
});

it('ignores late updates after cancellation', async () => {
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(() => response.promise),
  );
  const controller = new AbortController();
  const onProgress = vi.fn<() => void>();
  const pending = followDraftRequest({
    url: '/old',
    token: 'test',
    signal: controller.signal,
    onProgress,
    onConnectionChange: vi.fn<() => void>(),
  });
  controller.abort();
  response.resolve(Response.json({ status: 'completed', result: { httpStatus: 200, body: {} } }));
  await expect(pending).rejects.toThrow('aborted');
  expect(onProgress).not.toHaveBeenCalled();
});

it('keeps the received trace events when a later progress request is denied', async () => {
  vi.useFakeTimers();
  const progress: DraftRequestProgress = {
    requestId: 'one',
    status: 'running',
    stage: 'understanding',
    startedAt: '2026-09-19T22:00:00Z',
    liveText: true,
    events: [
      { sequence: 1, timestamp: 'now', kind: 'planning.stage', data: { stage: 'understanding' } },
    ],
  };
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(progress))
      .mockResolvedValueOnce(Response.json({ error: 'session-expired' }, { status: 403 })),
  );
  const onProgress = vi.fn<(state: DraftRequestProgress) => void>();
  const pending = followDraftRequest({
    url: '/v1/draft-requests/one',
    token: 'test',
    signal: new AbortController().signal,
    onProgress,
    onConnectionChange: vi.fn<(lost: boolean) => void>(),
  });
  const rejection = pending.catch((cause: unknown) => cause);
  await vi.runAllTimersAsync();
  expect(await rejection).toBeInstanceOf(Error);
  expect(onProgress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      requestId: progress.requestId,
      startedAt: progress.startedAt,
      events: progress.events,
      status: 'failed',
      result: { httpStatus: 403, body: { error: 'session-expired' } },
    }),
  );
});
