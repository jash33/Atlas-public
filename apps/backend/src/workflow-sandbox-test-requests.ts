import { ZodError } from 'zod';
import type { WorkflowSandboxProgressWire } from '@atlas/demo-estate';
import { InvalidSandboxTarget } from './capability-sandbox-targets.js';
import {
  WorkflowSandboxExecutionFailed,
  WorkflowSandboxTestsUnavailable,
} from './workflow-sandbox.js';

export type WorkflowSandboxTestRequestStatus =
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface WorkflowSandboxTestRequestState<Result> {
  requestId: string;
  status: WorkflowSandboxTestRequestStatus;
  startedAt: string;
  finishedAt?: string;
  result?: Result;
  error?: string;
  progress?: WorkflowSandboxProgressWire;
}

interface RequestOwner {
  actorId: string;
  organizationId: string;
  environmentId: string;
}

interface StoredRequest<Result> {
  owner: RequestOwner;
  requestHash: string;
  state: WorkflowSandboxTestRequestState<Result>;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

function sameOwner(left: RequestOwner, right: RequestOwner) {
  return (
    left.actorId === right.actorId &&
    left.organizationId === right.organizationId &&
    left.environmentId === right.environmentId
  );
}

const safeTargetMessages = new Set([
  'Connected sandbox controls must remain on the application origin',
  'Sandbox targets require credential-free HTTP(S) URLs',
  'Only internal capabilities can use customer sandbox targets',
  'Sandbox targets require a supported Atlas environment',
  'Sandbox targets cannot use the environment runtime service',
  'Secret alias is not registered for the target environment',
  'Sandbox target hostname is not allowed by capability policy',
  'Capability version was not found',
  'A capability can select only one sandbox target',
  'Sandbox target or test-data profile is missing or no longer valid',
]);

function describeFailure(error: unknown) {
  if (error instanceof InvalidSandboxTarget) {
    const reason = safeTargetMessages.has(error.message)
      ? error.message
      : 'Sandbox target configuration is invalid';
    return {
      category: 'invalid-target',
      message: `${reason}. Review the sandbox target and test-data profile, then run checks again.`,
    };
  }
  if (error instanceof WorkflowSandboxTestsUnavailable) {
    return {
      category: 'runner-unavailable',
      message:
        'The check runner is unavailable. Check the worker connection, then run checks again.',
    };
  }
  if (error instanceof WorkflowSandboxExecutionFailed) {
    return {
      category: 'runner-execution-failed',
      message:
        'The worker could not complete these checks. Check the worker logs, then run checks again.',
    };
  }
  return {
    category:
      error instanceof ZodError
        ? 'schema-error'
        : error instanceof TypeError
          ? 'type-error'
          : 'unexpected-error',
    message: 'The check runner could not finish these checks.',
  };
}

function safeFailureFrames(error: unknown) {
  if (!(error instanceof Error)) return [];
  // Keep only known source locations, never exception text, URLs, paths, or function names.
  return (error.stack ?? '')
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .flatMap((line) => {
      const match =
        /[/\\](capability-sandbox-targets|workflow-sandbox|http-workflow-sandbox-executor|workflow-sandbox-test-requests|app)\.(ts|js):(\d+):(\d+)\)?$/.exec(
          line,
        );
      return match
        ? [{ file: `${match[1]}.${match[2]}`, line: Number(match[3]), column: Number(match[4]) }]
        : [];
    })
    .slice(0, 8);
}

export class WorkflowSandboxTestRequests<Result extends { status: 'passed' | 'failed' }> {
  readonly #requests = new Map<string, StoredRequest<Result>>();

  constructor(private readonly timeoutMs: number) {}

  read(id: string, owner: RequestOwner) {
    const stored = this.#requests.get(id);
    return stored && sameOwner(stored.owner, owner) ? structuredClone(stored.state) : undefined;
  }

  cancel(id: string, owner: RequestOwner) {
    const stored = this.#requests.get(id);
    if (!stored || !sameOwner(stored.owner, owner)) return undefined;
    if (stored.state.status !== 'running') return structuredClone(stored.state);
    this.#finish(stored, {
      requestId: id,
      status: 'cancelled',
      startedAt: stored.state.startedAt,
      finishedAt: new Date().toISOString(),
    });
    stored.controller.abort(new Error('Checks were cancelled.'));
    return structuredClone(stored.state);
  }

  start(
    id: string,
    owner: RequestOwner,
    requestHash: string,
    work: (
      signal: AbortSignal,
      onProgress: (progress: WorkflowSandboxProgressWire) => void,
    ) => Promise<Result>,
  ) {
    const existing = this.#requests.get(id);
    if (existing) {
      return sameOwner(existing.owner, owner) && existing.requestHash === requestHash
        ? structuredClone(existing.state)
        : undefined;
    }

    const controller = new AbortController();
    const state: WorkflowSandboxTestRequestState<Result> = {
      requestId: id,
      status: 'running',
      startedAt: new Date().toISOString(),
      progress: { phase: 'preparing', completed: 0, total: 0 },
    };
    const stored: StoredRequest<Result> = {
      owner,
      requestHash,
      state,
      controller,
      timer: setTimeout(() => {
        if (stored.state.status !== 'running') return;
        this.#finish(stored, {
          requestId: id,
          status: 'timed_out',
          startedAt: stored.state.startedAt,
          finishedAt: new Date().toISOString(),
          error: 'Checks took too long and were stopped.',
        });
        controller.abort(new Error('Checks timed out.'));
      }, this.timeoutMs),
    };
    stored.timer.unref?.();
    this.#requests.set(id, stored);

    void work(controller.signal, (progress) => {
      if (stored.state.status !== 'running') return;
      stored.state = { ...stored.state, progress: structuredClone(progress) };
    })
      .then((result) => {
        if (stored.state.status !== 'running') return;
        this.#finish(stored, {
          requestId: id,
          status: result.status,
          startedAt: stored.state.startedAt,
          finishedAt: new Date().toISOString(),
          result,
        });
      })
      .catch((error: unknown) => {
        if (stored.state.status !== 'running') return;
        const failure = describeFailure(error);
        console.error('workflow-sandbox-test-request-failed', {
          category: failure.category,
          frames: safeFailureFrames(error),
        });
        this.#finish(stored, {
          requestId: id,
          status: 'failed',
          startedAt: stored.state.startedAt,
          finishedAt: new Date().toISOString(),
          error: failure.message,
        });
      });
    return structuredClone(state);
  }

  #finish(stored: StoredRequest<Result>, state: WorkflowSandboxTestRequestState<Result>) {
    clearTimeout(stored.timer);
    stored.state = {
      ...state,
      ...(stored.state.progress ? { progress: structuredClone(stored.state.progress) } : {}),
    };
  }
}
