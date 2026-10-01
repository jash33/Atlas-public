import type { JsonValue } from '@atlas/workflow-ir';

export type WorkflowRunPayload = Readonly<Record<string, JsonValue>>;

export type WorkflowResult =
  | { readonly status: 'running' }
  | { readonly status: 'completed'; readonly output: Readonly<Record<string, JsonValue>> }
  | { readonly status: 'failed'; readonly error: string };

export type RunTriggerProvenance =
  | { readonly type: 'manual' }
  | { readonly type: 'webhook'; readonly deliveryId: string }
  | { readonly type: 'api'; readonly deliveryId: string }
  | {
      readonly type: 'schedule';
      readonly scheduleId: string;
      readonly scheduledFor: string;
    };

export interface RunStartBinding {
  readonly workflowName?: string;
  readonly artifactId?: string;
  readonly runCommandId?: string;
  readonly workflowId?: string;
  readonly trigger: RunTriggerProvenance;
}

export interface SecretProvider {
  getSecret(alias: string): Promise<string>;
}

export interface StepInvocation {
  readonly runId?: string;
  readonly stepId: string;
  readonly capabilityVersionId: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly approvedHostnames?: readonly string[];
  readonly outputProjection?: readonly (readonly string[])[];
}

export interface DriftSignal {
  readonly stepId: string;
  readonly capabilityVersionId: string;
}

// Local execution controls; never serialized into workflow input or history.
export interface StepExecutionContext {
  readonly signal: AbortSignal;
}

export interface StepActivities {
  invokeStep(
    invocation: StepInvocation,
    context?: StepExecutionContext,
  ): Promise<Readonly<Record<string, JsonValue>>>;
  emitDriftSignal?(signal: DriftSignal): Promise<void>;
}

// Raised when a worker has no binding for a step's capabilityVersionId. Retrying cannot change
// that, so the interpreter never retries it regardless of the step's RetryPolicy.
export const UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE = 'UnknownCapabilityVersion';

export class StepActivityError extends Error {
  readonly type: string;

  constructor(type: string, message = type) {
    super(message);
    this.name = type;
    this.type = type;
  }
}
