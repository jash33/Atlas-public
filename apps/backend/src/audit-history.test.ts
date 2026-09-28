import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `audit_history_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const migrationOptions = {
  databaseUrl,
  schema: schemaName,
  migrationsSchema: schemaName,
  createSchema: true,
  createMigrationsSchema: true,
  dir: resolve('apps/backend/migrations'),
  direction: 'up' as const,
  migrationsTable: 'atlas_migrations',
  advisoryLockMode: 'wait' as const,
  lockValue: 38,
};
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await runner({ ...migrationOptions, count: 23 });
  await pool.query(`
    INSERT INTO organizations (id) VALUES ('org_audit');
    INSERT INTO capability_discoveries (organization_id, service_id, trigger)
    VALUES ('org_audit', 'payments', 'repository-push');
  `);
  await runner({ ...migrationOptions, count: 3 });
  app = createApp(pool);
});

afterAll(async () => {
  await pool.end();
});

describe('audit history API', () => {
  it('backfills the existing lifecycle and returns the complete history', async () => {
    await pool.query(`
      INSERT INTO capability_discoveries (organization_id, service_id, trigger)
      SELECT 'org_audit', 'payments-' || sequence, 'daily-poll'
      FROM generate_series(1, 101) sequence;
    `);

    const response = await app.request('/v1/audit-entries?organizationId=org_audit');

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{ eventType: string; details: Record<string, unknown> }>;
    };
    expect(body.entries).toHaveLength(102);
    expect(body.entries.at(-1)).toMatchObject({
      eventType: 'discovery',
      details: { serviceId: 'payments', trigger: 'repository-push' },
    });
  });

  it('names the person who acted and the person targeted by a membership event', async () => {
    await pool.query(`
      INSERT INTO users (id, email, name)
      VALUES ('user_maya', 'maya@example.com', 'Maya Chen'),
             ('user_owen', 'owen@example.com', 'Owen Brooks');
      INSERT INTO organization_memberships (organization_id, user_id, role)
      VALUES ('org_audit', 'user_maya', 'admin'), ('org_audit', 'user_owen', 'operator');
      INSERT INTO audit_entries
        (organization_id, event_type, subject_type, subject_id, actor_id, details)
      VALUES ('org_audit', 'membership', 'membership', 'user_owen', 'user_maya',
              '{"role":"operator"}');
    `);

    const response = await app.request('/v1/audit-entries?organizationId=org_audit');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { entries: Array<Record<string, unknown>> };
    expect(body.entries[0]).toMatchObject({
      eventType: 'membership',
      actorId: 'user_maya',
      actorName: 'Maya Chen',
      subjectId: 'user_owen',
      subjectName: 'Owen Brooks',
    });
  });
});
