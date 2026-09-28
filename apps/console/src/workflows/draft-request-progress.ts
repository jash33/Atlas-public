import { consoleFetch } from '../shell/api.js';

export interface DraftRequestProgress {
  requestId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stage?: 'understanding' | 'building' | 'validating' | 'repairing';
  startedAt: string;
  finishedAt?: string;
  liveText: boolean;
  events?: { sequence: number; timestamp: string; kind: string; data: Record<string, unknown> }[];
  previousEventCount?: number;
  error?: string;
  result?: { httpStatus: number; body: unknown };
}

export function continueDraftProgress(
  previous: DraftRequestProgress | undefined,
  next: DraftRequestProgress,
): DraftRequestProgress {
  if (!previous) return next;
  const previousEvents =
    previous.requestId === next.requestId
      ? (previous.events ?? []).slice(0, previous.previousEventCount ?? 0)
      : (previous.events ?? []);
  return {
    ...next,
    startedAt: previous.startedAt,
    ...(next.status === 'running' && next.stage !== 'validating'
      ? { stage: 'repairing' as const }
      : {}),
    previousEventCount: previousEvents.length,
    events: [...previousEvents, ...(next.events ?? [])],
  };
}

export async function followDraftRequest(options: {
  url: string;
  token: string;
  signal: AbortSignal;
  body?: unknown;
  onProgress: (state: DraftRequestProgress) => void;
  onConnectionChange: (lost: boolean) => void;
}): Promise<{ httpStatus: number; body: unknown }> {
  let starting = options.body !== undefined;
  const startedAt = new Date().toISOString();
  let previous: DraftRequestProgress | undefined;
  while (true) {
    options.signal.throwIfAborted();
    let response: Response;
    let state: DraftRequestProgress;
    try {
      response = await consoleFetch(options.url, {
        method: starting ? 'PUT' : 'GET',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        ...(starting ? { body: JSON.stringify(options.body) } : {}),
        signal: options.signal,
      });
      if (response.status >= 500) throw new Error('Connection unavailable');
      if (!response.ok) {
        const error = new DraftRequestError(
          'This draft request is unavailable or access was denied.',
        );
        const body: unknown = await response.json().catch(() => undefined);
        options.signal.throwIfAborted();
        options.onProgress({
          requestId:
            new URL(options.url, 'http://atlas.local').pathname.split('/').at(-1) ?? 'draft',
          startedAt,
          liveText: false,
          ...previous,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: error.message,
          result: { httpStatus: response.status, body },
        });
        throw error;
      }
      state = await response.json();
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof DraftRequestError) throw error;
      options.onConnectionChange(true);
      await pause(options.signal);
      continue;
    }
    options.signal.throwIfAborted();
    starting = false;
    options.onConnectionChange(false);
    previous = state;
    options.onProgress(state);
    if (state.status === 'completed' && state.result) return state.result;
    if (state.status === 'failed' || state.status === 'cancelled')
      throw new DraftRequestError(state.error ?? 'Draft cancelled.');
    await pause(options.signal);
  }
}

class DraftRequestError extends Error {}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
