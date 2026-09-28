import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Hono } from 'hono';
import { z } from 'zod';
import { validateWorkflowInput, type JsonValue } from '@atlas/workflow-ir';

import { matchesBearerToken } from './auth.js';
import type { BackendClient } from './backend-client.js';
import { encryptRunCommandPayload } from './encrypt.js';
import { fingerprintPayload } from './fingerprint.js';
import type { WorkflowResult } from './workflow-result.js';

const ingestRequestSchema = z
  .object({
    workflowName: z.string().trim().min(1),
    payload: z.record(z.string(), z.json()),
    idempotencyKey: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export interface IngestAppOptions {
  readonly readWorkflowResult: (runId: string, signal: AbortSignal) => Promise<WorkflowResult>;
  readonly responseTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly callerToken: string;
  readonly backend: BackendClient;
}

export function createIngestApp(options: IngestAppOptions): Hono {
  const app = new Hono();
  const timeoutMs = options.responseTimeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1
  ) {
    throw new Error('Response timeout and poll interval must be positive integers');
  }

  app.get('/health', (context) => context.json({ service: 'ingest', status: 'ok' }));

  app.post('/webhooks/:workflowId', async (context) => {
    if (!matchesBearerToken(context.req.header('authorization'), options.callerToken)) {
      return context.json({ error: 'unauthorized' }, 401);
    }
    const deliveryId = z
      .string()
      .trim()
      .min(1)
      .max(255)
      .safeParse(context.req.header('x-delivery-id'));
    if (!deliveryId.success)
      return context.json(
        {
          error: 'delivery-id-required',
          message: 'Supply an X-Delivery-Id header for this event.',
        },
        400,
      );
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: 'invalid-webhook-payload' }, 400);
    }
    const parsed = z.record(z.string(), z.json()).safeParse(body);
    if (!parsed.success) return context.json({ error: 'invalid-webhook-payload' }, 400);
    const workflowId = context.req.param('workflowId');
    const payloadFingerprint = fingerprintPayload(parsed.data);
    const previous = await options.backend.readWebhookDelivery({
      workflowId,
      deliveryId: deliveryId.data,
      payloadFingerprint,
    });
    if (previous.ok) {
      context.header('Cache-Control', 'no-store');
      context.header('X-Atlas-Command-Id', previous.body.commandId);
      return context.json(previous.body, 202);
    }
    if (previous.status !== 404 || previous.error !== 'webhook-delivery-not-found')
      return mapBackendFailure(context, previous, 'queue');
    const readiness = await options.backend.readWebhookRunReadiness(workflowId);
    if (!readiness.ok) return mapBackendFailure(context, readiness, 'readiness');
    const ready = readiness.body;
    if (
      !ready.ready ||
      !ready.runCommandPublicKey ||
      !ready.artifactId ||
      !ready.targetWorkerId ||
      !ready.inputSchema
    ) {
      return context.json(
        {
          error: 'webhook-run-unavailable',
          blockers: ready.blockers.length
            ? ready.blockers
            : ['Activate a checked workflow with an input schema before sending events.'],
        },
        409,
      );
    }
    const issues = validateWorkflowInput(parsed.data, ready.inputSchema);
    if (issues.length) return context.json({ error: 'invalid-webhook-payload', issues }, 400);
    let encryptedPayload: string;
    try {
      encryptedPayload = encryptRunCommandPayload(ready.runCommandPublicKey, parsed.data);
    } catch {
      return context.json(
        {
          error: 'invalid-webhook-payload',
          message: 'Payload could not be encrypted for the worker.',
        },
        400,
      );
    }
    const queued = await options.backend.queueWebhookRun({
      workflowId,
      deliveryId: deliveryId.data,
      encryptedPayload,
      payloadFingerprint,
    });
    if (!queued.ok) return mapBackendFailure(context, queued, 'queue');
    context.header('Cache-Control', 'no-store');
    context.header('X-Atlas-Command-Id', queued.body.commandId);
    return context.json(
      {
        commandId: queued.body.commandId,
        duplicate: queued.body.duplicate,
        status: queued.body.status,
      },
      202,
    );
  });

  app.post('/ingest', async (context) => {
    if (!matchesBearerToken(context.req.header('authorization'), options.callerToken)) {
      return context.json({ error: 'unauthorized' }, 401);
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(
        {
          error: 'invalid-ingest-body',
          issues: [{ path: '$', message: 'Expected JSON object.' }],
        },
        400,
      );
    }

    const parsed = ingestRequestSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          error: 'invalid-ingest-body',
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.length > 0 ? `$.${issue.path.join('.')}` : '$',
            message: issue.message,
          })),
        },
        400,
      );
    }

    const idempotencyKey = parsed.data.idempotencyKey ?? randomUUID();
    const payload = parsed.data.payload as Record<string, JsonValue>;

    const readiness = await options.backend.readApiRunReadiness(parsed.data.workflowName);
    if (!readiness.ok) return mapBackendFailure(context, readiness, 'readiness');

    const ready = readiness.body;
    if (
      !ready.ready ||
      !ready.runCommandPublicKey ||
      !ready.artifactId ||
      !ready.targetWorkerId ||
      !ready.inputSchema
    ) {
      return context.json(
        {
          error: 'api-run-unavailable',
          blockers:
            ready.blockers.length > 0
              ? ready.blockers
              : [
                  ready.inputSchema
                    ? 'Workflow intake is not ready.'
                    : 'The active workflow does not declare an input schema for intake validation.',
                ],
        },
        409,
      );
    }

    const issues = validateWorkflowInput(payload, ready.inputSchema);
    if (issues.length > 0) {
      return context.json({ error: 'invalid-ingest-payload', issues }, 400);
    }

    let encryptedPayload: string;
    let payloadFingerprint: string;
    try {
      encryptedPayload = encryptRunCommandPayload(ready.runCommandPublicKey, payload);
      payloadFingerprint = fingerprintPayload(payload);
    } catch {
      return context.json(
        {
          error: 'invalid-ingest-payload',
          issues: [{ path: '$', message: 'Payload could not be encrypted for the worker.' }],
        },
        400,
      );
    }

    const queued = await options.backend.queueApiRun({
      workflowId: ready.workflowId,
      idempotencyKey,
      payloadFingerprint,
      encryptedPayload,
    });
    if (!queued.ok) return mapBackendFailure(context, queued, 'queue');

    const commandId = queued.body.commandId;
    context.header('X-Atlas-Command-Id', commandId);
    context.header('X-Atlas-Idempotency-Key', idempotencyKey);
    context.header('Cache-Control', 'no-store');
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      while (!signal.aborted) {
        const status = await options.backend.readRunCommandStatus(commandId, signal);
        if (signal.aborted) break;
        if (!status.ok) return mapBackendFailure(context, status, 'status');
        if (status.body.status === 'failed' || status.body.intakeStatus === 'conflict') {
          return context.json(
            { error: status.body.error ?? 'workflow-start-failed', commandId },
            502,
          );
        }
        if (status.body.workflowRunId) {
          const result = await options.readWorkflowResult(status.body.workflowRunId, signal);
          if (result.status === 'completed') return context.json(result.output);
          if (result.status === 'failed')
            return context.json({ error: result.error, commandId }, 502);
        }
        await delay(pollIntervalMs, undefined, { signal });
      }
    } catch {
      if (!signal.aborted)
        return context.json({ error: 'workflow-result-unavailable', commandId }, 503);
    }
    // Timing out this HTTP request does not cancel or resubmit an in-flight workflow.
    return context.json({ error: 'workflow-response-timeout', commandId, idempotencyKey }, 504);
  });

  app.get('/ingest/:commandId', async (context) => {
    if (!matchesBearerToken(context.req.header('authorization'), options.callerToken)) {
      return context.json({ error: 'unauthorized' }, 401);
    }

    const commandId = context.req.param('commandId');
    if (!commandId.trim()) {
      return context.json({ error: 'invalid-command-id' }, 400);
    }

    const status = await options.backend.readRunCommandStatus(commandId);
    if (!status.ok) return mapBackendFailure(context, status, 'status');

    return context.json({
      commandId: status.body.commandId,
      status: status.body.status,
      intakeStatus: status.body.intakeStatus,
      workflowRunId: status.body.workflowRunId,
      error: status.body.error,
      errorDetails: status.body.errorDetails,
      createdAt: status.body.createdAt,
      completedAt: status.body.completedAt,
    });
  });

  return app;
}

function mapBackendFailure(
  context: { json: (body: unknown, status?: number) => Response },
  result: {
    readonly ok: false;
    readonly status: number;
    readonly error: string;
    readonly body?: unknown;
  },
  kind: 'readiness' | 'queue' | 'status',
) {
  if (result.error === 'backend-unreachable' || result.status >= 500) {
    return context.json({ error: 'backend-unreachable' }, 503);
  }
  if (result.status === 403) {
    return context.json({ error: 'backend-unreachable' }, 503);
  }
  if (kind === 'status' && (result.error === 'run-command-not-found' || result.status === 404)) {
    return context.json({ error: 'run-command-not-found' }, 404);
  }
  if (result.error === 'unknown-workflow-name' || (kind === 'readiness' && result.status === 404)) {
    return context.json(
      {
        error:
          result.error === 'unknown-workflow-id' ? 'unknown-workflow-id' : 'unknown-workflow-name',
      },
      404,
    );
  }
  if (result.error === 'ambiguous-workflow-name') {
    return context.json(
      {
        error: 'ambiguous-workflow-name',
        workflowIds: readStringArray(result.body, 'workflowIds'),
      },
      409,
    );
  }
  if (result.error === 'conflicting-api-delivery') {
    return context.json({ error: 'conflicting-api-delivery' }, 409);
  }
  if (result.error === 'api-run-unavailable') {
    return context.json(
      {
        error: 'api-run-unavailable',
        blockers: readStringArray(result.body, 'blockers', ['Workflow intake is not ready.']),
      },
      409,
    );
  }
  if (result.status === 409) {
    return context.json({ error: result.error }, 409);
  }
  if (result.status === 400) {
    return context.json({ error: 'invalid-ingest-body', body: result.body }, 400);
  }
  return context.json({ error: 'backend-unreachable' }, 503);
}

function readStringArray(body: unknown, key: string, fallback: string[] = []): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fallback;
  const value = (body as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return fallback;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : fallback;
}
