import {
  StepActivityError,
  UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE,
  type DriftSignal,
  type StepActivities,
} from '@atlas/runtime-ports';

import type { AdditionalCapabilityActivity } from './capability-activity.js';

export interface CapabilityStepActivitiesOptions {
  readonly capabilities?: readonly AdditionalCapabilityActivity[];
  readonly resolveCapability?: (
    capabilityVersionId: string,
  ) => Promise<AdditionalCapabilityActivity | undefined>;
  readonly onDriftSignal?: (signal: DriftSignal) => Promise<void> | void;
}

// The generic interpreter only knows capabilityVersionIds; this maps each one to the
// HTTP binding that carries it out. Nothing here is specific to any one workflow.
export function createCapabilityStepActivities(
  options: CapabilityStepActivitiesOptions,
): StepActivities {
  const registered = new Map(
    (options.capabilities ?? []).map((capability) => [capability.capabilityVersionId, capability]),
  );
  return {
    async emitDriftSignal(signal) {
      await options.onDriftSignal?.(signal);
    },
    async invokeStep(invocation) {
      const capability =
        registered.get(invocation.capabilityVersionId) ??
        (await options.resolveCapability?.(invocation.capabilityVersionId));
      if (!capability) {
        throw new StepActivityError(
          UNKNOWN_CAPABILITY_VERSION_FAILURE_TYPE,
          `No HTTP binding for ${invocation.capabilityVersionId}`,
        );
      }
      return capability.invokeStep(invocation);
    },
  };
}
