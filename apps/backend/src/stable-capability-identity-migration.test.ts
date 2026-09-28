import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schema = `identity_migration_${randomUUID().replaceAll('-', '')}`;
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

beforeAll(async () => {
  await runner({ ...migrationOptions, direction: 'up', count: 57 });
});

afterAll(async () => {
  await pool.end();
  if (!/^identity_migration_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe test schema');
  const cleanup = new Pool({ connectionString: databaseUrl });
  try {
    await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
});

describe('stable capability identity migration', () => {
  it('merges existing Async identity splits and preserves the latest dependent policy', async () => {
    await pool.query(`INSERT INTO organizations (id) VALUES ('org_identity_upgrade')`);
    const identities = await pool.query<{ id: string }>(
      `INSERT INTO capability_identities
        (organization_id, kind, service_id, operation_id, channel_address, message_key)
       VALUES
        ('org_identity_upgrade', 'asyncapi', 'events', 'publishInvoicePaid',
         'invoice.paid', 'invoicePaid'),
        ('org_identity_upgrade', 'asyncapi', 'event-bus', 'emitInvoicePaid',
         'invoice.paid', 'invoicePaid')
       RETURNING id`,
    );
    await pool.query(
      `INSERT INTO capability_host_policies
        (organization_id, capability_identity_id, environment_id, hostname,
         approved_by, approved_at)
       VALUES
        ('org_identity_upgrade', $1, 'development', 'events.test',
         'older-admin', '2026-01-01T00:00:00Z'),
        ('org_identity_upgrade', $2, 'development', 'events.test',
         'newer-admin', '2026-02-01T00:00:00Z')`,
      [identities.rows[0]!.id, identities.rows[1]!.id],
    );

    await runner({ ...migrationOptions, direction: 'up' });

    const merged = await pool.query<{ id: string }>(
      `SELECT id FROM capability_identities
       WHERE organization_id = 'org_identity_upgrade'
         AND channel_address = 'invoice.paid' AND message_key = 'invoicePaid'`,
    );
    expect(merged.rows).toHaveLength(1);
    await expect(
      pool.query<{ approved_by: string }>(
        `SELECT approved_by FROM capability_host_policies
         WHERE organization_id = 'org_identity_upgrade'
           AND capability_identity_id = $1`,
        [merged.rows[0]!.id],
      ),
    ).resolves.toMatchObject({ rows: [{ approved_by: 'newer-admin' }] });
  });
});
