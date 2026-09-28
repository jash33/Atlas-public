import { executionGrantSchema } from '@atlas/execution-grant';
import {
  deriveStableId,
  responseSchemaSchema as objectSchemaSchema,
  validateWorkflowInput,
  type ObjectSchema,
  type WorkflowInputValidationIssue,
} from '@atlas/workflow-ir';
import type { DriftSignal, RunStartBinding, RunTriggerProvenance } from '@atlas/runtime-ports';
import {
  type createRunRepairExecutor,
  type RunReporter,
  type StepAttempt,
} from '@atlas/temporal-adapter';

import {
  parseWorkflowRunPayload,
  type WorkflowRunStarter,
  type WorkflowRunPayload,
} from './app.js';

export interface BackendExecutionScope {
  readonly backendUrl: string;
  readonly workerToken: string;
  readonly organizationId: string;
  readonly environmentId: string;
}

export async function declareBackendEnvironmentWorker(
  options: BackendExecutionScope & {
    readonly workerId: string;
    readonly runCommandPublicKey: string;
    readonly fetch?: typeof globalThis.fetch;
  },
) {
  await sendBackendJson(
    options,
    options.fetch ?? globalThis.fetch,
    '/v1/environment-workers',
    'POST',
    {
      organizationId: options.organizationId,
      environmentId: options.environmentId,
      workerId: options.workerId,
      runCommandPublicKey: options.runCommandPublicKey,
      supportedIrVersions: { minimum: 2, maximum: 3 },
    },
    'Environment worker declaration failed',
  );
}

async function sendBackendJson(
  options: BackendExecutionScope,
  fetchImplementation: typeof globalThis.fetch,
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  failureMessage: string,
) {
  const response = await fetchImplementation(new URL(path, options.backendUrl), {
    method,
    headers: {
      authorization: `Bearer ${options.workerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${failureMessage} (${response.status})`);
  return response;
}

export function createBackendDriftSignalReporter(
  options: BackendExecutionScope & { readonly fetch?: typeof globalThis.fetch },
) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    async emitDriftSignal(signal: DriftSignal) {
      await sendBackendJson(
        options,
        fetchImplementation,
        '/v1/capability-rediscovery-requests',
        'POST',
        {
          organizationId: options.organizationId,
          environmentId: options.environmentId,
          capabilityVersionId: signal.capabilityVersionId,
          stepId: signal.stepId,
        },
        'Capability rediscovery request failed',
      );
    },
  };
}

// Temporal owns delivery and retries. This reporter holds no per-run state.
export function createBackendRunReporter(
  options: BackendExecutionScope & { readonly fetch?: typeof globalThis.fetch },
): RunReporter & { recordStepAttempt(input: StepAttempt): Promise<void> } {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    async recordRunStarted({ runId, ...input }) {
      await sendBackendJson(
        options,
        fetchImplementation,
        `/v1/runs/${encodeURIComponent(runId)}/lifecycle`,
        'POST',
        {
          organizationId: options.organizationId,
          environmentId: options.environmentId,
          event: 'started',
          ...input,
        },
        'Run lifecycle started reporting failed',
      );
    },
    async recordRunOutcome({ runId, ...input }) {
      await sendBackendJson(
        options,
        fetchImplementation,
        `/v1/runs/${encodeURIComponent(runId)}/completion`,
        'POST',
        {
          organizationId: options.organizationId,
          environmentId: options.environmentId,
          ...input,
        },
        'Run completion reporting failed',
      );
    },
    async recordStepAttempt({ runId, ...input }) {
      await sendBackendJson(
        options,
        fetchImplementation,
        `/v1/runs/${encodeURIComponent(runId)}/attempts`,
        'POST',
        {
          organizationId: options.organizationId,
          environmentId: options.environmentId,
          ...input,
        },
        'Step attempt reporting failed',
      );
    },
  };
}

interface RepairCommand {
  readonly repairId: string;
  readonly runId: string;
  readonly action: 'retry_step' | 'resume_run' | 'abandon_run';
  readonly stepId?: string;
  readonly baseRepairId?: string;
}

export function createBackendRepairCommandProcessor(
  options: BackendExecutionScope & {
    readonly repairExecutor: ReturnType<typeof createRunRepairExecutor>;
    readonly fetch?: typeof globalThis.fetch;
  },
) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    async processNext() {
      const query = new URLSearchParams({
        organizationId: options.organizationId,
        environmentId: options.environmentId,
      });
      const response = await fetchImplementation(
        new URL(`/v1/repair-commands/next?${query}`, options.backendUrl),
        { headers: { authorization: `Bearer ${options.workerToken}` } },
      );
      if (response.status === 204) return false;
      if (!response.ok) throw new Error(`Repair command polling failed (${response.status})`);
      const command = (await response.json()) as RepairCommand;
      try {
        await options.repairExecutor.execute({
          ...command,
          repairId: command.repairId,
        });
        await recordRepairResult(command.repairId, { status: 'completed' });
      } catch {
        await recordRepairResult(command.repairId, {
          status: 'failed',
          error: 'repair-command-failed',
        });
      }
      return true;
    },
  };

  async function recordRepairResult(
    repairId: string,
    result: { status: 'completed' | 'failed'; error?: string },
  ) {
    await sendBackendJson(
      options,
      fetchImplementation,
      `/v1/repair-commands/${encodeURIComponent(repairId)}`,
      'PATCH',
      {
        organizationId: options.organizationId,
        environmentId: options.environmentId,
        ...result,
      },
      'Repair command acknowledgement failed',
    );
  }
}

export function createBackendRunCommandProcessor(
  options: BackendExecutionScope & {
    readonly workerId: string;
    readonly starter: WorkflowRunStarter;
    readonly decryptPayload: (encryptedPayload: string) => unknown;
    readonly fetch?: typeof globalThis.fetch;
  },
) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return {
    async processNext() {
      const query = new URLSearchParams({
        organizationId: options.organizationId,
        environmentId: options.environmentId,
        workerId: options.workerId,
      });
      const response = await fetchImplementation(
        new URL(`/v1/run-commands/next?${query}`, options.backendUrl),
        { headers: { authorization: `Bearer ${options.workerToken}` } },
      );
      if (response.status === 204) return false;
      if (!response.ok) throw new Error(`Run command polling failed (${response.status})`);
      const body: unknown = await response.json();
      const command = parseRunCommand(body);
      let decryptedPayload: unknown;
      try {
        decryptedPayload = options.decryptPayload(command.encryptedPayload);
      } catch {
        await recordResult(command.commandId, {
          status: 'failed',
          error: 'invalid-trigger-payload',
          errorDetails: {
            issues: [{ path: '$', message: 'Payload could not be decrypted and parsed.' }],
          },
        });
        return true;
      }
      const validationPayload =
        decryptedPayload && typeof decryptedPayload === 'object' && !Array.isArray(decryptedPayload)
          ? { ...decryptedPayload, atlasWorkflowRunId: command.commandId }
          : decryptedPayload;
      const inputIssues = command.inputSchema
        ? validateWorkflowInput(validationPayload, command.inputSchema)
        : [];
      if (inputIssues.length > 0) {
        await recordResult(command.commandId, {
          status: 'failed',
          error: 'invalid-trigger-payload',
          errorDetails: { issues: inputIssues },
        });
        return true;
      }
      const payload = parseWorkflowRunPayload(decryptedPayload);
      if (!payload) {
        await recordResult(command.commandId, {
          status: 'failed',
          error: 'invalid-trigger-payload',
          errorDetails: {
            issues: [{ path: '$', message: 'Expected object.' }],
          },
        });
        return true;
      }
      try {
        const started = await options.starter.startWorkflowRun(payload, {
          artifactId: command.artifactId,
          runCommandId: command.commandId,
          workflowName: command.workflowName,
          ...(command.workflowId ? { workflowId: command.workflowId } : {}),
          trigger: command.trigger,
        });
        await recordResult(command.commandId, {
          status: started.status === 'conflict' ? 'failed' : 'completed',
          workflowRunId: started.workflowRunId,
          intakeStatus: started.status,
          ...(started.status === 'conflict' ? { error: 'conflicting-run-input' } : {}),
        });
      } catch {
        await recordResult(command.commandId, {
          status: 'failed',
          error: 'run-start-failed',
        });
      }
      return true;
    },
  };

  async function recordResult(
    commandId: string,
    result: {
      readonly status: 'completed' | 'failed';
      readonly error?: string;
      readonly workflowRunId?: string;
      readonly intakeStatus?: 'accepted' | 'duplicate' | 'conflict';
      readonly errorDetails?: { readonly issues: readonly WorkflowInputValidationIssue[] };
    },
  ) {
    await sendBackendJson(
      options,
      fetchImplementation,
      `/v1/run-commands/${encodeURIComponent(commandId)}`,
      'PATCH',
      {
        organizationId: options.organizationId,
        environmentId: options.environmentId,
        ...result,
      },
      'Run command acknowledgement failed',
    );
  }
}

function parseRunCommand(value: unknown): {
  commandId: string;
  encryptedPayload: string;
  artifactId: string;
  workflowId?: string;
  workflowName: string;
  trigger: RunTriggerProvenance;
  inputSchema?: ObjectSchema;
} {
  if (
    !value ||
    typeof value !== 'object' ||
    !('commandId' in value) ||
    !('encryptedPayload' in value) ||
    !('artifactId' in value)
  ) {
    throw new Error('Backend returned an invalid run command');
  }
  if (
    typeof value.commandId !== 'string' ||
    !value.commandId ||
    typeof value.encryptedPayload !== 'string' ||
    !value.encryptedPayload ||
    typeof value.artifactId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.artifactId)
  ) {
    throw new Error('Backend returned an invalid run command');
  }
  return {
    commandId: value.commandId,
    encryptedPayload: value.encryptedPayload,
    artifactId: value.artifactId,
    ...('workflowId' in value && typeof value.workflowId === 'string' && value.workflowId
      ? { workflowId: value.workflowId }
      : {}),
    workflowName:
      'workflowName' in value && typeof value.workflowName === 'string' ? value.workflowName : '',
    trigger: parseRunTrigger('trigger' in value ? value.trigger : undefined),
    ...('inputSchema' in value && value.inputSchema !== undefined
      ? { inputSchema: objectSchemaSchema.parse(value.inputSchema) }
      : {}),
  };
}

function parseRunTrigger(value: unknown): RunTriggerProvenance {
  if (value === undefined) return { type: 'manual' };
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new Error('Backend returned invalid trigger provenance');
  }
  if (value.type === 'manual') return { type: 'manual' };
  if (
    value.type === 'webhook' &&
    'deliveryId' in value &&
    typeof value.deliveryId === 'string' &&
    value.deliveryId.length > 0
  ) {
    return { type: 'webhook', deliveryId: value.deliveryId };
  }
  if (
    value.type === 'api' &&
    'deliveryId' in value &&
    typeof value.deliveryId === 'string' &&
    value.deliveryId.length > 0
  ) {
    return { type: 'api', deliveryId: value.deliveryId };
  }
  if (
    value.type === 'schedule' &&
    'scheduleId' in value &&
    typeof value.scheduleId === 'string' &&
    value.scheduleId.length > 0 &&
    'scheduledFor' in value &&
    typeof value.scheduledFor === 'string' &&
    value.scheduledFor.length > 0
  ) {
    return {
      type: 'schedule',
      scheduleId: value.scheduleId,
      scheduledFor: value.scheduledFor,
    };
  }
  throw new Error('Backend returned invalid trigger provenance');
}

export function createBackendInterpreterInputFactory(
  options: BackendExecutionScope & {
    readonly fetch?: typeof globalThis.fetch;
  },
) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return async (
    payload: WorkflowRunPayload,
    workflowRunId: string,
    binding: RunStartBinding = { trigger: { type: 'manual' } },
  ) => {
    const paymentId = payload.paymentId;
    const intakeKey = await deriveStableId('atlas.private-intake-key', [
      ...(binding.workflowId ? [binding.workflowId] : []),
      typeof paymentId === 'string' && paymentId.trim()
        ? paymentId
        : (binding.runCommandId ?? workflowRunId),
    ]);
    const response = await sendBackendJson(
      options,
      fetchImplementation,
      '/v1/execution-grants',
      'POST',
      {
        organizationId: options.organizationId,
        environmentId: options.environmentId,
        runId: workflowRunId,
        intakeKey,
        ...(binding.artifactId ? { artifactId: binding.artifactId } : {}),
        ...(binding.runCommandId ? { runCommandId: binding.runCommandId } : {}),
        trigger: binding.trigger,
      },
      'ExecutionGrant issuance failed',
    );
    const body: unknown = await response.json();
    const grant = executionGrantSchema.parse(
      body && typeof body === 'object' && 'grant' in body ? body.grant : undefined,
    );
    const artifactId =
      body &&
      typeof body === 'object' &&
      'artifactId' in body &&
      typeof body.artifactId === 'string'
        ? body.artifactId
        : undefined;
    return {
      workflowVersionId: grant.workflowVersionId,
      ...(artifactId ? { artifactId } : {}),
      grant,
      input: { ...payload, atlasWorkflowRunId: workflowRunId },
    };
  };
}
