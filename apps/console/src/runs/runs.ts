import type { RunTriggerProvenance } from '@atlas/runtime-ports';

import type { DemoRole } from '../shell/session.js';

export type RunState =
  | 'running'
  | 'completed'
  | 'validation_failed'
  | 'manual_review'
  | 'repair_required';

export type RunFilter = 'attention' | RunState | 'all';

export interface RunLifecycleSummary {
  workflowName: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  retryCount: number | null;
  outcome: 'succeeded' | 'failed' | null;
  inProgress: boolean;
}

export interface WorkflowRunSummary {
  runId: string;
  workflowVersionId: string;
  intakeReference: string;
  state: RunState;
  startedAt: string;
  updatedAt: string;
  trigger: RunTriggerProvenance;
  lifecycle: RunLifecycleSummary | null;
}

export interface RunAttempt {
  attempt: number;
  durationMs: number;
  status: 'succeeded' | 'failed';
  redactedInput: unknown;
  redactedOutput?: unknown;
  failureType?: string;
  failureClassification?: 'retryable-transient' | 'permanent-validation' | 'permanent-operational';
  retryDecision?:
    | 'scheduled'
    | 'stopped-error-class'
    | 'stopped-exhausted'
    | 'stopped-no-policy'
    | 'stopped-unsafe';
  recordedAt: string;
}

export interface RunStep {
  stepId: string;
  capabilityVersionId: string;
  irreversible: boolean;
  idempotency: {
    protected: boolean;
    businessKeySource?: string;
    evidence: string;
  };
  retry?: {
    safety: {
      allowed: boolean;
      basis: 'read-only-operation' | 'stable-idempotency-key' | 'unsafe-operation';
    };
    maximumAttempts: number;
    backoff: {
      initialInterval: string;
      coefficient: number;
      maximumInterval: string;
    };
    nonRetryableErrorTypes: string[];
  } | null;
  attempts: RunAttempt[];
}

export interface RepairControl {
  enabled: boolean;
  priorStepsNotRerun: string[];
  committedIrreversibleEffects: string[];
}

export interface RunRepairHistoryEntry {
  repairId: string;
  action: 'retry_step' | 'resume_run' | 'abandon_run';
  repairedCapabilityVersionId: string | null;
  stepId: string | null;
  reason: string | null;
  operatorId: string;
  warning: Pick<RepairControl, 'priorStepsNotRerun' | 'committedIrreversibleEffects'>;
  status: 'queued' | 'dispatched' | 'completed' | 'failed';
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  temporalWorkflowId: string;
  artifactId: string | null;
  disposition: 'active' | 'abandoned';
  failure: {
    bucket: 'retryable-transient' | 'permanent-validation' | 'permanent-operational';
    type: string;
    stepId: string;
  } | null;
  steps: RunStep[];
  saga: Array<{
    stepId: string;
    compensatesStepId: string;
    state: 'completed' | 'failed' | 'frozen' | 'armed' | 'not_reached';
  }>;
  controls: {
    retryStep: RepairControl & {
      stepId: string | null;
      repairedCapabilityVersionId: string | null;
      safetyBasis: 'read-only-operation' | 'stable-idempotency-key' | 'unsafe-operation';
    };
    resumeRun: RepairControl;
    abandonRun: RepairControl;
  };
  repairHistory: RunRepairHistoryEntry[];
  traceHistory: Array<{
    type: 'workflow.started' | 'step.attempt' | 'workflow.finished';
    recordedAt: string;
    stepId?: string;
    capabilityVersionId?: string;
    attempt?: number;
    status?: string;
    durationMs?: number;
    normalizedError?: string;
    failureClassification?: RunAttempt['failureClassification'];
    retryDecision?: RunAttempt['retryDecision'];
  }>;
  effects: Array<{
    stepId: string;
    capabilityVersionId: string;
    status: 'confirmed';
    evidence: string;
  }>;
  privacy: {
    payloadsRedactedAt: 'customer-worker';
    plaintextStoredByAtlas: false;
  };
  idempotencyEvidence: {
    duplicateSubmissions: number;
    durableRunIdentities: 1;
    effectExecutions: Array<{ stepId: string; successfulAttempts: number }>;
  };
}

const attentionStates = new Set<RunState>([
  'validation_failed',
  'manual_review',
  'repair_required',
]);

export function filterRuns(
  runs: readonly WorkflowRunSummary[],
  filter: RunFilter,
  intakeReference: string,
): WorkflowRunSummary[] {
  const search = intakeReference.trim().toLocaleLowerCase();
  return runs
    .filter((run) => {
      const matchesState =
        filter === 'all' ||
        (filter === 'attention' ? attentionStates.has(run.state) : run.state === filter);
      return matchesState && run.intakeReference.toLocaleLowerCase().includes(search);
    })
    .sort(
      (left, right) =>
        right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId),
    );
}

export function canRepair(role: DemoRole): boolean {
  return role === 'operator' || role === 'admin';
}

const statePresentation: Record<
  RunState,
  { label: string; tone: 'good' | 'bad' | 'warn' | 'info' }
> = {
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'good' },
  validation_failed: { label: 'Failed', tone: 'bad' },
  manual_review: { label: 'Manual review', tone: 'warn' },
  repair_required: { label: 'Parked', tone: 'bad' },
};

export function runStatePresentation(state: RunState) {
  return statePresentation[state];
}

export function buildRunEvidence(run: WorkflowRunDetail) {
  const attempts = run.steps.flatMap((step) => step.attempts);
  return {
    attemptCount: attempts.length,
    durationMs: attempts.reduce((total, attempt) => total + attempt.durationMs, 0),
    capabilityPins: [...new Set(run.steps.map((step) => step.capabilityVersionId))],
    irreversibleEffects: run.steps
      .filter(
        (step) =>
          step.irreversible && step.attempts.some((attempt) => attempt.status === 'succeeded'),
      )
      .map((step) => step.stepId),
  };
}
