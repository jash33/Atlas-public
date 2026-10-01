import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { migrationCountThrough } from './migration-test-support.js';
import { resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schema = `resource_control_migration_${randomUUID().replaceAll('-', '')}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const migrationOptions = {
  databaseUrl,
  schema,
  migrationsSchema: schema,
  createSchema: true,
  createMigrationsSchema: true,
  dir: resolve('apps/backend/migrations'),
  migrationsTable: 'atlas_migrations',
  advisoryLockMode: 'wait' as const,
};
const capabilityVersionId = 'a'.repeat(64);

beforeAll(async () => {
  await runner({
    ...migrationOptions,
    direction: 'up',
    count: migrationCountThrough('060_capability_risk_notifications'),
  });

  await pool.query(`
    INSERT INTO organizations (id) VALUES ('org_resource_control_migration');
    INSERT INTO environments (organization_id, id, name, kind)
    VALUES ('org_resource_control_migration', 'development', 'Development', 'development');
  `);
  const source = await pool.query<{ id: string }>(
    `INSERT INTO source_documents
       (organization_id, service_id, format, document, document_hash, repository, commit_sha, path)
     VALUES ($1, 'payments', 'openapi', '{}', $2, 'atlas', 'legacy', 'payment.json')
     RETURNING id`,
    ['org_resource_control_migration', 'b'.repeat(64)],
  );
  const identity = await pool.query<{ id: string }>(
    `INSERT INTO capability_identities
       (organization_id, kind, service_id, operation_id)
     VALUES ($1, 'openapi', 'payments', 'getPayment')
     RETURNING id`,
    ['org_resource_control_migration'],
  );
  await pool.query(
    `INSERT INTO capability_versions
       (organization_id, capability_version_id, capability_identity_id, source_document_id,
        manifest_annotation_id, capability_fragment_hash, capability_fragment)
     VALUES ($1, $2, $3, $4, NULL, $5, '{}')`,
    [
      'org_resource_control_migration',
      capabilityVersionId,
      identity.rows[0]!.id,
      source.rows[0]!.id,
      'c'.repeat(64),
    ],
  );
  await pool.query(
    `INSERT INTO capability_sandbox_target_revisions
       (organization_id, capability_version_id, environment_id, target_key, revision,
        base_url, hostname, health_path, control_paths, configured_by)
     VALUES ($1, $2, 'development', 'default', 1, 'http://mock-services:4100',
       'mock-services', '/health', $3, 'migration-test')`,
    [
      'org_resource_control_migration',
      capabilityVersionId,
      JSON.stringify({
        state: '/custom/provider-state',
        faults: '/__control/faults',
        observations: '/__control/observations',
      }),
    ],
  );
  await pool.query(
    `INSERT INTO capability_test_data_profile_versions
       (organization_id, capability_version_id, profile_key, version, inputs, target_state,
        setup_assumptions, configured_by)
     VALUES
       ($1, $2, 'legacy', 1, '{}', $3, '[]', 'migration-test'),
       ($1, $2, 'legacy', 2, '{}', '{}', '[]', 'migration-test'),
       ($1, $2, 'legacy', 3, '{}', '{"custom":[]}', '[]', 'migration-test')`,
    [
      'org_resource_control_migration',
      capabilityVersionId,
      JSON.stringify({
        payments: [{ paymentId: 'pay_migrated' }],
        invoices: [{ invoiceId: 'inv_migrated', version: 4 }],
      }),
    ],
  );
});

afterAll(async () => {
  await pool.end();
  if (!/^resource_control_migration_[a-f0-9]+$/.test(schema)) {
    throw new Error('Unsafe test schema');
  }
  const cleanup = new Pool({ connectionString: databaseUrl });
  try {
    await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
});

describe('resource control paths migration', () => {
  it('rewrites legacy rows atomically and restores immutable-row enforcement', async () => {
    await expect(runner({ ...migrationOptions, direction: 'up' })).rejects.toThrow(
      'cannot migrate unsupported capability test-data target state',
    );
    await expect(
      pool.query(
        `SELECT control_paths FROM capability_sandbox_target_revisions
         WHERE organization_id = $1`,
        ['org_resource_control_migration'],
      ),
    ).resolves.toMatchObject({
      rows: [{ control_paths: { state: '/custom/provider-state' } }],
    });

    await pool.query(
      `DELETE FROM capability_test_data_profile_versions
       WHERE organization_id = $1 AND profile_key = 'legacy' AND version = 3`,
      ['org_resource_control_migration'],
    );
    await runner({ ...migrationOptions, direction: 'up' });

    const target = await pool.query<{ control_paths: Record<string, string> }>(
      `SELECT control_paths FROM capability_sandbox_target_revisions
       WHERE organization_id = $1`,
      ['org_resource_control_migration'],
    );
    expect(target.rows[0]?.control_paths).toEqual({
      resources: '/__control/resources',
      faults: '/__control/faults',
      observations: '/__control/observations',
    });

    const profiles = await pool.query<{ version: number; target_state: unknown }>(
      `SELECT version, target_state FROM capability_test_data_profile_versions
       WHERE organization_id = $1 ORDER BY version`,
      ['org_resource_control_migration'],
    );
    expect(profiles.rows).toEqual([
      {
        version: 1,
        target_state: {
          mode: 'replace',
          resources: [
            {
              service: 'payments',
              collection: 'payments',
              id: 'pay_migrated',
              document: { paymentId: 'pay_migrated' },
            },
            {
              service: 'billing',
              collection: 'invoices',
              id: 'inv_migrated',
              document: { invoiceId: 'inv_migrated', version: 4 },
            },
          ],
        },
      },
      { version: 2, target_state: { mode: 'replace', resources: [] } },
    ]);

    await expect(
      pool.query(
        `UPDATE capability_sandbox_target_revisions SET hostname = 'changed'
         WHERE organization_id = $1`,
        ['org_resource_control_migration'],
      ),
    ).rejects.toThrow('sandbox target and test-data revisions are immutable');
    await expect(
      pool.query(
        `UPDATE capability_test_data_profile_versions SET inputs = '{"changed":true}'
         WHERE organization_id = $1`,
        ['org_resource_control_migration'],
      ),
    ).rejects.toThrow('sandbox target and test-data revisions are immutable');
  });
});
