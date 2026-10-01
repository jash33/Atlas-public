import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vite-plus/test';

import { createIngestApp as createApp } from './app.js';
import type {
  ApiRunReadiness,
  BackendClient,
  QueuedApiRun,
  RunCommandStatus,
} from './backend-client.js';
import { fingerprintPayload } from './fingerprint.js';

const finalOutput = { receiptId: 'receipt-5', total: 1234 };
const createIngestApp = (
  options: Omit<Parameters<typeof createApp>[0], 'readWorkflowResult'> &
    Partial<Pick<Parameters<typeof createApp>[0], 'readWorkflowResult'>>,
) =>
  createApp({
    readWorkflowResult: async () => ({ status: 'completed', output: finalOutput }),
    ...options,
  });

const callerToken = 'caller-token';
const publicKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
}).publicKey.toString('base64');

function readyWorkflow(overrides: Partial<ApiRunReadiness> = {}): ApiRunReadiness {
  return {
    workflowId: 'workflow_settle',
    name: 'Settle payment',
    ready: true,
    workflowVersionId: 'settle@1',
    artifactId: 'a'.repeat(64),
    targetWorkerId: 'worker-development',
    runCommandPublicKey: publicKey,
    inputSchema: { required: { orderId: { type: 'string' } } },
    blockers: [],
    ...overrides,
  };
}

function createStubBackend(options?: {
  readiness?:
    | { ok: true; body: ApiRunReadiness }
    | { ok: false; status: number; error: string; body?: unknown };
  queue?:
    | { ok: true; body: QueuedApiRun }
    | { ok: false; status: number; error: string; body?: unknown };
  status?:
    | { ok: true; body: RunCommandStatus }
    | { ok: false; status: number; error: string; body?: unknown };
}) {
  const queueCalls: Array<{
    workflowId: string;
    idempotencyKey: string;
    payloadFingerprint: string;
    encryptedPayload: string;
  }> = [];
  const backend: BackendClient = {
    readWebhookDelivery: async () => ({
      ok: false,
      status: 404,
      error: 'webhook-delivery-not-found',
      body: {},
    }),
    readWebhookRunReadiness: async () => ({ ok: true, status: 200, body: readyWorkflow() }),
    queueWebhookRun: async () => ({
      ok: true,
      status: 202,
      body: { commandId: 'webhook-1', status: 'queued', duplicate: false },
    }),
    readApiRunReadiness: vi.fn<BackendClient['readApiRunReadiness']>(async () => {
      if (options?.readiness?.ok === false) {
        return {
          ok: false as const,
          status: options.readiness.status,
          error: options.readiness.error,
          body: options.readiness.body,
        };
      }
      return {
        ok: true as const,
        status: 200,
        body: options?.readiness?.body ?? readyWorkflow(),
      };
    }),
    queueApiRun: vi.fn<BackendClient['queueApiRun']>(async (input) => {
      queueCalls.push(input);
      if (options?.queue?.ok === false) {
        return {
          ok: false as const,
          status: options.queue.status,
          error: options.queue.error,
          body: options.queue.body,
        };
      }
      return {
        ok: true as const,
        status: 202,
        body: options?.queue?.body ?? {
          commandId: 'command-1',
          status: 'queued',
          duplicate: false,
        },
      };
    }),
    readRunCommandStatus: vi.fn<BackendClient['readRunCommandStatus']>(async () => {
      if (options?.status?.ok === false) {
        return {
          ok: false as const,
          status: options.status.status,
          error: options.status.error,
          body: options.status.body,
        };
      }
      return {
        ok: true as const,
        status: 200,
        body: options?.status?.body ?? {
          commandId: 'command-1',
          status: 'completed',
          error: null,
          workflowRunId: 'run-1',
          intakeStatus: 'accepted',
          errorDetails: null,
          createdAt: '2026-09-04T12:00:00.000Z',
          completedAt: '2026-09-04T12:00:01.000Z',
        },
      };
    }),
  };
  return { backend, queueCalls };
}

describe('ingest gateway routes', () => {
  const trigger = {
    method: 'POST',
    headers: { authorization: `Bearer ${callerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workflowName: 'Settle payment', payload: { orderId: 'order-1' } }),
  };

  it('does not confuse completed command intake with completed workflow execution', async () => {
    const { backend, queueCalls } = createStubBackend();
    const readWorkflowResult = vi
      .fn<Parameters<typeof createApp>[0]['readWorkflowResult']>()
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'completed', output: finalOutput });
    const app = createIngestApp({ callerToken, backend, readWorkflowResult, pollIntervalMs: 1 });
    const response = await app.request('/ingest', trigger);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(finalOutput);
    expect(readWorkflowResult).toHaveBeenCalledTimes(3);
    expect(queueCalls).toHaveLength(1);
  });

  it('returns a failure instead of an earlier step response', async () => {
    const { backend } = createStubBackend();
    const app = createIngestApp({
      callerToken,
      backend,
      readWorkflowResult: async () => ({ status: 'failed', error: 'workflow-execution-failed' }),
    });
    const response = await app.request('/ingest', trigger);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'workflow-execution-failed',
      commandId: 'command-1',
    });
  });

  it('times out without resubmitting and returns the idempotency key for recovery', async () => {
    const { backend, queueCalls } = createStubBackend();
    const app = createIngestApp({
      callerToken,
      backend,
      pollIntervalMs: 1,
      responseTimeoutMs: 10,
      readWorkflowResult: async () => ({ status: 'running' }),
    });
    const response = await app.request('/ingest', trigger);
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: 'workflow-response-timeout',
      commandId: 'command-1',
      idempotencyKey: queueCalls[0]?.idempotencyKey,
    });
    expect(queueCalls).toHaveLength(1);
  });
  it('rejects missing or wrong caller tokens', async () => {
    const { backend } = createStubBackend();
    const app = createIngestApp({ callerToken, backend });

    const missing = await app.request('/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowName: 'Settle payment', payload: { orderId: 'o1' } }),
    });
    expect(missing.status).toBe(401);

    const wrong = await app.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workflowName: 'Settle payment', payload: { orderId: 'o1' } }),
    });
    expect(wrong.status).toBe(401);
  });

  it('waits for a valid workflow and returns only its final output', async () => {
    const { backend, queueCalls } = createStubBackend();
    const app = createIngestApp({ callerToken, backend });
    const payload = { orderId: 'order-100' };

    const response = await app.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowName: 'Settle payment',
        payload,
        idempotencyKey: 'key-100',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(finalOutput);
    expect(response.headers.get('x-atlas-command-id')).toBe('command-1');
    expect(response.headers.get('x-atlas-idempotency-key')).toBe('key-100');
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]?.idempotencyKey).toBe('key-100');
    expect(queueCalls[0]?.payloadFingerprint).toBe(fingerprintPayload(payload));
    expect(queueCalls[0]?.encryptedPayload.startsWith('rsa-aes-gcm:v1:')).toBe(true);
    expect(queueCalls[0]?.encryptedPayload).not.toContain('order-100');
  });

  it('generates an idempotency key when omitted', async () => {
    const { backend, queueCalls } = createStubBackend();
    const app = createIngestApp({ callerToken, backend });

    const response = await app.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowName: 'Settle payment',
        payload: { orderId: 'order-101' },
      }),
    });

    expect(response.status).toBe(200);
    const body = { idempotencyKey: response.headers.get('x-atlas-idempotency-key') };
    expect(body.idempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(queueCalls[0]?.idempotencyKey).toBe(body.idempotencyKey);
  });

  it('returns path-specific 400s for schema violations without queueing', async () => {
    const { backend, queueCalls } = createStubBackend();
    const app = createIngestApp({ callerToken, backend });

    const response = await app.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowName: 'Settle payment',
        payload: { orderId: 12 },
        idempotencyKey: 'bad-payload',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid-ingest-payload',
      issues: [{ path: '$.orderId', message: 'Expected string.' }],
    });
    expect(queueCalls).toHaveLength(0);
  });

  it('maps unknown and ambiguous workflow names', async () => {
    const unknown = createStubBackend({
      readiness: { ok: false, status: 404, error: 'unknown-workflow-name' },
    });
    const unknownApp = createIngestApp({ callerToken, backend: unknown.backend });
    const unknownResponse = await unknownApp.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workflowName: 'Missing', payload: { orderId: 'o1' } }),
    });
    expect(unknownResponse.status).toBe(404);
    await expect(unknownResponse.json()).resolves.toEqual({ error: 'unknown-workflow-name' });

    const ambiguous = createStubBackend({
      readiness: {
        ok: false,
        status: 409,
        error: 'ambiguous-workflow-name',
        body: { error: 'ambiguous-workflow-name', workflowIds: ['a', 'b'] },
      },
    });
    const ambiguousApp = createIngestApp({ callerToken, backend: ambiguous.backend });
    const ambiguousResponse = await ambiguousApp.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ workflowName: 'Dup', payload: { orderId: 'o1' } }),
    });
    expect(ambiguousResponse.status).toBe(409);
    await expect(ambiguousResponse.json()).resolves.toEqual({
      error: 'ambiguous-workflow-name',
      workflowIds: ['a', 'b'],
    });
  });

  it('returns duplicate commands and fingerprint conflicts from the backend', async () => {
    const duplicate = createStubBackend({
      queue: {
        ok: true,
        body: { commandId: 'command-1', status: 'queued', duplicate: true },
      },
    });
    const duplicateApp = createIngestApp({ callerToken, backend: duplicate.backend });
    const duplicateResponse = await duplicateApp.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowName: 'Settle payment',
        payload: { orderId: 'order-100' },
        idempotencyKey: 'key-100',
      }),
    });
    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toEqual(finalOutput);

    const conflict = createStubBackend({
      queue: { ok: false, status: 409, error: 'conflicting-api-delivery' },
    });
    const conflictApp = createIngestApp({ callerToken, backend: conflict.backend });
    const conflictResponse = await conflictApp.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowName: 'Settle payment',
        payload: { orderId: 'other' },
        idempotencyKey: 'key-100',
      }),
    });
    expect(conflictResponse.status).toBe(409);
    await expect(conflictResponse.json()).resolves.toEqual({ error: 'conflicting-api-delivery' });
  });

  it('reports intake unavailability with blockers and backend outages', async () => {
    const unavailable = createStubBackend({
      readiness: {
        ok: true,
        body: readyWorkflow({
          ready: false,
          runCommandPublicKey: null,
          blockers: ['No customer worker is ready to receive encrypted run input.'],
        }),
      },
    });
    const unavailableApp = createIngestApp({ callerToken, backend: unavailable.backend });
    const unavailableResponse = await unavailableApp.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowName: 'Settle payment',
        payload: { orderId: 'order-100' },
      }),
    });
    expect(unavailableResponse.status).toBe(409);
    await expect(unavailableResponse.json()).resolves.toEqual({
      error: 'api-run-unavailable',
      blockers: ['No customer worker is ready to receive encrypted run input.'],
    });

    const down = createStubBackend({
      readiness: { ok: false, status: 503, error: 'backend-unreachable' },
    });
    const downApp = createIngestApp({ callerToken, backend: down.backend });
    const downResponse = await downApp.request('/ingest', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${callerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflowName: 'Settle payment',
        payload: { orderId: 'order-100' },
      }),
    });
    expect(downResponse.status).toBe(503);
    await expect(downResponse.json()).resolves.toEqual({ error: 'backend-unreachable' });
  });

  it('returns run id from the status route after worker acceptance', async () => {
    const { backend } = createStubBackend({
      status: {
        ok: true,
        body: {
          commandId: 'command-1',
          status: 'completed',
          error: null,
          workflowRunId: 'run-42',
          intakeStatus: 'accepted',
          errorDetails: null,
          createdAt: '2026-09-04T12:00:00.000Z',
          completedAt: '2026-09-04T12:00:01.000Z',
        },
      },
    });
    const app = createIngestApp({ callerToken, backend });

    const response = await app.request('/ingest/command-1', {
      headers: { authorization: `Bearer ${callerToken}` },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      commandId: 'command-1',
      status: 'completed',
      intakeStatus: 'accepted',
      workflowRunId: 'run-42',
    });
  });
});
