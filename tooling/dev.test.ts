import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';
import { resolveConfig } from 'vite-plus';

import {
  composePrefixForDevelopment,
  developmentEnvironment,
  developmentMigrationArgs,
  developmentServiceArgs,
} from './dev.mjs';

describe('development launcher', () => {
  it('refuses to move the Console to another port when an old checkout is running', async () => {
    const config = await resolveConfig(
      { configFile: resolve('apps/console/vite.config.ts') },
      'serve',
    );
    expect(config.server.port).toBe(5173);
    expect(config.server.strictPort).toBe(true);
  });
  it('loads the documented root env file when it exists', () => {
    expect(composePrefixForDevelopment(true)).toEqual([
      'compose',
      '--env-file',
      expect.stringMatching(/[\\/]\.env$/),
      '-f',
      expect.stringMatching(/[\\/]infra[\\/]compose[\\/]compose\.yaml$/),
      '-f',
      expect.stringMatching(/[\\/]infra[\\/]compose[\\/]compose\.dev\.yaml$/),
    ]);
    expect(composePrefixForDevelopment(false)).not.toContain('--env-file');
  });

  it('prints the product URLs and identifies infrastructure separately', () => {
    const output = execFileSync(process.execPath, [resolve('tooling/dev.mjs'), '--print-urls'], {
      encoding: 'utf8',
    });

    expect(output).toContain('Atlas development URLs');
    expect(output).toContain('Console:       http://localhost:5173');
    expect(output).toContain('Backend:       http://localhost:4000/health');
    expect(output).toContain('Ingest:        http://localhost:4300/ingest');
    expect(output).toContain('Mock services: http://localhost:4100');
    expect(output).toContain('Temporal UI:   http://localhost:8080');
    expect(output).toContain('requires `pnpm infra:up`');
  });

  it('routes development through the Vite launcher', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.dev).toBe('node tooling/dev.mjs');
  });

  it('rebuilds only the hot-reloading development services', () => {
    expect(developmentServiceArgs()).toEqual([
      'up',
      '-d',
      '--no-deps',
      '--build',
      '--force-recreate',
      '--wait',
      'backend',
      'ingest-development',
    ]);
  });

  it('applies pending migrations before starting development services', () => {
    expect(developmentMigrationArgs()).toEqual(['run', '--rm', '--build', 'atlas-migrate']);
  });

  it('starts the backend and Console with Burger Town as the default demo profile', () => {
    expect(developmentEnvironment({ PATH: 'test-path' })).toEqual({
      PATH: 'test-path',
      ATLAS_DEMO_PROFILE: 'burger-town',
      VITE_ATLAS_DEMO_PROFILE: 'burger-town',
    });
  });

  it('keeps the Console out of Docker so Vite is the only local frontend runtime', () => {
    const compose = readFileSync(resolve('infra/compose/compose.yaml'), 'utf8');

    expect(compose).not.toMatch(/^  console:\s*$/m);
    expect(existsSync(resolve('apps/console/Dockerfile'))).toBe(false);
  });

  it('polls mounted backend and ingest source files for Windows Docker hot reload', () => {
    const compose = readFileSync(resolve('infra/compose/compose.dev.yaml'), 'utf8');
    expect(compose.match(/CHOKIDAR_USEPOLLING: 'true'/g)).toHaveLength(2);
    expect(compose.match(/CHOKIDAR_INTERVAL: '200'/g)).toHaveLength(2);
  });

  it('keeps the Temporal worker gateway off the backend container network', () => {
    const compose = readFileSync(resolve('infra/compose/compose.yaml'), 'utf8');

    expect(compose).toContain('TEMPORAL_ADDRESS: 172.30.100.5:7233');
    expect(compose).toMatch(/temporal-gateway:[\s\S]*?ipv4_address: 172\.30\.100\.5/);
    expect(compose).not.toContain('network_mode: service:backend');
  });

  it('keeps the planned Burger Town app on its own port', () => {
    const compose = readFileSync(resolve('infra/compose/compose.yaml'), 'utf8');
    const exampleEnvironment = readFileSync(resolve('.env.example'), 'utf8');

    for (const contents of [compose, exampleEnvironment]) {
      expect(contents).toContain('http://host.docker.internal:43123');
      expect(contents).toContain('http://host.docker.internal:43123/openapi.json');
      expect(contents).not.toContain(
        'ATLAS_BURGER_TOWN_APPLICATION_URLS=http://host.docker.internal:4300',
      );
    }
  });
});
