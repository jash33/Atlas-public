import { generateExecutionGrantKeyPair, verifyExecutionGrant } from '@atlas/execution-grant';
import {
  createNonProductionLocalEd25519Signer,
  inspectAtlasBundle,
} from '@atlas/workflow-artifact';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { createExecutionGrantIssuer } from './execution-grant-issuer.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import { saveWorkflowCatalogVersion } from './workflow-catalog.js';
import { compileWorkflowSource } from './workflow-source.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_approval_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });

let signingPublicKey: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 31 });
  await pool.query(`
    TRUNCATE organizations, workflow_versions RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas');
    INSERT INTO environments (organization_id, id, name, kind)
    VALUES ('org_atlas', 'production', 'Production', 'production');
    INSERT INTO organization_environment_policies
      (organization_id, environment_id, policy_version, approved_by)
    VALUES ('org_atlas', 'production', 'mvp-validation-v1', 'admin@example.com');
  `);
  const keyPair = await generateExecutionGrantKeyPair();
  const bundleKeyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  signingPublicKey = keyPair.publicKey;
  app = createApp(pool, { allowedHosts: [] }, undefined, undefined, {
    approvalAuthorizer: {
      async authorize({ authorizationHeader, organizationId }) {
        return authorizationHeader === 'Bearer admin-token' && organizationId === 'org_atlas'
          ? { actorId: 'admin@example.com', role: 'admin' as const }
          : null;
      },
    },
    workerAuthorizer: {
      async authorize({ authorizationHeader, organizationId, environmentId }) {
        return (
          authorizationHeader === 'Bearer worker-token' &&
          organizationId === 'org_atlas' &&
          environmentId === 'production'
        );
      },
    },
    executionGrantIssuer: createExecutionGrantIssuer(keyPair.privateKey),
    bundleSigner: createNonProductionLocalEd25519Signer(
      'approval-test-key',
      bundleKeyPair.privateKey,
    ),
  });
});

afterAll(async () => {
  await pool.end();
});

describe('workflow approval and execution API', () => {
  it('records an authorized approval bound to the recomputed hash and issues a grant per run', async () => {
    const draft = await validDraft('payment-to-billing@1');
    const projectionFingerprint = await currentProjectionFingerprint();
    const approval = await approve({ draft, projectionFingerprint });

    expect(approval.status).toBe(201);
    const approved = (await approval.json()) as {
      artifact: { artifactId: string; workflow: unknown; execution: unknown };
      bundle: { artifactId: string; signature: { keyId: string }; compiledPlan: unknown };
      source: string;
    };
    expect(approved).toMatchObject({
      workflowVersionId: draft.workflowVersionId,
      irHash: draft.irHash,
      approvedBy: 'admin@example.com',
      artifact: {
        artifactId: expect.stringMatching(/^[a-f0-9]{64}$/),
        workflow: draft,
        execution: expect.objectContaining({
          ordering: { mode: 'sequential', scope: 'workflow-run' },
        }),
      },
      bundle: {
        artifactId: expect.stringMatching(/^[a-f0-9]{64}$/),
        signature: { keyId: 'approval-test-key' },
      },
    });
    expect(approved.source).toContain('formatVersion: atlas-source/v1');
    const audit = await app.request(
      '/v1/audit-entries?organizationId=org_atlas&environmentId=production',
    );
    const auditBody = (await audit.json()) as {
      entries: Array<{
        id: string;
        eventType: string;
        actorId: string;
        subjectId: string;
        details: Record<string, unknown>;
      }>;
    };
    const approvalEntry = auditBody.entries.find(
      (entry) => entry.eventType === 'approval' && entry.subjectId === draft.workflowVersionId,
    );
    expect(approvalEntry).toMatchObject({
      actorId: 'admin@example.com',
      details: expect.objectContaining({ outcome: 'succeeded' }),
    });
    await expect(
      pool.query(`UPDATE audit_entries SET actor_id = 'somebody-else' WHERE id = $1`, [
        approvalEntry!.id,
      ]),
    ).rejects.toThrow('audit entries are append-only');
    await expect(
      pool.query('DELETE FROM audit_entries WHERE id = $1', [approvalEntry!.id]),
    ).rejects.toThrow('audit entries are append-only');
    await expect(pool.query('TRUNCATE audit_entries')).rejects.toThrow(
      'audit entries are append-only',
    );

    const mismatchedGrant = await requestGrant('run_wrong_artifact', 'f'.repeat(64));
    expect(mismatchedGrant.status).toBe(409);
    await expect(mismatchedGrant.json()).resolves.toEqual({
      error: 'execution-artifact-no-longer-active',
    });

    const grantResponse = await requestGrant('run_1', approved.bundle.artifactId, {
      type: 'webhook',
      deliveryId: 'stripe-event-100',
    });

    expect(grantResponse.status).toBe(201);
    const { artifactId, grant } = (await grantResponse.json()) as {
      artifactId: string;
      grant: Parameters<typeof verifyExecutionGrant>[1];
    };
    expect(artifactId).toBe(approved.bundle.artifactId);
    await expect(
      verifyExecutionGrant(signingPublicKey, grant, {
        organizationId: 'org_atlas',
        environmentId: 'production',
        runId: 'run_1',
        workflowVersionId: draft.workflowVersionId,
        irHash: draft.irHash,
        requiredCapabilityVersionIds: [],
      }),
    ).resolves.toBeUndefined();
    await expect(
      pool.query<{
        organization_id: string;
        environment_id: string;
        run_id: string;
        workflow_version_id: string;
        artifact_id: string;
        ir_hash: string;
        activation_artifact_id: string;
        approval_binding: Record<string, unknown>;
        admission_binding: Record<string, unknown>;
      }>(
        `SELECT run.organization_id, run.environment_id, run.run_id,
                run.workflow_version_id, run.artifact_id, version.ir_hash,
                bundle.activation_artifact_id, bundle.approval_binding,
                run.admission_binding
         FROM workflow_runs run
         JOIN workflow_versions version
           ON version.organization_id = run.organization_id
          AND version.workflow_version_id = run.workflow_version_id
         JOIN atlas_workflow_bundles bundle
           ON bundle.organization_id = run.organization_id
          AND bundle.environment_id = run.environment_id
          AND bundle.artifact_id = run.artifact_id
         WHERE run.organization_id = 'org_atlas'
           AND run.environment_id = 'production'
           AND run.run_id = 'run_1'`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          organization_id: 'org_atlas',
          environment_id: 'production',
          run_id: 'run_1',
          workflow_version_id: draft.workflowVersionId,
          artifact_id: approved.bundle.artifactId,
          ir_hash: draft.irHash,
          activation_artifact_id: approved.bundle.artifactId,
          approval_binding: {
            artifactId: approved.bundle.artifactId,
            organizationId: 'org_atlas',
            environmentId: 'production',
            workflowVersionId: draft.workflowVersionId,
            irHash: draft.irHash,
            status: 'active',
          },
          admission_binding: {
            organizationId: 'org_atlas',
            environmentId: 'production',
            runId: 'run_1',
            workflowVersionId: draft.workflowVersionId,
            artifactId: approved.bundle.artifactId,
            irHash: draft.irHash,
            capabilityVersionIds: [],
            activationArtifactId: approved.bundle.artifactId,
            approval: {
              artifactId: approved.bundle.artifactId,
              workflowVersionId: draft.workflowVersionId,
              irHash: draft.irHash,
              status: 'active',
            },
            executionGrant: grant,
          },
        },
      ],
    });
    await expect(
      pool.query(
        `UPDATE workflow_runs
         SET admission_binding = admission_binding || '{"artifactId":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}'::jsonb
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
           AND run_id = 'run_1'`,
      ),
    ).rejects.toThrow('workflow run admission binding is immutable');
    const run = await app.request(
      '/v1/runs/run_1?organizationId=org_atlas&environmentId=production',
    );
    await expect(run.json()).resolves.toMatchObject({
      workflowVersionId: draft.workflowVersionId,
      artifactId: approved.bundle.artifactId,
      trigger: { type: 'webhook', deliveryId: 'stripe-event-100' },
    });

    const scheduledCommandId = '00000000-0000-4000-8000-000000000068';
    const scheduleId = '00000000-0000-4000-8000-000000000068';
    await pool.query(
      `INSERT INTO workflow_run_commands
        (command_id, organization_id, environment_id, target_worker_id, artifact_id,
         encrypted_payload, status, trigger_type, trigger_schedule_id, trigger_scheduled_for)
       VALUES ($1, 'org_atlas', 'production', 'worker-production', $2, 'ciphertext',
         'dispatched', 'schedule', $3, '2026-08-17T13:00:00.000Z')`,
      [scheduledCommandId, approved.bundle.artifactId, scheduleId],
    );
    const scheduledGrant = await requestGrant(
      'run_scheduled',
      approved.bundle.artifactId,
      { type: 'schedule', scheduleId, scheduledFor: '2026-08-17T13:00:00.000Z' },
      scheduledCommandId,
    );
    expect(scheduledGrant.status).toBe(201);
    await expect(scheduledGrant.json()).resolves.toMatchObject({
      artifactId: approved.bundle.artifactId,
      grant: {
        workflowVersionId: draft.workflowVersionId,
        approvedCapabilityVersionIds: [],
      },
    });
    const scheduledRun = await app.request(
      '/v1/runs/run_scheduled?organizationId=org_atlas&environmentId=production',
    );
    await expect(scheduledRun.json()).resolves.toMatchObject({
      workflowVersionId: draft.workflowVersionId,
      artifactId: approved.bundle.artifactId,
      trigger: { type: 'schedule', scheduleId, scheduledFor: '2026-08-17T13:00:00.000Z' },
    });

    const fetched = await app.request(
      `/v1/workflow-versions/${draft.workflowVersionId}?organizationId=org_atlas&environmentId=production`,
      { headers: { authorization: 'Bearer worker-token' } },
    );
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toEqual(draft);

    const fetchedArtifact = await app.request(
      `/v1/workflow-artifacts/${approved.bundle.artifactId}?organizationId=org_atlas&environmentId=production`,
      { headers: { authorization: 'Bearer worker-token' } },
    );
    expect(fetchedArtifact.status).toBe(200);
    await expect(fetchedArtifact.json()).resolves.toEqual(approved.artifact);

    const fetchedBundle = await app.request(
      `/v1/workflow-bundles/${approved.bundle.artifactId}?organizationId=org_atlas&environmentId=production`,
      { headers: { authorization: 'Bearer worker-token' } },
    );
    expect(fetchedBundle.status).toBe(200);
    expect(inspectAtlasBundle(new Uint8Array(await fetchedBundle.arrayBuffer()))).toEqual(
      approved.bundle,
    );

    await pool.query(
      `UPDATE workflow_approvals SET artifact_id = NULL, artifact_manifest = NULL
       WHERE organization_id = 'org_atlas' AND environment_id = 'production'
         AND workflow_version_id = $1`,
      [draft.workflowVersionId],
    );
    const existingRun = await requestGrant('run_1');
    await expect(existingRun.json()).resolves.toMatchObject({
      artifactId: approved.bundle.artifactId,
    });
    const firstPostMigrationRun = await requestGrant('run_2');
    expect(firstPostMigrationRun.status).toBe(201);
    await expect(firstPostMigrationRun.json()).resolves.toMatchObject({
      artifactId: approved.bundle.artifactId,
    });
    await expect(
      pool.query<{ artifact_id: string }>(
        `SELECT artifact_id FROM workflow_approvals
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
           AND workflow_version_id = $1`,
        [draft.workflowVersionId],
      ),
    ).resolves.toMatchObject({ rows: [{ artifact_id: approved.bundle.artifactId }] });

    const queuedCommandId = '00000000-0000-4000-8000-000000000067';
    await pool.query(
      `INSERT INTO workflow_run_commands
        (command_id, organization_id, environment_id, target_worker_id, artifact_id,
         encrypted_payload, status, trigger_type, trigger_delivery_id,
         trigger_payload_fingerprint)
       VALUES ($1, 'org_atlas', 'production', 'worker-production', $2, 'ciphertext',
         'dispatched', 'webhook', 'delivery-before-activation', repeat('c', 64))`,
      [queuedCommandId, approved.bundle.artifactId],
    );
    const nextDraft = await validDraft('payment-to-billing@2');
    const nextApproval = await approve({
      draft: nextDraft,
      projectionFingerprint: await currentProjectionFingerprint(),
    });
    expect(nextApproval.status).toBe(201);
    const nextApproved = (await nextApproval.json()) as {
      artifact: { artifactId: string };
      bundle: { artifactId: string };
    };
    await expect(
      pool.query<{ workflow_version_id: string; lifecycle_status: string }>(
        `SELECT workflow_version_id, lifecycle_status FROM workflow_approvals
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
         ORDER BY workflow_version_id`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { workflow_version_id: draft.workflowVersionId, lifecycle_status: 'superseded' },
        { workflow_version_id: nextDraft.workflowVersionId, lifecycle_status: 'current' },
      ],
    });
    const postApprovalGrant = await requestGrant(
      'run_after_approval',
      nextApproved.bundle.artifactId,
    );
    expect(postApprovalGrant.status).toBe(201);
    await expect(postApprovalGrant.json()).resolves.toMatchObject({
      artifactId: nextApproved.bundle.artifactId,
      grant: { workflowVersionId: nextDraft.workflowVersionId },
    });

    const replayedOriginalRun = await requestGrant('run_1');
    expect(replayedOriginalRun.status).toBe(201);
    await expect(replayedOriginalRun.json()).resolves.toEqual({
      artifactId: approved.bundle.artifactId,
      grant,
    });
    const rejectedOldArtifact = await requestGrant(
      'new_run_for_superseded_artifact',
      approved.bundle.artifactId,
    );
    expect(rejectedOldArtifact.status).toBe(409);
    await expect(rejectedOldArtifact.json()).resolves.toEqual({
      error: 'execution-artifact-no-longer-active',
    });

    const queuedGrant = await requestGrant(
      'run_queued_before_activation',
      approved.bundle.artifactId,
      { type: 'webhook', deliveryId: 'delivery-before-activation' },
      queuedCommandId,
    );
    expect(queuedGrant.status).toBe(201);
    await expect(queuedGrant.json()).resolves.toMatchObject({
      artifactId: approved.bundle.artifactId,
      grant: { workflowVersionId: draft.workflowVersionId },
    });
  });

  // Console can have several current workflows in one environment. Approve used
  // to look up "the" current workflow_id as a single Postgres value, which 500s
  // when two or more are current. Catalog already named this version; Approve
  // must keep that identity and leave the other currents in place.
  it('approves a named workflow when other workflows are already current in the environment', async () => {
    const hash = (label: string) => Buffer.from(label.padEnd(32, '0')).toString('hex');
    await pool.query(
      `INSERT INTO workflow_identities (organization_id, workflow_id, name)
       VALUES
         ('org_atlas', 'workflow_current_a', 'Current A'),
         ('org_atlas', 'workflow_current_b', 'Current B')
       ON CONFLICT (organization_id, workflow_id) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO workflow_versions
        (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
       VALUES
         ('org_atlas', 'current-a@1', 'workflow_current_a', $1, '{}'::jsonb),
         ('org_atlas', 'current-b@1', 'workflow_current_b', $2, '{}'::jsonb)`,
      [hash('current-a'), hash('current-b')],
    );
    await pool.query(
      `INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, workflow_id, ir_hash,
         policy_version, projection_fingerprint, approved_by, lifecycle_status)
       VALUES
         ('org_atlas', 'production', 'current-a@1', 'workflow_current_a', $1,
          'mvp-validation-v1', $3, 'admin@example.com', 'current'),
         ('org_atlas', 'production', 'current-b@1', 'workflow_current_b', $2,
          'mvp-validation-v1', $3, 'admin@example.com', 'current')`,
      [hash('current-a'), hash('current-b'), hash('projection')],
    );

    const draft = await validDraft('named-third@1');
    // Same order as Console: name the version in Catalog, then Approve.
    await saveWorkflowCatalogVersion(pool, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowId: 'workflow_named_third',
      name: 'Named third',
      status: 'awaiting-approval',
      draft,
    });

    const approval = await approve({
      draft,
      projectionFingerprint: await currentProjectionFingerprint(),
    });
    expect(approval.status).toBe(201);
    await expect(approval.json()).resolves.toMatchObject({
      workflowVersionId: draft.workflowVersionId,
      irHash: draft.irHash,
    });
    const currents = await pool.query<{ workflow_id: string }>(
      `SELECT workflow_id FROM workflow_approvals
       WHERE organization_id = 'org_atlas' AND environment_id = 'production'
         AND lifecycle_status = 'current'
       ORDER BY workflow_id`,
    );
    expect(currents.rows.map(({ workflow_id }) => workflow_id)).toEqual(
      expect.arrayContaining(['workflow_current_a', 'workflow_current_b', 'workflow_named_third']),
    );
  });

  it('blocks approval when validation reports any unsatisfied diagnostic', async () => {
    const draft = await validDraft('blocked-workflow@1');
    const response = await approve({ draft, projectionFingerprint: '0'.repeat(64) });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: 'workflow-not-approvable',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: 'PROJECTION_FINGERPRINT_MISMATCH' }),
      ]),
    });
  });

  it('requires an authorized admin for approval and the environment worker for execution', async () => {
    const draft = await validDraft('unauthorized-workflow@1');
    const projectionFingerprint = await currentProjectionFingerprint();
    const unauthorizedApproval = await app.request('/v1/workflow-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        projectionFingerprint,
        draft,
      }),
    });
    expect(unauthorizedApproval.status).toBe(403);

    const unauthorizedFetch = await app.request(
      `/v1/workflow-versions/${draft.workflowVersionId}?organizationId=org_atlas&environmentId=production`,
    );
    expect(unauthorizedFetch.status).toBe(403);
  });

  it('binds ExecutionGrant issuance to API trigger provenance on the run command', async () => {
    const draft = await validDraft('api-trigger-binding@1');
    const projectionFingerprint = await currentProjectionFingerprint();
    const approval = await approve({ draft, projectionFingerprint });
    expect(approval.status).toBe(201);
    const approved = (await approval.json()) as { bundle: { artifactId: string } };
    const commandId = '00000000-0000-4000-8000-000000000205';
    await pool.query(
      `INSERT INTO workflow_run_commands
        (command_id, organization_id, environment_id, target_worker_id, artifact_id,
         encrypted_payload, status, trigger_type, trigger_delivery_id,
         trigger_payload_fingerprint)
       VALUES ($1, 'org_atlas', 'production', 'worker-production', $2, 'ciphertext',
         'dispatched', 'api', 'request-205', repeat('d', 64))`,
      [commandId, approved.bundle.artifactId],
    );

    const matched = await requestGrant(
      'run_api_matched',
      approved.bundle.artifactId,
      { type: 'api', deliveryId: 'request-205' },
      commandId,
    );
    expect(matched.status).toBe(201);
    await expect(matched.json()).resolves.toMatchObject({
      artifactId: approved.bundle.artifactId,
      grant: { workflowVersionId: draft.workflowVersionId },
    });
    const run = await app.request(
      '/v1/runs/run_api_matched?organizationId=org_atlas&environmentId=production',
    );
    await expect(run.json()).resolves.toMatchObject({
      trigger: { type: 'api', deliveryId: 'request-205' },
    });

    const mismatched = await requestGrant(
      'run_api_mismatched',
      approved.bundle.artifactId,
      { type: 'api', deliveryId: 'other-key' },
      commandId,
    );
    expect(mismatched.status).toBe(409);
    await expect(mismatched.json()).resolves.toEqual({
      error: 'execution-artifact-no-longer-active',
    });

    const wrongType = await requestGrant(
      'run_api_wrong_type',
      approved.bundle.artifactId,
      { type: 'webhook', deliveryId: 'request-205' },
      commandId,
    );
    expect(wrongType.status).toBe(409);
    await expect(wrongType.json()).resolves.toEqual({
      error: 'execution-artifact-no-longer-active',
    });
  });
});

// Approve renders Atlas source and recompiles it, then checks the hash.
// Hand-built IR (especially irVersion 1) fails that round-trip even when the
// identity lookup is correct. Compile from source so the draft is one Approve
// will accept.
async function validDraft(workflowVersionId: string) {
  const projection = await readPlannerCapabilityProjection(pool, 'org_atlas', 'production');
  const compiled = await compileWorkflowSource(
    [
      'formatVersion: atlas-source/v1',
      `projectionFingerprint: ${projection.fingerprint}`,
      'workflow:',
      '  steps:',
      '    - id: complete',
      '      kind: terminal',
      '      state: completed',
    ].join('\n'),
    {
      organizationId: 'org_atlas',
      workflowVersionId,
      projection,
    },
  );
  if (!compiled.success) {
    throw new Error(
      compiled.diagnostics.map(({ code, message }) => `${code}: ${message}`).join('; '),
    );
  }
  return compiled.workflow;
}

async function currentProjectionFingerprint() {
  const response = await app.request(
    '/v1/planner-capabilities?organizationId=org_atlas&environmentId=production',
  );
  return ((await response.json()) as { fingerprint: string }).fingerprint;
}

function approve(input: { draft: unknown; projectionFingerprint: string }) {
  return app.request('/v1/workflow-approvals', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: 'org_atlas',
      environmentId: 'production',
      projectionFingerprint: input.projectionFingerprint,
      draft: input.draft,
    }),
  });
}

function requestGrant(
  runId: string,
  artifactId?: string,
  trigger?:
    | { type: 'webhook'; deliveryId: string }
    | { type: 'api'; deliveryId: string }
    | { type: 'schedule'; scheduleId: string; scheduledFor: string },
  runCommandId?: string,
) {
  return app.request('/v1/execution-grants', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: 'org_atlas',
      environmentId: 'production',
      runId,
      intakeKey: 'a'.repeat(64),
      ...(artifactId ? { artifactId } : {}),
      ...(trigger ? { trigger } : {}),
      ...(runCommandId ? { runCommandId } : {}),
    }),
  });
}
