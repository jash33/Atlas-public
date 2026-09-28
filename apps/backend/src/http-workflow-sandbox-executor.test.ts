import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import type { WorkflowSandboxProgressWire } from '@atlas/demo-estate';
import { describe, expect, it, vi } from 'vite-plus/test';

import { createHttpWorkflowSandboxExecutor } from './http-workflow-sandbox-executor.js';
import {
  WorkflowSandboxTestsUnavailable,
  WorkflowSandboxExecutionFailed,
} from './workflow-sandbox.js';

async function suiteInput() {
  const workflow = await createCompiledWorkflowVersion('sandbox-runner@1', 'org_atlas', {
    irVersion: 1,
    steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
  });
  return {
    organizationId: 'org_atlas',
    environmentId: 'development',
    workflowVersionId: workflow.workflowVersionId,
    irHash: workflow.irHash,
    workflow,
    providerContracts: [],
    tests: [
      {
        testId: 'happy-path',
        kind: 'happy-path' as const,
        stepId: 'done',
        capabilityVersionId: null,
        expectation: 'Complete the workflow',
        requestSample: null,
        expectedResponseSchema: null,
      },
    ],
    targetBindings: [],
  };
}

describe('HTTP workflow sandbox executor', () => {
  const progress = {
    phase: 'running' as const,
    completed: 0,
    total: 1,
    currentTest: { kind: 'happy-path' as const, stepId: 'done' },
  };
  const outcomes = [
    {
      testId: 'happy-path',
      status: 'passed',
      workerVersion: 'test-worker',
      runtimeVersion: 'test-runtime',
      executionMethods: ['static-validation'],
    },
  ];
  const encoder = new TextEncoder();

  it('reports streamed progress before completion and reads split chunks', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
    });
    const onProgress = vi.fn<(progress: WorkflowSandboxProgressWire) => void>();
    const executor = createHttpWorkflowSandboxExecutor(
      'http://worker.example',
      async (_url, init) => {
        expect(new Headers(init?.headers).get('accept')).toBe('application/x-ndjson');
        return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
      },
    );
    let finished = false;
    const result = executor.execute({ ...(await suiteInput()), onProgress }).finally(() => {
      finished = true;
    });
    const first = JSON.stringify({ type: 'progress', progress }) + '\n';
    stream.enqueue(encoder.encode(first.slice(0, 17)));
    stream.enqueue(encoder.encode(first.slice(17)));
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(progress));
    expect(finished).toBe(false);
    stream.enqueue(encoder.encode(JSON.stringify({ type: 'result', outcomes })));
    stream.close();
    await expect(result).resolves.toEqual(outcomes);
  });

  it('accepts the final JSON response from older workers', async () => {
    const executor = createHttpWorkflowSandboxExecutor('http://worker.example', async () =>
      Response.json({ outcomes }),
    );
    const onProgress = vi.fn<(progress: WorkflowSandboxProgressWire) => void>();
    await expect(executor.execute({ ...(await suiteInput()), onProgress })).resolves.toEqual(
      outcomes,
    );
    expect(onProgress).not.toHaveBeenCalled();
  });

  it.each([
    '{invalid-json}\n',
    JSON.stringify({ type: 'progress', progress }) + '\n',
    JSON.stringify({ type: 'progress', progress: { ...progress, total: 9 } }) + '\n',
    JSON.stringify({ type: 'progress', progress: { ...progress, completed: 2 } }) + '\n',
    JSON.stringify({
      type: 'progress',
      progress: { ...progress, currentTest: { kind: 'retry', stepId: 'unknown' } },
    }) + '\n',
    JSON.stringify({ type: 'result', outcomes: [{ testId: 'happy-path' }] }) + '\n',
  ])('rejects incomplete or invalid stream evidence: %s', async (body) => {
    const executor = createHttpWorkflowSandboxExecutor(
      'http://worker.example',
      async () =>
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    await expect(executor.execute(await suiteInput())).rejects.toBeInstanceOf(
      WorkflowSandboxTestsUnavailable,
    );
  });

  it.each([
    ['invalid-workflow-sandbox-test', TypeError],
    ['workflow-sandbox-execution-failed', WorkflowSandboxExecutionFailed],
  ])('preserves the streamed error category %s', async (error, errorClass) => {
    const executor = createHttpWorkflowSandboxExecutor(
      'http://worker.example',
      async () =>
        new Response(JSON.stringify({ type: 'error', error }) + '\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    await expect(executor.execute(await suiteInput())).rejects.toBeInstanceOf(errorClass);
  });

  it('cancels the response reader when checks are cancelled', async () => {
    const controller = new AbortController();
    const cancel = vi.fn<() => void>();
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(encoder.encode(JSON.stringify({ type: 'progress', progress }) + '\n'));
      },
      cancel,
    });
    const onProgress = vi.fn<(progress: WorkflowSandboxProgressWire) => void>();
    const executor = createHttpWorkflowSandboxExecutor(
      'http://worker.example',
      async () =>
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    );
    const result = executor.execute({
      ...(await suiteInput()),
      onProgress,
      signal: controller.signal,
    });
    const outcome = result.catch((error: unknown) => error);
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledOnce());
    controller.abort(new Error('cancelled'));
    await expect(outcome).resolves.toMatchObject({ message: 'cancelled' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('distinguishes a runner execution failure from a connection failure', async () => {
    const executor = createHttpWorkflowSandboxExecutor('http://worker.example', async () =>
      Response.json({ error: 'workflow-sandbox-execution-failed' }, { status: 500 }),
    );
    await expect(executor.execute(await suiteInput())).rejects.toBeInstanceOf(
      WorkflowSandboxExecutionFailed,
    );
  });
  it('treats malformed worker evidence as unavailable, not an invalid caller request', async () => {
    const executor = createHttpWorkflowSandboxExecutor('http://worker.example', async () =>
      Response.json({ outcomes: [{ testId: 'happy-path', status: 'passed' }] }),
    );
    await expect(executor.execute(await suiteInput())).rejects.toBeInstanceOf(
      WorkflowSandboxTestsUnavailable,
    );
  });
  it('treats a down sandbox worker as unavailable tests', async () => {
    const executor = createHttpWorkflowSandboxExecutor('http://worker.example', async () => {
      throw new TypeError('fetch failed');
    });

    await expect(executor.execute(await suiteInput())).rejects.toBeInstanceOf(
      WorkflowSandboxTestsUnavailable,
    );
  });

  it('treats a 503 from the runner as unavailable tests', async () => {
    const executor = createHttpWorkflowSandboxExecutor('http://worker.example', async () =>
      Response.json({ error: 'workflow-sandbox-tests-unavailable' }, { status: 503 }),
    );

    await expect(executor.execute(await suiteInput())).rejects.toBeInstanceOf(
      WorkflowSandboxTestsUnavailable,
    );
  });

  it('keeps a rejected suite as a type error so the API can return 400', async () => {
    const executor = createHttpWorkflowSandboxExecutor('http://worker.example', async () =>
      Response.json({ error: 'invalid-workflow-sandbox-test' }, { status: 400 }),
    );

    await expect(executor.execute(await suiteInput())).rejects.toBeInstanceOf(TypeError);
  });

  it('passes cancellation to the sandbox worker request', async () => {
    const controller = new AbortController();
    const executor = createHttpWorkflowSandboxExecutor(
      'http://worker.example',
      async (_url, options) => {
        expect(options?.signal).toBe(controller.signal);
        throw controller.signal.reason;
      },
    );
    controller.abort(new Error('cancelled'));

    await expect(
      executor.execute({ ...(await suiteInput()), signal: controller.signal }),
    ).rejects.toThrow('cancelled');
  });
});
