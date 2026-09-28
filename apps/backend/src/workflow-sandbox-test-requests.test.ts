import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import type { WorkflowSandboxProgressWire } from '@atlas/demo-estate';
import { WorkflowSandboxTestRequests } from './workflow-sandbox-test-requests.js';
import { InvalidSandboxTarget } from './capability-sandbox-targets.js';
import {
  WorkflowSandboxExecutionFailed,
  WorkflowSandboxTestsUnavailable,
} from './workflow-sandbox.js';

const owner = { actorId: 'admin', organizationId: 'org', environmentId: 'development' };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('workflow sandbox test requests', () => {
  it('publishes isolated progress snapshots while the checks are still running', async () => {
    const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(60_000);
    const work = Promise.withResolvers<{ status: 'passed' | 'failed' }>();
    let reportProgress: ((progress: WorkflowSandboxProgressWire) => void) | undefined;
    const started = requests.start('progress', owner, 'same', (_signal, onProgress) => {
      reportProgress = onProgress;
      return work.promise;
    });
    expect(started).toMatchObject({
      status: 'running',
      progress: { phase: 'preparing', completed: 0, total: 0 },
    });
    reportProgress?.({ phase: 'preparing', completed: 0, total: 4 });
    const preparing = requests.read('progress', owner);
    const update: WorkflowSandboxProgressWire = {
      phase: 'running',
      completed: 1,
      total: 4,
      currentTest: { kind: 'duplicate-event', stepId: 'create-order' },
    };
    reportProgress?.(update);
    const running = requests.read('progress', owner);
    expect(running).toMatchObject({ status: 'running', progress: update });
    expect(running?.result).toBeUndefined();
    update.currentTest!.stepId = 'changed-after-reporting';
    running!.progress!.completed = 99;
    expect(requests.read('progress', owner)?.progress).toEqual({
      phase: 'running',
      completed: 1,
      total: 4,
      currentTest: { kind: 'duplicate-event', stepId: 'create-order' },
    });
    expect(preparing?.progress).toEqual({ phase: 'preparing', completed: 0, total: 4 });
    expect(started?.progress).toEqual({ phase: 'preparing', completed: 0, total: 0 });
    expect(requests.read('progress', { ...owner, actorId: 'other' })).toBeUndefined();
    work.resolve({ status: 'passed' });
    await Promise.resolve();
  });

  it.each(['passed', 'failed', 'rejected', 'cancelled', 'timed_out'] as const)(
    'ignores progress after a request has %s',
    async (outcome) => {
      vi.useFakeTimers();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(1_000);
      const work = Promise.withResolvers<{ status: 'passed' | 'failed' }>();
      let reportProgress: ((progress: WorkflowSandboxProgressWire) => void) | undefined;
      requests.start('finished-progress', owner, 'same', (_signal, onProgress) => {
        reportProgress = onProgress;
        return work.promise;
      });
      reportProgress?.({ phase: 'running', completed: 1, total: 2 });
      if (outcome === 'cancelled') requests.cancel('finished-progress', owner);
      else if (outcome === 'timed_out') await vi.advanceTimersByTimeAsync(1_000);
      else if (outcome === 'rejected') work.reject(new Error('Runner failed'));
      else work.resolve({ status: outcome });
      await vi.advanceTimersByTimeAsync(0);
      const finished = requests.read('finished-progress', owner);
      expect(finished?.status).toBe(outcome === 'rejected' ? 'failed' : outcome);
      expect(finished?.progress).toEqual({ phase: 'running', completed: 1, total: 2 });
      reportProgress?.({ phase: 'finalizing', completed: 2, total: 2 });
      expect(requests.read('finished-progress', owner)).toEqual(finished);
    },
  );

  it.each([
    {
      error: new InvalidSandboxTarget(
        'Sandbox target or test-data profile is missing or no longer valid',
      ),
      message:
        'Sandbox target or test-data profile is missing or no longer valid. Review the sandbox target and test-data profile, then run checks again.',
      category: 'invalid-target',
    },
    {
      error: new WorkflowSandboxTestsUnavailable('unavailable'),
      message:
        'The check runner is unavailable. Check the worker connection, then run checks again.',
      category: 'runner-unavailable',
    },
    {
      error: new WorkflowSandboxExecutionFailed('private provider error must not be shown'),
      message:
        'The worker could not complete these checks. Check the worker logs, then run checks again.',
      category: 'runner-execution-failed',
    },
  ])(
    'reports actionable $category failures without losing request ownership',
    async ({ error, message, category }) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(60_000);
      requests.start('failed', owner, 'same', async () => {
        throw error;
      });
      await vi.waitFor(() => expect(requests.read('failed', owner)?.status).toBe('failed'));
      expect(requests.read('failed', owner)).toMatchObject({ error: message });
      expect(requests.read('failed', owner)?.result).toBeUndefined();
      expect(requests.read('failed', { ...owner, actorId: 'other' })).toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        'workflow-sandbox-test-request-failed',
        expect.objectContaining({ category }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('private provider error');
    },
  );

  it('keeps unexpected messages, causes, URLs, and injected stack text out of the UI and logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(60_000);
    const error = new Error('SECRET_PROVIDER_PAYLOAD', {
      cause: { authorization: 'SECRET_TOKEN' },
    });
    error.stack =
      'Error: SECRET_PROVIDER_PAYLOAD\n    at SECRET_FUNCTION (https://provider.test/?token=SECRET_TOKEN:1:1)\n    at resolveSandboxTargetBindings (C:\\private-user\\repo\\apps\\backend\\src\\capability-sandbox-targets.ts:459:13)';
    requests.start('redacted', owner, 'same', async () => {
      throw error;
    });
    await vi.waitFor(() => expect(requests.read('redacted', owner)?.status).toBe('failed'));
    expect(requests.read('redacted', owner)?.error).toBe(
      'The check runner could not finish these checks.',
    );
    expect(log).toHaveBeenCalledWith('workflow-sandbox-test-request-failed', {
      category: 'unexpected-error',
      frames: [{ file: 'capability-sandbox-targets.ts', line: 459, column: 13 }],
    });
    expect(JSON.stringify([requests.read('redacted', owner), log.mock.calls])).not.toMatch(
      /SECRET_|provider\.test|private-user/,
    );
  });

  it('does not trust arbitrary messages even when the error has the target error type', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(60_000);
    requests.start('unknown-target', owner, 'same', async () => {
      throw new InvalidSandboxTarget('SECRET_TARGET_VALUE');
    });
    await vi.waitFor(() => expect(requests.read('unknown-target', owner)?.status).toBe('failed'));
    expect(requests.read('unknown-target', owner)?.error).toBe(
      'Sandbox target configuration is invalid. Review the sandbox target and test-data profile, then run checks again.',
    );
    expect(JSON.stringify([requests.read('unknown-target', owner), log.mock.calls])).not.toContain(
      'SECRET_TARGET_VALUE',
    );
  });

  it.each(['cancelled', 'timed_out'] as const)(
    'ignores a late rejection after checks are %s',
    async (status) => {
      vi.useFakeTimers();
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(1000);
      const work = Promise.withResolvers<{ status: 'passed' | 'failed' }>();
      requests.start('finished', owner, 'same', () => work.promise);
      if (status === 'cancelled') requests.cancel('finished', owner);
      else await vi.advanceTimersByTimeAsync(1000);
      work.reject(new Error('late private details'));
      await vi.advanceTimersByTimeAsync(0);
      expect(requests.read('finished', owner)?.status).toBe(status);
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('cancels running work and ignores its late result', async () => {
    const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(60_000);
    const work = Promise.withResolvers<{ status: 'passed' | 'failed' }>();
    let signal: AbortSignal | undefined;
    requests.start('one', owner, 'same', (currentSignal) => {
      signal = currentSignal;
      return work.promise;
    });

    expect(requests.cancel('one', owner)).toMatchObject({ status: 'cancelled' });
    expect(signal?.aborted).toBe(true);
    work.resolve({ status: 'passed' });
    await Promise.resolve();
    expect(requests.read('one', owner)).toMatchObject({ status: 'cancelled' });
  });

  it('times out running work and ignores its late result', async () => {
    vi.useFakeTimers();
    const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(1_000);
    const work = Promise.withResolvers<{ status: 'passed' | 'failed' }>();
    let signal: AbortSignal | undefined;
    requests.start('two', owner, 'same', (currentSignal) => {
      signal = currentSignal;
      return work.promise;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(requests.read('two', owner)).toMatchObject({ status: 'timed_out' });
    expect(signal?.aborted).toBe(true);
    work.resolve({ status: 'passed' });
    await Promise.resolve();
    expect(requests.read('two', owner)).toMatchObject({ status: 'timed_out' });
  });

  it('returns the same request only to its owner and only for the same input', () => {
    const requests = new WorkflowSandboxTestRequests<{ status: 'passed' | 'failed' }>(60_000);
    const never = () => new Promise<{ status: 'passed' | 'failed' }>(() => undefined);
    requests.start('three', owner, 'same', never);

    expect(requests.start('three', owner, 'same', never)).toMatchObject({ status: 'running' });
    expect(requests.start('three', owner, 'different', never)).toBeUndefined();
    expect(requests.read('three', { ...owner, actorId: 'other' })).toBeUndefined();
  });
});
