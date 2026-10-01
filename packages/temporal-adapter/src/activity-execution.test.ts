import { MockActivityEnvironment } from '@temporalio/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { withActivityExecution } from './activity-execution.js';

afterEach(() => vi.useRealTimers());

it('expires before start-to-close and prevents a late continuation from writing', async () => {
  vi.useFakeTimers();
  const environment = new MockActivityEnvironment({
    startToCloseTimeoutMs: 1_000,
    scheduleToCloseTimeoutMs: 0,
  });
  let release!: () => void;
  const lookup = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = vi.fn<() => void>();
  const result = environment.run(() =>
    withActivityExecution(async ({ signal }) => {
      await lookup;
      signal.throwIfAborted();
      write();
    }),
  );
  const rejected = result.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(950);
  expect(await rejected).toMatchObject({ type: 'ActivityDeadlineExceeded' });
  release();
  await vi.advanceTimersByTimeAsync(100);
  expect(write).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('respects a nearer schedule-to-close deadline', async () => {
  vi.useFakeTimers();
  const environment = new MockActivityEnvironment({
    startToCloseTimeoutMs: 30_000,
    scheduleToCloseTimeoutMs: 1_000,
    scheduledTimestampMs: Date.now() - 500,
  });
  const result = environment.run(() => withActivityExecution(() => new Promise(() => {})));
  const rejected = result.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(500);
  expect(await rejected).toMatchObject({ type: 'ActivityDeadlineExceeded' });
  expect(vi.getTimerCount()).toBe(0);
});

it('delivers Temporal cancellation to in-flight work and stops heartbeats', async () => {
  vi.useFakeTimers();
  const environment = new MockActivityEnvironment({
    startToCloseTimeoutMs: 30_000,
    scheduleToCloseTimeoutMs: 0,
    heartbeatTimeoutMs: 10_000,
  });
  const heartbeat = vi.fn<() => void>();
  environment.on('heartbeat', heartbeat);
  let requestSignal: AbortSignal | undefined;
  const result = environment.run(() =>
    withActivityExecution(({ signal }) => {
      requestSignal = signal;
      return new Promise(() => {});
    }),
  );
  const cancelled = result.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(heartbeat).toHaveBeenCalled();
  environment.cancel();
  expect(await cancelled).toMatchObject({ name: 'CancelledFailure' });
  expect(requestSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start an already cancelled activity', async () => {
  const environment = new MockActivityEnvironment();
  const execute = vi.fn<() => Promise<void>>().mockResolvedValue();
  environment.cancel();
  await expect(environment.run(() => withActivityExecution(execute))).rejects.toMatchObject({
    name: 'CancelledFailure',
  });
  expect(execute).not.toHaveBeenCalled();
});

it('does not start when schedule-to-close has already elapsed', async () => {
  const environment = new MockActivityEnvironment({
    startToCloseTimeoutMs: 30_000,
    scheduleToCloseTimeoutMs: 1_000,
    scheduledTimestampMs: Date.now() - 2_000,
  });
  const execute = vi.fn<() => Promise<void>>().mockResolvedValue();
  await expect(environment.run(() => withActivityExecution(execute))).rejects.toMatchObject({
    type: 'ActivityDeadlineExceeded',
  });
  expect(execute).not.toHaveBeenCalled();
});
