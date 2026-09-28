import { resolve } from 'node:path';

import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { resolveTestDatabaseUrl } from './test-database.js';
import { readWorkflowCatalog } from './workflow-catalog.js';
import { migrationCountAfter } from './migration-test-support.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `workflow_catalog_migration_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const migrationOptions = {
  databaseUrl,
  schema: schemaName,
  migrationsSchema: schemaName,
  createSchema: true,
  createMigrationsSchema: true,
  dir: resolve('apps/backend/migrations'),
  migrationsTable: 'atlas_migrations',
  advisoryLockMode: 'wait' as const,
  lockValue: 125,
};

beforeAll(async () => {
  await runner({ ...migrationOptions, direction: 'up' });
  await runner({
    ...migrationOptions,
    direction: 'down',
    count: migrationCountAfter('046_automatic_workflow_retests'),
  });
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA ${schemaName} CASCADE`);
  await pool.end();
});

describe('workflow Catalog migration', () => {
  it('deterministically backfills one identity without breaking version, approval, or run links', async () => {
    await pool.query(`
      INSERT INTO organizations (id) VALUES ('org_legacy');
      INSERT INTO environments (organization_id, id, name, kind)
      VALUES ('org_legacy', 'production', 'Production', 'production');
      INSERT INTO workflow_versions (organization_id, workflow_version_id, created_at) VALUES
        ('org_legacy', 'totally-opaque-first', '2026-01-01T00:00:00Z'),
        ('org_legacy', 'another-unrelated-key', '2026-01-02T00:00:00Z');
      INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
         projection_fingerprint, approved_by, approved_at, lifecycle_status)
      VALUES
        ('org_legacy', 'production', 'totally-opaque-first', '${'a'.repeat(64)}', 'v1',
         '${'b'.repeat(64)}', 'admin', '2026-01-03T00:00:00Z', 'current'),
        ('org_legacy', 'production', 'another-unrelated-key', '${'c'.repeat(64)}', 'v1',
         '${'d'.repeat(64)}', 'admin', '2026-01-04T00:00:00Z', 'superseded');
      INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state,
         started_at, updated_at)
      VALUES
        ('org_legacy', 'production', 'legacy-run', 'totally-opaque-first', '${'e'.repeat(64)}',
         'completed', '2026-01-05T00:00:00Z', '2026-01-05T01:00:00Z');
    `);

    await runner({ ...migrationOptions, direction: 'up' });

    const links = await pool.query<{
      workflow_version_id: string;
      workflow_id: string;
      approval_count: string;
      run_count: string;
    }>(`
      SELECT version.workflow_version_id, version.workflow_id,
             count(DISTINCT approval.workflow_version_id)::text AS approval_count,
             count(DISTINCT run.run_id)::text AS run_count
      FROM workflow_versions version
      LEFT JOIN workflow_approvals approval
        ON approval.organization_id = version.organization_id
       AND approval.workflow_version_id = version.workflow_version_id
      LEFT JOIN workflow_runs run
        ON run.organization_id = version.organization_id
       AND run.workflow_version_id = version.workflow_version_id
      WHERE version.organization_id = 'org_legacy'
      GROUP BY version.workflow_version_id, version.workflow_id
      ORDER BY version.workflow_version_id
    `);
    expect(new Set(links.rows.map(({ workflow_id }) => workflow_id)).size).toBe(1);
    expect(links.rows).toMatchObject([
      { workflow_version_id: 'another-unrelated-key', approval_count: '1', run_count: '0' },
      { workflow_version_id: 'totally-opaque-first', approval_count: '1', run_count: '1' },
    ]);

    await expect(
      readWorkflowCatalog(pool, { organizationId: 'org_legacy', environmentId: 'production' }),
    ).resolves.toMatchObject({
      workflows: [
        {
          name: 'Imported workflow',
          activeVersion: { workflowVersionId: 'totally-opaque-first' },
          latestVersion: {
            workflowVersionId: 'another-unrelated-key',
            status: 'approved-inactive',
          },
          mostRecentRun: { runId: 'legacy-run' },
        },
      ],
    });
  });
});
