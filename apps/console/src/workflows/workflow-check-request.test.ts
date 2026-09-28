import { afterEach, expect, it, vi } from 'vite-plus/test';
import { followWorkflowCheckRequest } from './workflow-check-request.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('polls one check request through running and passed states', async () => {
  vi.useFakeTimers();
  const result = { status: 'passed' as const, tests: [] };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ requestId: 'one', status: 'running', startedAt: 'now' }))
    .mockResolvedValueOnce(
      Response.json({ requestId: 'one', status: 'passed', startedAt: 'now', result }),
    );
  vi.stubGlobal('fetch', fetch);
  const progress = vi.fn<() => void>();
  const pending = followWorkflowCheckRequest({
    url: '/one',
    token: 'test',
    body: {},
    signal: new AbortController().signal,
    onProgress: progress,
  });

  await vi.runAllTimersAsync();
  await expect(pending).resolves.toMatchObject({ status: 'passed', result });
  expect(fetch.mock.calls.map(([, options]) => options?.method)).toEqual(['PUT', 'GET']);
  expect(progress).toHaveBeenCalledTimes(2);
});

it.each(['cancelled', 'timed_out'] as const)('returns the %s terminal state', async (status) => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ requestId: 'one', status, startedAt: 'now' })),
  );

  await expect(
    followWorkflowCheckRequest({
      url: '/one',
      token: 'test',
      body: {},
      signal: new AbortController().signal,
      onProgress: vi.fn<() => void>(),
    }),
  ).resolves.toMatchObject({ status });
});
