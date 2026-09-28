import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const documentationPaths = [
  '.env.example',
  'README.md',
  'apps/onboarding-site/lessons/0000-developer-setup.html',
  'apps/onboarding-site/lessons/0002-what-done-means.html',
  'apps/onboarding-site/lessons/0003-the-payment-flow.html',
  'apps/onboarding-site/reference/glossary.html',
] as const;

function read(relativePath: (typeof documentationPaths)[number]) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('Production environment documentation', () => {
  it('uses Production for canonical examples', () => {
    expect(read('.env.example')).toContain('ATLAS_EXECUTION_ENVIRONMENT_ID=production');
    expect(read('apps/onboarding-site/reference/glossary.html')).toContain(
      'such as Development or Production.',
    );
    expect(read('apps/onboarding-site/lessons/0003-the-payment-flow.html')).toContain(
      'whether you are in Development or Production.',
    );
  });

  it('documents the guarded one-time local transition', () => {
    for (const relativePath of [
      'README.md',
      'apps/onboarding-site/lessons/0000-developer-setup.html',
      'apps/onboarding-site/lessons/0002-what-done-means.html',
    ] as const) {
      const content = read(relativePath);
      expect(content).toMatch(/Production-like/);
      expect(content).toMatch(/PostgreSQL/);
      expect(content).toMatch(/Temporal/);
      expect(content).toMatch(/Worker-secret/);
      expect(content).toMatch(/unrelated Docker resources/i);
    }
  });
});
