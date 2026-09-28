import { describe, expect, it, vi } from 'vite-plus/test';

import packageJson from '../package.json';

import { composePrefixForDemo, demoEnvironment, prepareDemo } from './prepare-demo.mjs';

const runningServices = [
  'backend',
  'ingest-development',
  'ingest-production',
  'mock-services',
  'mock-specs',
  'postgres',
  'provider-repair-gateway',
  'temporal',
  'temporal-ui',
  'worker-development',
  'worker-production',
].join('\n');

const emptyCatalogState = JSON.stringify({
  organizations: 1,
  users: 3,
  memberships: 3,
  environments: 2,
  capabilityData: 0,
  repositories: 0,
});

describe('prepare demo command', () => {
  it('loads the documented root env file when it exists', () => {
    expect(composePrefixForDemo(true)).toEqual([
      'compose',
      '--env-file',
      expect.stringMatching(/[\\/]\.env$/),
      '-f',
      expect.stringMatching(/[\\/]infra[\\/]compose[\\/]compose\.yaml$/),
    ]);
    expect(composePrefixForDemo(false)).not.toContain('--env-file');
  });

  it('always prepares the empty Burger Town profile', () => {
    expect(demoEnvironment({ ATLAS_DEMO_PROFILE: 'sample', PATH: 'docker-path' })).toEqual({
      ATLAS_DEMO_PROFILE: 'burger-town',
      PATH: 'docker-path',
    });
  });

  it('clears Atlas and verifies an empty catalog with no connected repositories', async () => {
    const runCompose = vi.fn<(args: readonly string[]) => Promise<string>>(async (args) => {
      if (args[0] === 'ps') return runningServices;
      return args.includes('-Atc') ? emptyCatalogState : '';
    });
    const output = vi.fn<(message: string) => void>();
    const removeLocalState = vi.fn<() => Promise<string>>(async () => '');

    await prepareDemo({
      dockerBoundary: {
        runCompose,
        removeLocalState,
        resolveCleanupTargets: vi.fn<() => unknown>(),
      },
      output,
    });

    expect(removeLocalState).toHaveBeenCalledOnce();
    expect(runCompose).toHaveBeenCalledWith(['up', '-d', '--build', '--wait']);
    const calls = runCompose.mock.calls.map(([args]) => args);
    expect(calls.some((args) => args.some((value) => value.includes('INSERT INTO')))).toBe(false);
    expect(calls.some((args) => args.some((value) => value.includes('demo-seed.js')))).toBe(false);
    const verification = calls.find((args) => args.includes('-Atc'))?.at(-1);
    expect(verification).toContain('capabilityData');
    expect(verification).toContain('github_repository_connections');
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('Demo is ready with an empty capability catalog.'),
    );
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining(
        'Repositories: none connected; add a public repository in the Console.',
      ),
    );
    expect(packageJson.scripts['prepare-demo']).toBe('node tooling/prepare-demo.mjs');
  });

  it('retries stack startup after a transient Compose failure', async () => {
    let startupAttempts = 0;
    const runCompose = vi.fn<(args: readonly string[]) => Promise<string>>(async (args) => {
      if (args[0] === 'up' && ++startupAttempts === 1) throw new Error('startup failed');
      if (args[0] === 'ps') return runningServices;
      return args.includes('-Atc') ? emptyCatalogState : '';
    });
    const wait = vi.fn<(milliseconds: number) => Promise<void>>(async () => undefined);

    await prepareDemo({
      dockerBoundary: {
        runCompose,
        removeLocalState: vi.fn<() => Promise<string>>(async () => ''),
        resolveCleanupTargets: vi.fn<() => unknown>(),
      },
      output: vi.fn<(message: string) => void>(),
      wait,
    });

    expect(runCompose.mock.calls.filter(([args]) => args[0] === 'up')).toHaveLength(2);
    expect(wait).toHaveBeenCalledWith(1_000);
  });

  it('fails clearly when a required service is not running', async () => {
    const runCompose = vi.fn<(args: readonly string[]) => Promise<string>>(async (args) =>
      args[0] === 'ps' ? runningServices.replace('temporal-ui\n', '') : '',
    );

    await expect(
      prepareDemo({
        dockerBoundary: {
          runCompose,
          removeLocalState: vi.fn<() => Promise<string>>(async () => ''),
          resolveCleanupTargets: vi.fn<() => unknown>(),
        },
        output: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toThrow(
      'Demo preparation failed during service health check: required services are not running: temporal-ui',
    );
  });

  it('fails when capabilities remain after preparation', async () => {
    const runCompose = vi.fn<(args: readonly string[]) => Promise<string>>(async (args) => {
      if (args[0] === 'ps') return runningServices;
      return args.includes('-Atc')
        ? JSON.stringify({ ...JSON.parse(emptyCatalogState), capabilityData: 1 })
        : '';
    });

    await expect(
      prepareDemo({
        dockerBoundary: {
          runCompose,
          removeLocalState: vi.fn<() => Promise<string>>(async () => ''),
          resolveCleanupTargets: vi.fn<() => unknown>(),
        },
        output: vi.fn<(message: string) => void>(),
      }),
    ).rejects.toThrow(
      'Demo preparation failed during empty capability catalog verification: capabilityData: expected 0, received 1',
    );
  });
});
