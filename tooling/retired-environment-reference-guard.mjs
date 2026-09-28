import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const retiredKebab = ['production', 'like'].join('-');
const retiredSnake = ['production', 'like'].join('_');
const retiredSpellings = Object.freeze([
  retiredKebab,
  `P${retiredKebab.slice(1)}`,
  retiredSnake,
  retiredSnake.toUpperCase(),
]);

// Exact files only. Every exception is a transition boundary, a transition test, or explicit
// upgrade documentation. Do not replace this with a directory exclusion.
export const justifiedReferenceFiles = Object.freeze({
  '.env.example': 'stale local configuration guidance',
  'README.md': 'explicit local upgrade documentation',
  'apps/docs-site/src/content/self-host.md': 'explicit local upgrade documentation',
  'docs/production-transition-completion.md': 'transition completion report',
  'apps/backend/src/app.ts': 'stale API-input rejection boundary',
  'apps/backend/src/app.test.ts': 'stale API-input transition tests',
  'apps/console/src/shell/session.tsx': 'stale browser-state translation boundary',
  'apps/console/src/shell/session.test.ts': 'browser transition tests',
  'apps/worker/src/config.ts': 'stale Worker configuration error',
  'apps/worker/src/config.test.ts': 'Worker stale-configuration test',
  'apps/ingest/src/config.ts': 'stale Ingest configuration error',
  'apps/ingest/src/config.test.ts': 'Ingest stale-configuration test',
  'apps/worker/src/bundle-run-gate.test.ts': 'retired bundle rejection test',
  'apps/worker/src/execution-grant.test.ts': 'retired grant rejection test',
  'apps/onboarding-site/lessons/0000-developer-setup.html': 'explicit local upgrade lesson',
  'apps/onboarding-site/lessons/0002-what-done-means.html': 'explicit local upgrade lesson',
  'packages/execution-grant/src/index.test.ts': 'retired grant rejection test',
  'packages/workflow-artifact/src/atlas-bundle.test.ts': 'retired bundle rejection test',
  'packages/workflow-ir/src/index.test.ts': 'canonical contract rejection test',
  'tooling/atlas-local-state.mjs': 'isolated Docker legacy detector',
  'tooling/atlas-local-state.test.ts': 'Docker legacy detector tests',
  'tooling/compose-up.mjs': 'isolated database detector and actionable errors',
  'tooling/docker-storage.test.ts': 'startup recovery transition tests',
  'tooling/infra-up-legacy-smoke.test.ts': 'real-stack upgrade transition test',
  'tooling/prepare-demo.test.ts': 'canonical reset assertion',
  'tooling/production-documentation.test.ts': 'upgrade documentation test',
  'tooling/retired-environment-reference-guard.test.ts': 'static guard self-test',
});

function normalizePath(path) {
  return path.replaceAll('\\', '/');
}

function isActiveRepositorySurface(path) {
  return (
    ['.env.example', 'README.md', 'package.json'].includes(path) ||
    ['apps/', 'docs/', 'infra/', 'packages/', 'tooling/'].some((prefix) => path.startsWith(prefix))
  );
}

export function auditRetiredEnvironmentReferences(files) {
  const violations = [];
  for (const file of files) {
    const path = normalizePath(file.path);
    const reason = justifiedReferenceFiles[path];
    for (const [index, line] of file.content.split(/\r?\n/).entries()) {
      for (const spelling of retiredSpellings) {
        if (line.includes(spelling) && !reason) {
          violations.push({ path, line: index + 1, spelling });
        }
      }
    }
  }
  return violations;
}

export function readRepositoryTextFiles(root = workspaceRoot) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root },
  );
  return (
    output
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .filter((path) => isActiveRepositorySurface(normalizePath(path)))
      // Tracked files deleted in the working tree still appear in the index until staged.
      .filter((path) => existsSync(resolve(root, path)))
      .flatMap((path) => {
        const buffer = readFileSync(resolve(root, path));
        return buffer.includes(0) ? [] : [{ path, content: buffer.toString('utf8') }];
      })
  );
}

export function assertNoUnjustifiedRetiredEnvironmentReferences(root = workspaceRoot) {
  const violations = auditRetiredEnvironmentReferences(readRepositoryTextFiles(root));
  if (violations.length === 0) return;
  throw new Error(
    `Retired environment references require an exact justified exception:\n${violations
      .map(({ path, line, spelling }) => `- ${path}:${line} (${spelling})`)
      .join('\n')}`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertNoUnjustifiedRetiredEnvironmentReferences();
}
