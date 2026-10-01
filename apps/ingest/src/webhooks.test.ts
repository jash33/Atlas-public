import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vite-plus/test';

import { createIngestApp } from './app.js';
import { createBackendClient } from './backend-client.js';
import { fingerprintPayload } from './fingerprint.js';
import type { WorkflowResult } from './workflow-result.js';

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

const publicKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
}).publicKey.toString('base64');

function setup(options: { ready?: boolean; queueStatus?: number; duplicate?: boolean } = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    if (requestUrl(url).includes('/webhook-runs/deliveries/')) {
      if (options.duplicate)
        return Response.json({ commandId: 'command-1', status: 'queued', duplicate: true });
      if (options.queueStatus === 409)
        return Response.json({ error: 'conflicting-webhook-delivery' }, { status: 409 });
      return Response.json({ error: 'webhook-delivery-not-found' }, { status: 404 });
    }
    if (requestUrl(url).includes('webhook-run-readiness')) {
      return Response.json({
        workflowId: 'orders',
        name: 'Process orders',
        ready: options.ready ?? true,
        workflowVersionId: 'orders@1',
        artifactId: 'a'.repeat(64),
        targetWorkerId: 'worker-dev',
        runCommandPublicKey: publicKey,
        inputSchema: { required: { orderId: { type: 'string' } } },
        blockers: options.ready === false ? ['Workflow is not active.'] : [],
      });
    }
    return options.queueStatus === 409
      ? Response.json({ error: 'conflicting-webhook-delivery' }, { status: 409 })
      : Response.json(
          { commandId: 'command-1', status: 'queued', duplicate: options.duplicate ?? false },
          { status: 202 },
        );
  });
  const readWorkflowResult = vi.fn<() => Promise<WorkflowResult>>();
  const backend = createBackendClient({
    backendUrl: 'https://backend.test',
    backendToken: 'backend-test',
    organizationId: 'org-1',
    environmentId: 'development',
    fetch,
  });
  return {
    fetch,
    readWorkflowResult,
    app: createIngestApp({ callerToken: 'caller-test', backend, readWorkflowResult }),
  };
}

function request(payload: unknown = { orderId: 'order-1' }, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: {
      authorization: 'Bearer caller-test',
      'content-type': 'application/json',
      'x-delivery-id': 'event-1',
      ...headers,
    },
    body: JSON.stringify(payload),
  };
}

describe('workflow webhook gateway', () => {
  it('validates and encrypts the payload, then acknowledges without waiting for the run', async () => {
    const { app, fetch, readWorkflowResult } = setup();
    const response = await app.request('/webhooks/orders', request());
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      commandId: 'command-1',
      duplicate: false,
      status: 'queued',
    });
    expect(readWorkflowResult).not.toHaveBeenCalled();
    expect(requestUrl(fetch.mock.calls[0]![0])).toContain('workflowId=orders');
    const queuedBody = fetch.mock.calls[2]?.[1]?.body;
    if (typeof queuedBody !== 'string') throw new Error('Expected queued webhook request');
    expect(JSON.parse(queuedBody)).toMatchObject({
      organizationId: 'org-1',
      environmentId: 'development',
      workflowId: 'orders',
      deliveryId: 'event-1',
      payloadFingerprint: fingerprintPayload({ orderId: 'order-1' }),
      encryptedPayload: expect.stringMatching(/^rsa-aes-gcm:v1:/),
    });
    expect(queuedBody).not.toContain('order-1');
  });

  it('rejects unauthorized callers before reading or queueing a workflow', async () => {
    const { app, fetch } = setup();
    expect(
      (await app.request('/webhooks/orders', request({}, { authorization: 'Bearer wrong' })))
        .status,
    ).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires a delivery ID and rejects invalid inputs without queueing', async () => {
    const { app, fetch } = setup();
    expect(
      (await app.request('/webhooks/orders', request({}, { 'x-delivery-id': '' }))).status,
    ).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect((await app.request('/webhooks/orders', request({ orderId: 1 }))).status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not start inactive workflows', async () => {
    const { app, fetch } = setup({ ready: false });
    expect((await app.request('/webhooks/orders', request())).status).toBe(409);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns duplicate and conflicting-delivery results without starting another run', async () => {
    const duplicate = setup({ duplicate: true, ready: false });
    expect(await (await duplicate.app.request('/webhooks/orders', request())).json()).toMatchObject(
      { duplicate: true, commandId: 'command-1' },
    );
    expect(duplicate.fetch).toHaveBeenCalledTimes(1);
    const conflict = setup({ queueStatus: 409 });
    const response = await conflict.app.request('/webhooks/orders', request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'conflicting-webhook-delivery' });
  });
});
