import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

const runLegacySmoke = process.env.ATLAS_INFRA_UP_LEGACY_SMOKE === '1';
const composeFile = resolve('infra/compose/compose.yaml');

function docker(args: readonly string[]) {
  return execFileSync('docker', args, { cwd: resolve('.'), encoding: 'utf8' }).trim();
}

function bestEffortDocker(args: readonly string[]) {
  try {
    docker(args);
  } catch {}
}

describe.skipIf(!runLegacySmoke)('infra:up legacy recovery smoke', () => {
  it('upgrades a legacy stack, completes a Production run, and preserves unrelated Docker state', () => {
    const unrelatedVolume = `atlas-issue-154-unrelated-${randomUUID()}`;
    try {
      docker([
        'volume',
        'create',
        '--label',
        'com.docker.compose.project=unrelated',
        unrelatedVolume,
      ]);
      docker([
        'volume',
        'create',
        '--label',
        'com.docker.compose.project=atlas',
        'atlas-production-like-worker-secrets',
      ]);
      docker([
        'container',
        'create',
        '--name',
        'atlas-worker-production-like-1',
        '--label',
        'com.docker.compose.project=atlas',
        '--label',
        'com.docker.compose.service=worker-production-like',
        'node:24.19.0-bookworm-slim',
        'node',
        '-e',
        '',
      ]);

      execFileSync(process.execPath, ['tooling/compose-up.mjs'], {
        cwd: resolve('.'),
        stdio: 'inherit',
      });
      execFileSync(process.execPath, ['tooling/compose-smoke.mjs'], {
        cwd: resolve('.'),
        env: { ...process.env, ATLAS_SMOKE_REUSE_STACK: '1' },
        stdio: 'inherit',
      });

      expect(docker(['volume', 'inspect', '--format', '{{.Name}}', unrelatedVolume])).toBe(
        unrelatedVolume,
      );
    } finally {
      bestEffortDocker(['container', 'rm', '--force', 'atlas-worker-production-like-1']);
      bestEffortDocker(['volume', 'rm', 'atlas-production-like-worker-secrets']);
      bestEffortDocker(['volume', 'rm', unrelatedVolume]);
      bestEffortDocker(['compose', '-f', composeFile, 'down', '--volumes', '--remove-orphans']);
    }
  }, 600_000);
});
