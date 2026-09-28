import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

const guardPath = fileURLToPath(new URL('./dependency-guard.mjs', import.meta.url));

describe('dependency guard CLI', () => {
  it.each([
    {
      file: 'packages/workflow-ir/src/index.ts',
      importStatement: "import '@temporalio/client';",
      message: 'Temporal SDK imports are restricted to packages/temporal-adapter',
    },
    {
      file: 'packages/workflow-ir/src/index.ts',
      importStatement: "import 'react/jsx-runtime';",
      message: 'framework-neutral packages cannot import framework or Node transport modules',
    },
    {
      file: 'packages/runtime-ports/src/index.ts',
      importStatement: "import 'hono/utils/http-status';",
      message: 'framework-neutral packages cannot import framework or Node transport modules',
    },
    {
      file: 'packages/test-support/src/index.ts',
      importStatement: "import '@atlas/backend/internal';",
      message: 'shared packages cannot import applications',
    },
    {
      file: 'packages/test-support/src/index.ts',
      importStatement: "import '../../../apps/worker/src/index.js';",
      message: 'shared packages cannot import applications',
    },
    {
      file: 'apps/console/src/index.ts',
      importStatement: "import '../../backend/src/app.js';",
      message: 'browser code cannot import server application or transport modules',
    },
    {
      file: 'apps/console/src/index.test.ts',
      importStatement: "import '../../backend/src/app.js';",
      message: 'browser code cannot import server application or transport modules',
    },
  ])('rejects $message', ({ file, importStatement, message }) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'atlas-guard-'));
    const illegalFile = join(fixtureRoot, ...file.split('/'));
    mkdirSync(dirname(illegalFile), { recursive: true });
    writeFileSync(illegalFile, `${importStatement}\n`);

    try {
      expect(() =>
        execFileSync(process.execPath, [guardPath, '--root', fixtureRoot], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).toThrow(message);
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

  it('allows Node test-harness imports in console tests', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'atlas-guard-'));
    const testFile = join(fixtureRoot, 'apps/console/src/styles.test.ts');
    mkdirSync(dirname(testFile), { recursive: true });
    writeFileSync(testFile, "import { readFileSync } from 'node:fs';\n");

    try {
      expect(() =>
        execFileSync(process.execPath, [guardPath, '--root', fixtureRoot], {
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).not.toThrow();
    } finally {
      rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});
