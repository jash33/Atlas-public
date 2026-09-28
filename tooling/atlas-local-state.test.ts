import { describe, expect, it, vi } from 'vite-plus/test';

import { createAtlasDockerBoundary } from './atlas-local-state.mjs';

const composeConfig = JSON.stringify({
  name: 'atlas',
  volumes: {
    database: { name: 'atlas-postgres-data' },
    secrets: { name: 'atlas-development-worker-secrets' },
  },
});

function dockerFixture() {
  return vi.fn<(args: readonly string[]) => string>((args) => {
    if (args.includes('config')) return composeConfig;
    if (args[0] === 'container' && args[1] === 'ls') {
      if (args.includes('name=^/atlas-worker-production-like-1$')) {
        return 'atlas-worker-production-like-1';
      }
      if (args.includes('name=^/atlas-temporal-namespace-production-like-1$')) return '';
      return ['atlas-backend-1', 'atlas-worker-production-like-1', 'atlas-copycat-1'].join('\n');
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      if (args.includes('name=atlas-production-like-worker-secrets')) {
        return 'atlas-production-like-worker-secrets';
      }
      return [
        'atlas-postgres-data',
        'atlas-development-worker-secrets',
        'other-project-postgres-data',
        '${UNRESOLVED_VOLUME}',
      ].join('\n');
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const name = args.at(-1);
      return JSON.stringify([
        {
          Name: `/${name}`,
          Config: {
            Labels: {
              'com.docker.compose.project': name === 'atlas-copycat-1' ? 'copycat' : 'atlas',
            },
          },
        },
      ]);
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const name = args.at(-1);
      return JSON.stringify([
        {
          Name: name,
          Labels: {
            'com.docker.compose.project':
              name === 'other-project-postgres-data' ? 'other' : 'atlas',
          },
        },
      ]);
    }
    return '';
  });
}

describe('Atlas local Docker boundary', () => {
  it('detects retired exact names and Production-like Compose service metadata', () => {
    const fixture = dockerFixture();
    const runDocker = vi.fn<(args: readonly string[]) => string>((args) => {
      if (
        args[0] === 'container' &&
        args[1] === 'ls' &&
        args.includes('label=com.docker.compose.project=atlas')
      ) {
        return `${fixture(args)}\natlas-renamed-legacy-worker-1`;
      }
      if (
        args[0] === 'container' &&
        args[1] === 'inspect' &&
        args.at(-1) === 'atlas-renamed-legacy-worker-1'
      ) {
        return JSON.stringify([
          {
            Config: {
              Labels: {
                'com.docker.compose.project': 'atlas',
                'com.docker.compose.service': 'worker-production-like',
              },
            },
          },
        ]);
      }
      return fixture(args);
    });
    const boundary = createAtlasDockerBoundary({
      composePrefix: ['compose', '-f', 'compose.yaml'],
      runDocker,
      output: vi.fn<(message: string) => void>(),
    });

    expect(boundary.resolveLegacyMarkers()).toEqual({
      containers: ['atlas-renamed-legacy-worker-1', 'atlas-worker-production-like-1'],
      volumes: ['atlas-production-like-worker-secrets'],
    });
  });

  it('resolves running, stopped, and orphaned resources only after verifying Atlas ownership', () => {
    const runDocker = dockerFixture();
    const boundary = createAtlasDockerBoundary({
      composePrefix: ['compose', '-f', 'compose.yaml'],
      runDocker,
      output: vi.fn<(message: string) => void>(),
    });

    expect(boundary.resolveCleanupTargets()).toEqual({
      project: 'atlas',
      containers: ['atlas-backend-1', 'atlas-worker-production-like-1'],
      volumes: [
        'atlas-development-worker-secrets',
        'atlas-postgres-data',
        'atlas-production-like-worker-secrets',
      ],
    });
    expect(runDocker).toHaveBeenCalledWith([
      'container',
      'ls',
      '--all',
      '--filter',
      'label=com.docker.compose.project=atlas',
      '--format',
      '{{.Names}}',
    ]);
  });

  it('refuses an unresolved or differently named Compose project', () => {
    const runDocker = vi.fn<(args: readonly string[]) => string>(() =>
      JSON.stringify({ name: 'not-atlas', volumes: {} }),
    );
    const boundary = createAtlasDockerBoundary({
      composePrefix: ['compose', '-f', 'compose.yaml'],
      runDocker,
      output: vi.fn<(message: string) => void>(),
    });

    expect(() => boundary.resolveCleanupTargets()).toThrow(
      'Refusing local state cleanup: expected Compose project atlas',
    );
    expect(runDocker).toHaveBeenCalledTimes(1);
  });

  it('removes the exact resolved boundary without printing data or credentials', () => {
    const runDocker = dockerFixture();
    const output = vi.fn<(message: string) => void>();
    const boundary = createAtlasDockerBoundary({
      composePrefix: ['compose', '-f', 'compose.yaml'],
      runDocker,
      output,
    });

    boundary.removeLocalState();

    expect(runDocker).toHaveBeenCalledWith([
      'compose',
      '-f',
      'compose.yaml',
      'down',
      '--volumes',
      '--remove-orphans',
    ]);
    expect(output).toHaveBeenCalledWith(
      `Removing disposable Atlas local state in Compose project atlas.
  Containers (2): atlas-backend-1, atlas-worker-production-like-1
  Volumes (3): atlas-development-worker-secrets, atlas-postgres-data, atlas-production-like-worker-secrets`,
    );
    expect(runDocker).toHaveBeenCalledWith([
      'container',
      'rm',
      '--force',
      'atlas-backend-1',
      'atlas-worker-production-like-1',
    ]);
    expect(runDocker).toHaveBeenCalledWith([
      'volume',
      'rm',
      'atlas-development-worker-secrets',
      'atlas-postgres-data',
      'atlas-production-like-worker-secrets',
    ]);
    expect(output.mock.calls.flat().join('\n')).not.toMatch(/password|token|secret value/i);
  });
});
