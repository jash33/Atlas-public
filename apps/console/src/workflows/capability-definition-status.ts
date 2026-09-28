export interface CapabilityObservation {
  availability: 'available' | 'removed';
  freshness: 'fresh' | 'stale';
  reason: string;
  lastObservedAt: string;
  statusChangedAt: string;
}

export const lastKnownDefinitionMessage =
  'Using the last known definition. Discovery has not confirmed it recently.';

export function usesLastKnownDefinition(observation?: CapabilityObservation): boolean {
  return observation?.freshness === 'stale';
}

export function readCapabilityObservation(value: unknown): CapabilityObservation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const observation = value as Record<string, unknown>;
  if (
    (observation.availability !== 'available' && observation.availability !== 'removed') ||
    (observation.freshness !== 'fresh' && observation.freshness !== 'stale') ||
    typeof observation.reason !== 'string' ||
    typeof observation.lastObservedAt !== 'string' ||
    typeof observation.statusChangedAt !== 'string'
  )
    return undefined;
  return {
    availability: observation.availability,
    freshness: observation.freshness,
    reason: observation.reason,
    lastObservedAt: observation.lastObservedAt,
    statusChangedAt: observation.statusChangedAt,
  };
}
