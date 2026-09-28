import type { WorkflowSandboxProgressWire } from '@atlas/demo-estate';
import { consoleFetch } from '../shell/api.js';
import type { SandboxCheckOutcome } from './workflow.js';

export interface WorkflowCheckResult {
  status: 'passed' | 'failed';
  tests: readonly SandboxCheckOutcome[];
}

export type WorkflowCheckProgress = WorkflowSandboxProgressWire;

export interface WorkflowCheckRequestState<
  Result extends WorkflowCheckResult = WorkflowCheckResult,
> {
  requestId: string;
  status: 'running' | 'passed' | 'failed' | 'cancelled' | 'timed_out';
  startedAt: string;
  finishedAt?: string;
  result?: Result;
  error?: string;
  progress?: WorkflowCheckProgress;
}

export async function followWorkflowCheckRequest<
  Result extends WorkflowCheckResult = WorkflowCheckResult,
>(options: {
  url: string;
  token: string;
  body: unknown;
  signal: AbortSignal;
  onProgress: (state: WorkflowCheckRequestState<Result>) => void;
}): Promise<WorkflowCheckRequestState<Result>> {
  let starting = true;
  while (true) {
    options.signal.throwIfAborted();
    let response: Response;
    try {
      response = await consoleFetch(options.url, {
        method: starting ? 'PUT' : 'GET',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
        },
        ...(starting ? { body: JSON.stringify(options.body) } : {}),
        signal: options.signal,
      });
      if (response.status >= 500) throw new Error('Check status unavailable');
    } catch {
      options.signal.throwIfAborted();
      await pause(options.signal);
      continue;
    }
    if (!response.ok) throw new Error('This check request is unavailable or access was denied.');
    const state: WorkflowCheckRequestState<Result> = await response.json();
    starting = false;
    options.onProgress(state);
    if (state.status !== 'running') return state;
    await pause(options.signal);
  }
}

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
