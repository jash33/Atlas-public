import { randomUUID } from 'node:crypto';

import {
  versionedCompiledWorkflowVersionSchema,
  isCapabilityStep,
  type CapabilityStep,
  type GraphStep,
  type CompiledStep,
  type RetryPolicy,
  type TransformationStep,
} from '@atlas/workflow-ir';
import type { RunTriggerProvenance } from '@atlas/runtime-ports';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { WorkflowRepairActor } from './workflow-authorization.js';
import { presentRunLifecycle, type RunLifecycleSummary } from './run-lifecycle.js';

// Repair controls apply to capability calls in every workflow version.
type RunStep = CompiledStep | TransformationStep | GraphStep;

const runStateSchema = z.enum([
  'running',
  'completed',
  'validation_failed',
  'manual_review',
  'repair_required',
]);
export const runOutcomeSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    state: runStateSchema.exclude(['running']),
    failure: z
      .object({
        bucket: z.enum(['retryable-transient', 'permanent-validation', 'permanent-operational']),
        type: z.string().min(1),
        stepId: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const redactedJsonSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.literal('[REDACTED]'),
    z.array(redactedJsonSchema),
    z.record(z.string(), redactedJsonSchema),
  ]),
);

export const stepAttemptSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    stepId: z.string().min(1),
    capabilityVersionId: z.string().min(1),
    attempt: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
    status: z.enum(['succeeded', 'failed']),
    redactedInput: redactedJsonSchema,
    redactedOutput: redactedJsonSchema.optional(),
    failureType: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.status === 'failed' && !attempt.failureType) {
      context.addIssue({
        code: 'custom',
        message: 'A failed attempt requires failureType',
        path: ['failureType'],
      });
    }
    if (attempt.status === 'succeeded' && attempt.failureType) {
      context.addIssue({
        code: 'custom',
        message: 'A succeeded attempt cannot carry failureType',
        path: ['failureType'],
      });
    }
  });

const repairScopeSchema = z.object({
  organizationId: z.string().min(1),
  environmentId: z.string().min(1),
});

export const runRepairRequestSchema = z.discriminatedUnion('action', [
  repairScopeSchema
    .extend({
      action: z.literal('retry_step'),
      stepId: z.string().min(1),
      repairedCapabilityVersionId: z.string().min(1),
    })
    .strict(),
  repairScopeSchema.extend({ action: z.literal('resume_run') }).strict(),
  repairScopeSchema.extend({ action: z.literal('cancel_run') }).strict(),
  repairScopeSchema
    .extend({ action: z.literal('abandon_run'), reason: z.string().trim().min(1) })
    .strict(),
]);

export const repairCommandResultSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    status: z.enum(['completed', 'failed']),
    error: z.string().min(1).optional(),
  })
  .strict();

export class WorkflowRunNotFound extends Error {}
export class WorkflowRunRepairRejected extends Error {}

export const runsQuerySchema = z.object({
  organizationId: z.string().min(1),
  environmentId: z.string().min(1),
  state: z.union([z.literal('attention'), runStateSchema]).default('attention'),
  intakeReference: z.string().trim().optional(),
});

export async function readWorkflowRuns(pool: Pool, query: z.infer<typeof runsQuerySchema>) {
  const states =
    query.state === 'attention'
      ? ['validation_failed', 'manual_review', 'repair_required']
      : [query.state];
  const result = await pool.query<{
    run_id: string;
    workflow_version_id: string;
    intake_key: string;
    state: z.infer<typeof runStateSchema>;
    trigger_type: 'manual' | 'webhook' | 'schedule' | 'api';
    trigger_delivery_id: string | null;
    trigger_schedule_id: string | null;
    trigger_scheduled_for: Date | null;
    started_at: Date;
    updated_at: Date;
    lifecycle_workflow_name: string | null;
    lifecycle_started_at: Date | null;
    lifecycle_ended_at: Date | null;
    lifecycle_duration_ms: number | null;
    lifecycle_retry_count: number | null;
    lifecycle_outcome: 'succeeded' | 'failed' | null;
  }>(
    `SELECT run.run_id, run.workflow_version_id, run.intake_key, run.state, run.trigger_type,
            run.trigger_delivery_id, run.trigger_schedule_id, run.trigger_scheduled_for,
            run.started_at, run.updated_at,
            lifecycle.workflow_name AS lifecycle_workflow_name,
            lifecycle.started_at AS lifecycle_started_at,
            lifecycle.ended_at AS lifecycle_ended_at,
            lifecycle.duration_ms AS lifecycle_duration_ms,
            lifecycle.retry_count AS lifecycle_retry_count,
            lifecycle.outcome AS lifecycle_outcome
     FROM workflow_runs run
     LEFT JOIN workflow_run_lifecycles lifecycle
       ON lifecycle.organization_id = run.organization_id
      AND lifecycle.environment_id = run.environment_id
      AND lifecycle.run_id = run.run_id
     WHERE run.organization_id = $1
       AND run.environment_id = $2
       AND run.state = ANY($3::text[])
       AND ($4::text IS NULL OR run.intake_key ILIKE '%' || $4 || '%')
     ORDER BY run.started_at DESC, run.run_id DESC`,
    [query.organizationId, query.environmentId, states, query.intakeReference || null],
  );
  return {
    filter: query.state,
    runs: result.rows.map((row) => ({
      runId: row.run_id,
      workflowVersionId: row.workflow_version_id,
      intakeReference: row.intake_key,
      state: row.state,
      trigger: serializeRunTrigger(row),
      startedAt: row.started_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      lifecycle:
        row.lifecycle_started_at === null || row.lifecycle_workflow_name === null
          ? null
          : presentRunLifecycle({
              workflow_name: row.lifecycle_workflow_name,
              started_at: row.lifecycle_started_at,
              ended_at: row.lifecycle_ended_at,
              duration_ms: row.lifecycle_duration_ms,
              retry_count: row.lifecycle_retry_count,
              outcome: row.lifecycle_outcome,
            }),
    })),
  };
}

export async function recordWorkflowRunStarted(
  pool: Pick<Pool, 'query'>,
  input: {
    organizationId: string;
    environmentId: string;
    runId: string;
    workflowVersionId: string;
    artifactId?: string | undefined;
    intakeKey: string;
    trigger?: RunTriggerProvenance;
  },
) {
  await pool.query(
    `INSERT INTO workflow_runs
      (organization_id, environment_id, run_id, workflow_version_id, artifact_id, intake_key, state,
       trigger_type, trigger_delivery_id, trigger_schedule_id, trigger_scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, 'running', $7, $8, $9, $10)
     ON CONFLICT (organization_id, environment_id, run_id) DO NOTHING`,
    [
      input.organizationId,
      input.environmentId,
      input.runId,
      input.workflowVersionId,
      input.artifactId ?? null,
      input.intakeKey,
      input.trigger?.type ?? 'manual',
      input.trigger?.type === 'webhook' || input.trigger?.type === 'api'
        ? input.trigger.deliveryId
        : null,
      input.trigger?.type === 'schedule' ? input.trigger.scheduleId : null,
      input.trigger?.type === 'schedule' ? input.trigger.scheduledFor : null,
    ],
  );
}

export async function recordWorkflowRunOutcome(
  pool: Pick<Pool, 'query'>,
  runId: string,
  input: z.infer<typeof runOutcomeSchema>,
) {
  const result = await pool.query(
    `UPDATE workflow_runs
     SET state = $4, failure_bucket = $5, failure_type = $6, failed_step_id = $7,
         updated_at = current_timestamp
     WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3`,
    [
      input.organizationId,
      input.environmentId,
      runId,
      input.state,
      input.failure?.bucket ?? null,
      input.failure?.type ?? null,
      input.failure?.stepId ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function recordWorkflowStepAttempt(
  pool: Pool,
  runId: string,
  input: z.infer<typeof stepAttemptSchema>,
) {
  const result = await pool.query(
    `INSERT INTO workflow_run_step_attempts
      (organization_id, environment_id, run_id, step_id, capability_version_id, attempt,
       duration_ms, status, redacted_input, redacted_output, failure_type)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
     WHERE EXISTS (
       SELECT 1 FROM workflow_runs
       WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3
     )`,
    [
      input.organizationId,
      input.environmentId,
      runId,
      input.stepId,
      input.capabilityVersionId,
      input.attempt,
      input.durationMs,
      input.status,
      input.redactedInput,
      input.redactedOutput ?? null,
      input.failureType ?? null,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

interface AttemptRow {
  step_id: string;
  capability_version_id: string;
  attempt: number;
  duration_ms: number;
  status: 'succeeded' | 'failed';
  redacted_input: unknown;
  redacted_output: unknown;
  failure_type: string | null;
  recorded_at: Date;
}

interface RepairRow {
  repair_id: string;
  action: 'retry_step' | 'resume_run' | 'abandon_run';
  step_id: string | null;
  reason: string | null;
  operator_id: string;
  warning: {
    priorStepsNotRerun: string[];
    committedIrreversibleEffects: string[];
    repairedCapabilityVersionId?: string;
  };
  status: 'queued' | 'dispatched' | 'completed' | 'failed';
  created_at: Date;
  completed_at: Date | null;
  error: string | null;
}

interface RunDetailRow {
  run_id: string;
  workflow_version_id: string;
  intake_key: string;
  state: z.infer<typeof runStateSchema>;
  failure_bucket: 'retryable-transient' | 'permanent-validation' | 'permanent-operational' | null;
  failure_type: string | null;
  failed_step_id: string | null;
  disposition: 'active' | 'abandoned';
  started_at: Date;
  updated_at: Date;
  artifact_id: string | null;
  duplicate_submission_count: number;
  trigger_type: 'manual' | 'webhook' | 'schedule' | 'api';
  trigger_delivery_id: string | null;
  trigger_schedule_id: string | null;
  trigger_scheduled_for: Date | null;
  compiled_workflow: unknown;
}

type FailureBucket = 'retryable-transient' | 'permanent-validation' | 'permanent-operational';

interface RetrySafety {
  allowed: boolean;
  basis: 'read-only-operation' | 'stable-idempotency-key' | 'unsafe-operation';
}

export async function readWorkflowRun(
  pool: Pool,
  runId: string,
  scope: { organizationId: string; environmentId: string },
) {
  const runResult = await pool.query<
    RunDetailRow & {
      lifecycle_workflow_name: string | null;
      lifecycle_started_at: Date | null;
      lifecycle_ended_at: Date | null;
      lifecycle_duration_ms: number | null;
      lifecycle_retry_count: number | null;
      lifecycle_outcome: 'succeeded' | 'failed' | null;
    }
  >(
    `SELECT run.run_id, run.workflow_version_id, run.intake_key, run.state,
            run.failure_bucket, run.failure_type, run.failed_step_id, run.disposition,
            run.started_at, run.updated_at, run.artifact_id, run.duplicate_submission_count,
            run.trigger_type, run.trigger_delivery_id, run.trigger_schedule_id,
            run.trigger_scheduled_for,
            version.compiled_workflow,
            lifecycle.workflow_name AS lifecycle_workflow_name,
            lifecycle.started_at AS lifecycle_started_at,
            lifecycle.ended_at AS lifecycle_ended_at,
            lifecycle.duration_ms AS lifecycle_duration_ms,
            lifecycle.retry_count AS lifecycle_retry_count,
            lifecycle.outcome AS lifecycle_outcome
     FROM workflow_runs run
     JOIN workflow_versions version
       ON version.organization_id = run.organization_id
      AND version.workflow_version_id = run.workflow_version_id
     LEFT JOIN workflow_run_lifecycles lifecycle
       ON lifecycle.organization_id = run.organization_id
      AND lifecycle.environment_id = run.environment_id
      AND lifecycle.run_id = run.run_id
     WHERE run.organization_id = $1 AND run.environment_id = $2 AND run.run_id = $3`,
    [scope.organizationId, scope.environmentId, runId],
  );
  const run = runResult.rows[0];
  if (!run) return undefined;
  const workflow = versionedCompiledWorkflowVersionSchema.parse(run.compiled_workflow);
  const workflowSteps: RunStep[] = workflow.executable.steps;
  const capabilityIds = workflow.executionRequirements.requiredCapabilityVersionIds;
  const capabilityMethods =
    capabilityIds.length === 0
      ? []
      : (
          await pool.query<{ capability_version_id: string; method: string | null }>(
            `SELECT capability_version_id, lower(capability_fragment->>'method') AS method
             FROM capability_versions
             WHERE organization_id = $1 AND capability_version_id = ANY($2::text[])`,
            [scope.organizationId, capabilityIds],
          )
        ).rows;
  const methodsByCapability = new Map(
    capabilityMethods.map((capability) => [capability.capability_version_id, capability.method]),
  );
  const attemptsResult = await pool.query<AttemptRow>(
    `SELECT step_id, capability_version_id, attempt, duration_ms, status, redacted_input,
            redacted_output, failure_type, recorded_at
     FROM workflow_run_step_attempts
     WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3
     ORDER BY id`,
    [scope.organizationId, scope.environmentId, runId],
  );
  const repairsResult = await pool.query<RepairRow>(
    `SELECT repair_id, action, step_id, reason, operator_id, warning, status, created_at,
            completed_at, error
     FROM workflow_run_repairs
     WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3
     ORDER BY created_at, repair_id`,
    [scope.organizationId, scope.environmentId, runId],
  );
  const attemptsByStep = new Map<string, AttemptRow[]>();
  for (const attempt of attemptsResult.rows) {
    const attempts = attemptsByStep.get(attempt.step_id) ?? [];
    attempts.push(attempt);
    attemptsByStep.set(attempt.step_id, attempts);
  }
  const executableSteps = workflowSteps.filter(isCapabilityStep);
  const visibleSteps = executableSteps.filter((step) => step.kind !== 'compensation');
  const latestSuccessfulAttempt = new Map<string, number>();
  const latestAttempt = new Map<string, { index: number; status: AttemptRow['status'] }>();
  attemptsResult.rows.forEach((attempt, index) => {
    latestAttempt.set(attempt.step_id, { index, status: attempt.status });
    if (attempt.status === 'succeeded') latestSuccessfulAttempt.set(attempt.step_id, index);
  });
  const successfulStepIds = new Set(latestSuccessfulAttempt.keys());
  const completedCompensations = new Set(
    executableSteps
      .filter(
        (step): step is Extract<RunStep, { kind: 'compensation' }> => step.kind === 'compensation',
      )
      .filter((step) => {
        const compensation = latestAttempt.get(step.id);
        const compensatedStepIndex = latestSuccessfulAttempt.get(step.compensatesStepId);
        return (
          compensation?.status === 'succeeded' &&
          compensatedStepIndex !== undefined &&
          compensation.index > compensatedStepIndex
        );
      })
      .map((step) => step.compensatesStepId),
  );
  const irreversibleEffects = visibleSteps
    .filter((step) => step.irreversibleAfter && successfulStepIds.has(step.id))
    .map((step) => step.id);
  const failedStepIndex = visibleSteps.findIndex((step) => step.id === run.failed_step_id);
  const priorStepsNotRerun = visibleSteps
    .slice(0, failedStepIndex < 0 ? 0 : failedStepIndex)
    .filter((step) => successfulStepIds.has(step.id) && !completedCompensations.has(step.id))
    .map((step) => step.id);
  const warning = { priorStepsNotRerun, committedIrreversibleEffects: irreversibleEffects };
  const stepsById = new Map(executableSteps.map((step) => [step.id, step]));
  const failedStep = run.failed_step_id ? stepsById.get(run.failed_step_id) : undefined;
  const failedStepRetrySafety = failedStep
    ? deriveRetrySafety(failedStep, methodsByCapability.get(failedStep.capabilityVersionId) ?? null)
    : { allowed: false, basis: 'unsafe-operation' as const };
  const repairsEnabled =
    run.state === 'repair_required' &&
    run.disposition === 'active' &&
    run.failed_step_id !== null &&
    run.failed_step_id !== 'workflow-load' &&
    failedStepRetrySafety.allowed;
  const failedStepAttempts = run.failed_step_id
    ? (attemptsByStep.get(run.failed_step_id) ?? [])
    : [];
  const failedStepRetriedSuccessfully = failedStepAttempts.at(-1)?.status === 'succeeded';
  const traceHistory = [
    {
      type: 'workflow.started' as const,
      recordedAt: run.started_at.toISOString(),
      workflowVersionId: run.workflow_version_id,
      artifactId: run.artifact_id?.trim() ?? null,
    },
    ...attemptsResult.rows.map((attempt) => {
      const step = stepsById.get(attempt.step_id);
      const retrySafety = step
        ? deriveRetrySafety(step, methodsByCapability.get(step.capabilityVersionId) ?? null)
        : { allowed: false, basis: 'unsafe-operation' as const };
      const failureEvidence =
        attempt.failure_type && step
          ? describeFailureAttempt(
              attempt.attempt,
              attempt.failure_type,
              step.retryPolicy,
              retrySafety,
            )
          : undefined;
      return {
        type: 'step.attempt' as const,
        recordedAt: attempt.recorded_at.toISOString(),
        stepId: attempt.step_id,
        capabilityVersionId: attempt.capability_version_id,
        attempt: attempt.attempt,
        status: attempt.status,
        durationMs: attempt.duration_ms,
        ...(attempt.failure_type ? { normalizedError: attempt.failure_type } : {}),
        ...(failureEvidence ?? {}),
      };
    }),
    ...(run.state === 'running'
      ? []
      : [
          {
            type: 'workflow.finished' as const,
            recordedAt: run.updated_at.toISOString(),
            state: run.state,
          },
        ]),
  ];

  const lifecycle: RunLifecycleSummary | null =
    run.lifecycle_started_at === null || run.lifecycle_workflow_name === null
      ? null
      : presentRunLifecycle({
          workflow_name: run.lifecycle_workflow_name,
          started_at: run.lifecycle_started_at,
          ended_at: run.lifecycle_ended_at,
          duration_ms: run.lifecycle_duration_ms,
          retry_count: run.lifecycle_retry_count,
          outcome: run.lifecycle_outcome,
        });

  return {
    runId: run.run_id,
    temporalWorkflowId: run.run_id,
    workflowVersionId: run.workflow_version_id,
    artifactId: run.artifact_id?.trim() ?? null,
    trigger: serializeRunTrigger(run),
    intakeReference: run.intake_key,
    state: run.state,
    disposition: run.disposition,
    startedAt: run.started_at.toISOString(),
    updatedAt: run.updated_at.toISOString(),
    lifecycle,
    failure:
      run.failure_bucket && run.failure_type && run.failed_step_id
        ? { bucket: run.failure_bucket, type: run.failure_type, stepId: run.failed_step_id }
        : null,
    steps: visibleSteps.map((step) => {
      const retrySafety = deriveRetrySafety(
        step,
        methodsByCapability.get(step.capabilityVersionId) ?? null,
      );
      return {
        stepId: step.id,
        capabilityVersionId: step.capabilityVersionId,
        irreversible: step.irreversibleAfter === true,
        idempotency: step.idempotency
          ? {
              protected: true,
              businessKeySource: step.idempotency.businessKey.source,
              evidence: 'The worker reuses one stable derived key for every attempt.',
            }
          : {
              protected: false,
              evidence:
                retrySafety.basis === 'read-only-operation'
                  ? 'The pinned capability is read-only; retries cannot repeat a write.'
                  : 'This step has no declared idempotency protection; retries are not safe.',
            },
        retry: serializeRetryPolicy(step.retryPolicy, retrySafety),
        attempts: serializeAttempts(
          attemptsByStep.get(step.id) ?? [],
          step.retryPolicy,
          retrySafety,
        ),
      };
    }),
    saga: executableSteps
      .filter(
        (step): step is Extract<RunStep, { kind: 'compensation' }> => step.kind === 'compensation',
      )
      .map((step) => ({
        stepId: step.id,
        compensatesStepId: step.compensatesStepId,
        state: compensationState(
          latestAttempt.get(step.id),
          latestSuccessfulAttempt.get(step.compensatesStepId),
          successfulStepIds.has(step.compensatesStepId),
          irreversibleEffects.length > 0,
        ),
      })),
    controls: {
      retryStep: {
        enabled:
          repairsEnabled && !failedStepRetriedSuccessfully && completedCompensations.size === 0,
        stepId: repairsEnabled ? run.failed_step_id : null,
        repairedCapabilityVersionId: repairsEnabled
          ? (failedStep?.capabilityVersionId ?? null)
          : null,
        safetyBasis: failedStepRetrySafety.basis,
        ...warning,
      },
      resumeRun: { enabled: repairsEnabled && failedStepRetriedSuccessfully, ...warning },
      abandonRun: {
        enabled:
          run.disposition === 'active' &&
          ['validation_failed', 'manual_review', 'repair_required'].includes(run.state),
        ...warning,
      },
    },
    repairHistory: repairsResult.rows.map((repair) => ({
      repairId: repair.repair_id,
      action: repair.action,
      repairedCapabilityVersionId: repair.warning.repairedCapabilityVersionId ?? null,
      stepId: repair.step_id,
      reason: repair.reason,
      operatorId: repair.operator_id,
      warning: repair.warning,
      status: repair.status,
      createdAt: repair.created_at.toISOString(),
      completedAt: repair.completed_at?.toISOString() ?? null,
      error: repair.error,
    })),
    traceHistory,
    effects: visibleSteps.flatMap((step) =>
      (step.idempotency || step.irreversibleAfter) &&
      (attemptsByStep.get(step.id) ?? []).some((attempt) => attempt.status === 'succeeded')
        ? [
            {
              stepId: step.id,
              capabilityVersionId: step.capabilityVersionId,
              status: 'confirmed' as const,
              evidence: 'Customer worker reported the declared side effect succeeded.',
            },
          ]
        : [],
    ),
    privacy: {
      payloadsRedactedAt: 'customer-worker',
      plaintextStoredByAtlas: false,
    },
    idempotencyEvidence: {
      duplicateSubmissions: run.duplicate_submission_count,
      durableRunIdentities: 1,
      effectExecutions: visibleSteps
        .filter((step) => step.idempotency || step.irreversibleAfter)
        .map((step) => ({
          stepId: step.id,
          successfulAttempts: (attemptsByStep.get(step.id) ?? []).filter(
            (attempt) => attempt.status === 'succeeded',
          ).length,
        })),
    },
  };
}

function serializeRunTrigger(row: {
  trigger_type: 'manual' | 'webhook' | 'schedule' | 'api';
  trigger_delivery_id: string | null;
  trigger_schedule_id: string | null;
  trigger_scheduled_for: Date | null;
}): RunTriggerProvenance {
  return row.trigger_type === 'webhook'
    ? { type: 'webhook', deliveryId: row.trigger_delivery_id! }
    : row.trigger_type === 'api'
      ? { type: 'api', deliveryId: row.trigger_delivery_id! }
      : row.trigger_type === 'schedule'
        ? {
            type: 'schedule',
            scheduleId: row.trigger_schedule_id!,
            scheduledFor: row.trigger_scheduled_for!.toISOString(),
          }
        : { type: 'manual' };
}

function serializeRetryPolicy(policy: RetryPolicy | undefined, safety: RetrySafety) {
  if (!policy) return null;
  return {
    safety,
    maximumAttempts: policy.maximumAttempts,
    backoff: {
      initialInterval: policy.initialInterval,
      coefficient: policy.backoffCoefficient,
      maximumInterval: policy.maximumInterval,
    },
    nonRetryableErrorTypes: policy.nonRetryableErrorTypes,
  };
}

function deriveRetrySafety(step: CapabilityStep, method: string | null): RetrySafety {
  if (step.idempotency) return { allowed: true, basis: 'stable-idempotency-key' };
  if (method && ['get', 'head', 'options'].includes(method)) {
    return { allowed: true, basis: 'read-only-operation' };
  }
  return { allowed: false, basis: 'unsafe-operation' };
}

function describeFailureAttempt(
  attempt: number,
  failureType: string,
  policy: RetryPolicy | undefined,
  safety: RetrySafety,
) {
  if (!policy) {
    return {
      failureClassification: 'permanent-operational' as FailureBucket,
      retryDecision: 'stopped-no-policy' as const,
    };
  }
  const nonRetryable = policy.nonRetryableErrorTypes.includes(failureType);
  const failureClassification: FailureBucket = nonRetryable
    ? (policy.failureBuckets?.[failureType] ?? 'permanent-operational')
    : 'retryable-transient';
  const retryDecision = nonRetryable
    ? ('stopped-error-class' as const)
    : !safety.allowed
      ? ('stopped-unsafe' as const)
      : attempt >= policy.maximumAttempts
        ? ('stopped-exhausted' as const)
        : ('scheduled' as const);
  return { failureClassification, retryDecision };
}

function serializeAttempts(
  attempts: readonly AttemptRow[],
  policy: RetryPolicy | undefined,
  safety: RetrySafety,
) {
  return attempts.map((attempt) => ({
    attempt: attempt.attempt,
    durationMs: attempt.duration_ms,
    status: attempt.status,
    redactedInput: attempt.redacted_input,
    ...(attempt.redacted_output === null ? {} : { redactedOutput: attempt.redacted_output }),
    ...(attempt.failure_type === null ? {} : { failureType: attempt.failure_type }),
    ...(attempt.failure_type === null
      ? {}
      : describeFailureAttempt(attempt.attempt, attempt.failure_type, policy, safety)),
    recordedAt: attempt.recorded_at.toISOString(),
  }));
}

function compensationState(
  latestCompensationAttempt: { index: number; status: AttemptRow['status'] } | undefined,
  latestCompensatedStepSuccess: number | undefined,
  compensatedStepCompleted: boolean,
  irreversibleEffectCommitted: boolean,
) {
  if (
    latestCompensationAttempt &&
    latestCompensatedStepSuccess !== undefined &&
    latestCompensationAttempt.index > latestCompensatedStepSuccess
  ) {
    return latestCompensationAttempt.status === 'succeeded' ? 'completed' : 'failed';
  }
  if (compensatedStepCompleted && irreversibleEffectCommitted) return 'frozen';
  if (compensatedStepCompleted) return 'armed';
  return 'not_reached';
}

export async function queueWorkflowRunRepair(
  pool: Pool,
  runId: string,
  request: z.infer<typeof runRepairRequestSchema>,
  actor: WorkflowRepairActor,
) {
  const run = await readWorkflowRun(pool, runId, request);
  if (!run) throw new WorkflowRunNotFound('Workflow run was not found');
  if (request.action === 'retry_step') {
    if (
      !run.controls.retryStep.enabled ||
      request.stepId !== run.failure?.stepId ||
      request.repairedCapabilityVersionId !== run.controls.retryStep.repairedCapabilityVersionId
    ) {
      throw new WorkflowRunRepairRejected(
        'Only the recorded failed step and its pinned capabilityVersionId can be retried',
      );
    }
    const repairConfirmation = await pool.query(
      `SELECT 1
       FROM audit_entries
       WHERE organization_id = $1 AND environment_id = $2
         AND event_type = 'repair' AND subject_type = 'workflow-run' AND subject_id = $3
         AND details->>'operation' = 'provider-condition-repaired'
         AND details->>'repairedCapabilityVersionId' = $4
         AND recorded_at >= $5
       LIMIT 1`,
      [
        request.organizationId,
        request.environmentId,
        runId,
        request.repairedCapabilityVersionId,
        run.updatedAt,
      ],
    );
    if ((repairConfirmation.rowCount ?? 0) === 0) {
      throw new WorkflowRunRepairRejected(
        'The permitted provider condition must be repaired before retry',
      );
    }
  } else if (request.action === 'resume_run') {
    if (!run.controls.resumeRun.enabled) {
      throw new WorkflowRunRepairRejected('This run cannot be resumed');
    }
  } else if (request.action === 'cancel_run') {
    if (run.state !== 'manual_review' || run.disposition !== 'active') {
      throw new WorkflowRunRepairRejected('Only an active manual-review run can be cancelled');
    }
  } else if (!run.controls.abandonRun.enabled) {
    throw new WorkflowRunRepairRejected('This run cannot be abandoned');
  }

  const repairId = randomUUID();
  const warning =
    request.action === 'abandon_run' || request.action === 'cancel_run'
      ? {
          priorStepsNotRerun: run.controls.resumeRun.priorStepsNotRerun,
          committedIrreversibleEffects: run.controls.resumeRun.committedIrreversibleEffects,
        }
      : {
          priorStepsNotRerun:
            run.controls[request.action === 'retry_step' ? 'retryStep' : 'resumeRun']
              .priorStepsNotRerun,
          committedIrreversibleEffects:
            run.controls[request.action === 'retry_step' ? 'retryStep' : 'resumeRun']
              .committedIrreversibleEffects,
          ...(request.action === 'retry_step'
            ? { repairedCapabilityVersionId: request.repairedCapabilityVersionId }
            : {}),
        };
  const persistedAction = request.action === 'cancel_run' ? 'abandon_run' : request.action;
  try {
    await pool.query(
      `INSERT INTO workflow_run_repairs
        (repair_id, organization_id, environment_id, run_id, action, step_id, reason,
         operator_id, warning)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        repairId,
        request.organizationId,
        request.environmentId,
        runId,
        persistedAction,
        request.action === 'retry_step' ? request.stepId : null,
        request.action === 'abandon_run'
          ? request.reason
          : request.action === 'cancel_run'
            ? 'Manual review cancelled'
            : null,
        actor.actorId,
        warning,
      ],
    );
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'constraint' in error &&
      error.constraint === 'workflow_run_repairs_active_run_unique'
    ) {
      throw new WorkflowRunRepairRejected('Another repair command is already active for this run');
    }
    throw error;
  }
  return {
    repairId,
    runId,
    action: request.action,
    ...(request.action === 'retry_step'
      ? {
          stepId: request.stepId,
          repairedCapabilityVersionId: request.repairedCapabilityVersionId,
          safetyBasis: run.controls.retryStep.safetyBasis,
        }
      : {}),
    ...(request.action === 'abandon_run' ? { reason: request.reason } : {}),
    operatorId: actor.actorId,
    warning,
    status: 'queued' as const,
  };
}

export async function claimNextRepairCommand(
  pool: Pool,
  scope: { organizationId: string; environmentId: string },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      repair_id: string;
      run_id: string;
      action: 'retry_step' | 'resume_run' | 'abandon_run';
      step_id: string | null;
      reason: string | null;
      base_repair_id: string | null;
    }>(
      `SELECT command.repair_id, command.run_id, command.action, command.step_id, command.reason,
              CASE WHEN command.action = 'resume_run' THEN (
                SELECT prior.repair_id
                FROM workflow_run_repairs prior
                WHERE prior.organization_id = command.organization_id
                  AND prior.environment_id = command.environment_id
                  AND prior.run_id = command.run_id
                  AND prior.action = 'retry_step'
                  AND prior.status = 'completed'
                ORDER BY prior.completed_at DESC, prior.repair_id DESC
                LIMIT 1
              ) ELSE NULL END AS base_repair_id
       FROM workflow_run_repairs command
       WHERE command.organization_id = $1 AND command.environment_id = $2
         AND command.status IN ('queued', 'dispatched')
       ORDER BY command.created_at, command.repair_id
       FOR UPDATE OF command SKIP LOCKED
       LIMIT 1`,
      [scope.organizationId, scope.environmentId],
    );
    const command = result.rows[0];
    if (!command) {
      await client.query('COMMIT');
      return undefined;
    }
    await client.query(
      `UPDATE workflow_run_repairs SET status = 'dispatched' WHERE repair_id = $1`,
      [command.repair_id],
    );
    await client.query('COMMIT');
    return {
      repairId: command.repair_id,
      runId: command.run_id,
      action: command.action,
      ...(command.step_id ? { stepId: command.step_id } : {}),
      ...(command.reason ? { reason: command.reason } : {}),
      ...(command.base_repair_id ? { baseRepairId: command.base_repair_id } : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordRepairCommandResult(
  pool: Pool,
  repairId: string,
  input: z.infer<typeof repairCommandResultSchema>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ run_id: string; action: string }>(
      `UPDATE workflow_run_repairs
       SET status = $4, error = $5, completed_at = current_timestamp
       WHERE repair_id = $3 AND organization_id = $1 AND environment_id = $2
         AND status = 'dispatched'
       RETURNING run_id, action`,
      [input.organizationId, input.environmentId, repairId, input.status, input.error ?? null],
    );
    const command = result.rows[0];
    if (command?.action === 'abandon_run' && input.status === 'completed') {
      await client.query(
        `UPDATE workflow_runs SET disposition = 'abandoned', updated_at = current_timestamp
         WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3`,
        [input.organizationId, input.environmentId, command.run_id],
      );
    }
    await client.query('COMMIT');
    return command !== undefined;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
