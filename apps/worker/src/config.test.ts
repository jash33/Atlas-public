import { describe, expect, it } from 'vite-plus/test';

import { loadWorkerConfig } from './config.js';

describe('Worker environment configuration', () => {
  it('defaults to the canonical Production environment', () => {
    expect(loadWorkerConfig({}).environmentId).toBe('production');
  });

  it.each(['development', 'production'] as const)('accepts %s', (environmentId) => {
    expect(loadWorkerConfig({ ATLAS_EXECUTION_ENVIRONMENT_ID: environmentId }).environmentId).toBe(
      environmentId,
    );
  });

  it('rejects the retired environment with an actionable error', () => {
    expect(() => loadWorkerConfig({ ATLAS_EXECUTION_ENVIRONMENT_ID: 'production-like' })).toThrow(
      'ATLAS_EXECUTION_ENVIRONMENT_ID "production-like" is retired; use "production"',
    );
  });
});
