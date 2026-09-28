import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vite-plus/test';

import { loadBackendConfig } from './config.js';

const temporaryDirectories: string[] = [];

it('rejects shared human tokens in customer mode and unknown sign-in modes', () => {
  expect(() =>
    loadBackendConfig({ ATLAS_AUTH_MODE: 'customer', ATLAS_APPROVAL_ADMIN_TOKEN: 'demo-secret' }),
  ).toThrow('Remove shared human demo tokens');
  expect(() => loadBackendConfig({ ATLAS_AUTH_MODE: 'typo' })).toThrow(/authMode/);
});

it('configures customer worker credentials without requiring human demo tokens', () => {
  const config = loadBackendConfig({
    ATLAS_AUTH_MODE: 'customer',
    ATLAS_EXECUTION_ORGANIZATION_ID: 'customer',
    ATLAS_WORKER_CREDENTIALS: JSON.stringify([
      { organizationId: 'customer', environmentId: 'production', token: 'machine-only' },
    ]),
    EXECUTION_GRANT_PRIVATE_KEYS: JSON.stringify({ production: 'test-signing-key' }),
  });
  expect(config.authMode).toBe('customer');
  expect(config.workerCredentials).toHaveLength(1);
  expect(config.approvalAdminToken).toBeNull();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('loads the planning credential from a secret file without requiring it in the environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-planner-config-'));
  temporaryDirectories.push(directory);
  const secretPath = join(directory, 'openai-api-key');
  writeFileSync(secretPath, 'test-secret-from-file\n', { mode: 0o600 });

  const config = loadBackendConfig({
    OPENAI_API_KEY_FILE: secretPath,
    OPENAI_MODEL: 'configured-model',
  });

  expect(config.openAiApiKey).toBe('test-secret-from-file');
  expect(config.openAiModel).toBe('configured-model');
});

it('loads environment-specific workflow sandbox runner URLs', () => {
  const config = loadBackendConfig({
    ATLAS_SANDBOX_RUNNER_URLS: JSON.stringify({
      development: 'http://worker-development:4200',
      production: 'http://worker-production:4200',
    }),
  });

  expect(config.workflowSandboxRunnerUrls).toEqual({
    development: 'http://worker-development:4200',
    production: 'http://worker-production:4200',
  });
});

it('selects the Burger Town demo profile only when requested', () => {
  expect(loadBackendConfig({}).demoProfile).toBe('sample');
  expect(loadBackendConfig({ ATLAS_DEMO_PROFILE: 'burger-town' }).demoProfile).toBe('burger-town');
  expect(() => loadBackendConfig({ ATLAS_DEMO_PROFILE: 'unknown' })).toThrow(/sample|burger-town/);
});

it('keeps the prepared Burger Town addresses away from the Atlas ingest ports', () => {
  const config = loadBackendConfig({ ATLAS_DEMO_PROFILE: 'burger-town' });

  expect(config.burgerTownAllowedHosts).toEqual(['host.docker.internal']);
  expect(config.burgerTownAllowedPrivateHosts).toEqual(['host.docker.internal']);
  expect(config.burgerTownApplicationUrls).toEqual(['http://host.docker.internal:43123']);
  expect(config.burgerTownOpenApiUrls).toEqual(['http://host.docker.internal:43123/openapi.json']);
  expect(config.burgerTownApplicationUrls).not.toContain('http://host.docker.internal:4300');
});

it('allows the local Burger Town connection settings to be disabled', () => {
  const config = loadBackendConfig({
    ATLAS_BURGER_TOWN_ALLOWED_HOSTS: '',
    ATLAS_BURGER_TOWN_ALLOWED_PRIVATE_HOSTS: '',
    ATLAS_BURGER_TOWN_APPLICATION_URLS: '',
    ATLAS_BURGER_TOWN_OPENAPI_URLS: '',
  });

  expect(config.burgerTownAllowedHosts).toEqual([]);
  expect(config.burgerTownAllowedPrivateHosts).toEqual([]);
  expect(config.burgerTownApplicationUrls).toEqual([]);
  expect(config.burgerTownOpenApiUrls).toEqual([]);
});

it('loads the separate Burger Town address allowlist', () => {
  const config = loadBackendConfig({
    CAPABILITY_SOURCE_ALLOWED_HOSTS: 'mock-specs',
    ATLAS_BURGER_TOWN_ALLOWED_HOSTS: 'burger-town.test, burger-town-spec.test',
    ATLAS_BURGER_TOWN_ALLOWED_PRIVATE_HOSTS: 'burger-town.test',
    ATLAS_BURGER_TOWN_APPLICATION_URLS: 'https://burger-town.test/',
    ATLAS_BURGER_TOWN_OPENAPI_URLS: 'https://burger-town-spec.test/openapi.json',
  });

  expect(config.capabilitySourceAllowedHosts).toEqual(['mock-specs']);
  expect(config.burgerTownAllowedHosts).toEqual(['burger-town.test', 'burger-town-spec.test']);
  expect(config.burgerTownAllowedPrivateHosts).toEqual(['burger-town.test']);
  expect(config.burgerTownApplicationUrls).toEqual(['https://burger-town.test/']);
  expect(config.burgerTownOpenApiUrls).toEqual(['https://burger-town-spec.test/openapi.json']);
});
