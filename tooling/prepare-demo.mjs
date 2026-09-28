import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAtlasDockerBoundary } from './atlas-local-state.mjs';
import { pruneAtlasDockerStorage } from './docker-storage.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(workspaceRoot, 'infra/compose/compose.yaml');
const rootEnvFile = resolve(workspaceRoot, '.env');

export function composePrefixForDemo(envFilePresent = existsSync(rootEnvFile)) {
  return ['compose', ...(envFilePresent ? ['--env-file', rootEnvFile] : []), '-f', composeFile];
}

export function demoEnvironment(environment = process.env) {
  return { ...environment, ATLAS_DEMO_PROFILE: 'burger-town' };
}

const requiredServices = [
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
];

function runDemoDocker(args) {
  const capturesOutput =
    args[0] === 'container' ||
    args[0] === 'volume' ||
    args.includes('config') ||
    args.includes('ps') ||
    args.includes('psql');
  return execFileSync('docker', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: demoEnvironment(),
    stdio: capturesOutput ? 'pipe' : 'inherit',
  });
}

const demoDockerBoundary = createAtlasDockerBoundary({
  composePrefix: composePrefixForDemo(),
  runDocker: runDemoDocker,
});

function databaseStateQuery() {
  return `SELECT json_build_object(
    'organizations', (SELECT count(*) FROM organizations
       WHERE id = 'org_atlas' AND name = 'Burger Town'),
    'users', (SELECT count(*) FROM users
       WHERE (id = 'atlas-author' AND email = 'demo@burgertown.local'
              AND name = 'Burger Town Demo')
          OR (id = 'atlas-admin' AND email = 'admin@burgertown.local')
          OR (id = 'atlas-operator' AND email = 'operator@burgertown.local')),
    'memberships', (SELECT count(*) FROM organization_memberships
       WHERE organization_id = 'org_atlas'
         AND ((user_id = 'atlas-author' AND role = 'author')
           OR (user_id = 'atlas-admin' AND role = 'admin')
           OR (user_id = 'atlas-operator' AND role = 'operator'))),
    'environments', (SELECT count(*) FROM environments
       WHERE organization_id = 'org_atlas'
         AND ((id = 'development' AND name = 'Development' AND kind = 'development')
           OR (id = 'production' AND name = 'Production' AND kind = 'production'))),
    'capabilityData', (SELECT sum(row_count) FROM (
       SELECT count(*) AS row_count FROM source_documents WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM capability_source_registrations WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM capability_discoveries WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM capability_discovery_changes WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM capability_identities WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM capability_versions WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM environment_capability_observations WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM capability_approvals WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM capability_host_policies WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM workflow_versions WHERE organization_id = 'org_atlas'
       UNION ALL SELECT count(*) FROM workflow_runs WHERE organization_id = 'org_atlas'
     ) empty_catalog),
    'repositories', (SELECT count(*) FROM github_repository_connections
       WHERE organization_id = 'org_atlas'));`;
}

function pause(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export async function prepareDemo({
  dockerBoundary = demoDockerBoundary,
  output = console.log,
  wait = pause,
} = {}) {
  const removeLocalState = () => Promise.resolve(dockerBoundary.removeLocalState());
  const runCompose = (args) => Promise.resolve(dockerBoundary.runCompose(args));
  async function stage(name, action) {
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Demo preparation failed during ${name}: ${message}`, { cause: error });
    }
  }

  await stage('local state removal', () => removeLocalState());
  await stage('stack startup', async () => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await runCompose(['up', '-d', '--build', '--wait']);
      } catch (error) {
        lastError = error;
        if (attempt < 2) await wait(1_000);
      }
    }
    throw lastError;
  });

  await stage('service health check', async () => {
    const running = new Set(
      String(await runCompose(['ps', '--status', 'running', '--services']))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean),
    );
    const missing = requiredServices.filter((service) => !running.has(service));
    if (missing.length > 0) {
      throw new Error(`required services are not running: ${missing.join(', ')}`);
    }
  });

  await stage('empty capability catalog verification', async () => {
    const result = String(
      await runCompose([
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'postgres',
        '-d',
        'atlas',
        '-Atc',
        databaseStateQuery(),
      ]),
    ).trim();
    let state;
    try {
      state = JSON.parse(result);
    } catch {
      throw new Error(`database check returned ${result || 'no result'}`);
    }
    const expected = {
      organizations: 1,
      users: 3,
      memberships: 3,
      environments: 2,
      capabilityData: 0,
      repositories: 0,
    };
    const wrong = Object.entries(expected)
      .filter(([name, value]) => state[name] !== value)
      .map(([name, value]) => `${name}: expected ${value}, received ${String(state[name])}`);
    if (wrong.length > 0) throw new Error(wrong.join('; '));
  });

  output(`Demo is ready with an empty capability catalog.
  Repositories: none connected; add a public repository in the Console.
  Console:     run pnpm dev --console-only, then open http://localhost:5173/?demoProfile=burger-town&role=author#/capabilities?environmentId=development
  Backend:     http://localhost:4000
  Temporal UI: http://localhost:8080`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareDemo()
    .then(() => pruneAtlasDockerStorage())
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
