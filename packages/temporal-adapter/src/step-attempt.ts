import type { JsonValue } from '@atlas/workflow-ir';
import type { StepInvocation } from '@atlas/runtime-ports';

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

export interface ReportedStepActivities {
  invokeStepWithAttempt(invocation: StepInvocation): Promise<{
    output: Readonly<Record<string, JsonValue>>;
    attempt?: StepAttempt;
  }>;
  recordStepAttempt(attempt: StepAttempt): Promise<void>;
}

export const STEP_ATTEMPT_DETAIL = 'atlas.step-attempt.v1';
