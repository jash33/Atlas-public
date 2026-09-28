import { resolve } from 'node:path';

import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { resolveTestDatabaseUrl } from './test-database.js';
import { readWorkflowCatalog } from './workflow-catalog.js';
import { migrationCountAfter } from './migration-test-support.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `workflow_catalog_convergence_test_${process.pid}`;
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
  lockValue: 126,
};

beforeAll(async () => {
  await runner({ ...migrationOptions, direction: 'up' });
  await runner({
    ...migrationOptions,
    direction: 'down',
    count: migrationCountAfter('048_converge_workflow_catalog'),
  });
  await pool.query(`
    DELETE FROM atlas_migrations WHERE name = '048_converge_workflow_catalog';

    DROP TRIGGER IF EXISTS bind_workflow_approval_identity_before_insert ON workflow_approvals;
    DROP FUNCTION IF EXISTS bind_workflow_approval_identity();
    DROP INDEX workflow_approvals_one_current;
    CREATE UNIQUE INDEX workflow_approvals_one_current
      ON workflow_approvals (organization_id, environment_id)
      WHERE lifecycle_status = 'current';
    ALTER TABLE workflow_approvals DROP CONSTRAINT IF EXISTS workflow_approvals_identity_fk;
    ALTER TABLE workflow_approvals DROP COLUMN IF EXISTS workflow_id;

    DROP TRIGGER IF EXISTS assign_unscoped_workflow_identity_before_insert ON workflow_versions;
    DROP FUNCTION IF EXISTS assign_unscoped_workflow_identity();
    ALTER TABLE workflow_environment_versions DROP COLUMN IF EXISTS is_active;

    INSERT INTO organizations (id) VALUES ('org_drifted');
    INSERT INTO workflow_identities (organization_id, workflow_id, name)
    VALUES ('org_drifted', 'workflow_drifted', 'Drifted workflow');
    INSERT INTO workflow_versions (organization_id, workflow_version_id, workflow_id)
    VALUES ('org_drifted', 'drifted@1', 'workflow_drifted');
    INSERT INTO workflow_approvals
      (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
       projection_fingerprint, approved_by, lifecycle_status)
    VALUES ('org_drifted', 'development', 'drifted@1', '${'a'.repeat(64)}', 'v1',
      '${'b'.repeat(64)}', 'admin', 'current');
    INSERT INTO workflow_environment_versions
      (organization_id, environment_id, workflow_version_id, lifecycle_status)
    VALUES ('org_drifted', 'development', 'drifted@1', 'active');
  `);
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA ${schemaName} CASCADE`);
  await pool.end();
});

describe('workflow Catalog convergence migration', () => {
  it('repairs a database that recorded the early partial Catalog schema', async () => {
    await runner({ ...migrationOptions, direction: 'up' });

    await expect(
      readWorkflowCatalog(pool, {
        organizationId: 'org_drifted',
        environmentId: 'development',
      }),
    ).resolves.toMatchObject({
      workflows: [
        {
          workflowId: 'workflow_drifted',
          activeVersion: { workflowVersionId: 'drifted@1' },
        },
      ],
    });

    const approval = await pool.query<{ workflow_id: string }>(
      `SELECT workflow_id FROM workflow_approvals
       WHERE organization_id = 'org_drifted' AND workflow_version_id = 'drifted@1'`,
    );
    expect(approval.rows[0]?.workflow_id).toBe('workflow_drifted');

    const unscoped = await pool.query<{ workflow_id: string }>(
      `INSERT INTO workflow_versions (organization_id, workflow_version_id)
       VALUES ('org_drifted', 'unscoped@1') RETURNING workflow_id`,
    );
    expect(unscoped.rows[0]?.workflow_id).toMatch(/^unassigned-/);
  });
});
