// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';
import { renderHook } from '../test-render.js';
import { useRemote } from './data.js';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('ignores an old load even when its loader completes after cancellation', async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  const firstLoad = () => first.promise;
  const secondLoad = () => second.promise;
  let load = firstLoad;
  let scope = 'first';
  const hook = renderHook(() => useRemote([scope], load));
  try {
    await act(async () => {});
    scope = 'second';
    load = secondLoad;
    hook.render();
    await act(async () => second.resolve('new environment'));
    expect(hook.current.remote).toEqual({ status: 'ready', data: 'new environment' });
    await act(async () => first.resolve('old environment'));
    expect(hook.current.remote).toEqual({ status: 'ready', data: 'new environment' });
  } finally {
    hook.unmount();
  }
});

it('uses the explicit scope, keeps ready data while refreshing, and aborts on unmount', async () => {
  const loads: AbortSignal[] = [];
  let scope = 'development';
  const hook = renderHook(() =>
    useRemote([scope], async (signal) => {
      loads.push(signal);
      return scope;
    }),
  );
  try {
    await act(async () => {});
    expect(hook.current.remote).toEqual({ status: 'ready', data: 'development' });
    hook.render();
    await act(async () => {});
    expect(loads).toHaveLength(1);
    act(() => hook.current.reload());
    expect(hook.current.remote).toEqual({ status: 'ready', data: 'development' });
    await act(async () => {});
    expect(loads).toHaveLength(2);
    scope = 'production';
    hook.render();
    expect(hook.current.remote).toEqual({ status: 'loading' });
    await act(async () => {});
    expect(hook.current.remote).toEqual({ status: 'ready', data: 'production' });
    expect(loads.slice(0, 2).every((signal) => signal.aborted)).toBe(true);
  } finally {
    hook.unmount();
  }
  expect(loads.every((signal) => signal.aborted)).toBe(true);
});

it('retries errors through the same loading interface', async () => {
  let attempts = 0;
  const hook = renderHook(() =>
    useRemote(['scope'], async () => {
      if (++attempts === 1) throw new Error('Unavailable');
      return 'recovered';
    }),
  );
  try {
    await act(async () => {});
    expect(hook.current.remote).toEqual({ status: 'error', message: 'Unavailable' });
    act(() => hook.current.reload());
    expect(hook.current.remote).toMatchObject({ status: 'loading', retrying: true });
    await act(async () => {});
    expect(hook.current.remote).toEqual({ status: 'ready', data: 'recovered' });
  } finally {
    hook.unmount();
  }
});

it('ignores rejection from an old scope and late success after unmount', async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  let scope = 'first';
  const hook = renderHook(() =>
    useRemote([scope], () => (scope === 'first' ? first.promise : second.promise)),
  );
  await act(async () => {});
  scope = 'second';
  hook.render();
  await act(async () => {});
  await act(async () => first.reject(new Error('Old error')));
  expect(hook.current.remote).toEqual({ status: 'loading' });
  hook.unmount();
  await act(async () => second.resolve('late'));
  expect(hook.current.remote).toEqual({ status: 'loading' });
});
