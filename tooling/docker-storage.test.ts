import { globSync, readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vite-plus/test';

import packageJson from '../package.json';

import { composePrefixForInfrastructure, startInfrastructure } from './compose-up.mjs';
import { demoProviderBaseline } from './demo-provider-baseline.mjs';
import { pruneAtlasDockerStorage } from './docker-storage.mjs';

const dockerfiles = [
  'apps/backend/Dockerfile',
  'apps/ingest/Dockerfile',
  'apps/mock-services/Dockerfile',
  'apps/worker/Dockerfile',
];

const workspaceManifests = [
  ...globSync('apps/*/package.json'),
  ...globSync('packages/*/package.json'),
]
  .map((manifest) => manifest.replaceAll('\\', '/'))
  .sort((left, right) => left.localeCompare(right));

const canonicalDatabaseState = JSON.stringify({
  legacyEnvironmentCount: 0,
  environments: [
    { id: 'development', name: 'Development', kind: 'development' },
    { id: 'production', name: 'Production', kind: 'production' },
  ],
});
const legacyDatabaseState = JSON.stringify({
  legacyEnvironmentCount: 1,
  environments: [
    { id: 'development', name: 'Development', kind: 'development' },
    { id: 'production', name: 'Production', kind: 'production' },
    { id: 'production-like', name: 'Production-like', kind: 'production' },
  ],
});

describe('Docker storage controls', () => {
  it('keeps the demo baseline as generic resource rows', () => {
    expect(Array.isArray(demoProviderBaseline)).toBe(true);
    expect(
      demoProviderBaseline.map(({ service, collection, id, document }) => ({
        service,
        collection,
        id,
        document,
      })),
    ).toEqual(demoProviderBaseline);
    expect(
      demoProviderBaseline
        .filter(({ service, collection }) => service === 'payments' && collection === 'payments')
        .map(({ id }) => id),
    ).toEqual([
      'payment_demo_001',
      'payment_drift_migrated_demo_001',
      'payment_retry_demo_001',
      'payment_repair_demo_001',
    ]);
  });

  it.each(dockerfiles)(
    '%s reuses installed dependencies after source-only changes',
    (dockerfile) => {
      const contents = readFileSync(dockerfile, 'utf8');
      const install = contents.indexOf('RUN vp install --frozen-lockfile');
      const fullSourceCopy = contents.indexOf('COPY --chown=vp:vp . .');
      const archiveLinks = contents.indexOf('RUN tar -cf /tmp/workspace-node-modules.tar');
      const restoreLinks = contents.indexOf('RUN tar -xf /tmp/workspace-node-modules.tar');

      expect(install).toBeGreaterThan(-1);
      expect(archiveLinks).toBeGreaterThan(install);
      expect(fullSourceCopy).toBeGreaterThan(install);
      expect(restoreLinks).toBeGreaterThan(fullSourceCopy);
    },
  );

  it.each(dockerfiles)('%s installs every workspace package manifest', (dockerfile) => {
    const contents = readFileSync(dockerfile, 'utf8');
    const install = contents.indexOf('RUN vp install --frozen-lockfile');

    for (const manifest of workspaceManifests) {
      const manifestCopy = contents.indexOf(`COPY --chown=vp:vp ${manifest} `);
      expect(manifestCopy, `${dockerfile} must copy ${manifest}`).toBeGreaterThan(-1);
      expect(manifestCopy, `${dockerfile} must copy ${manifest} before install`).toBeLessThan(
        install,
      );
    }
  });

  it('removes only dangling Atlas images and old build cache', () => {
    const runDocker = vi.fn<(args: readonly string[]) => void>();

    pruneAtlasDockerStorage({ runDocker, output: vi.fn<(message: string) => void>() });

    expect(runDocker.mock.calls.map(([args]) => args)).toEqual([
      ['image', 'prune', '--force', '--filter', 'label=com.docker.compose.project=atlas'],
      ['builder', 'prune', '--force', '--filter', 'until=24h'],
    ]);
  });

  it('includes recent build cache when requested', () => {
    const runDocker = vi.fn<(args: readonly string[]) => void>();

    pruneAtlasDockerStorage({
      runDocker,
      output: vi.fn<(message: string) => void>(),
      buildCache: 'include-recent',
    });

    expect(runDocker.mock.calls.map(([args]) => args)).toEqual([
      ['image', 'prune', '--force', '--filter', 'label=com.docker.compose.project=atlas'],
      ['builder', 'prune', '--force'],
    ]);
  });

  it('routes infrastructure startup through automatic storage cleanup', () => {
    expect(packageJson.scripts['infra:up']).toBe('node tooling/compose-up.mjs');
    expect(packageJson.scripts['infra:clean:docker-cache']).toBe('node tooling/docker-storage.mjs');
    expect(packageJson.scripts['infra:test:e2e']).toBe('node tooling/compose-smoke.mjs');
    expect(packageJson.scripts['infra:prune']).toBeUndefined();
    expect(packageJson.scripts['infra:smoke']).toBeUndefined();
  });

  it('loads the documented root env file when it exists', () => {
    expect(composePrefixForInfrastructure(true)).toEqual([
      'compose',
      '--env-file',
      expect.stringMatching(/[\\/]\.env$/),
      '-f',
      expect.stringMatching(/[\\/]infra[\\/]compose[\\/]compose\.yaml$/),
    ]);
    expect(composePrefixForInfrastructure(false)).not.toContain('--env-file');
  });

  it('cleans storage after a Compose build, including when startup fails', () => {
    const runCompose = vi.fn<(args: readonly string[]) => void>(() => {
      throw new Error('startup failed');
    });
    const dockerBoundary = {
      runCompose,
      resolveCleanupTargets: vi.fn<() => unknown>(() => ({
        project: 'atlas',
        containers: [],
        volumes: [],
      })),
      removeLocalState: vi.fn<() => unknown>(),
    };
    const runDocker = vi.fn<(args: readonly string[]) => void>();

    expect(() =>
      startInfrastructure({
        dockerBoundary,
        runDocker,
        output: vi.fn<(message: string) => void>(),
      }),
    ).toThrow('startup failed');
    expect(runCompose).toHaveBeenCalledWith(['up', '-d', '--build', '--wait']);
    expect(dockerBoundary.resolveCleanupTargets).toHaveBeenCalledOnce();
    expect(dockerBoundary.removeLocalState).not.toHaveBeenCalled();
    expect(runDocker.mock.calls.map(([args]) => args[0])).toEqual(['image']);
  });

  it('merges demo provider fixtures after preserving infrastructure state', () => {
    const runCompose = vi.fn<(args: readonly string[]) => string>((args) => {
      if (args.includes('ps')) {
        return 'backend\ningest-development\ningest-production\npostgres\nworker-development\nworker-production\n';
      }
      if (args.includes('psql')) {
        return canonicalDatabaseState;
      }
      return '';
    });
    const dockerBoundary = {
      runCompose,
      resolveCleanupTargets: vi.fn<() => unknown>(() => ({
        project: 'atlas',
        containers: [],
        volumes: [],
      })),
      removeLocalState: vi.fn<() => unknown>(),
    };
    const runDocker = vi.fn<(args: readonly string[]) => void>();

    startInfrastructure({ dockerBoundary, runDocker, output: vi.fn<(message: string) => void>() });

    const calls = runCompose.mock.calls.map(([args]) => args);
    expect(calls[0]).toEqual(['up', '-d', '--build', '--wait']);
    expect(dockerBoundary.resolveCleanupTargets).toHaveBeenCalledOnce();
    expect(calls[1]?.slice(0, -1)).toEqual([
      'exec',
      '-T',
      'mock-services',
      'node',
      '--input-type=module',
      '-e',
    ]);
    expect(calls[1]?.at(-1)).toContain(
      "put('/__control/resources',{mode:'merge',resources:baseline})",
    );
    expect(calls[1]?.at(-1)).toContain('payment_demo_001');
    expect(dockerBoundary.removeLocalState).not.toHaveBeenCalled();
    expect(runDocker.mock.calls.map(([args]) => args[0])).toEqual(['image']);
  });

  it('replaces a verified legacy stack before starting the canonical environments', () => {
    const runCompose = vi.fn<(args: readonly string[]) => string>((args) => {
      if (args.includes('ps')) {
        return 'backend\ningest-development\ningest-production\npostgres\nworker-development\nworker-production\n';
      }
      if (args.includes('psql')) {
        return canonicalDatabaseState;
      }
      return '';
    });
    const dockerBoundary = {
      runCompose,
      resolveCleanupTargets: vi.fn<() => unknown>(),
      resolveLegacyMarkers: vi.fn<() => { containers: string[]; volumes: string[] }>(() => ({
        containers: ['atlas-worker-production-like-1'],
        volumes: ['atlas-production-like-worker-secrets'],
      })),
      removeLocalState: vi.fn<() => unknown>(),
    };
    const output = vi.fn<(message: string) => void>();

    startInfrastructure({ dockerBoundary, runDocker: vi.fn<() => void>(), output });

    expect(dockerBoundary.removeLocalState).toHaveBeenCalledOnce();
    expect(output.mock.calls.flat().join('\n')).toContain(
      'Detected retired Production-like Atlas resources',
    );
    expect(runCompose).toHaveBeenCalledWith(['up', '-d', '--build', '--wait']);
  });

  it('performs one guarded cleanup and retry when legacy database state survives startup', () => {
    let databaseChecks = 0;
    const runCompose = vi.fn<(args: readonly string[]) => string>((args) => {
      if (args.includes('ps')) {
        return 'backend\ningest-development\ningest-production\npostgres\nworker-development\nworker-production\n';
      }
      if (args.includes('psql')) {
        databaseChecks += 1;
        return databaseChecks === 1 ? legacyDatabaseState : canonicalDatabaseState;
      }
      return '';
    });
    const dockerBoundary = {
      runCompose,
      resolveCleanupTargets: vi.fn<() => unknown>(),
      resolveLegacyMarkers: vi.fn<() => { containers: string[]; volumes: string[] }>(() => ({
        containers: [],
        volumes: [],
      })),
      removeLocalState: vi.fn<() => unknown>(),
    };

    startInfrastructure({
      dockerBoundary,
      runDocker: vi.fn<() => void>(),
      output: vi.fn<(message: string) => void>(),
    });

    expect(dockerBoundary.removeLocalState).toHaveBeenCalledOnce();
    expect(runCompose.mock.calls.filter(([args]) => args[0] === 'up')).toHaveLength(2);
  });

  it('stops with categorized guidance when legacy database state survives the retry', () => {
    const runCompose = vi.fn<(args: readonly string[]) => string>((args) => {
      if (args.includes('ps')) {
        return 'backend\ningest-development\ningest-production\npostgres\nworker-development\nworker-production\n';
      }
      if (args.includes('psql')) {
        return legacyDatabaseState;
      }
      return '';
    });
    const dockerBoundary = {
      runCompose,
      resolveCleanupTargets: vi.fn<() => unknown>(),
      resolveLegacyMarkers: vi.fn<() => { containers: string[]; volumes: string[] }>(() => ({
        containers: [],
        volumes: [],
      })),
      removeLocalState: vi.fn<() => unknown>(),
    };

    expect(() =>
      startInfrastructure({
        dockerBoundary,
        runDocker: vi.fn<() => void>(),
        output: vi.fn<(message: string) => void>(),
      }),
    ).toThrow('[legacy-database-state]');
    expect(dockerBoundary.removeLocalState).toHaveBeenCalledOnce();
    expect(runCompose.mock.calls.filter(([args]) => args[0] === 'up')).toHaveLength(2);
  });

  it('categorizes a canonical startup failure during the single recovery attempt', () => {
    let startupAttempts = 0;
    const runCompose = vi.fn<(args: readonly string[]) => string>((args) => {
      if (args[0] === 'up') {
        startupAttempts += 1;
        if (startupAttempts === 2) throw new Error('worker failed its health check');
      }
      if (args.includes('ps')) {
        return 'backend\ningest-development\ningest-production\npostgres\nworker-development\nworker-production\n';
      }
      if (args.includes('psql')) return legacyDatabaseState;
      return '';
    });
    const dockerBoundary = {
      runCompose,
      resolveCleanupTargets: vi.fn<() => unknown>(),
      resolveLegacyMarkers: vi.fn<() => { containers: string[]; volumes: string[] }>(() => ({
        containers: [],
        volumes: [],
      })),
      removeLocalState: vi.fn<() => unknown>(),
    };

    expect(() =>
      startInfrastructure({
        dockerBoundary,
        runDocker: vi.fn<() => void>(),
        output: vi.fn<(message: string) => void>(),
      }),
    ).toThrow('[legacy-recovery-failed]');
  });

  it('preserves an already-canonical stack and its durable data', () => {
    const runCompose = vi.fn<(args: readonly string[]) => string>((args) => {
      if (args.includes('ps')) {
        return 'backend\ningest-development\ningest-production\npostgres\nworker-development\nworker-production\n';
      }
      if (args.includes('psql')) {
        return canonicalDatabaseState;
      }
      return '';
    });
    const dockerBoundary = {
      runCompose,
      resolveCleanupTargets: vi.fn<() => unknown>(),
      resolveLegacyMarkers: vi.fn<() => { containers: string[]; volumes: string[] }>(() => ({
        containers: [],
        volumes: [],
      })),
      removeLocalState: vi.fn<() => unknown>(),
    };

    startInfrastructure({
      dockerBoundary,
      runDocker: vi.fn<() => void>(),
      output: vi.fn<(message: string) => void>(),
    });

    expect(dockerBoundary.removeLocalState).not.toHaveBeenCalled();
  });
});
