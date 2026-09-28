import { defineConfig } from 'vite-plus';

import { consoleWorkspaceSourceAliases } from './tooling/workspace-source-aliases';

export default defineConfig({
  resolve: {
    alias: consoleWorkspaceSourceAliases,
  },
  fmt: {
    ignorePatterns: [
      '**/.astro/**',
      '.agents/**',
      '.claude/**',
      '.scratch/**',
      'apps/backend/src/fixtures/009-validation-policy/**',
      'apps/backend/src/fixtures/hostile-workflow-source/01-malformed.atlas.yaml',
      'apps/mock-services/specs/**',
      'AGENTS.md',
      'CLAUDE.md',
      'README.md',
      'RESOURCES.md',
      'apps/onboarding-site/**/*.html',
      'apps/onboarding-site/assets/**',
      'apps/onboarding-site/README.md',
      // Preserve captured evidence and its manifest without rewriting the archive.
      'docs/reviews/2026-09-07-demo-success/**',
    ],
    singleQuote: true,
    semi: true,
  },
  lint: {
    ignorePatterns: [
      '**/.astro/**',
      '.agents/**',
      '.claude/**',
      '.scratch/**',
      'apps/backend/src/fixtures/009-validation-policy/**',
      'dist/**',
      'node_modules/**',
      'apps/onboarding-site/assets/**',
    ],
    plugins: ['typescript', 'react', 'vitest'],
    options: {
      typeAware: true,
      typeCheck: false,
    },
  },
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
  },
  test: {
    setupFiles: ['./tooling/test-network-guard.ts'],
    include: [
      'apps/**/*.test.ts',
      'apps/onboarding-site/**/*.test.ts',
      'packages/**/*.test.ts',
      'tooling/**/*.test.ts',
    ],
  },
});
