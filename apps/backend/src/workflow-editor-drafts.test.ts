import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApp } from './app.js';
import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_editor_drafts_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const authorizer = {
  async authorize({ authorizationHeader }) {
    return authorizationHeader === 'Bearer author' ? ('author' as const) : null;
  },
} satisfies NonNullable<Parameters<typeof createApp>[3]>;
const app = createApp(pool, { allowedHosts: [] }, undefined, authorizer);
const readOnlyPool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName} -c default_transaction_read_only=on`,
});
const readOnlyApp = createApp(readOnlyPool, { allowedHosts: [] }, undefined, authorizer);
const headers = { authorization: 'Bearer author', 'content-type': 'application/json' };
const scope = { organizationId: 'org_atlas', environmentId: 'development' };
const document = {
  executable: {
    irVersion: 3,
    startStepId: 'wait',
    inputSchema: { required: {} },
    steps: [
      { id: 'wait', kind: 'sleep', durationMs: 10, next: 'done' },
      { id: 'done', kind: 'terminal', state: 'completed' },
    ],
  },
  layout: {},
  labels: {},
  notes: [],
  trigger: { type: 'manual' },
};

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 283 });
  await pool.query(`TRUNCATE organizations RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas'), ('org_other');
    INSERT INTO organization_environment_policies (organization_id, environment_id, policy_version, approved_by)
    VALUES ('org_atlas', 'development', 'mvp-validation-v1', 'admin');`);
});
afterAll(async () => {
  await Promise.all([pool.end(), readOnlyPool.end()]);
});

function save(workflowId: string, expectedRevision: number | null, content: unknown = document) {
  return app.request(`/v1/workflow-editor-drafts/${workflowId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ...scope,
      name: 'Manual workflow',
      expectedRevision,
      document: content,
    }),
  });
}

describe('saved working drafts', () => {
  it('requires an author for reading and writing the new endpoints', async () => {
    expect(
      (
        await app.request('/v1/workflow-editor-drafts/one', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...scope, name: 'Test', expectedRevision: null, document }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          '/v1/workflow-editor-drafts?organizationId=org_atlas&environmentId=development',
        )
      ).status,
    ).toBe(403);
  });

  it('saves incomplete work separately, discovers it, and isolates environments and organizations', async () => {
    expect(
      (
        await save('incomplete', null, {
          ...document,
          executable: { ...document.executable, steps: [] },
        })
      ).status,
    ).toBe(200);
    const saved = await app.request(
      '/v1/workflow-editor-drafts/incomplete?organizationId=org_atlas&environmentId=development',
      { headers },
    );
    expect(await saved.json()).toMatchObject({
      workflowId: 'incomplete',
      revision: 1,
      document: { executable: { steps: [] } },
    });
    const list = await app.request(
      '/v1/workflow-editor-drafts?organizationId=org_atlas&environmentId=development',
      { headers },
    );
    expect(await list.json()).toMatchObject({
      drafts: expect.arrayContaining([expect.objectContaining({ workflowId: 'incomplete' })]),
    });
    for (const query of [
      'organizationId=org_atlas&environmentId=production',
      'organizationId=org_other&environmentId=development',
    ]) {
      expect(
        (await app.request(`/v1/workflow-editor-drafts/incomplete?${query}`, { headers })).status,
      ).toBe(404);
    }
    expect((await pool.query('SELECT 1 FROM workflow_versions')).rows).toEqual([]);
  });

  it('rejects concurrent saves using the same revision', async () => {
    expect((await save('concurrent', null)).status).toBe(200);
    const responses = await Promise.all([save('concurrent', 1), save('concurrent', 1)]);
    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect((await save('concurrent', null)).status).toBe(409);
  });

  it('creates a checked immutable version and reuses it after canvas-only changes', async () => {
    await save('versioned', null);
    const projection = await readPlannerCapabilityProjection(
      pool,
      scope.organizationId,
      scope.environmentId,
    );
    const compile = (expectedRevision: number) =>
      app.request('/v1/workflow-editor-drafts/versioned/versions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...scope,
          expectedRevision,
          projectionFingerprint: projection.fingerprint,
        }),
      });
    const first = await compile(1);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.review.approval.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'compileError' })]),
    );
    expect(firstBody.draft.executionRequirements.workflowVersionId).toBe(
      firstBody.draft.workflowVersionId,
    );
    await pool.query(
      `UPDATE workflow_environment_versions SET lifecycle_status = 'active', is_active = true WHERE workflow_version_id = $1`,
      [firstBody.draft.workflowVersionId],
    );
    await save('versioned', 1, { ...document, layout: { wait: { x: 200, y: 100 } } });
    expect((await compile(1)).status).toBe(409);
    const second = await compile(2);
    expect(second.status).toBe(201);
    expect((await second.json()).draft).toEqual(firstBody.draft);
    expect(
      (
        await pool.query(
          `SELECT lifecycle_status, is_active FROM workflow_environment_versions WHERE workflow_version_id = $1`,
          [firstBody.draft.workflowVersionId],
        )
      ).rows[0],
    ).toEqual({ lifecycle_status: 'active', is_active: true });
    expect(
      (await pool.query(`SELECT 1 FROM workflow_versions WHERE workflow_id = 'versioned'`)).rows,
    ).toHaveLength(1);
  });

  it('rejects compiling an incomplete definition without making a catalog version', async () => {
    const projection = await readPlannerCapabilityProjection(
      pool,
      scope.organizationId,
      scope.environmentId,
    );
    const response = await app.request('/v1/workflow-editor-drafts/incomplete/versions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...scope,
        expectedRevision: 1,
        projectionFingerprint: projection.fingerprint,
      }),
    });
    expect(response.status).toBe(422);
    expect(
      (await pool.query(`SELECT 1 FROM workflow_versions WHERE workflow_id = 'incomplete'`)).rows,
    ).toEqual([]);
  });

  it('reports invalid Transform values and missing condition inputs during review', async () => {
    await save('invalid-mappings', null, {
      ...document,
      executable: {
        irVersion: 3,
        startStepId: 'format',
        inputSchema: { required: {} },
        steps: [
          {
            id: 'format',
            kind: 'transform',
            arguments: { amount: { source: 'literal', value: 'not a number' } },
            responseSchema: { required: { amount: { type: 'number' } } },
            next: 'choose',
          },
          {
            id: 'choose',
            kind: 'condition',
            condition: { left: { source: 'input', path: ['missing'] }, operator: 'exists' },
            whenTrue: 'done',
            whenFalse: 'done',
          },
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      },
    });
    const projection = await readPlannerCapabilityProjection(
      pool,
      scope.organizationId,
      scope.environmentId,
    );
    const response = await app.request('/v1/workflow-editor-drafts/invalid-mappings/versions', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...scope,
        expectedRevision: 1,
        projectionFingerprint: projection.fingerprint,
      }),
    });
    expect(response.status).toBe(201);
    const review = (await response.json()).review;
    expect(review.approval.enabled).toBe(false);
    expect(review.approval.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'TRANSFORM_TYPE_MISMATCH' }),
        expect.objectContaining({ code: 'TRANSFORM_SOURCE_PATH_NOT_FOUND' }),
      ]),
    );
  });
});

describe('validation of the current unsaved document', () => {
  async function validate(workflowId: string, content: unknown = document, fingerprint?: string) {
    const projection = await readPlannerCapabilityProjection(
      pool,
      scope.organizationId,
      scope.environmentId,
    );
    return readOnlyApp.request(`/v1/workflow-editor-drafts/${workflowId}/validation`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...scope,
        document: content,
        projectionFingerprint: fingerprint ?? projection.fingerprint,
      }),
    });
  }

  it('validates a new workflow with a read-only connection and a stable artifact identity', async () => {
    const response = await validate('unsaved');
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.workflowId).toBe('unsaved');
    expect(result.draft.workflowVersionId).toBe(`unsaved@builder-${result.draft.irHash}`);
    expect(result.draft.executionRequirements.workflowVersionId).toBe(
      result.draft.workflowVersionId,
    );
    expect(result.review.artifact).toEqual(result.draft);
    expect(result.review.approval.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'SANDBOX_TESTS_MISSING' })]),
    );
    const moved = await validate('unsaved', { ...document, layout: { wait: { x: 20, y: 40 } } });
    expect(moved.status).toBe(200);
    expect((await moved.json()).draft).toEqual(result.draft);
    for (const table of ['workflow_editor_drafts', 'workflow_identities', 'workflow_versions']) {
      expect(
        (await pool.query(`SELECT 1 FROM ${table} WHERE workflow_id = 'unsaved'`)).rowCount,
      ).toBe(0);
    }
  });

  it('uses unsaved executable changes without changing the stored draft, revision, or catalog version', async () => {
    await save('validation-is-read-only', null);
    const projection = await readPlannerCapabilityProjection(
      pool,
      scope.organizationId,
      scope.environmentId,
    );
    const version = await app.request(
      '/v1/workflow-editor-drafts/validation-is-read-only/versions',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...scope,
          expectedRevision: 1,
          projectionFingerprint: projection.fingerprint,
        }),
      },
    );
    expect(version.status).toBe(201);
    const savedBefore = await pool.query(
      `SELECT * FROM workflow_editor_drafts WHERE workflow_id = 'validation-is-read-only'`,
    );
    const versionsBefore = await pool.query(
      `SELECT * FROM workflow_versions WHERE workflow_id = 'validation-is-read-only'`,
    );
    const response = await validate('validation-is-read-only', {
      ...document,
      executable: {
        ...document.executable,
        steps: [
          { id: 'wait', kind: 'sleep', durationMs: 42, next: 'done' },
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      },
    });
    expect(response.status).toBe(200);
    const current = await response.json();
    expect(current.draft.executable.steps[0].durationMs).toBe(42);
    expect(current.draft.irHash).not.toBe((await version.json()).draft.irHash);
    expect(
      (
        await pool.query(
          `SELECT * FROM workflow_editor_drafts WHERE workflow_id = 'validation-is-read-only'`,
        )
      ).rows,
    ).toEqual(savedBefore.rows);
    expect(
      (
        await pool.query(
          `SELECT * FROM workflow_versions WHERE workflow_id = 'validation-is-read-only'`,
        )
      ).rows,
    ).toEqual(versionsBefore.rows);
  });

  it('returns diagnostics for invalid current connections and rejects outdated projection bindings', async () => {
    const response = await validate('invalid-unsaved', {
      ...document,
      executable: {
        ...document.executable,
        steps: [
          { id: 'wait', kind: 'sleep', durationMs: 10, next: 'missing' },
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: 'workflow-editor-compilation-failed',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'LEGACY_IR_STRUCTURE_INVALID' }),
      ]),
    });
    expect((await validate('invalid-unsaved', document, '0'.repeat(64))).status).toBe(409);
    expect(
      (
        await pool.query(
          `SELECT 1 FROM workflow_editor_drafts WHERE workflow_id = 'invalid-unsaved'`,
        )
      ).rowCount,
    ).toBe(0);
  });

  it('requires an author before validating and bounds the submitted document', async () => {
    const projection = await readPlannerCapabilityProjection(
      pool,
      scope.organizationId,
      scope.environmentId,
    );
    const request = { ...scope, document, projectionFingerprint: projection.fingerprint };
    const denied = await readOnlyApp.request('/v1/workflow-editor-drafts/unsaved/validation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(denied.status).toBe(403);
    const oversized = await validate('unsaved', {
      ...document,
      notes: [{ id: 'long', text: 'x'.repeat(4001), x: 0, y: 0 }],
    });
    expect(oversized.status).toBe(400);
  });
});
