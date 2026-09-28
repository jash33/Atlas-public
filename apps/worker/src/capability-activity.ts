import type { StepInvocation } from '@atlas/runtime-ports';
import type { JsonValue } from '@atlas/workflow-ir';

export interface AdditionalCapabilityActivity {
  readonly capabilityVersionId: string;
  invokeStep(invocation: StepInvocation): Promise<Readonly<Record<string, JsonValue>>>;
}
