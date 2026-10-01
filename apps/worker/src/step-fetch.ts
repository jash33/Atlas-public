import type { StepExecutionContext } from '@atlas/runtime-ports';

// Use the same activity budget for catalog lookup, credential lookup, and provider I/O.
// Standalone connector calls also have a bounded request lifetime.
export function stepFetch(
  fetchImplementation: typeof globalThis.fetch,
  context?: StepExecutionContext,
): typeof globalThis.fetch {
  const signal = context?.signal ?? AbortSignal.timeout(25_000);
  return async (input, init) => {
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const combined = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
    combined.throwIfAborted();
    const response = await fetchImplementation(input, { ...init, signal: combined });
    combined.throwIfAborted();
    return response;
  };
}
