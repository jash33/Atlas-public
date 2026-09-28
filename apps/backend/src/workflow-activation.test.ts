import { generateExecutionGrantKeyPair } from '@atlas/execution-grant';
import {
  compileTemporalWorkflowArtifact,
  type TemporalWorkflowArtifactManifest,
} from '@atlas/workflow-artifact';
import { createCompiledWorkflowVersion, type CompiledWorkflowVersion } from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { readWorkflowCapabilityLossProtection } from './capability-loss-protection.js';
import { createExecutionGrantIssuer } from './execution-grant-issuer.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_activation_v3_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const organizationId = 'org_activation';
const environmentId = 'production';
const oldCapabilityVersionId = 'a'.repeat(64);
const newCapabilityVersionId = 'b'.repeat(64);
let app: ReturnType<typeof createApp>;
let sourceWorkflow: CompiledWorkflowVersion;
let candidateWorkflow: CompiledWorkflowVersion;
let sourceArtifact: TemporalWorkflowArtifactManifest;
let candidateArtifact: TemporalWorkflowArtifactManifest;

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 66 });
  const keyPair = await generateExecutionGrantKeyPair();
  app = createApp(pool, { allowedHosts: [] }, undefined, undefined, {
    approvalAuthorizer: {
      async authorize({ authorizationHeader }) {
        return authorizationHeader === 'Bearer admin-token'
          ? { actorId: 'admin@example.com', role: 'admin' as const }
          : null;
      },
    },
    workerAuthorizer: {
      async authorize({ authorizationHeader }) {
        return authorizationHeader === 'Bearer worker-token';
      },
    },
    executionGrantIssuer: createExecutionGrantIssuer(keyPair.privateKey),
  });
});

beforeEach(seedActivationGraph);

afterAll(async () => {
  await pool.end();
});

describe('workflow migration activation API', () => {
  it('shows exact grant pins, worker compatibility, and every blocker before activation', async () => {
    expect((await registerWorker(2, 2)).status).toBe(204);
    await pool.query(
      `DELETE FROM workflow_approvals
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3`,
      [organizationId, environmentId, candidateWorkflow.workflowVersionId],
    );

    const response = await app.request(
      `/v1/workflow-lifecycle?organizationId=${organizationId}&environmentId=${environmentId}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      activationCandidates: [
        {
          candidateId: '1',
          source: {
            workflowVersionId: sourceWorkflow.workflowVersionId,
            capabilityVersionId: oldCapabilityVersionId,
          },
          candidate: {
            workflowVersionId: candidateWorkflow.workflowVersionId,
            capabilityVersionId: newCapabilityVersionId,
            irHash: candidateWorkflow.irHash,
            irVersion: 1,
            requiredCapabilityVersionIds: [newCapabilityVersionId],
            artifactId: null,
          },
          workerDeclarations: [
            {
              workerId: 'payment-worker',
              minimumIrVersion: 2,
              maximumIrVersion: 2,
              supported: false,
            },
          ],
          blockers: [
            {
              code: 'fresh-approval-required',
              message: 'Every new capability-version pin requires a fresh approval.',
            },
            {
              code: 'worker-ir-version-unsupported',
              message: "Candidate IR version '1' is outside worker 'payment-worker' range '2..2'",
            },
          ],
          activationEnabled: false,
        },
      ],
      rollbackActivations: [],
    });
  });

  it('requires a fresh approval before activating a pin-refresh migration', async () => {
    expect((await registerWorker(1, 1)).status).toBe(204);
    await pool.query(
      `DELETE FROM workflow_approvals
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3`,
      [organizationId, environmentId, candidateWorkflow.workflowVersionId],
    );

    const response = await app.request('/v1/workflow-migration-candidates/1/activation', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, environmentId }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workflow-activation-conflict',
      message: 'Migration candidate must be approved before activation',
    });
    await expect(
      (await requestExecutionGrant('run-after-unapproved-pin-refresh')).json(),
    ).resolves.toMatchObject({
      grant: {
        workflowVersionId: sourceWorkflow.workflowVersionId,
        approvedCapabilityVersionIds: [oldCapabilityVersionId],
      },
    });
  });

  it('keeps an approved migration inactive until activation atomically switches the pair', async () => {
    expect((await registerWorker(1, 1)).status).toBe(204);
    const identity = await pool.query<{ id: string }>(
      `SELECT capability_identity_id AS id FROM capability_versions
       WHERE organization_id = $1 AND capability_version_id = $2`,
      [organizationId, oldCapabilityVersionId],
    );
    await pool.query(
      `INSERT INTO environments (organization_id, id, name, kind)
       VALUES ($1, $2, 'Production', 'production')`,
      [organizationId, environmentId],
    );
    await pool.query(
      `INSERT INTO workflow_environment_versions
        (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active)
       VALUES
        ($1, $2, $3, 'active', true),
        ($1, $2, $4, 'approved-inactive', false)`,
      [
        organizationId,
        environmentId,
        sourceWorkflow.workflowVersionId,
        candidateWorkflow.workflowVersionId,
      ],
    );
    await pool.query(
      `INSERT INTO environment_capability_observations
        (organization_id, environment_id, capability_identity_id, capability_version_id,
         availability_status, freshness_status, status_reason)
       VALUES ($1, $2, $3, $4, 'removed', 'fresh',
         'operation-absent-from-successful-discovery')`,
      [organizationId, environmentId, identity.rows[0]!.id, oldCapabilityVersionId],
    );
    await expect(
      readWorkflowCapabilityLossProtection(pool, {
        organizationId,
        environmentId,
        workflowVersionId: sourceWorkflow.workflowVersionId,
      }),
    ).resolves.toMatchObject({ allowed: false });
    const before = await requestExecutionGrant('run-before-activation');
    expect(before.status).toBe(409);
    await expect(before.json()).resolves.toMatchObject({
      error: 'workflow-capability-removed',
      blockers: [expect.stringContaining('confirmed removed')],
    });

    const response = await app.request('/v1/workflow-migration-candidates/1/activation', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, environmentId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      artifactId: candidateArtifact.artifactId,
      current: {
        workflowVersionId: candidateWorkflow.workflowVersionId,
        capabilityVersionId: newCapabilityVersionId,
      },
      previous: {
        workflowVersionId: sourceWorkflow.workflowVersionId,
        capabilityVersionId: oldCapabilityVersionId,
      },
    });
    await expect(
      pool.query<{ current_artifact_id: string }>(
        `SELECT current_artifact_id FROM workflow_activations
         WHERE organization_id = $1 AND environment_id = $2`,
        [organizationId, environmentId],
      ),
    ).resolves.toMatchObject({
      rows: [{ current_artifact_id: candidateArtifact.artifactId }],
    });
    const statuses = await pool.query<{ workflow_version_id: string; lifecycle_status: string }>(
      `SELECT workflow_version_id, lifecycle_status FROM workflow_approvals
       WHERE organization_id = $1 AND environment_id = $2 ORDER BY workflow_version_id`,
      [organizationId, environmentId],
    );
    expect(statuses.rows).toEqual([
      { workflow_version_id: sourceWorkflow.workflowVersionId, lifecycle_status: 'superseded' },
      { workflow_version_id: candidateWorkflow.workflowVersionId, lifecycle_status: 'current' },
    ]);
    await expect(
      readWorkflowCapabilityLossProtection(pool, {
        organizationId,
        environmentId,
        workflowVersionId: candidateWorkflow.workflowVersionId,
      }),
    ).resolves.toMatchObject({ allowed: true, blockers: [] });

    const after = await requestExecutionGrant('run-after-activation');
    expect(after.status).toBe(201);
    await expect(after.json()).resolves.toMatchObject({
      grant: {
        workflowVersionId: candidateWorkflow.workflowVersionId,
        approvedCapabilityVersionIds: [newCapabilityVersionId],
      },
    });
    const retriedBefore = await requestExecutionGrant('run-before-activation');
    await expect(retriedBefore.json()).resolves.toMatchObject({
      grant: {
        workflowVersionId: candidateWorkflow.workflowVersionId,
        approvedCapabilityVersionIds: [newCapabilityVersionId],
      },
    });
  });

  it('offers rollback only for the active workflow and capability pair', async () => {
    expect((await registerWorker(1, 1)).status).toBe(204);
    const activation = await app.request('/v1/workflow-migration-candidates/1/activation', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, environmentId }),
    });
    const activated = (await activation.json()) as { activationId: string };

    const response = await app.request(
      `/v1/workflow-lifecycle?organizationId=${organizationId}&environmentId=${environmentId}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      activationCandidates: [],
      rollbackActivations: [
        {
          activationId: activated.activationId,
          previous: {
            workflowVersionId: sourceWorkflow.workflowVersionId,
            capabilityVersionId: oldCapabilityVersionId,
          },
          current: {
            workflowVersionId: candidateWorkflow.workflowVersionId,
            capabilityVersionId: newCapabilityVersionId,
          },
          activatedBy: 'admin@example.com',
          activatedAt: expect.any(String),
          rollbackEnabled: true,
          blocker: null,
        },
      ],
    });
  });

  it('refuses activation when the approved workflow does not contain the claimed pin change', async () => {
    expect((await registerWorker(1, 1)).status).toBe(204);
    const mismatchedWorkflow = await workflow(
      candidateWorkflow.workflowVersionId,
      oldCapabilityVersionId,
    );
    await pool.query(
      `UPDATE workflow_versions SET ir_hash = $3, compiled_workflow = $4
       WHERE organization_id = $1 AND workflow_version_id = $2`,
      [
        organizationId,
        candidateWorkflow.workflowVersionId,
        mismatchedWorkflow.irHash,
        mismatchedWorkflow,
      ],
    );
    await pool.query(
      `UPDATE workflow_approvals SET ir_hash = $3
       WHERE organization_id = $1 AND workflow_version_id = $2`,
      [organizationId, candidateWorkflow.workflowVersionId, mismatchedWorkflow.irHash],
    );
    await pool.query(
      `UPDATE workflow_migration_candidates SET draft = $2
       WHERE organization_id = $1`,
      [organizationId, mismatchedWorkflow],
    );
    await pool.query(
      `UPDATE workflow_capability_dependencies SET capability_version_id = $3
       WHERE organization_id = $1 AND workflow_version_id = $2`,
      [organizationId, candidateWorkflow.workflowVersionId, oldCapabilityVersionId],
    );

    const response = await app.request('/v1/workflow-migration-candidates/1/activation', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, environmentId }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workflow-activation-conflict',
      message: 'Approved workflow does not replace the claimed capability pin',
    });
  });

  it('refuses activation when the candidate IR is outside the serving workers range', async () => {
    expect((await registerWorker(2, 2)).status).toBe(204);

    const response = await app.request('/v1/workflow-migration-candidates/1/activation', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, environmentId }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'worker-ir-version-unsupported',
      message: "Candidate IR version '1' is outside worker 'payment-worker' range '2..2'",
    });
    const current = await requestExecutionGrant('run-after-refused-activation');
    await expect(current.json()).resolves.toMatchObject({
      grant: { workflowVersionId: sourceWorkflow.workflowVersionId },
    });
  });

  it('lifts breaking-drift quarantine only when the approved migration activates', async () => {
    expect((await registerWorker(1, 1)).status).toBe(204);
    await pool.query(
      `INSERT INTO workflow_quarantines
         (organization_id, environment_id, workflow_version_id,
          from_capability_version_id, to_capability_version_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        organizationId,
        environmentId,
        sourceWorkflow.workflowVersionId,
        oldCapabilityVersionId,
        newCapabilityVersionId,
      ],
    );
    expect((await requestExecutionGrant('run-quarantined')).status).toBe(409);

    const activation = await app.request('/v1/workflow-migration-candidates/1/activation', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, environmentId }),
    });

    expect(activation.status).toBe(200);
    const catalogAfterActivation = await app.request(
      `/v1/workflow-catalog?organizationId=${organizationId}&environmentId=${environmentId}`,
    );
    await expect(catalogAfterActivation.json()).resolves.toMatchObject({
      workflows: [
        {
          activeVersion: { workflowVersionId: candidateWorkflow.workflowVersionId },
          latestVersion: {
            workflowVersionId: candidateWorkflow.workflowVersionId,
            status: 'active',
          },
        },
      ],
    });
    const intake = await requestExecutionGrant('run-after-quarantine-lifted');
    expect(intake.status).toBe(201);
    await expect(intake.json()).resolves.toMatchObject({
      grant: { workflowVersionId: candidateWorkflow.workflowVersionId },
    });
    const quarantine = await pool.query<{ lifted_at: Date | null }>(
      `SELECT lifted_at FROM workflow_quarantines WHERE organization_id = $1`,
      [organizationId],
    );
    expect(quarantine.rows[0]!.lifted_at).toBeInstanceOf(Date);
  });

  it('rolls back the workflow version and capability pin as one pair without changing issued runs', async () => {
    expect((await registerWorker(1, 1)).status).toBe(204);
    const activation = await app.request('/v1/workflow-migration-candidates/1/activation', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, environmentId }),
    });
    const activated = (await activation.json()) as { activationId: string };
    expect(activated.activationId).toEqual(expect.any(String));
    const inFlight = await requestExecutionGrant('run-started-before-rollback');
    const inFlightGrant = (await inFlight.json()) as {
      grant: { workflowVersionId: string; approvedCapabilityVersionIds: string[] };
    };
    expect(inFlightGrant.grant).toMatchObject({
      workflowVersionId: candidateWorkflow.workflowVersionId,
      approvedCapabilityVersionIds: [newCapabilityVersionId],
    });

    const rollback = await app.request(
      `/v1/workflow-activations/${activated.activationId}/rollback`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, environmentId }),
      },
    );

    expect(rollback.status).toBe(200);
    await expect(rollback.json()).resolves.toMatchObject({
      current: {
        workflowVersionId: sourceWorkflow.workflowVersionId,
        capabilityVersionId: oldCapabilityVersionId,
      },
      rolledBack: {
        workflowVersionId: candidateWorkflow.workflowVersionId,
        capabilityVersionId: newCapabilityVersionId,
      },
    });
    const catalogAfterRollback = await app.request(
      `/v1/workflow-catalog?organizationId=${organizationId}&environmentId=${environmentId}`,
    );
    await expect(catalogAfterRollback.json()).resolves.toMatchObject({
      workflows: [
        {
          activeVersion: { workflowVersionId: sourceWorkflow.workflowVersionId },
          latestVersion: {
            workflowVersionId: candidateWorkflow.workflowVersionId,
            status: 'approved-inactive',
          },
        },
      ],
    });
    const after = await requestExecutionGrant('run-started-after-rollback');
    await expect(after.json()).resolves.toMatchObject({
      grant: {
        workflowVersionId: sourceWorkflow.workflowVersionId,
        approvedCapabilityVersionIds: [oldCapabilityVersionId],
      },
    });
    const retriedInFlight = await requestExecutionGrant('run-started-before-rollback');
    await expect(retriedInFlight.json()).resolves.toMatchObject({
      grant: {
        workflowVersionId: candidateWorkflow.workflowVersionId,
        approvedCapabilityVersionIds: [newCapabilityVersionId],
      },
    });
    expect(inFlightGrant.grant).toMatchObject({
      workflowVersionId: candidateWorkflow.workflowVersionId,
      approvedCapabilityVersionIds: [newCapabilityVersionId],
    });
    const recordedRun = await pool.query<{ workflow_version_id: string }>(
      `SELECT workflow_version_id FROM workflow_runs
       WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3`,
      [organizationId, environmentId, 'run-started-before-rollback'],
    );
    expect(recordedRun.rows[0]!.workflow_version_id).toBe(candidateWorkflow.workflowVersionId);
    const audit = await app.request(
      `/v1/audit-entries?organizationId=${organizationId}&environmentId=${environmentId}`,
    );
    const auditBody = (await audit.json()) as {
      entries: Array<{
        eventType: string;
        actorId: string;
        subjectId: string;
        details: Record<string, unknown>;
      }>;
    };
    expect(auditBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'activation',
          actorId: 'admin@example.com',
          subjectId: activated.activationId,
          details: expect.objectContaining({ outcome: 'succeeded' }),
        }),
        expect.objectContaining({
          eventType: 'rollback',
          actorId: 'admin@example.com',
          subjectId: activated.activationId,
          details: expect.objectContaining({ outcome: 'succeeded' }),
        }),
      ]),
    );
  });
});

async function seedActivationGraph() {
  await pool.query('TRUNCATE organizations, workflow_versions RESTART IDENTITY CASCADE');
  await pool.query('INSERT INTO organizations (id) VALUES ($1)', [organizationId]);
  await pool.query(
    `INSERT INTO organization_environment_policies
       (organization_id, environment_id, policy_version, approved_by)
     VALUES ($1, $2, 'mvp-validation-v1', 'admin@example.com')`,
    [organizationId, environmentId],
  );
  await pool.query(
    `INSERT INTO source_documents
       (organization_id, service_id, format, document, document_hash, repository, commit_sha, path)
     VALUES
       ($1, 'billing', 'openapi', '{}', $2, 'atlas/mock-services', 'old', 'billing.json'),
       ($1, 'billing', 'openapi', '{}', $3, 'atlas/mock-services', 'new', 'billing.json')`,
    [organizationId, '1'.repeat(64), '2'.repeat(64)],
  );
  const identity = await pool.query<{ id: string }>(
    `INSERT INTO capability_identities (organization_id, kind, service_id, operation_id)
     VALUES ($1, 'openapi', 'billing', 'settleInvoice') RETURNING id`,
    [organizationId],
  );
  const documents = await pool.query<{ id: string; commit_sha: string }>(
    'SELECT id, commit_sha FROM source_documents WHERE organization_id = $1',
    [organizationId],
  );
  const documentByCommit = new Map(documents.rows.map((row) => [row.commit_sha, row.id]));
  for (const [versionId, commit] of [
    [oldCapabilityVersionId, 'old'],
    [newCapabilityVersionId, 'new'],
  ] as const) {
    await pool.query(
      `INSERT INTO capability_versions
         (organization_id, capability_version_id, capability_identity_id, source_document_id,
          capability_fragment_hash, capability_fragment)
       VALUES ($1, $2, $3, $4, $2, '{}')`,
      [organizationId, versionId, identity.rows[0]!.id, documentByCommit.get(commit)],
    );
  }
  sourceWorkflow = await workflow('payment-flow@1', oldCapabilityVersionId);
  candidateWorkflow = await workflow('payment-flow@2', newCapabilityVersionId);
  sourceArtifact = await compileTemporalWorkflowArtifact(sourceWorkflow, {
    sandboxSuiteFingerprint: 'f'.repeat(64),
    secretReferencesByCapabilityVersion: {},
  });
  candidateArtifact = await compileTemporalWorkflowArtifact(candidateWorkflow, {
    sandboxSuiteFingerprint: 'f'.repeat(64),
    secretReferencesByCapabilityVersion: {},
  });
  for (const compiled of [sourceWorkflow, candidateWorkflow]) {
    await pool.query(
      `INSERT INTO workflow_versions
         (organization_id, workflow_version_id, ir_hash, compiled_workflow)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, compiled.workflowVersionId, compiled.irHash, compiled],
    );
    const capabilityVersionId = compiled.executionRequirements.requiredCapabilityVersionIds[0]!;
    await pool.query(
      `INSERT INTO workflow_capability_dependencies
         (organization_id, workflow_version_id, step_id, capability_version_id)
       VALUES ($1, $2, 'settle-invoice', $3)`,
      [organizationId, compiled.workflowVersionId, capabilityVersionId],
    );
  }
  await pool.query(
    `INSERT INTO workflow_approvals
       (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
        projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
     VALUES
       ($1, $2, $3, $4, 'mvp-validation-v1', $5, 'admin@example.com', 'current', $8, $9),
       ($1, $2, $6, $7, 'mvp-validation-v1', $5, 'admin@example.com', 'approved', $10, $11)`,
    [
      organizationId,
      environmentId,
      sourceWorkflow.workflowVersionId,
      sourceWorkflow.irHash,
      '0'.repeat(64),
      candidateWorkflow.workflowVersionId,
      candidateWorkflow.irHash,
      sourceArtifact.artifactId,
      sourceArtifact,
      candidateArtifact.artifactId,
      candidateArtifact,
    ],
  );
  await pool.query(
    `INSERT INTO workflow_migration_candidates
       (organization_id, environment_id, source_workflow_version_id, workflow_version_id,
        from_capability_version_id, to_capability_version_id, author, draft, validation)
     VALUES ($1, $2, $3, $4, $5, $6, 'compiler', $7, '{}')`,
    [
      organizationId,
      environmentId,
      sourceWorkflow.workflowVersionId,
      candidateWorkflow.workflowVersionId,
      oldCapabilityVersionId,
      newCapabilityVersionId,
      candidateWorkflow,
    ],
  );
}

function workflow(workflowVersionId: string, capabilityVersionId: string) {
  return createCompiledWorkflowVersion(workflowVersionId, organizationId, {
    irVersion: 1,
    inputSchema: { required: { paymentId: { type: 'string' } } },
    steps: [
      {
        id: 'settle-invoice',
        kind: 'capabilityCall',
        capabilityVersionId,
        arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
      },
      { id: 'complete', kind: 'terminal', state: 'completed' },
    ],
  });
}

function requestExecutionGrant(runId: string) {
  return app.request('/v1/execution-grants', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId, environmentId, runId, intakeKey: 'a'.repeat(64) }),
  });
}

function registerWorker(minimum: number, maximum: number) {
  return app.request('/v1/environment-workers', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      environmentId,
      workerId: 'payment-worker',
      supportedIrVersions: { minimum, maximum },
    }),
  });
}
