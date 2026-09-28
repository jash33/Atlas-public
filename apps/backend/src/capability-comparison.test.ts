import { describe, expect, it } from 'vitest';

import {
  compareCapabilityObservations,
  type ComparableCapabilityObservation,
  type CapabilityComparisonState,
} from './capability-comparison.js';

function observation(
  capabilityVersionId: string,
  overrides: Partial<ComparableCapabilityObservation> = {},
): ComparableCapabilityObservation {
  return {
    capabilityVersionId,
    observation: { availability: 'available', freshness: 'fresh' },
    sourceResolution: { status: 'uncontested' },
    ...overrides,
  };
}

describe('capability environment comparison', () => {
  const cases: Array<{
    expected: CapabilityComparisonState;
    development: ComparableCapabilityObservation | null;
    production: ComparableCapabilityObservation | null;
    ahead?: boolean;
  }> = [
    { expected: 'matching', development: observation('same'), production: observation('same') },
    {
      expected: 'ahead',
      development: observation('new'),
      production: observation('old'),
      ahead: true,
    },
    {
      expected: 'different',
      development: observation('left'),
      production: observation('right'),
    },
    { expected: 'missing-in-development', development: null, production: observation('prod') },
    {
      expected: 'missing-in-production',
      development: observation('dev'),
      production: null,
    },
    {
      expected: 'removed-in-development',
      development: observation('dev', {
        observation: { availability: 'removed', freshness: 'fresh' },
      }),
      production: observation('prod'),
    },
    {
      expected: 'removed-in-production',
      development: observation('dev'),
      production: observation('prod', {
        observation: { availability: 'removed', freshness: 'fresh' },
      }),
    },
    {
      expected: 'stale-in-development',
      development: observation('dev', {
        observation: { availability: 'available', freshness: 'stale' },
      }),
      production: observation('prod'),
    },
    {
      expected: 'stale-in-production',
      development: observation('dev'),
      production: observation('prod', {
        observation: { availability: 'available', freshness: 'stale' },
      }),
    },
    {
      expected: 'conflicting-in-development',
      development: observation('dev', { sourceResolution: { status: 'conflicting' } }),
      production: observation('prod'),
    },
    {
      expected: 'conflicting-in-production',
      development: observation('dev'),
      production: observation('prod', { sourceResolution: { status: 'conflicting' } }),
    },
  ];

  for (const testCase of cases) {
    it(`reports ${testCase.expected}`, () => {
      expect(
        compareCapabilityObservations(
          testCase.development,
          testCase.production,
          testCase.ahead ?? false,
        ),
      ).toBe(testCase.expected);
    });
  }
});
