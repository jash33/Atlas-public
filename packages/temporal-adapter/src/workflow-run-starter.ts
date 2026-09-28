import { WorkflowExecutionAlreadyStartedError, type WorkflowClient } from '@temporalio/client';

import type { ExecutionGrant } from '@atlas/execution-grant';
import {
  deriveStableId,
  type JsonValue,
  type VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import type { RunStartBinding, WorkflowRunPayload } from '@atlas/runtime-ports';

import { INTERPRETER_WORKFLOW } from './workflow-names.js';

// Shared with tooling/compose-smoke.mjs, which recomputes run ids outside this package.
export const WORKFLOW_RUN_ID_NAMESPACE = 'atlas.workflow-run-id';
export const WORKFLOW_RUN_ID_PREFIX = 'atlas:run:';

export interface InterpreterStartInput {
  readonly workflowVersionId: string;
  readonly artifactId?: string;
  readonly grant?: ExecutionGrant;
  readonly input: Readonly<Record<string, JsonValue>>;
}

export interface TemporalWorkflowRunStarterOptions {
  readonly workflowClient: WorkflowClient;
  readonly taskQueue: string;
  readonly createInterpreterInput: (
    payload: WorkflowRunPayload,
    workflowRunId: string,
    binding?: RunStartBinding,
  ) => Promise<InterpreterStartInput>;
  readonly startAuthorized: (
    input: InterpreterStartInput,
    startTemporal: (
      verifiedWorkflow: VersionedCompiledWorkflowVersion,
    ) => Promise<'accepted' | 'duplicate' | 'conflict'>,
  ) => Promise<'accepted' | 'duplicate' | 'conflict'>;
  readonly reportLifecycle?: boolean;
}

export function createTemporalWorkflowRunStarter(options: TemporalWorkflowRunStarterOptions) {
  return {
    async startWorkflowRun(
      payload: WorkflowRunPayload,
      binding: RunStartBinding = { trigger: { type: 'manual' } },
    ) {
      // Webhook-style intakes carry a paymentId that dedupes redeliveries into one run.
      // API intake uses the caller idempotency key (stored as deliveryId) as the business key.
      const paymentId = payload.paymentId;
      const businessKey =
        binding.trigger.type === 'schedule'
          ? `${binding.trigger.scheduleId}:${binding.trigger.scheduledFor}`
          : binding.trigger.type === 'api'
            ? binding.trigger.deliveryId
            : typeof paymentId === 'string' && paymentId.trim()
              ? paymentId
              : binding.runCommandId;
      if (typeof businessKey !== 'string' || !businessKey.trim()) {
        throw new Error('A manual run requires paymentId when no run command is bound');
      }
      const workflowIdentity = await deriveStableId(WORKFLOW_RUN_ID_NAMESPACE, [
        ...(binding.workflowId ? [binding.workflowId] : []),
        businessKey,
      ]);
      const workflowRunId = `${WORKFLOW_RUN_ID_PREFIX}${workflowIdentity}`;
      const interpreterInput = await options.createInterpreterInput(
        payload,
        workflowRunId,
        binding,
      );

      try {
        const status = await options.startAuthorized(interpreterInput, async (verifiedWorkflow) => {
          await options.workflowClient.start(INTERPRETER_WORKFLOW, {
            workflowId: workflowRunId,
            // A business key maps to exactly one execution for its lifetime; redeliveries after
            // the run closes must still dedupe instead of starting a second execution.
            workflowIdReusePolicy: 'REJECT_DUPLICATE',
            taskQueue: options.taskQueue,
            workflowExecutionTimeout: '1 hour',
            args: [
              {
                workflow: verifiedWorkflow,
                input: interpreterInput.input,
                ...(options.reportLifecycle
                  ? { lifecycle: { workflowName: binding.workflowName ?? '' } }
                  : {}),
                ...(binding.trigger.type === 'api' ? { returnFinalOutput: true } : {}),
                ...(interpreterInput.grant?.approvedHostnames
                  ? { approvedHostnames: interpreterInput.grant.approvedHostnames }
                  : {}),
              },
            ],
          });
          return 'accepted' as const;
        });
        return { workflowRunId, status } as const;
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
        return { workflowRunId, status: 'duplicate' as const };
      }
    },
  };
}
