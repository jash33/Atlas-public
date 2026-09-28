import { useRemote } from '../home/data.js';
import { requestJson } from '../shell/api.js';
import type { ApiRunReadiness } from './RunLauncher.js';
import type { WorkflowRunDetail, WorkflowRunSummary } from './runs.js';

const runStates = [
  'running',
  'completed',
  'validation_failed',
  'manual_review',
  'repair_required',
] as const;

function describeRunFailure(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    if ('blockers' in body && Array.isArray(body.blockers) && body.blockers[0]) {
      return String(body.blockers[0]);
    }
    if ('issues' in body && Array.isArray(body.issues) && body.issues[0]) {
      const issue = body.issues[0] as { path?: unknown; message?: unknown };
      return [issue.path, issue.message].filter(Boolean).join(': ');
    }
    if ('message' in body) return String((body as { message: unknown }).message);
    if ('error' in body) return String((body as { error: unknown }).error).replaceAll('-', ' ');
  }
  return `Request failed (${status})`;
}

export async function loadRuns(
  organizationId: string,
  environmentId: string,
  signal: AbortSignal,
): Promise<WorkflowRunSummary[]> {
  const responses = await Promise.all(
    runStates.map(async (state) => {
      const query = new URLSearchParams({ organizationId, environmentId, state });
      const body = await requestJson<{ runs: WorkflowRunSummary[] }>(
        `/v1/runs?${query}`,
        { signal },
        describeRunFailure,
      );
      return body.runs;
    }),
  );
  return responses.flat();
}

export function useRuns(organizationId: string, environmentId: string) {
  return useRemote(
    [environmentId, organizationId],
    (signal: AbortSignal) => loadRuns(organizationId, environmentId, signal),
    { refreshIntervalMs: 5_000 },
  );
}

export function loadRunDetail(
  organizationId: string,
  environmentId: string,
  runId: string,
  signal: AbortSignal,
): Promise<WorkflowRunDetail> {
  const query = new URLSearchParams({ organizationId, environmentId });
  return requestJson<WorkflowRunDetail>(
    `/v1/runs/${encodeURIComponent(runId)}?${query}`,
    { signal },
    describeRunFailure,
  );
}

export function useRunDetail(
  organizationId: string,
  environmentId: string,
  runId: string | undefined,
) {
  return useRemote(
    [environmentId, organizationId, runId],
    (signal: AbortSignal) =>
      runId
        ? loadRunDetail(organizationId, environmentId, runId, signal)
        : Promise.reject(new Error('Select a run to inspect its execution timeline.')),
    { refreshIntervalMs: 5_000 },
  );
}

interface ApiRunScope {
  organizationId: string;
  environmentId: string;
  bearerToken: string;
}

export function loadApiRunReadiness(
  scope: ApiRunScope & { workflowName: string },
  signal?: AbortSignal,
): Promise<ApiRunReadiness> {
  const query = new URLSearchParams({
    organizationId: scope.organizationId,
    environmentId: scope.environmentId,
    workflowName: scope.workflowName,
  });
  return requestJson<ApiRunReadiness>(
    `/v1/api-run-readiness?${query}`,
    {
      ...(signal ? { signal } : {}),
      headers: { authorization: `Bearer ${scope.bearerToken}` },
    },
    describeRunFailure,
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function encryptApiRunInput(publicKey: string, plaintext: string): Promise<string> {
  const binary = atob(publicKey);
  const keyBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'spki',
    keyBytes,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const encrypted = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    key,
    new TextEncoder().encode(plaintext),
  );
  let encoded = '';
  for (const byte of new Uint8Array(encrypted)) encoded += String.fromCharCode(byte);
  return `rsa-oaep:${btoa(encoded)}`;
}

interface RunCommandStatus {
  commandId: string;
  status: 'queued' | 'dispatched' | 'completed' | 'failed';
  error: string | null;
  errorDetails?: { issues?: Array<{ path?: string; message?: string }> } | null;
  workflowRunId: string | null;
  intakeStatus: 'accepted' | 'duplicate' | 'conflict' | null;
}

function describeCommandFailure(command: RunCommandStatus): string {
  const issue = command.errorDetails?.issues?.[0];
  if (issue) return [issue.path, issue.message].filter(Boolean).join(': ');
  return command.error?.replaceAll('-', ' ') ?? 'Run could not be started.';
}

export async function startApiRun(
  scope: ApiRunScope,
  readiness: ApiRunReadiness,
  paymentId: string,
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 500)),
): Promise<RunCommandStatus> {
  if (!readiness.ready || !readiness.runCommandPublicKey || !readiness.workflowVersionId) {
    throw new Error(readiness.blockers[0] ?? 'The selected workflow is not ready to run.');
  }
  const normalizedPaymentId = paymentId.trim();
  if (!normalizedPaymentId) throw new Error('Enter a payment ID before starting the run.');

  const plaintext = JSON.stringify({ paymentId: normalizedPaymentId });
  const [payloadFingerprint, idempotencyFingerprint, encryptedPayload] = await Promise.all([
    sha256Hex(plaintext),
    sha256Hex(`${readiness.workflowId}\0${plaintext}`),
    encryptApiRunInput(readiness.runCommandPublicKey, plaintext),
  ]);
  const queued = await requestJson<{ commandId: string }>(
    '/v1/api-runs',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${scope.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: scope.organizationId,
        environmentId: scope.environmentId,
        workflowId: readiness.workflowId,
        idempotencyKey: `console:${idempotencyFingerprint}`,
        payloadFingerprint,
        encryptedPayload,
      }),
    },
    describeRunFailure,
  );

  const query = new URLSearchParams({
    organizationId: scope.organizationId,
    environmentId: scope.environmentId,
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const command = await requestJson<RunCommandStatus>(
      `/v1/run-command-status/${encodeURIComponent(queued.commandId)}?${query}`,
      { headers: { authorization: `Bearer ${scope.bearerToken}` } },
      describeRunFailure,
    );
    if (command.status === 'completed') {
      if (!command.workflowRunId) {
        throw new Error('The customer worker completed intake without returning a run identity.');
      }
      return command;
    }
    if (command.status === 'failed') throw new Error(describeCommandFailure(command));
    await pause();
  }
  throw new Error('The customer worker did not accept the run in time.');
}

type RepairScope = {
  organizationId: string;
  environmentId: string;
  runId: string;
  bearerToken: string;
};

export type RunRepairRequest = RepairScope &
  (
    | { action: 'retry_step'; stepId: string; repairedCapabilityVersionId: string }
    | { action: 'resume_run' }
    | { action: 'cancel_run' }
    | { action: 'abandon_run'; reason: string }
  );

export async function queueRunRepair(input: RunRepairRequest): Promise<{ repairId: string }> {
  const { bearerToken, runId, ...body } = input;
  return requestJson<{ repairId: string }>(
    `/v1/runs/${encodeURIComponent(runId)}/repairs`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    describeRunFailure,
  );
}

export async function repairProviderCondition(input: {
  organizationId: string;
  environmentId: string;
  runId: string;
  bearerToken: string;
  repairedCapabilityVersionId: string;
}): Promise<void> {
  const { bearerToken, runId, ...body } = input;
  await requestJson<void>(
    `/v1/runs/${encodeURIComponent(runId)}/provider-condition-repair`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    describeRunFailure,
  );
}
