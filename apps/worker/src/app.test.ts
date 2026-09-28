import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import type { WorkflowRunStarter } from './app.js';
import { createWorkerApp, InvalidWorkflowSandboxRequest } from './app.js';
import type { WorkflowSandboxRunner } from './app.js';

describe('payment workflow intake API', () => {
  it('authenticates result reads even when run intake is disabled', async () => {
    let reads = 0;
    const app = createWorkerApp(
      {
        startWorkflowRun: async () => {
          throw new Error('Must not start');
        },
      },
      undefined,
      false,
      {
        token: 'result-token',
        read: async (id) => {
          reads++;
          expect(id).toBe('atlas:run:one');
          return { status: 'completed', output: { receiptId: 'receipt-5' } };
        },
      },
    );
    const url = 'http://worker/v1/workflow-results/atlas%3Arun%3Aone';
    expect((await app.fetch(new Request(url))).status).toBe(401);
    expect(
      (await app.fetch(new Request(url, { headers: { authorization: 'Bearer wrong' } }))).status,
    ).toBe(401);
    expect(reads).toBe(0);
    const response = await app.fetch(
      new Request(url, { headers: { authorization: 'Bearer result-token' } }),
    );
    expect(await response.json()).toEqual({
      status: 'completed',
      output: { receiptId: 'receipt-5' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(reads).toBe(1);
  });
  it('reports readiness even when inbound run intake is disabled', async () => {
    const app = createWorkerApp(
      {
        async startWorkflowRun() {
          throw new Error('health checks must not start workflows');
        },
      },
      undefined,
      false,
    );

    const response = await app.fetch(new Request('http://worker/health'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ service: 'worker', status: 'ok' });
  });

  it('accepts a payment run asynchronously', async () => {
    const starter: WorkflowRunStarter = {
      async startWorkflowRun(payload) {
        expect(payload).toEqual({ paymentId: 'pay_1' });
        return { workflowRunId: 'atlas:run:pay_1', status: 'accepted' };
      },
    };
    const app = createWorkerApp(starter);

    const response = await app.fetch(
      new Request('http://worker/v1/workflows/payment-to-billing/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentId: 'pay_1' }),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ workflowRunId: 'atlas:run:pay_1' });
  });

  it('keeps the worker-owned sandbox endpoint available when inbound run intake is disabled', async () => {
    const starter: WorkflowRunStarter = {
      async startWorkflowRun() {
        throw new Error('ordinary intake must remain disabled');
      },
    };
    const app = createWorkerApp(
      starter,
      {
        async execute(suite) {
          expect(suite).toEqual({ workflowVersionId: 'workflow@1' });
          return { outcomes: [{ testId: 'happy-path', status: 'passed' }] };
        },
      },
      false,
    );

    const sandboxResponse = await app.fetch(
      new Request('http://worker/v1/workflow-sandbox-tests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowVersionId: 'workflow@1' }),
      }),
    );
    expect(sandboxResponse.status).toBe(200);
    await expect(sandboxResponse.json()).resolves.toEqual({
      outcomes: [{ testId: 'happy-path', status: 'passed' }],
    });

    const intakeResponse = await app.fetch(
      new Request('http://worker/v1/workflows/payment-to-billing/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentId: 'pay_1' }),
      }),
    );
    expect(intakeResponse.status).toBe(404);
  });

  it('keeps malformed sandbox suites as invalid requests', async () => {
    const app = createWorkerApp(
      {
        async startWorkflowRun() {
          throw new Error('ordinary intake must remain disabled');
        },
      },
      {
        async execute() {
          throw new InvalidWorkflowSandboxRequest();
        },
      },
      false,
    );

    const response = await app.fetch(
      new Request('http://worker/v1/workflow-sandbox-tests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowVersionId: 'workflow@1' }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid-workflow-sandbox-test' });
  });

  it('reports an execution failure separately from an unreachable worker', async () => {
    const app = createWorkerApp(
      {
        async startWorkflowRun() {
          throw new Error('ordinary intake must remain disabled');
        },
      },
      {
        async execute() {
          throw new Error('tcp connect error');
        },
      },
      false,
    );

    const response = await app.fetch(
      new Request('http://worker/v1/workflow-sandbox-tests', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowVersionId: 'workflow@1' }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'workflow-sandbox-execution-failed',
    });
  });

  it('does not misclassify an execution-time network TypeError as a bad suite', async () => {
    const app = createWorkerApp(
      {
        async startWorkflowRun() {
          throw new Error('unused');
        },
      },
      {
        async execute() {
          throw new TypeError('fetch failed');
        },
      },
    );
    const response = await app.fetch(
      new Request('http://worker/v1/workflow-sandbox-tests', {
        method: 'POST',
        body: '{}',
      }),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'workflow-sandbox-execution-failed' });
  });
});

describe('streamed workflow checks', () => {
  afterEach(() => vi.restoreAllMocks());
  const request = (body = '{}', signal?: AbortSignal) =>
    new Request('http://worker/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { accept: 'application/x-ndjson', 'content-type': 'application/json' },
      body,
      ...(signal ? { signal } : {}),
    });
  const appWith = (execute: WorkflowSandboxRunner['execute']) =>
    createWorkerApp(
      {
        startWorkflowRun: async () => {
          throw new Error('Unused');
        },
      },
      { execute },
      false,
    );
  const decode = (chunk: Uint8Array | undefined) =>
    JSON.parse(new TextDecoder().decode(chunk).trim());

  it('delivers actual progress before execution finishes and then a flat result event', async () => {
    const finish = Promise.withResolvers<void>();
    const progress = { phase: 'preparing', completed: 0, total: 1 } as const;
    const outcomes = [{ testId: 'happy-path', status: 'passed' }];
    const app = appWith(async (_suite, onProgress) => {
      onProgress?.(progress);
      await finish.promise;
      onProgress?.({ phase: 'finalizing', completed: 1, total: 1 });
      return { outcomes };
    });

    const response = await app.fetch(request());
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toEqual({ type: 'progress', progress });
    finish.resolve();
    expect(decode((await reader.read()).value)).toEqual({
      type: 'progress',
      progress: { phase: 'finalizing', completed: 1, total: 1 },
    });
    expect(decode((await reader.read()).value)).toEqual({ type: 'result', outcomes });
    expect((await reader.read()).done).toBe(true);
  });

  it.each([
    [new InvalidWorkflowSandboxRequest(), 'invalid-workflow-sandbox-test'],
    [new Error('private provider payload'), 'workflow-sandbox-execution-failed'],
  ])('closes with a safe terminal error for %s', async (error, code) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = appWith(async (_suite, onProgress) => {
      onProgress?.({ phase: 'preparing', completed: 0, total: 1 });
      throw error;
    });
    const response = await app.fetch(request());
    expect(
      (await response.text())
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { type: 'progress', progress: { phase: 'preparing', completed: 0, total: 1 } },
      { type: 'error', error: code },
    ]);
    expect(log.mock.calls).toEqual(
      error instanceof InvalidWorkflowSandboxRequest
        ? []
        : [['workflow-sandbox-execution-failed', { category: 'runtime-error' }]],
    );
  });

  it('reports malformed JSON without starting the runner', async () => {
    let executed = false;
    const app = appWith(async () => {
      executed = true;
      return { outcomes: [] };
    });
    const response = await app.fetch(request('{'));
    expect(decode(new TextEncoder().encode(await response.text()))).toEqual({
      type: 'error',
      error: 'invalid-workflow-sandbox-test',
    });
    expect(executed).toBe(false);
  });

  it.each(['reader cancel', 'request abort'])(
    'ignores late progress and rejection after %s',
    async (kind) => {
      const release = Promise.withResolvers<void>();
      const runnerFinished = Promise.withResolvers<void>();
      const controller = new AbortController();
      const app = appWith(async (_suite, onProgress) => {
        onProgress?.({ phase: 'preparing', completed: 0, total: 1 });
        try {
          await release.promise;
          onProgress?.({ phase: 'running', completed: 0, total: 1 });
          throw new Error('late private failure');
        } finally {
          runnerFinished.resolve();
        }
      });
      const response = await app.fetch(request('{}', controller.signal));
      const reader = response.body!.getReader();
      expect((await reader.read()).done).toBe(false);
      if (kind === 'reader cancel') await reader.cancel();
      else controller.abort();
      release.resolve();
      await runnerFinished.promise;
      expect(await reader.read()).toEqual({ done: true, value: undefined });
    },
  );
});
