import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = () => randomBytes(32).toString('hex');
function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

export function generateLocalCredentials() {
  const development = keyPair();
  const production = keyPair();
  const bundle = keyPair();
  const keyId = `local-${randomBytes(8).toString('hex')}`;
  const values = {};
  for (const name of [
    'ATLAS_POSTGRES_PASSWORD',
    'ATLAS_DATABASE_PASSWORD',
    'ATLAS_TEMPORAL_PASSWORD',
    'ATLAS_DEMO_ADMIN_PASSWORD',
    'ATLAS_PLANNING_AUTHOR_TOKEN',
    'ATLAS_APPROVAL_ADMIN_TOKEN',
    'ATLAS_REPAIR_OPERATOR_TOKEN',
    'ATLAS_INGEST_CALLER_TOKEN',
    'ATLAS_DEVELOPMENT_WORKER_TOKEN',
    'ATLAS_PRODUCTION_WORKER_TOKEN',
    'ATLAS_DEVELOPMENT_RESULT_TOKEN',
    'ATLAS_PRODUCTION_RESULT_TOKEN',
  ])
    values[name] = token();
  Object.assign(values, {
    DATABASE_URL: `postgresql://atlas:${values.ATLAS_DATABASE_PASSWORD}@localhost:5432/atlas`,
    ATLAS_TEST_DATABASE_URL: `postgresql://atlas:${values.ATLAS_DATABASE_PASSWORD}@localhost:5432/atlas_test`,
    ATLAS_APPROVAL_ADMIN_ACTOR_ID: 'atlas-admin',
    ATLAS_REPAIR_OPERATOR_ACTOR_ID: 'atlas-operator',
    ATLAS_INGEST_BACKEND_TOKEN: values.ATLAS_PLANNING_AUTHOR_TOKEN,
    ATLAS_WORKER_TOKEN: values.ATLAS_PRODUCTION_WORKER_TOKEN,
    ATLAS_WORKFLOW_RESULT_TOKEN: values.ATLAS_PRODUCTION_RESULT_TOKEN,
    EXECUTION_GRANT_PRIVATE_KEY: production.privateKey,
    EXECUTION_GRANT_PUBLIC_KEY: production.publicKey,
    EXECUTION_GRANT_PRIVATE_KEYS: JSON.stringify({
      development: development.privateKey,
      production: production.privateKey,
    }),
    ATLAS_DEVELOPMENT_GRANT_PUBLIC_KEY: development.publicKey,
    ATLAS_PRODUCTION_GRANT_PUBLIC_KEY: production.publicKey,
    ATLAS_BUNDLE_SIGNING_KEY_ID: keyId,
    ATLAS_BUNDLE_SIGNING_PRIVATE_KEY: bundle.privateKey,
    ATLAS_BUNDLE_TRUST_CONFIG: JSON.stringify({
      keys: [
        {
          keyId,
          algorithm: 'Ed25519',
          publicKey: bundle.publicKey,
          organizationIds: ['org_atlas'],
          environmentIds: ['development', 'production'],
          notBefore: new Date(Date.now() - 60_000).toISOString(),
          notAfter: new Date(Date.now() + 365 * 86400_000).toISOString(),
          status: 'active',
        },
      ],
    }),
    ATLAS_WORKER_CREDENTIALS: JSON.stringify(
      ['development', 'production'].map((environmentId) => ({
        organizationId: 'org_atlas',
        environmentId,
        token: values[`ATLAS_${environmentId.toUpperCase()}_WORKER_TOKEN`],
      })),
    ),
  });
  return values;
}

export function setupLocal(directory = root) {
  const destination = resolve(directory, '.env');
  if (existsSync(destination))
    throw new Error(
      '.env already exists; it was not changed. Back it up before creating new local credentials.',
    );
  const values = {
    ...parseEnv(readFileSync(resolve(directory, '.env.example'), 'utf8')),
    ...generateLocalCredentials(),
  };
  const content =
    '# Private local configuration. Never commit or share this file.\n' +
    Object.entries(values)
      .map(([name, value]) => `${name}='${value}'`)
      .join('\n') +
    '\n';
  writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
}

export function localEnvironment(directory = root) {
  const path = resolve(directory, '.env');
  if (!existsSync(path)) throw new Error('Run pnpm setup:local before starting Atlas.');
  return { ...parseEnv(readFileSync(path, 'utf8')), ...process.env };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupLocal();
  console.log(
    'Created private .env with unique local credentials. Keep it out of version control.',
  );
}
