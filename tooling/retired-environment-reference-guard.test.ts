import { describe, expect, it } from 'vitest';

import {
  assertNoUnjustifiedRetiredEnvironmentReferences,
  auditRetiredEnvironmentReferences,
} from './retired-environment-reference-guard.mjs';

describe('retired environment reference guard', () => {
  it('rejects every retired spelling in an unapproved file', () => {
    const content = [
      'production-like',
      'Production-like',
      'production_like',
      'PRODUCTION_LIKE',
    ].join('\n');

    expect(auditRetiredEnvironmentReferences([{ path: 'apps/example.ts', content }])).toEqual([
      { path: 'apps/example.ts', line: 1, spelling: 'production-like' },
      { path: 'apps/example.ts', line: 2, spelling: 'Production-like' },
      { path: 'apps/example.ts', line: 3, spelling: 'production_like' },
      { path: 'apps/example.ts', line: 4, spelling: 'PRODUCTION_LIKE' },
    ]);
  });

  it('permits an exact transition-test exception without allowing adjacent files', () => {
    expect(
      auditRetiredEnvironmentReferences([
        {
          path: 'apps/backend/src/app.test.ts',
          content: "expect(environmentId).not.toBe('production-like')",
        },
      ]),
    ).toEqual([]);
    expect(
      auditRetiredEnvironmentReferences([
        {
          path: 'apps/backend/src/another.test.ts',
          content: "expect(environmentId).not.toBe('production-like')",
        },
      ]),
    ).toHaveLength(1);
  });

  it('keeps the repository free of unjustified retired references', () => {
    expect(() => assertNoUnjustifiedRetiredEnvironmentReferences()).not.toThrow();
  });
});
