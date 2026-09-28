import { describe, expect, it, vi } from 'vite-plus/test';

import {
  createBackendDriftSignalReporter,
  createBackendInterpreterInputFactory,
  createBackendRunCommandProcessor,
  createBackendRunReporter,
  declareBackendEnvironmentWorker,
} from './backend-execution.js';
import type { WorkflowRunStarter } from './app.js';

describe('backend run command processor', () => {
  it('polls outbound, starts the run, and acknowledges the command', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-1',
          encryptedPayload: 'encrypted-payload',
          artifactId: 'a'.repeat(64),
          workflowId: 'scheduled-workflow',
          workflowName: 'Settle payments',
          trigger: {
            type: 'schedule',
            scheduleId: '00000000-0000-4000-8000-000000000068',
            scheduledFor: '2026-08-17T13:00:00.000Z',
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          workflowName: 'Settle payments',
          startedAt: '2026-09-04T14:00:00.000Z',
          endedAt: null,
          inProgress: true,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>().mockResolvedValue({
        workflowRunId: 'run-1',
        status: 'accepted' as const,
      }),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload(encryptedPayload) {
        expect(encryptedPayload).toBe('encrypted-payload');
        return { paymentId: 'pay_1' };
      },
      fetch,
    });

    await expect(processor.processNext()).resolves.toBe(true);
    expect(starter.startWorkflowRun).toHaveBeenCalledWith(
      { paymentId: 'pay_1' },
      {
        artifactId: 'a'.repeat(64),
        runCommandId: 'command-1',
        workflowName: 'Settle payments',
        workflowId: 'scheduled-workflow',
        trigger: {
          type: 'schedule',
          scheduleId: '00000000-0000-4000-8000-000000000068',
          scheduledFor: '2026-08-17T13:00:00.000Z',
        },
      },
    );
    const pollUrl = fetch.mock.calls[0]![0];
    if (!(pollUrl instanceof URL)) throw new Error('Expected the poll request to use a URL');
    expect(pollUrl.searchParams.get('workerId')).toBe('atlas-development/payment');
    expect(fetch).toHaveBeenLastCalledWith(
      new URL('http://atlas.internal/v1/run-commands/command-1'),
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          status: 'completed',
          workflowRunId: 'run-1',
          intakeStatus: 'accepted',
        }),
      }),
    );
  });

  it('reports only a normalized code when startup throws sensitive text', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-sensitive',
          encryptedPayload: 'ciphertext',
          artifactId: 'a'.repeat(64),
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter: {
        async startWorkflowRun() {
          throw new Error('provider echoed sk_live_sensitive and payment pay_secret');
        },
      },
      decryptPayload: () => ({ paymentId: 'pay_secret' }),
      fetch,
    });

    await processor.processNext();
    const acknowledgement = fetch.mock.calls[1]![1]?.body;
    if (typeof acknowledgement !== 'string') {
      throw new Error('Expected a serialized acknowledgement');
    }
    expect(acknowledgement).toContain('run-start-failed');
    expect(acknowledgement).not.toContain('sk_live_sensitive');
    expect(acknowledgement).not.toContain('pay_secret');
  });

  it('starts Temporal for an API command with API trigger provenance', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-api',
          encryptedPayload: 'encrypted-api-payload',
          artifactId: 'b'.repeat(64),
          workflowId: 'workflow_api',
          workflowName: 'API workflow',
          trigger: { type: 'api', deliveryId: 'idempotency-key-1' },
          inputSchema: { required: { orderId: { type: 'string' } } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          workflowName: 'Settle payments',
          startedAt: '2026-09-04T14:00:00.000Z',
          endedAt: null,
          inProgress: true,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>().mockResolvedValue({
        workflowRunId: 'run-api-1',
        status: 'accepted' as const,
      }),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload(encryptedPayload) {
        expect(encryptedPayload).toBe('encrypted-api-payload');
        return { orderId: 'ord_1' };
      },
      fetch,
    });

    await expect(processor.processNext()).resolves.toBe(true);
    expect(starter.startWorkflowRun).toHaveBeenCalledWith(
      { orderId: 'ord_1' },
      {
        artifactId: 'b'.repeat(64),
        runCommandId: 'command-api',
        workflowName: 'API workflow',
        workflowId: 'workflow_api',
        trigger: { type: 'api', deliveryId: 'idempotency-key-1' },
      },
    );
  });

  it('reports a normalized payload error before starting a webhook run', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-invalid-webhook',
          encryptedPayload: 'rsa-oaep:not-valid',
          artifactId: 'a'.repeat(64),
          trigger: { type: 'webhook', deliveryId: 'delivery-invalid' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>(),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload() {
        throw new Error('Encrypted run command has an invalid payload');
      },
      fetch,
    });

    await processor.processNext();

    expect(starter.startWorkflowRun).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenLastCalledWith(
      new URL('http://atlas.internal/v1/run-commands/command-invalid-webhook'),
      expect.objectContaining({
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          status: 'failed',
          error: 'invalid-trigger-payload',
          errorDetails: {
            issues: [{ path: '$', message: 'Payload could not be decrypted and parsed.' }],
          },
        }),
      }),
    );
  });

  it('validates decrypted webhook input against the approved artifact schema before Temporal', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-schema-invalid',
          encryptedPayload: 'encrypted-payload',
          artifactId: 'a'.repeat(64),
          trigger: { type: 'webhook', deliveryId: 'delivery-schema-invalid' },
          inputSchema: {
            required: {
              paymentId: { type: 'string' },
              source: { type: 'string' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>(),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload: () => ({ paymentId: 'pay_1' }),
      fetch,
    });

    await processor.processNext();

    expect(starter.startWorkflowRun).not.toHaveBeenCalled();
    const acknowledgement = fetch.mock.calls[1]![1]?.body;
    if (typeof acknowledgement !== 'string') {
      throw new Error('Expected a serialized acknowledgement');
    }
    expect(JSON.parse(acknowledgement)).toMatchObject({
      error: 'invalid-trigger-payload',
      errorDetails: {
        issues: [{ path: '$.source', message: 'Required value is missing.' }],
      },
    });
  });

  it('reports a missing field from the pinned artifact schema', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-missing-payment-id',
          encryptedPayload: 'encrypted-payload',
          artifactId: 'a'.repeat(64),
          trigger: { type: 'webhook', deliveryId: 'delivery-missing-payment-id' },
          inputSchema: { required: { paymentId: { type: 'string' } } },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>(),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload: () => ({}),
      fetch,
    });

    await processor.processNext();

    expect(starter.startWorkflowRun).not.toHaveBeenCalled();
    const acknowledgement = fetch.mock.calls[1]![1]?.body;
    if (typeof acknowledgement !== 'string') {
      throw new Error('Expected a serialized acknowledgement');
    }
    expect(JSON.parse(acknowledgement)).toMatchObject({
      error: 'invalid-trigger-payload',
      errorDetails: {
        issues: [{ path: '$.paymentId', message: 'Required value is missing.' }],
      },
    });
  });

  it('validates Atlas-injected workflow run identity without requiring it in trigger input', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-injected-run-id',
          encryptedPayload: 'encrypted-payload',
          artifactId: 'a'.repeat(64),
          trigger: { type: 'manual' },
          inputSchema: {
            required: {
              paymentId: { type: 'string' },
              atlasWorkflowRunId: { type: 'string' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          workflowName: 'Settle payments',
          startedAt: '2026-09-04T14:00:00.000Z',
          endedAt: null,
          inProgress: true,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>().mockResolvedValue({
        workflowRunId: 'run_injected',
        status: 'accepted',
      }),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload: () => ({ paymentId: 'payment_demo_001' }),
      fetch,
    });

    await processor.processNext();

    expect(starter.startWorkflowRun).toHaveBeenCalledWith(
      { paymentId: 'payment_demo_001' },
      expect.objectContaining({ runCommandId: 'command-injected-run-id' }),
    );
  });

  it('accepts webhook input solely according to the pinned artifact schema', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-schema-only',
          encryptedPayload: 'encrypted-payload',
          artifactId: 'a'.repeat(64),
          trigger: { type: 'webhook', deliveryId: 'delivery-schema-only' },
          inputSchema: { required: { source: { type: 'string' } } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          workflowName: 'Settle payments',
          startedAt: '2026-09-04T14:00:00.000Z',
          endedAt: null,
          inProgress: true,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>().mockResolvedValue({
        workflowRunId: 'run_schema_only',
        status: 'accepted',
      }),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload: () => ({ source: 'gateway' }),
      fetch,
    });

    await processor.processNext();

    expect(starter.startWorkflowRun).toHaveBeenCalledWith(
      { source: 'gateway' },
      expect.objectContaining({ runCommandId: 'command-schema-only' }),
    );
  });

  it('posts no started lifecycle event when Temporal reports a duplicate start', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-dup',
          encryptedPayload: 'encrypted-payload',
          artifactId: 'a'.repeat(64),
          workflowName: 'Settle payments',
          trigger: { type: 'manual' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>().mockResolvedValue({
        workflowRunId: 'run-dup',
        status: 'duplicate' as const,
      }),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload: () => ({ paymentId: 'pay_dup' }),
      fetch,
    });

    await processor.processNext();

    expect(
      fetch.mock.calls.map(([url]) => {
        if (!(url instanceof URL)) throw new Error('Expected fetch URL instance');
        return url.href;
      }),
    ).toEqual([
      'http://atlas.internal/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=atlas-development%2Fpayment',
      'http://atlas.internal/v1/run-commands/command-dup',
    ]);
    expect(fetch).toHaveBeenLastCalledWith(
      new URL('http://atlas.internal/v1/run-commands/command-dup'),
      expect.objectContaining({
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          status: 'completed',
          workflowRunId: 'run-dup',
          intakeStatus: 'duplicate',
        }),
      }),
    );
  });

  it('passes an empty workflow name to the durable reporter when the command has none', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          commandId: 'command-no-name',
          encryptedPayload: 'encrypted-payload',
          artifactId: 'a'.repeat(64),
          trigger: { type: 'manual' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          workflowName: 'Settle payments',
          startedAt: '2026-09-04T14:00:00.000Z',
          endedAt: null,
          inProgress: true,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const starter = {
      startWorkflowRun: vi.fn<WorkflowRunStarter['startWorkflowRun']>().mockResolvedValue({
        workflowRunId: 'run-no-name',
        status: 'accepted' as const,
      }),
    };
    const processor = createBackendRunCommandProcessor({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      workerId: 'atlas-development/payment',
      starter,
      decryptPayload: () => ({ paymentId: 'pay_no_name' }),
      fetch,
    });

    await processor.processNext();

    expect(starter.startWorkflowRun).toHaveBeenCalledWith(
      { paymentId: 'pay_no_name' },
      expect.objectContaining({ workflowName: '' }),
    );
  });
});

describe('backend drift signal reporter', () => {
  it('turns an interpreter drift signal into an authenticated rediscovery request', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));
    const reporter = createBackendDriftSignalReporter({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'production',
      fetch,
    });

    await reporter.emitDriftSignal({
      capabilityVersionId: 'capability-version-v1',
      stepId: 'read-payment',
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://atlas.internal/v1/capability-rediscovery-requests'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer worker-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          capabilityVersionId: 'capability-version-v1',
          stepId: 'read-payment',
        }),
      }),
    );
  });
});

describe('backend interpreter input', () => {
  it('uses the workflow version selected by the backend for each new run', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON grant request');
      const request = JSON.parse(init.body) as Record<string, unknown>;
      expect(request).toEqual({
        organizationId: 'org_atlas',
        environmentId: 'production',
        runId: 'run_2',
        intakeKey: expect.any(String),
        artifactId: 'c'.repeat(64),
        runCommandId: 'command-2',
        trigger: { type: 'webhook', deliveryId: 'delivery-2' },
      });
      expect(JSON.stringify(request)).not.toContain('pay_2');
      return Response.json({
        artifactId: 'b'.repeat(64),
        grant: {
          organizationId: 'org_atlas',
          environmentId: 'production',
          runId: 'run_2',
          workflowVersionId: 'payment-to-billing@2',
          irHash: 'a'.repeat(64),
          approvedCapabilityVersionIds: ['capability-v2'],
          approvedHostnames: ['providers.internal'],
          signatureAlgorithm: 'Ed25519',
          signature: 'signature',
        },
      });
    });
    const createInput = createBackendInterpreterInputFactory({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'production',
      fetch,
    });

    await expect(
      createInput({ paymentId: 'pay_2' }, 'run_2', {
        artifactId: 'c'.repeat(64),
        runCommandId: 'command-2',
        trigger: { type: 'webhook', deliveryId: 'delivery-2' },
      }),
    ).resolves.toMatchObject({
      artifactId: 'b'.repeat(64),
      workflowVersionId: 'payment-to-billing@2',
      grant: { workflowVersionId: 'payment-to-billing@2' },
    });
  });
});

describe('backend worker declaration', () => {
  it('declares the packaged worker IR range before serving the environment', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));

    await declareBackendEnvironmentWorker({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'production',
      workerId: 'atlas-development/payment',
      runCommandPublicKey: 'worker-public-key',
      fetch,
    });

    expect(fetch).toHaveBeenCalledWith(
      new URL('http://atlas.internal/v1/environment-workers'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          workerId: 'atlas-development/payment',
          runCommandPublicKey: 'worker-public-key',
          supportedIrVersions: { minimum: 2, maximum: 3 },
        }),
      }),
    );
  });
});

describe('run reporting', () => {
  it('retries a failed completion with the original facts and no in-memory tally', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const scope = {
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      fetch,
    };
    const outcome = {
      runId: 'run-complete',
      workflowName: 'Settle payments',
      state: 'completed' as const,
      occurredAt: '2026-09-19T12:00:00.000Z',
      durationMs: 40,
    };
    await expect(createBackendRunReporter(scope).recordRunOutcome(outcome)).rejects.toThrow(
      '(503)',
    );
    // A replacement worker can deliver the saved activity input unchanged.
    await createBackendRunReporter(scope).recordRunOutcome(outcome);
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
    expect(fetch.mock.calls[0]![0]).toEqual(
      new URL('http://atlas.internal/v1/runs/run-complete/completion'),
    );
    const body = fetch.mock.calls[0]![1]?.body;
    if (typeof body !== 'string') throw new Error('Expected a serialized completion body');
    expect(JSON.parse(body)).toEqual({
      organizationId: 'org_atlas',
      environmentId: 'development',
      workflowName: 'Settle payments',
      state: 'completed',
      occurredAt: outcome.occurredAt,
      durationMs: 40,
    });
  });
});
