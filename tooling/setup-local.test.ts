import { createBackendAtlasBundleRunGate } from '../apps/worker/src/backend-bundle-run-gate.js';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vite-plus/test';

import { generateLocalCredentials, setupLocal } from './setup-local.mjs';

describe('private local setup', () => {
  it('generates bundle trust that the worker can load', async () => {
    const values = generateLocalCredentials();
    await expect(
      createBackendAtlasBundleRunGate({
        backendUrl: 'http://localhost:4000',
        organizationId: 'org_atlas',
        environmentId: 'production',
        workerToken: values.ATLAS_PRODUCTION_WORKER_TOKEN,
        grantPublicKey: values.ATLAS_PRODUCTION_GRANT_PUBLIC_KEY,
        trustConfigJson: values.ATLAS_BUNDLE_TRUST_CONFIG,
      }),
    ).resolves.toBeDefined();
  });
  it('creates fresh passwords, matching worker credentials and separate signing keys', () => {
    const values = generateLocalCredentials();
    expect(values.ATLAS_DEMO_ADMIN_PASSWORD).not.toBe(
      generateLocalCredentials().ATLAS_DEMO_ADMIN_PASSWORD,
    );
    const workers = JSON.parse(values.ATLAS_WORKER_CREDENTIALS);
    expect(workers[0].token).toBe(values.ATLAS_DEVELOPMENT_WORKER_TOKEN);
    expect(workers[1].token).toBe(values.ATLAS_PRODUCTION_WORKER_TOKEN);
    expect(values.ATLAS_INGEST_BACKEND_TOKEN).toBe(values.ATLAS_PLANNING_AUTHOR_TOKEN);
    const grants = JSON.parse(values.EXECUTION_GRANT_PRIVATE_KEYS);
    const bundle = JSON.parse(values.ATLAS_BUNDLE_TRUST_CONFIG).keys[0];
    expect(
      new Set([grants.development, grants.production, values.ATLAS_BUNDLE_SIGNING_PRIVATE_KEY])
        .size,
    ).toBe(3);
    for (const [privateKey, publicKey] of [
      [grants.development, values.ATLAS_DEVELOPMENT_GRANT_PUBLIC_KEY],
      [grants.production, values.ATLAS_PRODUCTION_GRANT_PUBLIC_KEY],
      [values.ATLAS_BUNDLE_SIGNING_PRIVATE_KEY, bundle.publicKey],
    ]) {
      const payload = Buffer.from('test payload');
      const signature = sign(
        null,
        payload,
        createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
      );
      expect(
        verify(
          null,
          payload,
          createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
          signature,
        ),
      ).toBe(true);
    }
  });

  it('writes a readable environment file and refuses to overwrite credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-setup-test-'));
    try {
      writeFileSync(join(directory, '.env.example'), 'TEMPORAL_NAMESPACE=atlas-development\n');
      setupLocal(directory);
      const before = readFileSync(join(directory, '.env'), 'utf8');
      expect(parseEnv(before).TEMPORAL_NAMESPACE).toBe('atlas-development');
      expect(parseEnv(before).ATLAS_DEMO_ADMIN_PASSWORD).toHaveLength(64);
      expect(() => setupLocal(directory)).toThrow('already exists');
      expect(readFileSync(join(directory, '.env'), 'utf8')).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
