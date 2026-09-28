import { fileURLToPath } from 'node:url';

import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { Client, Connection, type WorkflowClient } from '@temporalio/client';
import type { DataConverter } from '@temporalio/common';
import { NativeConnection, Worker, type WorkerOptions } from '@temporalio/worker';

import {
  StepActivityError,
  type DriftSignal,
  type StepActivities,
  type StepInvocation,
} from '@atlas/runtime-ports';
import { deriveStableId } from '@atlas/workflow-ir';
import { assertEncryptedDataConverter, type EncryptedDataConverter } from './payload-codec.js';
import type { RunReporter } from './workflow.js';
import { INTERPRETER_WORKFLOW } from './workflow-names.js';

export { INTERPRETER_WORKFLOW };
export { createWorkflowResultReader } from './workflow-result.js';

export { createBackendCapabilityApprovalVerifier } from './capability-approval.js';
export {
  createTemporalWorkflowRunStarter,
  WORKFLOW_RUN_ID_NAMESPACE,
  WORKFLOW_RUN_ID_PREFIX,
} from './workflow-run-starter.js';
export { createBackendWorkflowLoader } from './workflow-loader.js';
export { createAesGcmPayloadCodec } from './payload-codec.js';
export { createEncryptedDataConverter, type EncryptedDataConverter } from './payload-codec.js';
export {
  evaluateTransformationArguments,
  TransformationEvaluationError,
  type TransformationEvaluationContext,
  type TransformationEvaluationErrorCode,
} from '@atlas/transformation-runtime';
export type {
  InterpreterFailure,
  InterpreterFailureBucket,
  InterpreterInput,
  InterpreterResult,
  RunReporter,
  WorkflowRunOutcome,
} from './workflow.js';
export type { WorkflowLoader } from './workflow-loader.js';
export { WorkflowAuthorizationRejected, WorkflowBackendUnavailable } from './workflow-loader.js';

export async function connectTemporalRuntime(options: {
  readonly address: string;
  readonly namespace: string;
  readonly dataConverter?: DataConverter;
}) {
  const clientConnection = await Connection.connect({ address: options.address });
  let acquiredWorkerConnection: NativeConnection | undefined;
  try {
    const workerConnection = await NativeConnection.connect({ address: options.address });
    acquiredWorkerConnection = workerConnection;
    const client = new Client({
      connection: clientConnection,
      namespace: options.namespace,
      ...(options.dataConverter ? { dataConverter: options.dataConverter } : {}),
    });
    return {
      workerConnection,
      workflowClient: client.workflow,
      async close() {
        await Promise.all([clientConnection.close(), workerConnection.close()]);
      },
    };
  } catch (error) {
    await Promise.all([clientConnection.close(), acquiredWorkerConnection?.close()]);
    throw error;
  }
}

export interface StepAttempt {
  readonly runId: string;
  readonly stepId: string;
  readonly capabilityVersionId: string;
  readonly attempt: number;
  readonly durationMs: number;
  readonly status: 'succeeded' | 'failed';
  readonly redactedInput: unknown;
  readonly redactedOutput?: unknown;
  readonly failureType?: string;
}

const UNKNOWN_OPERATIONAL_FAILURE_TYPE = 'UnknownOperationalFailure';

export interface CreateTemporalWorkerOptions {
  readonly runReporter?: RunReporter;
  readonly connection: NativeConnection;
  readonly taskQueue: string;
  readonly namespace?: WorkerOptions['namespace'];
  readonly activities: StepActivities;
  readonly maxCachedWorkflows?: WorkerOptions['maxCachedWorkflows'];
  readonly dataConverter: EncryptedDataConverter;
  readonly stepAttemptReporter?: {
    recordStepAttempt(input: StepAttempt): Promise<void>;
  };
}

function workflowModuleUrl(): URL {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./workflow.${extension}`, import.meta.url);
}

export async function createTemporalWorker(options: CreateTemporalWorkerOptions): Promise<Worker> {
  assertEncryptedDataConverter(options.dataConverter);
  return Worker.create({
    connection: options.connection,
    taskQueue: options.taskQueue,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    activities: {
      async recordRunStarted(input: Parameters<RunReporter['recordRunStarted']>[0]) {
        if (!options.runReporter) throw new Error('Run reporting is not configured');
        await options.runReporter.recordRunStarted(input);
      },
      async recordRunOutcome(input: Parameters<RunReporter['recordRunOutcome']>[0]) {
        if (!options.runReporter) throw new Error('Run reporting is not configured');
        await options.runReporter.recordRunOutcome(input);
      },
      ...projectActivityOutputs(wrapStepAttempts(options.activities, options.stepAttemptReporter)),
      deriveStableId,
      async emitDriftSignal(signal: DriftSignal) {
        await options.activities.emitDriftSignal?.(signal);
      },
    },
    workflowsPath: fileURLToPath(workflowModuleUrl()),
    dataConverter: options.dataConverter,
    ...(options.maxCachedWorkflows === undefined
      ? {}
      : { maxCachedWorkflows: options.maxCachedWorkflows }),
  });
}

function wrapStepAttempts(
  activities: StepActivities,
  reporter: CreateTemporalWorkerOptions['stepAttemptReporter'],
): StepActivities {
  if (!reporter) {
    return {
      ...activities,
      async invokeStep(invocation) {
        return invokeOrFail(activities, invocation);
      },
    };
  }
  return {
    ...activities,
    async invokeStep(invocation) {
      const startedAt = Date.now();
      const attempt = Context.current().info.attempt;
      const runId = invocation.runId ?? Context.current().info.workflowExecution?.workflowId;
      if (!runId) throw new Error('Step invocation has no workflow run identity');
      try {
        const output = await invokeOrFail(activities, invocation);
        await reporter.recordStepAttempt({
          runId,
          stepId: invocation.stepId,
          capabilityVersionId: invocation.capabilityVersionId,
          attempt,
          durationMs: Date.now() - startedAt,
          status: 'succeeded',
          redactedInput: redactJson(invocation.input),
          redactedOutput: redactJson(output),
        });
        return output;
      } catch (error) {
        await reporter.recordStepAttempt({
          runId,
          stepId: invocation.stepId,
          capabilityVersionId: invocation.capabilityVersionId,
          attempt,
          durationMs: Date.now() - startedAt,
          status: 'failed',
          redactedInput: redactJson(invocation.input),
          failureType: stepAttemptFailureType(error),
        });
        throw error;
      }
    },
  };
}

function stepAttemptFailureType(error: unknown): string {
  if (error instanceof StepActivityError || error instanceof ApplicationFailure) {
    return failureTypeOrFallback(error.type);
  }
  return UNKNOWN_OPERATIONAL_FAILURE_TYPE;
}

function failureTypeOrFallback(type: unknown): string {
  return typeof type === 'string' && type.trim().length > 0
    ? type
    : UNKNOWN_OPERATIONAL_FAILURE_TYPE;
}

async function invokeOrFail(
  activities: StepActivities,
  invocation: StepInvocation,
): Promise<Readonly<Record<string, import('@atlas/workflow-ir').JsonValue>>> {
  try {
    return await activities.invokeStep(invocation);
  } catch (error) {
    if (error instanceof StepActivityError) {
      throw ApplicationFailure.create({
        message: error.message,
        type: failureTypeOrFallback(error.type),
      });
    }
    throw error;
  }
}

function projectActivityOutputs(activities: StepActivities): StepActivities {
  return {
    ...activities,
    async invokeStep(invocation) {
      const output = await activities.invokeStep(invocation);
      return invocation.outputProjection === undefined
        ? output
        : projectOutput(output, invocation.outputProjection);
    },
  };
}

function projectOutput(
  output: Readonly<Record<string, import('@atlas/workflow-ir').JsonValue>>,
  paths: readonly (readonly string[])[],
) {
  if (paths.some((path) => path.length === 0)) return output;
  const projected: Record<string, import('@atlas/workflow-ir').JsonValue> = {};
  for (const path of paths) copyProjectedPath(output, projected, path);
  return projected;
}

function copyProjectedPath(
  source: import('@atlas/workflow-ir').JsonValue | undefined,
  destination: Record<string, import('@atlas/workflow-ir').JsonValue>,
  path: readonly string[],
) {
  const [segment, ...remaining] = path;
  if (
    segment === undefined ||
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source) ||
    !(segment in source)
  ) {
    return;
  }
  const value = source[segment]!;
  if (remaining.length === 0) {
    destination[segment] = value;
    return;
  }
  const child = destination[segment];
  const childDestination =
    child !== null && typeof child === 'object' && !Array.isArray(child)
      ? child
      : ({} as Record<string, import('@atlas/workflow-ir').JsonValue>);
  copyProjectedPath(value, childDestination, remaining);
  destination[segment] = childDestination;
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactJson(item),
      ]),
    );
  }
  return '[REDACTED]';
}

export async function executeRunRepair(
  _workflowClient: WorkflowClient,
  input: {
    readonly runId: string;
    readonly action: 'retry_step' | 'resume_run' | 'abandon_run';
    readonly stepId?: string;
    readonly repairId?: string;
    readonly baseRepairId?: string;
  },
) {
  if (input.action === 'abandon_run') return { state: 'abandoned' as const };
  throw new Error(`Run '${input.runId}' has no repairable generic-interpreter continuation`);
}

export function createRunRepairExecutor(workflowClient: WorkflowClient) {
  return {
    execute(input: Parameters<typeof executeRunRepair>[1]) {
      return executeRunRepair(workflowClient, input);
    },
  };
}

export async function replayTemporalHistory(
  history: unknown,
  dataConverter?: DataConverter,
): Promise<void> {
  await Worker.runReplayHistory(
    {
      workflowsPath: fileURLToPath(workflowModuleUrl()),
      ...(dataConverter ? { dataConverter } : {}),
    },
    history,
  );
}
