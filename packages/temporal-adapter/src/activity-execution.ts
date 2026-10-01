import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import type { StepExecutionContext } from '@atlas/runtime-ports';

export async function withActivityExecution<T>(
  execute: (context: StepExecutionContext) => Promise<T>,
): Promise<T> {
  const activity = Context.current();
  const deadline = new AbortController();
  // Finish before Temporal's timeout, leaving time to serialize and deliver the outcome.
  const remaining = Math.min(
    activity.info.startToCloseTimeoutMs,
    activity.info.scheduleToCloseTimeoutMs > 0
      ? activity.info.scheduledTimestampMs + activity.info.scheduleToCloseTimeoutMs - Date.now()
      : Infinity,
  );
  const budget = Math.max(0, remaining - Math.min(1_000, remaining / 10));
  const signal = AbortSignal.any([activity.cancellationSignal, deadline.signal]);
  const expire = () =>
    deadline.abort(
      ApplicationFailure.retryable(
        'The provider activity exceeded its local execution deadline',
        'ActivityDeadlineExceeded',
      ),
    );
  const timer = setTimeout(expire, budget);
  timer.unref();
  const heartbeat = activity.info.heartbeatTimeoutMs
    ? setInterval(() => activity.heartbeat(), Math.min(1_000, activity.info.heartbeatTimeoutMs / 2))
    : undefined;
  heartbeat?.unref();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    if (budget === 0) {
      expire();
      return await aborted;
    }
    return await Promise.race([execute({ signal }), aborted]);
  } finally {
    clearTimeout(timer);
    clearInterval(heartbeat);
    signal.removeEventListener('abort', onAbort);
  }
}
