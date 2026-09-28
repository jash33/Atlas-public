import { describe, expect, it } from 'vite-plus/test';

import { loadIngestConfig } from './config.js';

describe('Ingest gateway configuration', () => {
  it('defaults to the development environment and local ports', () => {
    const config = loadIngestConfig({});
    expect(config.environmentId).toBe('development');
    expect(config.httpPort).toBe(4300);
    expect(config.backendUrl).toBe('http://localhost:4000');
    expect(config.organizationId).toBe('org_atlas');
  });

  it.each(['development', 'production'] as const)('accepts %s', (environmentId) => {
    expect(loadIngestConfig({ ATLAS_EXECUTION_ENVIRONMENT_ID: environmentId }).environmentId).toBe(
      environmentId,
    );
  });

  it('rejects the retired environment with an actionable error', () => {
    expect(() => loadIngestConfig({ ATLAS_EXECUTION_ENVIRONMENT_ID: 'production-like' })).toThrow(
      'ATLAS_EXECUTION_ENVIRONMENT_ID "production-like" is retired; use "production"',
    );
  });
});
