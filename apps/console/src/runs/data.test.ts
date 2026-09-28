import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  loadApiRunReadiness,
  loadRunDetail,
  loadRuns,
  queueRunRepair,
  repairProviderCondition,
  startApiRun,
} from './data.js';
import type { ApiRunReadiness } from './RunLauncher.js';

afterEach(() => vi.unstubAllGlobals());

describe('Runs API client', () => {
  it('loads server-owned readiness for the documented workflow identity', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        workflowId: 'invoice-drift-demo',
        name: 'Invoice drift demo workflow',
        ready: true,
        workflowVersionId: 'invoice-drift-demo@1',
        artifactId: 'a'.repeat(64),
        targetWorkerId: 'atlas-production/atlas-production',
        runCommandPublicKey: 'public-key',
        inputSchema: { required: { paymentId: { type: 'string' } } },
        blockers: [],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const readiness = await loadApiRunReadiness(
      {
        organizationId: 'org_atlas',
        environmentId: 'production',
        bearerToken: 'admin-token',
        workflowName: 'Invoice drift demo workflow',
      },
      new AbortController().signal,
    );

    expect(readiness).toMatchObject({
      ready: true,
      workflowId: 'invoice-drift-demo',
      workflowVersionId: 'invoice-drift-demo@1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/v1/api-run-readiness?organizationId=org_atlas&environmentId=production&workflowName=Invoice+drift+demo+workflow',
      ),
      expect.objectContaining({
        headers: { authorization: 'Bearer admin-token' },
      }),
    );
  });

  it('starts the ready workflow identity with encrypted, idempotent input', async () => {
    const keys = (await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        hash: 'SHA-256',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
      },
      true,
      ['encrypt', 'decrypt'],
    )) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey));
    let publicKeyBinary = '';
    for (const byte of publicKey) publicKeyBinary += String.fromCharCode(byte);
    const readiness: ApiRunReadiness = {
      workflowId: 'invoice-drift-demo',
      name: 'Invoice drift demo workflow',
      ready: true,
      workflowVersionId: 'invoice-drift-demo@1',
      artifactId: 'a'.repeat(64),
      targetWorkerId: 'atlas-production/atlas-production',
      runCommandPublicKey: btoa(publicKeyBinary),
      inputSchema: { required: { paymentId: { type: 'string' } } },
      blockers: [],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ commandId: 'command-183', status: 'queued', duplicate: false }),
      )
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-183',
          status: 'completed',
          error: null,
          workflowRunId: 'atlas:run:183',
          intakeStatus: 'accepted',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await startApiRun(
      {
        organizationId: 'org_atlas',
        environmentId: 'production',
        bearerToken: 'admin-token',
      },
      readiness,
      'payment_demo_001',
      async () => undefined,
    );

    expect(result.workflowRunId).toBe('atlas:run:183');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:4000/v1/api-runs');
    const requestBody = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== 'string') throw new Error('Expected serialized API run input');
    const request = JSON.parse(requestBody) as {
      workflowId: string;
      idempotencyKey: string;
      payloadFingerprint: string;
      encryptedPayload: string;
    };
    expect(request).toMatchObject({
      workflowId: 'invoice-drift-demo',
      idempotencyKey: 'console:d7b64b15366e37a159e34dfa84f833c3b6fbf4aa9a14c82a80d9f547c0ba000e',
      payloadFingerprint: '5043a12ce12f3acaefcd40efc004f27dfea74bcec35da362d0e6366e821e7e4d',
    });
    expect(request.encryptedPayload).not.toContain('payment_demo_001');
    const ciphertext = Uint8Array.from(
      atob(request.encryptedPayload.replace('rsa-oaep:', '')),
      (character) => character.charCodeAt(0),
    );
    const plaintext = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      keys.privateKey,
      ciphertext,
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      paymentId: 'payment_demo_001',
    });
  });

  it('loads every run state within the selected environment', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async (input) => {
        const url = new URL(input);
        const state = url.searchParams.get('state')!;
        return Response.json({
          runs: [
            {
              runId: `run_${state}`,
              workflowVersionId: 'payment@1',
              intakeReference: `ref_${state}`,
              state,
              startedAt: '2026-08-15T10:00:00.000Z',
              updatedAt: '2026-08-15T10:00:01.000Z',
              lifecycle: null,
            },
          ],
        });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadRuns('org_atlas', 'production', new AbortController().signal);

    expect(result).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'organizationId=org_atlas&environmentId=production&state=repair_required',
        ),
        expect.stringContaining('state=completed'),
      ]),
    );
  });

  it('loads the selected execution timeline in the current environment', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ runId: 'run/51' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await loadRunDetail('org_atlas', 'development', 'run/51', new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/v1/runs/run%2F51?organizationId=org_atlas&environmentId=development',
      ),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('sends bounded repair actions with the selected role token and typed reason', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ repairId: 'repair_51' }, { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await queueRunRepair({
      organizationId: 'org_atlas',
      environmentId: 'production',
      runId: 'run_51',
      bearerToken: 'operator-token',
      action: 'abandon_run',
      reason: 'Downstream account permanently retired',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/runs/run_51/repairs'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer operator-token' }),
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          action: 'abandon_run',
          reason: 'Downstream account permanently retired',
        }),
      }),
    );
  });

  it('repairs only the pinned capability version before retry is queued', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await repairProviderCondition({
      organizationId: 'org_atlas',
      environmentId: 'production',
      runId: 'run_51',
      bearerToken: 'operator-token',
      repairedCapabilityVersionId: 'events.invoice-paid@v1',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/runs/run_51/provider-condition-repair'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          repairedCapabilityVersionId: 'events.invoice-paid@v1',
        }),
      }),
    );
  });
});
