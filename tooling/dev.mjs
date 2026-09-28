import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localEnvironment } from './setup-local.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(workspaceRoot, 'infra/compose/compose.yaml');
const developmentComposeFile = resolve(workspaceRoot, 'infra/compose/compose.dev.yaml');
const rootEnvFile = resolve(workspaceRoot, '.env');

export function composePrefixForDevelopment(envFilePresent = existsSync(rootEnvFile)) {
  return [
    'compose',
    ...(envFilePresent ? ['--env-file', rootEnvFile] : []),
    '-f',
    composeFile,
    '-f',
    developmentComposeFile,
  ];
}

export function developmentServiceArgs() {
  return [
    'up',
    '-d',
    '--no-deps',
    '--build',
    '--force-recreate',
    '--wait',
    'backend',
    'ingest-development',
  ];
}

export function developmentMigrationArgs() {
  return ['run', '--rm', '--build', 'atlas-migrate'];
}

export function developmentEnvironment(environment = process.env) {
  return {
    ...environment,
    ATLAS_DEMO_PROFILE: 'burger-town',
    VITE_ATLAS_DEMO_PROFILE: 'burger-town',
  };
}

function printUrls() {
  console.log(`
Atlas development URLs
  Checkout:      ${workspaceRoot}
  Console:       http://localhost:5173
  Backend:       http://localhost:4000/health
  Ingest:        http://localhost:4300/ingest
  Mock services: http://localhost:4100
  Temporal UI:   http://localhost:8080 (requires \`pnpm infra:up\`)
`);
}

export function startDevelopment({ consoleOnly = false } = {}) {
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) {
    console.error(
      'Run the frontend on your host with pnpm dev --console-only, not inside a container.',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Starting the local frontend from ${workspaceRoot}`);
  console.log('Port 5173 must be free. Stop any frontend running from another checkout first.');
  const local = localEnvironment();
  const environment = developmentEnvironment({
    ...local,
    VITE_ATLAS_DEMO_AUTHOR_TOKEN: local.ATLAS_PLANNING_AUTHOR_TOKEN,
    VITE_ATLAS_DEMO_ADMIN_TOKEN: local.ATLAS_APPROVAL_ADMIN_TOKEN,
    VITE_ATLAS_DEMO_OPERATOR_TOKEN: local.ATLAS_REPAIR_OPERATOR_TOKEN,
    VITE_ATLAS_INGEST_CALLER_TOKEN: local.ATLAS_INGEST_CALLER_TOKEN,
  });
  if (!consoleOnly) {
    const composePrefix = composePrefixForDevelopment();
    const migrate = spawnSync('docker', [...composePrefix, ...developmentMigrationArgs()], {
      cwd: workspaceRoot,
      env: environment,
      stdio: 'inherit',
    });
    if (migrate.error || migrate.status !== 0) {
      const message = migrate.error?.message ?? `Docker exited with status ${migrate.status}`;
      console.error(`Unable to apply pending database migrations: ${message}`);
      process.exit(1);
    }

    const startBackend = spawnSync('docker', [...composePrefix, ...developmentServiceArgs()], {
      cwd: workspaceRoot,
      env: environment,
      stdio: 'inherit',
    });
    if (startBackend.error || startBackend.status !== 0) {
      const message =
        startBackend.error?.message ?? `Docker exited with status ${startBackend.status}`;
      console.error(`Unable to start the hot-reloading backend: ${message}`);
      process.exit(1);
    }
  }

  const vitePlus = resolve(workspaceRoot, 'node_modules/vite-plus/bin/vp');
  const child = spawn(process.execPath, [vitePlus, 'run', '@atlas/console#dev'], {
    cwd: workspaceRoot,
    env: environment,
    stdio: 'inherit',
  });

  const summaryTimer = setTimeout(printUrls, 2000);

  child.on('error', (error) => {
    clearTimeout(summaryTimer);
    console.error(`Unable to start Atlas development tasks: ${error.message}`);
    process.exitCode = 1;
  });

  child.on('exit', (code) => {
    clearTimeout(summaryTimer);
    process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--print-urls')) printUrls();
  else startDevelopment({ consoleOnly: process.argv.includes('--console-only') });
}
