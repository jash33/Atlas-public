import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAtlasDockerBoundary } from './atlas-local-state.mjs';
import { pruneAtlasDockerStorage } from './docker-storage.mjs';
import { demoProviderResetScript } from './demo-provider-baseline.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(workspaceRoot, 'infra/compose/compose.yaml');
const rootEnvFile = resolve(workspaceRoot, '.env');
const expectedEnvironments = Object.freeze([
  Object.freeze({ id: 'development', name: 'Development', kind: 'development' }),
  Object.freeze({ id: 'production', name: 'Production', kind: 'production' }),
]);
const requiredCanonicalServices = Object.freeze([
  'backend',
  'ingest-development',
  'ingest-production',
  'postgres',
  'worker-development',
  'worker-production',
]);

export function composePrefixForInfrastructure(envFilePresent = existsSync(rootEnvFile)) {
  return ['compose', ...(envFilePresent ? ['--env-file', rootEnvFile] : []), '-f', composeFile];
}

function defaultRunDocker(args) {
  const capturesOutput =
    args[0] === 'container' ||
    args[0] === 'volume' ||
    args.includes('config') ||
    args.includes('ps') ||
    args.includes('psql');
  return execFileSync('docker', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    stdio: capturesOutput ? 'pipe' : 'inherit',
  });
}

// TODO(#148-transition-removal): remove database detection after the local rename window.
function databaseEnvironmentQuery() {
  return `SELECT json_build_object(
    'legacyEnvironmentCount',
      (SELECT count(*) FROM environments WHERE id = 'production-like'),
    'environments',
      coalesce(json_agg(json_build_object('id', id, 'name', name, 'kind', kind)
        ORDER BY id), '[]'::json)
    ) FROM environments WHERE organization_id = 'org_atlas';`;
}

function verifyCanonicalInfrastructure(localState) {
  const services = new Set(
    String(localState.runCompose(['ps', '--status', 'running', '--services']))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean),
  );
  const missingServices = requiredCanonicalServices.filter((service) => !services.has(service));
  const retiredServices = [...services].filter((service) => service.includes('production-like'));
  if (missingServices.length > 0 || retiredServices.length > 0) {
    throw new Error(
      `[canonical-services] Infrastructure verification failed. Missing: ${missingServices.join(', ') || 'none'}; retired: ${retiredServices.join(', ') || 'none'}. Inspect with docker compose ps.`,
    );
  }

  const databaseOutput = String(
    localState.runCompose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'atlas',
      '-Atc',
      databaseEnvironmentQuery(),
    ]),
  ).trim();
  let databaseState;
  try {
    databaseState = JSON.parse(databaseOutput);
  } catch {
    throw new Error(
      `[canonical-environment-state] PostgreSQL returned invalid environment state. Run pnpm prepare-demo for a full local reset.`,
    );
  }
  if (databaseState.legacyEnvironmentCount > 0) return { legacyDatabaseState: true };
  if (JSON.stringify(databaseState.environments) !== JSON.stringify(expectedEnvironments)) {
    throw new Error(
      `[canonical-environment-state] Expected exactly Development and Production, received ${databaseOutput || 'no environment state'}. Run pnpm prepare-demo for a full local reset.`,
    );
  }
  return { legacyDatabaseState: false };
}

function startCanonicalStack(localState, output) {
  localState.runCompose(['up', '-d', '--build', '--wait']);
  localState.runCompose([
    'exec',
    '-T',
    'mock-services',
    'node',
    '--input-type=module',
    '-e',
    demoProviderResetScript('merge'),
  ]);
  output('Ensured demo provider fixtures exist without deleting other provider resources.');
  return verifyCanonicalInfrastructure(localState);
}

export function startInfrastructure({
  dockerBoundary,
  runDocker = defaultRunDocker,
  output = console.log,
} = {}) {
  const localState =
    dockerBoundary ??
    createAtlasDockerBoundary({
      composePrefix: composePrefixForInfrastructure(),
      runDocker,
      output,
    });
  try {
    const legacyMarkers = localState.resolveLegacyMarkers?.() ?? {
      containers: [],
      volumes: [],
    };
    if (legacyMarkers.containers.length > 0 || legacyMarkers.volumes.length > 0) {
      output(
        'Detected retired Production-like Atlas resources. Removing disposable local state before canonical startup.',
      );
      localState.removeLocalState();
    } else {
      localState.resolveCleanupTargets();
    }

    let verification = startCanonicalStack(localState, output);
    if (verification.legacyDatabaseState) {
      output(
        'Detected retired Production-like database state. Removing disposable Atlas state and retrying canonical startup once.',
      );
      localState.removeLocalState();
      try {
        verification = startCanonicalStack(localState, output);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `[legacy-recovery-failed] Canonical startup failed during the single recovery attempt: ${detail}. Inspect with docker compose ps, then run pnpm prepare-demo.`,
          { cause: error },
        );
      }
      if (verification.legacyDatabaseState) {
        throw new Error(
          '[legacy-database-state] Production-like rows survived the single recovery attempt. Inspect Atlas Docker volumes, then run pnpm prepare-demo.',
        );
      }
    }
  } finally {
    pruneAtlasDockerStorage({ runDocker, output, buildCache: 'preserve' });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startInfrastructure();
}
