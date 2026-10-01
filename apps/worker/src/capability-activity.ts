import type { StepInvocation, StepExecutionContext } from '@atlas/runtime-ports';
import type { JsonValue } from '@atlas/workflow-ir';

export interface AdditionalCapabilityActivity {
  readonly capabilityVersionId: string;
  invokeStep(
    invocation: StepInvocation,
    context?: StepExecutionContext,
  ): Promise<Readonly<Record<string, JsonValue>>>;
}
