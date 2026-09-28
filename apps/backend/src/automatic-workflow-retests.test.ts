import { workflowSandboxRuntimeVersion, workflowSandboxWorkerVersion } from '@atlas/demo-estate';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import {
  configureWorkflowSandboxRetestPolicy,
  processNextWorkflowSandboxRetest,
  queueCapabilityRediscoveryRetests,
  queueExpiredWorkflowSandboxRetests,
  readWorkflowSandboxTestHistory,
} from './automatic-workflow-retests.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import {
  readWorkflowSandboxReadiness,
  runWorkflowSandboxTests,
  type WorkflowSandboxExecutor,
} from './workflow-sandbox.js';
import { deterministicTestExecutionMethods } from './workflow-sandbox-test-support.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'automatic_workflow_retests_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const oldCapabilityVersionId = 'a'.repeat(64);
const newCapabilityVersionId = 'b'.repeat(64);
let fail = false;
let unavailable = false;

const executor: WorkflowSandboxExecutor = {
  async execute(input) {
    if (unavailable) throw new Error('sandbox worker is offline');
    return input.tests.map((test) => ({
      testId: test.testId,
      status: fail ? ('failed' as const) : ('passed' as const),
      workerVersion: workflowSandboxWorkerVersion,
      runtimeVersion: workflowSandboxRuntimeVersion,
      executionMethods: deterministicTestExecutionMethods(test.kind),
    }));
  },
};

let workflow: Awaited<ReturnType<typeof createCompiledWorkflowVersion>>;

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 105 });
  await pool.query(`
    TRUNCATE organizations RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_auto');
    INSERT INTO environments (organization_id, id, name, kind)
      VALUES ('org_auto', 'test', 'Automated tests', 'development');
  `);
  const source = await pool.query<{ id: string }>(
    `INSERT INTO source_documents
      (organization_id, service_id, format, document, document_hash, repository, commit_sha, path)
     VALUES ('org_auto', 'payments', 'openapi', '{"openapi":"3.1.0"}', $1,
       'fixture', 'v1', 'payments.json') RETURNING id`,
    ['c'.repeat(64)],
  );
  const identity = await pool.query<{ id: string }>(
    `INSERT INTO capability_identities (organization_id, kind, service_id, operation_id)
     VALUES ('org_auto', 'openapi', 'payments', 'getPayment') RETURNING id`,
  );
  const annotation = await pool.query<{ id: string }>(
    `INSERT INTO manifest_annotations
      (organization_id, capability_identity_id, annotation_hash, owner, business_semantics,
       irreversible_after, source_document_id)
     VALUES ('org_auto', $1, $2, 'payments-team', $3, false, $4) RETURNING id`,
    [
      identity.rows[0]!.id,
      'd'.repeat(64),
      { provider: 'Payments', sourceType: 'internal', defaultConnectionMode: 'local' },
      source.rows[0]!.id,
    ],
  );
  for (const capabilityVersionId of [oldCapabilityVersionId, newCapabilityVersionId]) {
    await pool.query(
      `INSERT INTO capability_versions
        (organization_id, capability_version_id, capability_identity_id, source_document_id,
         manifest_annotation_id, capability_fragment_hash, capability_fragment)
       VALUES ('org_auto', $1, $2, $3, $4, $5, $6)`,
      [
        capabilityVersionId,
        identity.rows[0]!.id,
        source.rows[0]!.id,
        annotation.rows[0]!.id,
        capabilityVersionId,
        {
          method: 'get',
          path: '/payments/{paymentId}',
          pathParameters: [{ name: 'paymentId', schema: { type: 'string' } }],
          operation: { responses: { '200': { description: 'Payment' } } },
        },
      ],
    );
  }
  workflow = await createCompiledWorkflowVersion('payment-workflow@1', 'org_auto', {
    irVersion: 1,
    steps: [
      {
        id: 'read-payment',
        kind: 'capabilityCall',
        capabilityVersionId: oldCapabilityVersionId,
        arguments: {},
      },
      { id: 'complete', kind: 'terminal', state: 'completed' },
    ],
  });
  await pool.query(
    `INSERT INTO workflow_versions
      (organization_id, workflow_version_id, ir_hash, compiled_workflow)
     VALUES ('org_auto', $1, $2, $3)`,
    [workflow.workflowVersionId, workflow.irHash, workflow],
  );
  await pool.query(
    `INSERT INTO workflow_capability_dependencies
      (organization_id, workflow_version_id, step_id, capability_version_id)
     VALUES ('org_auto', $1, 'read-payment', $2)`,
    [workflow.workflowVersionId, oldCapabilityVersionId],
  );
  await pool.query(
    `INSERT INTO workflow_approvals
      (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
       projection_fingerprint, approved_by, lifecycle_status)
     VALUES ('org_auto', 'test', $1, $2, 'test-policy', $3, 'admin@example.com', 'current')`,
    [workflow.workflowVersionId, workflow.irHash, 'e'.repeat(64)],
  );
  await runWorkflowSandboxTests(
    pool,
    executor,
    { organizationId: 'org_auto', environmentId: 'test', draft: workflow },
    'admin@example.com',
  );
});

afterAll(async () => pool.end());

describe('automatic workflow retesting', () => {
  it('stales affected approved artifacts and deduplicates rediscovery revalidation', async () => {
    const input = {
      organizationId: 'org_auto',
      discoveryId: '42',
      fromCapabilityVersionId: oldCapabilityVersionId,
      toCapabilityVersionId: newCapabilityVersionId,
    };
    await expect(queueCapabilityRediscoveryRetests(pool, input)).resolves.toBe(1);
    await expect(queueCapabilityRediscoveryRetests(pool, input)).resolves.toBe(0);

    await expect(
      readWorkflowSandboxReadiness(pool, {
        organizationId: 'org_auto',
        environmentId: 'test',
        workflowVersionId: workflow.workflowVersionId,
        irHash: workflow.irHash,
      }),
    ).resolves.toMatchObject({ ready: false, status: 'queued' });

    await expect(processNextWorkflowSandboxRetest(pool, executor)).resolves.toMatchObject({
      status: 'passed',
    });
    const history = await readWorkflowSandboxTestHistory(pool, {
      organizationId: 'org_auto',
      environmentId: 'test',
      workflowVersionId: workflow.workflowVersionId,
    });
    expect(history.results).toHaveLength(2);
    expect(history.results[0]).toMatchObject({
      status: 'passed',
      trigger: 'capability-rediscovery',
      triggerDetail: { discoveryId: '42' },
      setupBinding: { irHash: workflow.irHash, environmentId: 'test' },
    });
    expect(history.results[1]).toMatchObject({ trigger: 'manual' });
  });

  it('queues expired results once and never changes workflow approval state', async () => {
    await configureWorkflowSandboxRetestPolicy(pool, {
      organizationId: 'org_auto',
      environmentId: 'test',
      maxAgeHours: 1,
    });
    await pool.query(
      `UPDATE workflow_sandbox_test_runs SET tested_at = current_timestamp - interval '2 hours'`,
    );
    await expect(queueExpiredWorkflowSandboxRetests(pool)).resolves.toBe(1);
    await expect(queueExpiredWorkflowSandboxRetests(pool)).resolves.toBe(0);
    fail = true;
    await expect(processNextWorkflowSandboxRetest(pool, executor)).resolves.toMatchObject({
      status: 'failed',
    });
    const approval = await pool.query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM workflow_approvals
       WHERE organization_id = 'org_auto' AND workflow_version_id = $1`,
      [workflow.workflowVersionId],
    );
    expect(approval.rows).toEqual([{ lifecycle_status: 'current' }]);
    expect(
      (
        await readWorkflowSandboxTestHistory(pool, {
          organizationId: 'org_auto',
          environmentId: 'test',
          workflowVersionId: workflow.workflowVersionId,
        })
      ).results[0],
    ).toMatchObject({ status: 'failed', trigger: 'expiration' });
  });

  it('exposes an unavailable automatic run instead of preserving an old pass as current', async () => {
    await pool.query(
      `UPDATE workflow_sandbox_test_runs SET tested_at = current_timestamp - interval '2 hours'`,
    );
    await expect(queueExpiredWorkflowSandboxRetests(pool)).resolves.toBe(1);
    fail = false;
    unavailable = true;
    await expect(processNextWorkflowSandboxRetest(pool, executor)).resolves.toMatchObject({
      status: 'unavailable',
    });
    await expect(
      readWorkflowSandboxReadiness(pool, {
        organizationId: 'org_auto',
        environmentId: 'test',
        workflowVersionId: workflow.workflowVersionId,
        irHash: workflow.irHash,
      }),
    ).resolves.toMatchObject({ ready: false, status: 'unavailable' });
    const unavailableHistory = await readWorkflowSandboxTestHistory(pool, {
      organizationId: 'org_auto',
      environmentId: 'test',
      workflowVersionId: workflow.workflowVersionId,
    });
    expect(unavailableHistory.automaticRuns[0]).toMatchObject({
      status: 'unavailable',
      trigger: 'expiration',
      unavailableReason: 'sandbox worker is offline',
    });

    unavailable = false;
    await runWorkflowSandboxTests(
      pool,
      executor,
      { organizationId: 'org_auto', environmentId: 'test', draft: workflow },
      'admin@example.com',
    );
    await expect(
      readWorkflowSandboxReadiness(pool, {
        organizationId: 'org_auto',
        environmentId: 'test',
        workflowVersionId: workflow.workflowVersionId,
        irHash: workflow.irHash,
      }),
    ).resolves.toMatchObject({ ready: true, status: 'passed' });
  });
});
