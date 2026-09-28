import type { CapabilityComparisonState } from '@atlas/workflow-ir';

export type { CapabilityComparisonState } from '@atlas/workflow-ir';

export interface ComparableCapabilityObservation {
  capabilityVersionId: string;
  observation: {
    availability: 'available' | 'removed';
    freshness: 'fresh' | 'stale';
  };
  sourceResolution: { status: 'uncontested' | 'conflicting' | 'authoritative' };
}

export function compareCapabilityObservations(
  development: ComparableCapabilityObservation | null,
  production: ComparableCapabilityObservation | null,
  developmentIsAhead: boolean,
): CapabilityComparisonState {
  if (!development) return 'missing-in-development';
  if (!production) return 'missing-in-production';
  if (development.sourceResolution.status === 'conflicting') {
    return 'conflicting-in-development';
  }
  if (production.sourceResolution.status === 'conflicting') {
    return 'conflicting-in-production';
  }
  if (development.observation.availability === 'removed') return 'removed-in-development';
  if (production.observation.availability === 'removed') {
    return 'removed-in-production';
  }
  if (development.observation.freshness === 'stale') return 'stale-in-development';
  if (production.observation.freshness === 'stale') return 'stale-in-production';
  if (development.capabilityVersionId === production.capabilityVersionId) return 'matching';
  return developmentIsAhead ? 'ahead' : 'different';
}
