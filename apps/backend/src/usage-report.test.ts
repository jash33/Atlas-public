import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import { usageReportCountingRules, type UsageReport } from './usage-report.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'usage_report_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });

const periodStart = '2026-09-01T00:00:00.000Z';
const periodEnd = '2026-09-08T00:00:00.000Z';
const timeZone = 'America/Chicago';
const query = new URLSearchParams({
  organizationId: 'org_atlas',
  environmentId: 'development',
  periodStart,
  periodEnd,
  timeZone,
});

let sandboxRunId = 'sandbox:1';
let checkoutWorkflowVersionId = '';
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 260 });
  const checkout = await createCompiledWorkflowVersion('checkout@1', 'org_atlas', {
    irVersion: 1,
    steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
  });
  checkoutWorkflowVersionId = checkout.workflowVersionId;
  const kitchen = await createCompiledWorkflowVersion('kitchen@1', 'org_atlas', {
    irVersion: 1,
    steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
  });
  await pool.query(`
    TRUNCATE organizations RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas'), ('org_other');
    INSERT INTO environments (organization_id, id, name, kind)
    VALUES
      ('org_atlas', 'development', 'Development', 'development'),
      ('org_atlas', 'production', 'Production', 'production'),
      ('org_other', 'development', 'Development', 'development');
    INSERT INTO workflow_identities (organization_id, workflow_id, name)
    VALUES
      ('org_atlas', 'workflow_checkout', 'Checkout'),
      ('org_atlas', 'workflow_kitchen', 'Kitchen');
  `);
  await pool.query(
    `INSERT INTO workflow_versions
      (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
     VALUES
       ('org_atlas', $1, 'workflow_checkout', $2, $3),
       ('org_atlas', $4, 'workflow_kitchen', $5, $6)`,
    [
      checkout.workflowVersionId,
      checkout.irHash,
      checkout,
      kitchen.workflowVersionId,
      kitchen.irHash,
      kitchen,
    ],
  );

  await insertStartedRun({
    runId: 'run_ok',
    workflowVersionId: checkout.workflowVersionId,
    startedAt: '2026-09-03T15:00:00.000Z',
    state: 'completed',
  });
  await insertStartedRun({
    runId: 'run_ok',
    workflowVersionId: checkout.workflowVersionId,
    startedAt: '2026-09-03T15:00:00.000Z',
    state: 'completed',
  });
  await pool.query(
    `INSERT INTO workflow_run_step_attempts
      (organization_id, environment_id, run_id, step_id, capability_version_id, attempt,
       duration_ms, status, redacted_input)
     VALUES
       ('org_atlas', 'development', 'run_ok', 'pay', 'pay@1', 1, 10, 'failed', '"[REDACTED]"'),
       ('org_atlas', 'development', 'run_ok', 'pay', 'pay@1', 2, 12, 'succeeded', '"[REDACTED]"')`,
  );
  await insertLifecycle('run_ok', '2026-09-03T15:00:00.000Z', 'succeeded');

  await insertStartedRun({
    runId: 'run_fail',
    workflowVersionId: checkout.workflowVersionId,
    startedAt: '2026-09-04T12:00:00.000Z',
    state: 'repair_required',
  });
  await insertLifecycle('run_fail', '2026-09-04T12:00:00.000Z', 'failed');

  const sandbox = await pool.query<{ id: string }>(
    `INSERT INTO workflow_sandbox_test_runs
      (organization_id, environment_id, workflow_version_id, ir_hash, suite_fingerprint, status,
       provider_contracts, tests, target_bindings, tested_by, tested_at)
     VALUES
       ('org_atlas', 'development', $1, $2, $3, 'passed', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
        'author', '2026-09-05T18:00:00.000Z')
     RETURNING id`,
    [kitchen.workflowVersionId, kitchen.irHash, 'a'.repeat(64)],
  );
  sandboxRunId = `sandbox:${sandbox.rows[0]!.id}`;

  await pool.query(
    `INSERT INTO workflow_run_commands
      (command_id, organization_id, environment_id, encrypted_payload, status)
     VALUES ('cmd_queued', 'org_atlas', 'development', 'ciphertext', 'queued')`,
  );

  await insertStartedRun({
    runId: 'run_outside',
    workflowVersionId: checkout.workflowVersionId,
    startedAt: periodEnd,
    state: 'completed',
  });
  await insertLifecycle('run_outside', periodEnd, 'succeeded');

  app = createApp(pool, { allowedHosts: [] }, undefined, undefined, undefined, {
    async authorize({ authorizationHeader, organizationId, action }) {
      if (organizationId !== 'org_atlas' || action !== 'manage-organization') return null;
      if (authorizationHeader === 'Bearer admin-token') {
        return { actorId: 'admin', role: 'admin' };
      }
      return null;
    },
  });
});

afterAll(async () => {
  await pool.end();
});

async function insertStartedRun(input: {
  runId: string;
  workflowVersionId: string;
  startedAt: string;
  state: 'running' | 'completed' | 'repair_required';
  disposition?: 'active' | 'abandoned';
}) {
  await pool.query(
    `INSERT INTO workflow_runs
      (organization_id, environment_id, run_id, workflow_version_id, intake_key, state,
       disposition, started_at)
     VALUES ('org_atlas', 'development', $1, $2, $1, $3, $4, $5::timestamptz)
     ON CONFLICT (organization_id, environment_id, run_id) DO NOTHING`,
    [
      input.runId,
      input.workflowVersionId,
      input.state,
      input.disposition ?? 'active',
      input.startedAt,
    ],
  );
}

async function insertLifecycle(
  runId: string,
  startedAt: string,
  outcome: 'succeeded' | 'failed' | null,
) {
  if (outcome) {
    await pool.query(
      `INSERT INTO workflow_run_lifecycles
        (organization_id, environment_id, run_id, workflow_name, started_at, ended_at,
         duration_ms, retry_count, outcome)
       VALUES ('org_atlas', 'development', $1, 'Checkout', $2::timestamptz, $2::timestamptz,
         1000, 1, $3)
       ON CONFLICT (organization_id, environment_id, run_id) DO NOTHING`,
      [runId, startedAt, outcome],
    );
    return;
  }
  await pool.query(
    `INSERT INTO workflow_run_lifecycles
      (organization_id, environment_id, run_id, workflow_name, started_at)
     VALUES ('org_atlas', 'development', $1, 'Checkout', $2::timestamptz)
     ON CONFLICT (organization_id, environment_id, run_id) DO NOTHING`,
    [runId, startedAt],
  );
}

function reportUrl(extra: Record<string, string> = {}, path = '/v1/usage-report') {
  const parameters = new URLSearchParams(query);
  for (const [key, value] of Object.entries(extra)) parameters.set(key, value);
  return `${path}?${parameters}`;
}

function getReport(url = reportUrl(), token = 'admin-token') {
  return app.request(url, { headers: { authorization: `Bearer ${token}` } });
}

describe('admin usage reporting', () => {
  it('counts a known set of started runs without double-counting duplicates, retries, or queued work', async () => {
    const response = await getReport();
    expect(response.status).toBe(200);
    const body = (await response.json()) as UsageReport;
    expect(body).toMatchObject({
      timeZone,
      periodStart,
      periodEnd,
      completeness: 'verified',
      countingRules: usageReportCountingRules,
      customer: {
        startedRuns: 2,
        outcomes: { succeeded: 1, failed: 1, cancelled: 0, inProgress: 0 },
      },
      test: {
        startedRuns: 1,
        outcomes: { passed: 1, failed: 0 },
      },
    });
    expect(body.rows.map((row) => row.runId).sort()).toEqual(['run_fail', 'run_ok', sandboxRunId]);
    expect(body.rows.every((row) => !JSON.stringify(row).includes('REDACTED'))).toBe(true);
  });

  it('keeps CSV totals aligned with the JSON report at the same report filters', async () => {
    const jsonResponse = await getReport();
    const csvResponse = await getReport(reportUrl({}, '/v1/usage-report.csv'));
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get('content-type')).toMatch(/text\/csv/);
    const report = (await jsonResponse.json()) as UsageReport;
    const csv = await csvResponse.text();
    expect(csv).toContain(`# customerStartedRuns=${report.customer.startedRuns}`);
    expect(csv).toContain(`# testStartedRuns=${report.test.startedRuns}`);
    expect(csv).toContain('run_ok');
    expect(csv).toContain('run_fail');
    expect(csv).toContain(sandboxRunId);
    expect(csv).not.toContain('run_outside');
    expect(csv).not.toContain('cmd_queued');
  });

  it('applies workflow and environment filters to both the view and export', async () => {
    const kitchen = await getReport(reportUrl({ workflowId: 'workflow_kitchen' }));
    const kitchenReport = (await kitchen.json()) as UsageReport;
    expect(kitchen.status).toBe(200);
    expect(kitchenReport.customer.startedRuns).toBe(0);
    expect(kitchenReport.test.startedRuns).toBe(1);

    const production = await getReport(reportUrl({ environmentId: 'production' }));
    const productionReport = (await production.json()) as UsageReport;
    expect(productionReport.customer.startedRuns).toBe(0);
    expect(productionReport.test.startedRuns).toBe(0);
  });

  it('excludes a run that starts on the exclusive period end', async () => {
    const response = await getReport();
    const body = (await response.json()) as UsageReport;
    expect(body.rows.map((row) => row.runId)).not.toContain('run_outside');
  });

  it('discloses incomplete history when a lifecycle row has no started run', async () => {
    await pool.query(
      `INSERT INTO workflow_run_lifecycles
        (organization_id, environment_id, run_id, workflow_name, started_at)
       VALUES ('org_atlas', 'development', 'run_missing_start', 'Checkout',
         '2026-09-06T09:00:00.000Z')`,
    );
    const response = await getReport();
    const body = (await response.json()) as UsageReport;
    expect(body.completeness).toBe('incomplete');
    expect(body.completenessNote).toContain(
      'Do not treat these totals as a verified billing figure',
    );
    expect(body.customer.startedRuns).toBe(3);
    expect(body.customer.outcomes.inProgress).toBe(1);
    await pool.query(
      `DELETE FROM workflow_run_lifecycles
       WHERE organization_id = 'org_atlas' AND run_id = 'run_missing_start'`,
    );
  });

  it('requires an admin in the same organization', async () => {
    expect((await getReport(reportUrl(), 'author-token')).status).toBe(403);
    expect((await getReport(reportUrl(), 'missing-token')).status).toBe(403);
    const otherOrg = await getReport(reportUrl({ organizationId: 'org_other' }));
    expect(otherOrg.status).toBe(403);
  });

  it('counts a run that starts in the period and ends after the exclusive end, once', async () => {
    try {
      await insertStartedRun({
        runId: 'run_cross',
        workflowVersionId: checkoutWorkflowVersionId,
        startedAt: '2026-09-07T22:00:00.000Z',
        state: 'completed',
      });
      await pool.query(
        `INSERT INTO workflow_run_lifecycles
          (organization_id, environment_id, run_id, workflow_name, started_at, ended_at,
           duration_ms, retry_count, outcome)
         VALUES ('org_atlas', 'development', 'run_cross', 'Checkout',
           '2026-09-07T22:00:00.000Z', '2026-09-08T03:00:00.000Z', 18000000, 0, 'succeeded')`,
      );
      await pool.query(
        `INSERT INTO workflow_run_lifecycles
          (organization_id, environment_id, run_id, workflow_name, started_at, ended_at,
           duration_ms, retry_count, outcome)
         VALUES ('org_atlas', 'development', 'run_cross', 'Checkout',
           '2026-09-07T22:00:00.000Z', '2026-09-08T03:00:00.000Z', 18000000, 0, 'succeeded')
         ON CONFLICT (organization_id, environment_id, run_id) DO NOTHING`,
      );

      const body = (await (await getReport()).json()) as UsageReport;
      expect(body.rows.filter((row) => row.runId === 'run_cross')).toHaveLength(1);

      await insertStartedRun({
        runId: 'run_before',
        workflowVersionId: checkoutWorkflowVersionId,
        startedAt: '2026-08-31T22:00:00.000Z',
        state: 'completed',
      });
      await insertLifecycle('run_before', '2026-08-31T22:00:00.000Z', 'succeeded');
      const after = (await (await getReport()).json()) as UsageReport;
      expect(after.rows.map((row) => row.runId)).not.toContain('run_before');
    } finally {
      await pool.query(
        `DELETE FROM workflow_run_lifecycles
         WHERE organization_id = 'org_atlas' AND run_id IN ('run_cross', 'run_before')`,
      );
      await pool.query(
        `DELETE FROM workflow_runs
         WHERE organization_id = 'org_atlas' AND run_id IN ('run_cross', 'run_before')`,
      );
    }
  });

  it('counts a delayed start record for an earlier lifecycle update only once', async () => {
    try {
      await pool.query(
        `INSERT INTO workflow_run_lifecycles
          (organization_id, environment_id, run_id, workflow_name, started_at, ended_at,
           duration_ms, retry_count, outcome)
         VALUES ('org_atlas', 'development', 'run_late_start', 'Checkout',
           '2026-09-06T10:00:00.000Z', '2026-09-06T10:05:00.000Z', 300000, 0, 'succeeded')`,
      );
      const orphan = (await (await getReport()).json()) as UsageReport;
      expect(orphan.completeness).toBe('incomplete');
      expect(orphan.rows.filter((row) => row.runId === 'run_late_start')).toHaveLength(1);

      await insertStartedRun({
        runId: 'run_late_start',
        workflowVersionId: checkoutWorkflowVersionId,
        startedAt: '2026-09-06T10:00:00.000Z',
        state: 'completed',
      });
      const matched = (await (await getReport()).json()) as UsageReport;
      expect(matched.rows.filter((row) => row.runId === 'run_late_start')).toHaveLength(1);
      expect(matched.completeness).toBe('verified');
    } finally {
      await pool.query(
        `DELETE FROM workflow_run_lifecycles
         WHERE organization_id = 'org_atlas' AND run_id = 'run_late_start'`,
      );
      await pool.query(
        `DELETE FROM workflow_runs
         WHERE organization_id = 'org_atlas' AND run_id = 'run_late_start'`,
      );
    }
  });

  it('discloses incomplete history when a started run has no lifecycle row', async () => {
    try {
      await insertStartedRun({
        runId: 'run_no_lifecycle',
        workflowVersionId: checkoutWorkflowVersionId,
        startedAt: '2026-09-06T11:00:00.000Z',
        state: 'running',
      });
      const body = (await (await getReport()).json()) as UsageReport;
      expect(body.completeness).toBe('incomplete');
      expect(body.completenessNote).toContain(
        'Do not treat these totals as a verified billing figure',
      );
      expect(body.rows.filter((row) => row.runId === 'run_no_lifecycle')).toEqual([
        expect.objectContaining({ runId: 'run_no_lifecycle', outcome: 'inProgress' }),
      ]);
    } finally {
      await pool.query(
        `DELETE FROM workflow_runs
         WHERE organization_id = 'org_atlas' AND run_id = 'run_no_lifecycle'`,
      );
    }
  });
});
