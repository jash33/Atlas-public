import {
  objectSchemaSchema,
  type ObjectSchema,
  type CanonicalEnvironmentId,
} from '@atlas/workflow-ir';

export interface ApiRunReadiness {
  readonly workflowId: string;
  readonly name: string;
  readonly ready: boolean;
  readonly workflowVersionId: string | null;
  readonly artifactId: string | null;
  readonly targetWorkerId: string | null;
  readonly runCommandPublicKey: string | null;
  readonly inputSchema: ObjectSchema | null;
  readonly blockers: readonly string[];
}

export interface QueuedApiRun {
  readonly commandId: string;
  readonly status: string;
  readonly duplicate: boolean;
}

export interface RunCommandStatus {
  readonly commandId: string;
  readonly status: 'queued' | 'dispatched' | 'completed' | 'failed';
  readonly error: string | null;
  readonly workflowRunId: string | null;
  readonly intakeStatus: 'accepted' | 'duplicate' | 'conflict' | null;
  readonly errorDetails: unknown;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export type BackendClientResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly body: unknown;
    }
  | { readonly ok: false; readonly status: 503; readonly error: 'backend-unreachable' };

export interface BackendClient {
  readWebhookDelivery(input: {
    readonly workflowId: string;
    readonly deliveryId: string;
    readonly payloadFingerprint: string;
  }): Promise<BackendClientResult<QueuedApiRun>>;
  readWebhookRunReadiness(workflowId: string): Promise<BackendClientResult<ApiRunReadiness>>;
  queueWebhookRun(input: {
    readonly workflowId: string;
    readonly deliveryId: string;
    readonly payloadFingerprint: string;
    readonly encryptedPayload: string;
  }): Promise<BackendClientResult<QueuedApiRun>>;
  readApiRunReadiness(workflowName: string): Promise<BackendClientResult<ApiRunReadiness>>;
  queueApiRun(input: {
    readonly workflowId: string;
    readonly idempotencyKey: string;
    readonly payloadFingerprint: string;
    readonly encryptedPayload: string;
  }): Promise<BackendClientResult<QueuedApiRun>>;
  readRunCommandStatus(
    commandId: string,
    signal?: AbortSignal,
  ): Promise<BackendClientResult<RunCommandStatus>>;
}

export function createBackendClient(options: {
  readonly backendUrl: string;
  readonly backendToken: string;
  readonly organizationId: string;
  readonly environmentId: CanonicalEnvironmentId;
  readonly fetch?: typeof fetch;
}): BackendClient {
  const fetchImpl = options.fetch ?? fetch;
  const authorization = `Bearer ${options.backendToken}`;

  return {
    async readWebhookDelivery(input) {
      const query = new URLSearchParams({
        organizationId: options.organizationId,
        environmentId: options.environmentId,
        workflowId: input.workflowId,
        payloadFingerprint: input.payloadFingerprint,
      });
      const result = await requestJson(
        fetchImpl,
        `${options.backendUrl}/v1/webhook-runs/deliveries/${encodeURIComponent(input.deliveryId)}?${query}`,
        { headers: { authorization } },
      );
      if (!result.ok) return result;
      const body = result.body;
      if (
        !body ||
        typeof body !== 'object' ||
        !('commandId' in body) ||
        typeof body.commandId !== 'string' ||
        !('status' in body) ||
        typeof body.status !== 'string'
      )
        return { ok: false, status: 503, error: 'backend-unreachable' };
      return {
        ok: true,
        status: result.status,
        body: { commandId: body.commandId, status: body.status, duplicate: true },
      };
    },
    async readWebhookRunReadiness(workflowId) {
      const query = new URLSearchParams({
        organizationId: options.organizationId,
        environmentId: options.environmentId,
        workflowId,
      });
      const result = await requestJson(
        fetchImpl,
        `${options.backendUrl}/v1/webhook-run-readiness?${query}`,
        { headers: { authorization } },
      );
      if (!result.ok) return result;
      return { ok: true, status: result.status, body: parseApiRunReadiness(result.body) };
    },
    async queueWebhookRun(input) {
      const result = await requestJson(fetchImpl, `${options.backendUrl}/v1/webhook-runs`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: options.organizationId,
          environmentId: options.environmentId,
          ...input,
        }),
      });
      if (!result.ok) return result;
      const body = result.body;
      if (
        !body ||
        typeof body !== 'object' ||
        !('commandId' in body) ||
        typeof body.commandId !== 'string' ||
        !('duplicate' in body) ||
        typeof body.duplicate !== 'boolean'
      ) {
        return { ok: false, status: 503, error: 'backend-unreachable' };
      }
      return {
        ok: true,
        status: result.status,
        body: {
          commandId: body.commandId,
          duplicate: body.duplicate,
          status: 'status' in body && typeof body.status === 'string' ? body.status : 'queued',
        },
      };
    },
    async readApiRunReadiness(workflowName) {
      const query = new URLSearchParams({
        organizationId: options.organizationId,
        environmentId: options.environmentId,
        workflowName,
      });
      const result = await requestJson(
        fetchImpl,
        `${options.backendUrl}/v1/api-run-readiness?${query}`,
        { headers: { authorization } },
      );
      if (!result.ok) return result;
      return { ok: true, status: result.status, body: parseApiRunReadiness(result.body) };
    },

    async queueApiRun(input) {
      const result = await requestJson(fetchImpl, `${options.backendUrl}/v1/api-runs`, {
        method: 'POST',
        headers: {
          authorization,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          organizationId: options.organizationId,
          environmentId: options.environmentId,
          workflowId: input.workflowId,
          idempotencyKey: input.idempotencyKey,
          payloadFingerprint: input.payloadFingerprint,
          encryptedPayload: input.encryptedPayload,
        }),
      });
      if (!result.ok) return result;
      const body = result.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        typeof (body as { commandId?: unknown }).commandId !== 'string' ||
        typeof (body as { duplicate?: unknown }).duplicate !== 'boolean'
      ) {
        return {
          ok: false,
          status: 503,
          error: 'backend-unreachable',
        };
      }
      const record = body as {
        commandId: string;
        duplicate: boolean;
        status?: unknown;
      };
      return {
        ok: true,
        status: result.status,
        body: {
          commandId: record.commandId,
          status: typeof record.status === 'string' ? record.status : 'queued',
          duplicate: record.duplicate,
        },
      };
    },

    async readRunCommandStatus(commandId, signal) {
      const query = new URLSearchParams({
        organizationId: options.organizationId,
        environmentId: options.environmentId,
      });
      const result = await requestJson(
        fetchImpl,
        `${options.backendUrl}/v1/run-command-status/${encodeURIComponent(commandId)}?${query}`,
        { headers: { authorization }, ...(signal ? { signal } : {}) },
      );
      if (!result.ok) return result;
      return {
        ok: true,
        status: result.status,
        body: parseRunCommandStatus(result.body, commandId),
      };
    },
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly body: unknown;
    }
  | { readonly ok: false; readonly status: 503; readonly error: 'backend-unreachable' }
> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 503, error: 'backend-unreachable' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error =
      body &&
      typeof body === 'object' &&
      !Array.isArray(body) &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : 'backend-error';
    return { ok: false, status: response.status, error, body };
  }
  return { ok: true, status: response.status, body };
}

function parseApiRunReadiness(value: unknown): ApiRunReadiness {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid api-run-readiness response');
  }
  const record = value as Record<string, unknown>;
  const inputSchema =
    record.inputSchema === null || record.inputSchema === undefined
      ? null
      : objectSchemaSchema.parse(record.inputSchema);
  return {
    workflowId: String(record.workflowId),
    name: String(record.name),
    ready: Boolean(record.ready),
    workflowVersionId:
      typeof record.workflowVersionId === 'string' ? record.workflowVersionId : null,
    artifactId: typeof record.artifactId === 'string' ? record.artifactId : null,
    targetWorkerId: typeof record.targetWorkerId === 'string' ? record.targetWorkerId : null,
    runCommandPublicKey:
      typeof record.runCommandPublicKey === 'string' ? record.runCommandPublicKey : null,
    inputSchema,
    blockers: Array.isArray(record.blockers)
      ? record.blockers.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function parseRunCommandStatus(value: unknown, commandId: string): RunCommandStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid run-command-status response');
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (
    status !== 'queued' &&
    status !== 'dispatched' &&
    status !== 'completed' &&
    status !== 'failed'
  ) {
    throw new Error('Invalid run-command-status response');
  }
  const intakeStatus = record.intakeStatus;
  return {
    commandId: typeof record.commandId === 'string' ? record.commandId : commandId,
    status,
    error: typeof record.error === 'string' ? record.error : null,
    workflowRunId: typeof record.workflowRunId === 'string' ? record.workflowRunId : null,
    intakeStatus:
      intakeStatus === 'accepted' || intakeStatus === 'duplicate' || intakeStatus === 'conflict'
        ? intakeStatus
        : null,
    errorDetails: record.errorDetails ?? null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    completedAt: typeof record.completedAt === 'string' ? record.completedAt : null,
  };
}
