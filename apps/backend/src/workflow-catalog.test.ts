import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import {
  demoteActiveWorkflowVersions,
  readWorkflowCatalog,
  recordWorkflowLifecycle,
  resolveWorkflowIdentityByName,
} from './workflow-catalog.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_catalog_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const app = createApp(pool, { allowedHosts: [] }, undefined, {
  async authorize() {
    return 'author';
  },
});

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 124 });
  await pool.query(`
    TRUNCATE organizations, workflow_identities RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas'), ('org_other');
    INSERT INTO workflow_identities
      (organization_id, workflow_id, name, created_at, updated_at) VALUES
      ('org_atlas', 'workflow_payment', 'Settle payments',
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('org_atlas', 'workflow_refund', 'Refund payments',
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('org_atlas', 'workflow_empty', 'Empty imported identity',
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      ('org_other', 'workflow_foreign', 'Foreign workflow',
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO workflow_versions
      (organization_id, workflow_version_id, workflow_id, created_at)
    VALUES
      ('org_atlas', 'opaque-version-a', 'workflow_payment', '2026-01-01T00:00:00Z'),
      ('org_atlas', 'opaque-version-b', 'workflow_payment', '2026-01-02T00:00:00Z'),
      ('org_atlas', 'refund-draft', 'workflow_refund', '2026-01-03T00:00:00Z'),
      ('org_other', 'foreign-version', 'workflow_foreign', '2026-01-04T00:00:00Z');
    INSERT INTO workflow_environment_versions
      (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active,
       updated_at)
    VALUES
      ('org_atlas', 'production', 'opaque-version-a', 'active', true,
       '2026-01-05T00:00:00Z'),
      ('org_atlas', 'production', 'opaque-version-b', 'draft', false,
       '2026-01-06T00:00:00Z'),
      ('org_atlas', 'development', 'refund-draft', 'testing', false,
       '2026-01-07T00:00:00Z'),
      ('org_other', 'production', 'foreign-version', 'blocked', false,
       '2026-01-08T00:00:00Z');
    INSERT INTO workflow_runs
      (organization_id, environment_id, run_id, workflow_version_id, intake_key, state,
       started_at, updated_at)
    VALUES
      ('org_atlas', 'production', 'run_old', 'opaque-version-a', '${'a'.repeat(64)}',
       'completed', '2026-01-08T00:00:00Z', '2026-01-08T01:00:00Z'),
      ('org_atlas', 'production', 'run_latest', 'opaque-version-a', '${'b'.repeat(64)}',
       'running', '2026-01-09T00:00:00Z', '2026-01-09T01:00:00Z');
    INSERT INTO workflow_approvals
      (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
       projection_fingerprint, approved_by, approved_at, lifecycle_status)
    VALUES
      ('org_atlas', 'production', 'opaque-version-a', '${'c'.repeat(64)}', 'policy-v1',
       '${'d'.repeat(64)}', 'admin@example.com', '2026-01-05T00:00:00Z', 'current');
  `);
});

afterAll(async () => {
  await pool.end();
});

describe('workflow Catalog read API', () => {
  it('returns one stable workflow row scoped to exactly one organization and environment', async () => {
    const response = await app.request(
      '/v1/workflow-catalog?organizationId=org_atlas&environmentId=production',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workflows: [
        {
          workflowId: 'workflow_payment',
          name: 'Settle payments',
          activeVersion: { workflowVersionId: 'opaque-version-a' },
          latestVersion: { workflowVersionId: 'opaque-version-b', status: 'draft' },
          mostRecentRun: {
            runId: 'run_latest',
            workflowVersionId: 'opaque-version-a',
            state: 'running',
            startedAt: '2026-01-09T00:00:00.000Z',
          },
          updatedAt: '2026-01-09T01:00:00.000Z',
        },
      ],
    });
  });

  it.each(['draft', 'testing', 'awaiting-approval', 'approved-inactive', 'active', 'blocked'])(
    'reports the %s lifecycle state without requiring a run',
    async (status) => {
      await pool.query(
        `UPDATE workflow_environment_versions SET lifecycle_status = $1, updated_at = now()
         WHERE organization_id = 'org_atlas' AND environment_id = 'development'
           AND workflow_version_id = 'refund-draft'`,
        [status],
      );
      const response = await app.request(
        '/v1/workflow-catalog?organizationId=org_atlas&environmentId=development',
      );
      const body = (await response.json()) as {
        workflows: Array<{ latestVersion: { status: string }; mostRecentRun: unknown }>;
      };
      expect(body.workflows).toHaveLength(1);
      expect(body.workflows[0]).toMatchObject({
        latestVersion: { status },
        mostRecentRun: null,
      });
    },
  );

  it('requires both scope identifiers', async () => {
    expect((await app.request('/v1/workflow-catalog?organizationId=org_atlas')).status).toBe(400);
    expect((await app.request('/v1/workflow-catalog?environmentId=production')).status).toBe(400);
  });

  it('resolves one stable workflow in scope with immutable versions and recent run triggers', async () => {
    const response = await app.request(
      '/v1/workflow-catalog/workflow_payment?organizationId=org_atlas&environmentId=production',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workflowId: 'workflow_payment',
      name: 'Settle payments',
      activeVersion: { workflowVersionId: 'opaque-version-a' },
      inputSchema: null,
      invocationExample: null,
      latestVersion: { workflowVersionId: 'opaque-version-b', status: 'draft' },
      updatedAt: '2026-01-09T01:00:00.000Z',
      versions: [
        {
          workflowVersionId: 'opaque-version-b',
          status: 'draft',
          isActive: false,
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-06T00:00:00.000Z',
          approval: null,
        },
        {
          workflowVersionId: 'opaque-version-a',
          status: 'active',
          isActive: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-05T00:00:00.000Z',
          approval: {
            approvedBy: 'admin@example.com',
            approvedAt: '2026-01-05T00:00:00.000Z',
          },
        },
      ],
      recentRuns: [
        {
          runId: 'run_latest',
          workflowVersionId: 'opaque-version-a',
          trigger: { type: 'manual' },
          state: 'running',
          startedAt: '2026-01-09T00:00:00.000Z',
        },
        {
          runId: 'run_old',
          workflowVersionId: 'opaque-version-a',
          trigger: { type: 'manual' },
          state: 'completed',
          startedAt: '2026-01-08T00:00:00.000Z',
        },
      ],
    });
  });

  it('fails closed when a workflow is absent from the selected scope', async () => {
    const wrongEnvironment = await app.request(
      '/v1/workflow-catalog/workflow_payment?organizationId=org_atlas&environmentId=development',
    );
    const wrongOrganization = await app.request(
      '/v1/workflow-catalog/workflow_payment?organizationId=org_other&environmentId=production',
    );
    const identityWithoutScopedVersions = await app.request(
      '/v1/workflow-catalog/workflow_empty?organizationId=org_atlas&environmentId=production',
    );

    expect(wrongEnvironment.status).toBe(404);
    expect(wrongOrganization.status).toBe(404);
    expect(identityWithoutScopedVersions.status).toBe(404);
  });

  it('exposes the active ingest payload schema, preferring the approved artifact', async () => {
    await pool.query(
      `UPDATE workflow_versions
         SET compiled_workflow = $1
       WHERE organization_id = 'org_atlas' AND workflow_version_id = 'opaque-version-a'`,
      [{ executable: { inputSchema: { required: { orderId: { type: 'string' } } } } }],
    );
    const compiledOnly = await app.request(
      '/v1/workflow-catalog/workflow_payment?organizationId=org_atlas&environmentId=production',
    );
    await expect(compiledOnly.json()).resolves.toMatchObject({
      inputSchema: { required: { orderId: { type: 'string' } } },
    });

    await pool.query(
      `UPDATE workflow_approvals
         SET artifact_manifest = $1
       WHERE organization_id = 'org_atlas' AND environment_id = 'production'
         AND workflow_version_id = 'opaque-version-a'`,
      [
        {
          workflow: {
            executable: {
              inputSchema: {
                required: {
                  paymentId: { type: 'string' },
                  context: { type: 'object', required: { retry: { type: 'boolean' } } },
                },
              },
            },
          },
        },
      ],
    );
    const withArtifact = await app.request(
      '/v1/workflow-catalog/workflow_payment?organizationId=org_atlas&environmentId=production',
    );
    await expect(withArtifact.json()).resolves.toMatchObject({
      workflowId: 'workflow_payment',
      inputSchema: {
        required: {
          paymentId: { type: 'string' },
          context: { type: 'object', required: { retry: { type: 'boolean' } } },
        },
      },
    });
  });

  it('opens an exact latest version for the existing review flow without crossing scope', async () => {
    const draft = { workflowVersionId: 'opaque-version-b', immutable: true };
    await pool.query(
      `UPDATE workflow_versions SET compiled_workflow = $1
       WHERE organization_id = 'org_atlas' AND workflow_version_id = 'opaque-version-b'`,
      [draft],
    );

    const response = await app.request(
      '/v1/workflow-catalog/workflow_payment/versions/opaque-version-b?organizationId=org_atlas&environmentId=production',
    );
    const wrongEnvironment = await app.request(
      '/v1/workflow-catalog/workflow_payment/versions/opaque-version-b?organizationId=org_atlas&environmentId=development',
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ draft });
    expect(wrongEnvironment.status).toBe(404);
  });

  it('replaces a blocked active version without leaving two active markers', async () => {
    await recordWorkflowLifecycle(pool, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowVersionId: 'opaque-version-a',
      status: 'blocked',
      isActive: true,
    });
    await demoteActiveWorkflowVersions(pool, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      replacingWorkflowVersionId: 'opaque-version-b',
    });
    await recordWorkflowLifecycle(pool, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowVersionId: 'opaque-version-b',
      status: 'active',
      isActive: true,
    });

    const catalog = await readWorkflowCatalog(pool, {
      organizationId: 'org_atlas',
      environmentId: 'production',
    });
    expect(catalog.workflows[0]?.activeVersion).toEqual({
      workflowVersionId: 'opaque-version-b',
    });
    const activeMarkers = await pool.query<{ workflow_version_id: string }>(
      `SELECT workflow_version_id FROM workflow_environment_versions
       WHERE organization_id = 'org_atlas' AND environment_id = 'production' AND is_active`,
    );
    expect(activeMarkers.rows).toEqual([{ workflow_version_id: 'opaque-version-b' }]);
  });

  it('saves a required human name separately from opaque machine IDs', async () => {
    const draft = await createCompiledWorkflowVersion('version-without-a-name', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: {} },
      steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
    });
    const missingName = await app.request('/v1/workflow-catalog/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'staging',
        workflowId: 'workflow_named',
        status: 'draft',
        draft,
      }),
    });
    expect(missingName.status).toBe(400);

    const saved = await app.request('/v1/workflow-catalog/versions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'staging',
        workflowId: 'workflow_named',
        name: 'Human readable name',
        status: 'draft',
        draft,
      }),
    });
    expect(saved.status).toBe(201);
    const catalog = await app.request(
      '/v1/workflow-catalog?organizationId=org_atlas&environmentId=staging',
    );
    expect(await catalog.json()).toMatchObject({
      workflows: [
        {
          workflowId: 'workflow_named',
          name: 'Human readable name',
          latestVersion: { workflowVersionId: 'version-without-a-name', status: 'draft' },
        },
      ],
    });
  });
});

describe('workflow identity name resolution', () => {
  it('resolves an exact unique name to one identity', async () => {
    await expect(
      resolveWorkflowIdentityByName(pool, {
        organizationId: 'org_atlas',
        name: 'Settle payments',
      }),
    ).resolves.toEqual({
      status: 'resolved',
      workflowId: 'workflow_payment',
      name: 'Settle payments',
    });
  });

  it('reports none when no identity shares the name', async () => {
    await expect(
      resolveWorkflowIdentityByName(pool, {
        organizationId: 'org_atlas',
        name: 'Missing workflow',
      }),
    ).resolves.toEqual({ status: 'none' });
  });

  it('reports ambiguous when several identities share the name', async () => {
    await pool.query(`
      INSERT INTO workflow_identities (organization_id, workflow_id, name)
      VALUES
        ('org_atlas', 'workflow_legacy_a', 'Imported workflow'),
        ('org_atlas', 'workflow_legacy_b', 'Imported workflow');
    `);
    try {
      await expect(
        resolveWorkflowIdentityByName(pool, {
          organizationId: 'org_atlas',
          name: 'Imported workflow',
        }),
      ).resolves.toEqual({
        status: 'ambiguous',
        name: 'Imported workflow',
        workflowIds: ['workflow_legacy_a', 'workflow_legacy_b'],
      });
    } finally {
      await pool.query(`
        DELETE FROM workflow_identities
        WHERE organization_id = 'org_atlas'
          AND workflow_id IN ('workflow_legacy_a', 'workflow_legacy_b');
      `);
    }
  });

  it('does not resolve a name that only exists in another organization', async () => {
    await expect(
      resolveWorkflowIdentityByName(pool, {
        organizationId: 'org_atlas',
        name: 'Foreign workflow',
      }),
    ).resolves.toEqual({ status: 'none' });
  });
});

describe('repeated catalog draft saves', () => {
  it.each([
    { status: 'active', isActive: true, approval: 'current' },
    { status: 'approved-inactive', isActive: false, approval: 'approved' },
    { status: 'blocked', isActive: false, approval: 'superseded' },
    { status: 'action-required', isActive: true, approval: 'current' },
    { status: 'testing', isActive: false, approval: null },
    { status: 'awaiting-approval', isActive: false, approval: null },
  ] as const)(
    'preserves $status lifecycle and approval when binding the same artifact again',
    async ({ status, isActive, approval }) => {
      const workflowId = `preserve-${status}`;
      const draft = await createCompiledWorkflowVersion(
        `${workflowId}@builder-stable`,
        'org_atlas',
        {
          irVersion: 1,
          inputSchema: { required: {} },
          steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
        },
      );
      const save = (environmentId = 'development', artifact = draft) =>
        app.request('/v1/workflow-catalog/versions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            organizationId: 'org_atlas',
            environmentId,
            workflowId,
            name: 'Preserved workflow',
            status: 'draft',
            draft: artifact,
          }),
        });
      expect((await save()).status).toBe(201);
      await recordWorkflowLifecycle(pool, {
        organizationId: 'org_atlas',
        environmentId: 'development',
        workflowVersionId: draft.workflowVersionId,
        status,
        isActive,
        observedAt: '2026-01-01T00:00:00Z',
      });
      if (approval) {
        await pool.query(
          `INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
         projection_fingerprint, approved_by, lifecycle_status)
        VALUES ('org_atlas', 'development', $1, $2, 'policy-v1', $3, 'admin', $4)`,
          [draft.workflowVersionId, draft.irHash, 'a'.repeat(64), approval],
        );
      }
      const snapshot = async () => {
        const environment = await pool.query(
          `SELECT * FROM workflow_environment_versions
        WHERE organization_id = 'org_atlas' AND environment_id = 'development' AND workflow_version_id = $1`,
          [draft.workflowVersionId],
        );
        const approvals = await pool.query(
          `SELECT * FROM workflow_approvals
        WHERE organization_id = 'org_atlas' AND environment_id = 'development' AND workflow_version_id = $1`,
          [draft.workflowVersionId],
        );
        return { environment: environment.rows, approvals: approvals.rows };
      };
      const before = await snapshot();
      const responses = await Promise.all([save(), save()]);
      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
        expect.objectContaining({ status }),
        expect.objectContaining({ status }),
      ]);
      expect(await snapshot()).toEqual(before);

      const otherEnvironment = await save('production');
      expect(otherEnvironment.status).toBe(201);
      expect(await otherEnvironment.json()).toMatchObject({ status: 'draft' });
      expect(await snapshot()).toEqual(before);

      const changed = await createCompiledWorkflowVersion(draft.workflowVersionId, 'org_atlas', {
        irVersion: 1,
        inputSchema: { required: {} },
        steps: [{ id: 'done', kind: 'terminal', state: 'validation_failed' }],
      });
      expect((await save('development', changed)).status).toBe(409);
      expect(await snapshot()).toEqual(before);
    },
  );
});
