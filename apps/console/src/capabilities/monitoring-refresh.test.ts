// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { renderHook } from '../test-render.js';
import { useBurgerTownMonitoring } from './data.js';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(['stopped', 'unavailable', 'starting', 'active', 'stopping'] as const)(
  'only polls monitoring while running or changing: %s',
  async (state) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () =>
      Response.json({
        state,
        lastCompletedSweepAt: null,
        readinessMessage: null,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const hook = renderHook(() => useBurgerTownMonitoring('org_atlas', 'development', 'test'));
    try {
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(fetch).toHaveBeenCalledTimes(
        ['starting', 'active', 'stopping'].includes(state) ? 2 : 1,
      );
    } finally {
      hook.unmount();
    }
    const calls = fetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).toHaveBeenCalledTimes(calls);
  },
);

it('stops polling after failure and resumes after a successful manual retry', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockImplementation(async () => Response.json({ state: 'active' }));
  vi.stubGlobal('fetch', fetch);
  const hook = renderHook(() => useBurgerTownMonitoring('org_atlas', 'development', 'test'));
  try {
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => hook.current.reload());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  } finally {
    hook.unmount();
  }
});
