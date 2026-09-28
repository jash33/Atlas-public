import type { JsonValue } from '@atlas/workflow-ir';
import type { WorkflowSandboxProgressWire } from '@atlas/demo-estate';
import type { RunStartBinding, WorkflowResult } from '@atlas/runtime-ports';
import { timingSafeEqual } from 'node:crypto';
import type { WorkflowRunPayload } from '@atlas/runtime-ports';
import { z } from 'zod';

export type { WorkflowRunPayload } from '@atlas/runtime-ports';

export interface PaymentRunPayload extends WorkflowRunPayload {
  readonly paymentId: string;
}

export interface WorkflowRunStartResult {
  readonly workflowRunId: string;
  readonly status: 'accepted' | 'duplicate' | 'conflict';
}

export interface WorkflowRunStarter {
  startWorkflowRun(
    payload: WorkflowRunPayload,
    binding?: RunStartBinding,
  ): Promise<WorkflowRunStartResult>;
}

export interface WorkflowSandboxRunner {
  execute(
    suite: unknown,
    onProgress?: (progress: WorkflowSandboxProgressWire) => void,
  ): Promise<{ outcomes: unknown[] }>;
}

export class InvalidWorkflowSandboxRequest extends Error {
  constructor() {
    super('Invalid workflow sandbox request');
  }
}

export function createWorkerApp(
  starter: WorkflowRunStarter,
  workflowSandboxRunner?: WorkflowSandboxRunner,
  intakeHttpEnabled = true,
  results?: { readonly token: string; readonly read: (runId: string) => Promise<WorkflowResult> },
) {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') {
        return Response.json({ service: 'worker', status: 'ok' });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/workflow-results/') && results) {
        const supplied = Buffer.from(request.headers.get('authorization') ?? '');
        const expected = Buffer.from(`Bearer ${results.token}`);
        if (
          !results.token.trim() ||
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        try {
          const runId = decodeURIComponent(url.pathname.slice('/v1/workflow-results/'.length));
          if (!runId.startsWith('atlas:run:'))
            return Response.json({ error: 'invalid-run-id' }, { status: 400 });
          return Response.json(await results.read(runId), {
            headers: { 'Cache-Control': 'no-store' },
          });
        } catch {
          return Response.json({ error: 'workflow-result-unavailable' }, { status: 503 });
        }
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/v1/workflow-sandbox-tests' &&
        workflowSandboxRunner
      ) {
        if (
          request.headers
            .get('accept')
            ?.split(',')
            .some((type) => type.split(';')[0]?.trim() === 'application/x-ndjson')
        ) {
          return streamWorkflowSandboxChecks(request, workflowSandboxRunner);
        }
        let suite: unknown;
        try {
          suite = await request.json();
        } catch {
          return Response.json({ error: 'invalid-workflow-sandbox-test' }, { status: 400 });
        }
        try {
          return Response.json(await workflowSandboxRunner.execute(suite));
        } catch (error) {
          if (error instanceof InvalidWorkflowSandboxRequest) {
            return Response.json({ error: 'invalid-workflow-sandbox-test' }, { status: 400 });
          }
          logWorkflowSandboxFailure(error);
          return Response.json({ error: 'workflow-sandbox-execution-failed' }, { status: 500 });
        }
      }
      if (!intakeHttpEnabled) return Response.json({ error: 'not-found' }, { status: 404 });
      if (request.method !== 'POST' || url.pathname !== '/v1/workflows/payment-to-billing/runs') {
        return Response.json({ error: 'not-found' }, { status: 404 });
      }

      const payload = await readPaymentRunPayload(request);
      if (!payload) return Response.json({ error: 'invalid-payment-run' }, { status: 400 });

      const result = await starter.startWorkflowRun(payload);
      if (result.status === 'conflict') {
        return Response.json({ error: 'conflicting-payment-run' }, { status: 409 });
      }
      return Response.json({ workflowRunId: result.workflowRunId }, { status: 202 });
    },
  };
}

function streamWorkflowSandboxChecks(request: Request, runner: WorkflowSandboxRunner): Response {
  const encoder = new TextEncoder();
  let stopped = false;
  let removeAbortListener = () => {};
  const stop = () => {
    stopped = true;
    removeAbortListener();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (stopped) return;
        stop();
        try {
          controller.close();
        } catch {
          // A disconnected reader may have already closed the stream.
        }
      };
      const emit = (event: unknown) => {
        if (stopped || request.signal.aborted) return;
        const chunk = encoder.encode(`${JSON.stringify(event)}\n`);
        try {
          controller.enqueue(chunk);
        } catch {
          stop();
        }
      };
      request.signal.addEventListener('abort', close, { once: true });
      removeAbortListener = () => request.signal.removeEventListener('abort', close);
      if (request.signal.aborted) {
        close();
        return;
      }
      void (async () => {
        try {
          let suite: unknown;
          try {
            suite = await request.json();
          } catch {
            throw new InvalidWorkflowSandboxRequest();
          }
          if (stopped) return;
          const result = await runner.execute(suite, (progress) =>
            emit({ type: 'progress', progress }),
          );
          emit({ type: 'result', outcomes: result.outcomes });
        } catch (error) {
          if (!(error instanceof InvalidWorkflowSandboxRequest)) logWorkflowSandboxFailure(error);
          emit({
            type: 'error',
            error:
              error instanceof InvalidWorkflowSandboxRequest
                ? 'invalid-workflow-sandbox-test'
                : 'workflow-sandbox-execution-failed',
          });
        } finally {
          close();
        }
      })();
    },
    cancel: stop,
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    },
  });
}

function logWorkflowSandboxFailure(error: unknown) {
  // Fixed categories only; provider messages and payloads must not enter logs.
  console.error('workflow-sandbox-execution-failed', {
    category:
      error instanceof TypeError
        ? 'type-error'
        : error instanceof z.ZodError
          ? 'schema-error'
          : 'runtime-error',
  });
}

async function readPaymentRunPayload(request: Request): Promise<PaymentRunPayload | undefined> {
  try {
    const value: unknown = await request.json();
    return parsePaymentRunPayload(value);
  } catch {
    return undefined;
  }
}

export function parsePaymentRunPayload(value: unknown): PaymentRunPayload | undefined {
  const payload = parseWorkflowRunPayload(value);
  if (!payload || typeof payload.paymentId !== 'string' || !payload.paymentId.trim()) {
    return undefined;
  }
  return payload as PaymentRunPayload;
}

export function parseWorkflowRunPayload(value: unknown): WorkflowRunPayload | undefined {
  return isJsonObject(value) ? value : undefined;
}

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}
