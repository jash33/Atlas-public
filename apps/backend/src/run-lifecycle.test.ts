import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'run_lifecycle_ended_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-csearch_path=${schemaName}` });
const app = createApp(pool, { allowedHosts: [] }, undefined, undefined, {
  approvalAuthorizer: {
    async authorize() {
      return null;
    },
  },
  workerAuthorizer: {
    async authorize({ authorizationHeader, environmentId }) {
      return authorizationHeader === 'Bearer development-token' && environmentId === 'development';
    },
  },
  executionGrantIssuer: {
    async issueForRun() {
      throw new Error('not used');
    },
  },
});

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 211 });
  const workflow = await createCompiledWorkflowVersion('settle@1', 'org_atlas', {
    irVersion: 1,
    steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
  });
  await pool.query(`
    TRUNCATE organizations RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas');
    INSERT INTO environments (organization_id, id, name, kind)
    VALUES ('org_atlas', 'development', 'Development', 'development');
    INSERT INTO workflow_identities (organization_id, workflow_id, name)
    VALUES ('org_atlas', 'workflow_settle', 'Settle payments');
  `);
  await pool.query(
    `INSERT INTO workflow_versions
      (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
     VALUES ('org_atlas', $1, 'workflow_settle', $2, $3)`,
    [workflow.workflowVersionId, workflow.irHash, workflow],
  );
  await pool.query(
    `INSERT INTO workflow_runs
      (organization_id, environment_id, run_id, workflow_version_id, intake_key, state)
     VALUES ('org_atlas', 'development', 'atlas:run:lifecycle-1', $1, 'pay_1', 'running')`,
    [workflow.workflowVersionId],
  );
});

afterAll(async () => pool.end());

async function postLifecycle(runId: string, body: unknown) {
  return app.request(`/v1/runs/${encodeURIComponent(runId)}/lifecycle`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer development-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('run lifecycle started events', () => {
  it('stores completion and lifecycle together, rolls back failures, and accepts redelivery', async () => {
    const runId = 'atlas:run:atomic-completion';
    await pool.query(
      `INSERT INTO workflow_runs
      (organization_id, environment_id, run_id, workflow_version_id, intake_key, state)
      VALUES ('org_atlas', 'development', $1, 'settle@1', 'atomic', 'running')`,
      [runId],
    );
    await pool.query(
      `INSERT INTO workflow_run_step_attempts
      (organization_id, environment_id, run_id, step_id, capability_version_id, attempt,
       duration_ms, status, redacted_input)
      VALUES ('org_atlas', 'development', $1, 'read', 'cap', 2, 10, 'succeeded', '{}')`,
      [runId],
    );
    const body = {
      organizationId: 'org_atlas',
      environmentId: 'development',
      workflowName: 'Settle payments',
      state: 'completed',
      occurredAt: '2026-09-19T12:00:00.000Z',
      durationMs: 50,
    };
    const complete = (token = 'development-token', input = body) =>
      app.request(`/v1/runs/${encodeURIComponent(runId)}/completion`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    expect((await complete('wrong')).status).toBe(403);
    await pool.query(`CREATE FUNCTION reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.run_id = 'atlas:run:atomic-completion' THEN RAISE EXCEPTION 'completion write failed'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER reject_completion BEFORE INSERT ON workflow_run_lifecycles
      FOR EACH ROW EXECUTE FUNCTION reject_completion();`);
    try {
      expect((await complete()).status).toBe(500);
      expect(
        (await pool.query('SELECT state FROM workflow_runs WHERE run_id = $1', [runId])).rows,
      ).toEqual([{ state: 'running' }]);
    } finally {
      await pool.query(
        'DROP TRIGGER reject_completion ON workflow_run_lifecycles; DROP FUNCTION reject_completion();',
      );
    }
    expect((await complete()).status).toBe(204);
    expect((await complete()).status).toBe(204);
    const saved = await pool.query(
      `SELECT run.state, lifecycle.duration_ms, lifecycle.retry_count
      FROM workflow_runs run JOIN workflow_run_lifecycles lifecycle USING (organization_id, environment_id, run_id)
      WHERE run.run_id = $1`,
      [runId],
    );
    expect(saved.rows).toEqual([{ state: 'completed', duration_ms: 50, retry_count: 1 }]);
  });

  it('creates a lifecycle row for a worker started event and keeps repeats idempotent', async () => {
    const body = {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'started',
      workflowName: 'Settle payments',
      occurredAt: '2026-09-04T14:00:00.000Z',
    };

    const created = await postLifecycle('atlas:run:lifecycle-1', body);
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({
      workflowName: 'Settle payments',
      startedAt: '2026-09-04T14:00:00.000Z',
      endedAt: null,
      durationMs: null,
      retryCount: null,
      outcome: null,
      inProgress: true,
    });

    const repeat = await postLifecycle('atlas:run:lifecycle-1', {
      ...body,
      workflowName: 'Different name that must not overwrite',
      occurredAt: '2026-09-04T15:00:00.000Z',
    });
    expect(repeat.status).toBe(200);
    await expect(repeat.json()).resolves.toEqual({
      workflowName: 'Settle payments',
      startedAt: '2026-09-04T14:00:00.000Z',
      endedAt: null,
      durationMs: null,
      retryCount: null,
      outcome: null,
      inProgress: true,
    });

    const stored = await pool.query(
      `SELECT workflow_name, started_at, ended_at, duration_ms, retry_count, outcome
       FROM workflow_run_lifecycles
       WHERE organization_id = 'org_atlas'
         AND environment_id = 'development'
         AND run_id = 'atlas:run:lifecycle-1'`,
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]).toMatchObject({
      workflow_name: 'Settle payments',
      ended_at: null,
      duration_ms: null,
      retry_count: null,
      outcome: null,
    });
    expect(stored.rows[0]!.started_at.toISOString()).toBe('2026-09-04T14:00:00.000Z');
  });

  it('rejects unknown fields and unauthenticated workers', async () => {
    const denied = await app.request('/v1/runs/atlas%3Arun%3Alifecycle-1/lifecycle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        event: 'started',
        workflowName: 'Settle payments',
        occurredAt: '2026-09-04T14:00:00.000Z',
      }),
    });
    expect(denied.status).toBe(403);

    const unknownField = await postLifecycle('atlas:run:lifecycle-2', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'started',
      workflowName: 'Settle payments',
      occurredAt: '2026-09-04T14:00:00.000Z',
      payload: { paymentId: 'must-not-leak' },
    });
    expect(unknownField.status).toBe(400);
    await expect(unknownField.json()).resolves.toMatchObject({
      error: 'invalid-run-lifecycle-event',
    });
  });

  it('falls back to the Catalog identity name when the worker sends an empty name', async () => {
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state)
       VALUES ('org_atlas', 'development', 'atlas:run:lifecycle-fallback', 'settle@1', 'pay_2',
               'running')`,
    );

    const response = await postLifecycle('atlas:run:lifecycle-fallback', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'started',
      workflowName: '',
      occurredAt: '2026-09-04T16:00:00.000Z',
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workflowName: 'Settle payments',
      inProgress: true,
    });
  });

  it('includes the lifecycle record on the runs list and run detail', async () => {
    const list = await app.request(
      '/v1/runs?organizationId=org_atlas&environmentId=development&state=running',
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      runs: Array<{ runId: string; lifecycle: unknown }>;
    };
    expect(listed.runs.find((run) => run.runId === 'atlas:run:lifecycle-1')?.lifecycle).toEqual({
      workflowName: 'Settle payments',
      startedAt: '2026-09-04T14:00:00.000Z',
      endedAt: null,
      durationMs: null,
      retryCount: null,
      outcome: null,
      inProgress: true,
    });

    const detail = await app.request(
      '/v1/runs/atlas%3Arun%3Alifecycle-1?organizationId=org_atlas&environmentId=development',
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      runId: 'atlas:run:lifecycle-1',
      lifecycle: {
        workflowName: 'Settle payments',
        startedAt: '2026-09-04T14:00:00.000Z',
        endedAt: null,
        durationMs: null,
        retryCount: null,
        outcome: null,
        inProgress: true,
      },
    });
  });
});

describe('run lifecycle ended events', () => {
  it('completes an existing started row with duration, retries, and outcome', async () => {
    const ended = await postLifecycle('atlas:run:lifecycle-1', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'ended',
      workflowName: 'Settle payments',
      occurredAt: '2026-09-04T14:00:04.250Z',
      durationMs: 4250,
      retryCount: 0,
      outcome: 'succeeded',
    });
    expect(ended.status).toBe(200);
    await expect(ended.json()).resolves.toEqual({
      workflowName: 'Settle payments',
      startedAt: '2026-09-04T14:00:00.000Z',
      endedAt: '2026-09-04T14:00:04.250Z',
      durationMs: 4250,
      retryCount: 0,
      outcome: 'succeeded',
      inProgress: false,
    });

    const repeat = await postLifecycle('atlas:run:lifecycle-1', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'ended',
      workflowName: 'Other name',
      occurredAt: '2026-09-04T15:00:00.000Z',
      durationMs: 999,
      retryCount: 5,
      outcome: 'failed',
    });
    expect(repeat.status).toBe(200);
    await expect(repeat.json()).resolves.toEqual({
      workflowName: 'Settle payments',
      startedAt: '2026-09-04T14:00:00.000Z',
      endedAt: '2026-09-04T14:00:04.250Z',
      durationMs: 4250,
      retryCount: 0,
      outcome: 'succeeded',
      inProgress: false,
    });
  });

  it('creates a complete row with a derived start when started was lost', async () => {
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state)
       VALUES ('org_atlas', 'development', 'atlas:run:lifecycle-ended-only', 'settle@1', 'pay_3',
               'completed')`,
    );

    const ended = await postLifecycle('atlas:run:lifecycle-ended-only', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'ended',
      workflowName: 'Settle payments',
      occurredAt: '2026-09-04T18:00:02.000Z',
      durationMs: 2000,
      retryCount: 1,
      outcome: 'succeeded',
    });
    expect(ended.status).toBe(200);
    await expect(ended.json()).resolves.toEqual({
      workflowName: 'Settle payments',
      startedAt: '2026-09-04T18:00:00.000Z',
      endedAt: '2026-09-04T18:00:02.000Z',
      durationMs: 2000,
      retryCount: 1,
      outcome: 'succeeded',
      inProgress: false,
    });
  });

  it('records failed outcomes for validation failures and parked runs', async () => {
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state)
       VALUES ('org_atlas', 'development', 'atlas:run:lifecycle-failed', 'settle@1', 'pay_4',
               'validation_failed'),
              ('org_atlas', 'development', 'atlas:run:lifecycle-parked', 'settle@1', 'pay_5',
               'repair_required')`,
    );

    const failed = await postLifecycle('atlas:run:lifecycle-failed', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'ended',
      workflowName: 'Settle payments',
      occurredAt: '2026-09-04T19:00:01.000Z',
      durationMs: 1000,
      retryCount: 0,
      outcome: 'failed',
    });
    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toMatchObject({
      outcome: 'failed',
      inProgress: false,
    });

    const parked = await postLifecycle('atlas:run:lifecycle-parked', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'ended',
      workflowName: 'Settle payments',
      occurredAt: '2026-09-04T19:30:03.000Z',
      durationMs: 3000,
      retryCount: 2,
      outcome: 'failed',
    });
    expect(parked.status).toBe(200);
    await expect(parked.json()).resolves.toMatchObject({
      outcome: 'failed',
      retryCount: 2,
      inProgress: false,
    });
  });

  it('rejects ended events that carry payload data or omit required fields', async () => {
    const unknownField = await postLifecycle('atlas:run:lifecycle-bad', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'ended',
      workflowName: 'Settle payments',
      occurredAt: '2026-09-04T20:00:00.000Z',
      durationMs: 100,
      retryCount: 0,
      outcome: 'succeeded',
      payload: { paymentId: 'must-not-leak' },
    });
    expect(unknownField.status).toBe(400);
    await expect(unknownField.json()).resolves.toMatchObject({
      error: 'invalid-run-lifecycle-event',
    });

    const missingOutcome = await postLifecycle('atlas:run:lifecycle-bad', {
      organizationId: 'org_atlas',
      environmentId: 'development',
      event: 'ended',
      workflowName: 'Settle payments',
      occurredAt: '2026-09-04T20:00:00.000Z',
      durationMs: 100,
      retryCount: 0,
    });
    expect(missingOutcome.status).toBe(400);
  });
});
