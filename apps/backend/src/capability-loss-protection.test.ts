import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { ingestCapabilities } from './capability-ingestion.js';
import { readWorkflowCapabilityLossProtection } from './capability-loss-protection.js';
import {
  claimNextRunCommand,
  queueWebhookRunCommand,
  readRunIntakeReadiness,
  WebhookRunUnavailable,
} from './run-commands.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'capability_loss_protection_risk_v9_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const artifactId = 'b'.repeat(64);
let capabilityVersionId = '';

const app = createApp(pool, undefined, undefined, undefined, undefined, {
  async authorize({ authorizationHeader, organizationId, action }) {
    if (organizationId !== 'org_loss') return null;
    if (authorizationHeader === 'Bearer admin' && action === 'manage-organization') {
      return { actorId: 'admin_loss', role: 'admin' as const };
    }
    return null;
  },
});

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 63 });
  await pool.query(`
    TRUNCATE users, organizations RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_loss');
    INSERT INTO users (id, email, name) VALUES
      ('admin_loss', 'admin-loss@example.com', 'Admin Loss');
    INSERT INTO organization_memberships (organization_id, user_id, role)
    VALUES ('org_loss', 'admin_loss', 'admin');
    INSERT INTO environments (organization_id, id, name, kind) VALUES
      ('org_loss', 'development', 'Development', 'development'),
      ('org_loss', 'production', 'Production', 'production');
  `);
  const ingested = await ingestCapabilities(pool, capabilityRequest(), 'development');
  if (ingested.capabilities.length !== 1) throw new Error('Expected one discovered capability');
  await ingestCapabilities(pool, capabilityRequest(), 'production');
  capabilityVersionId = ingested.capabilities[0]!.capabilityVersionId;
  await seedWorkflow(capabilityVersionId);
});

afterAll(async () => pool.end());

describe('confirmed capability loss workflow protection', () => {
  it('warns for stale evidence, blocks confirmed removal, and isolates environments', async () => {
    const pin = currentPin();
    await pool.query(
      `UPDATE environment_capability_observations
       SET freshness_status = 'stale', status_reason = 'source-refresh-failed'
       WHERE organization_id = 'org_loss' AND environment_id = 'development'
         AND capability_version_id = $1`,
      [pin],
    );
    const stale = await readWorkflowCapabilityLossProtection(pool, scope());
    expect(stale).toMatchObject({ allowed: true, blockers: [] });
    expect(stale.warnings).toEqual([expect.stringContaining('is stale')]);
    await expect(
      pool.query(
        `SELECT kind, severity, subject_label, next_action, resolved_at
         FROM notifications WHERE organization_id = 'org_loss'
           AND environment_id = 'development' AND kind = 'stale-source'`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          kind: 'stale-source',
          severity: 'warning',
          subject_label: 'getPayment',
          next_action: expect.stringContaining('rediscover'),
          resolved_at: null,
        },
      ],
    });

    const reviewDiscovery = await pool.query<{ id: string }>(
      `INSERT INTO capability_discoveries
        (organization_id, service_id, environment_id, trigger)
       VALUES ('org_loss', 'payments', 'development', 'daily-poll') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO capability_discovery_changes
        (discovery_id, organization_id, from_capability_version_id,
         to_capability_version_id, classification, change_kind, field_changes,
         affected_workflows)
       VALUES ($1, 'org_loss', $2, $2, 'conditional', 'version-change', '[]',
         '[{"workflowVersionId":"loss-workflow@1","stepId":"invoke"}]')`,
      [reviewDiscovery.rows[0]!.id, pin],
    );
    const needsReview = await readWorkflowCapabilityLossProtection(pool, scope());
    expect(needsReview.allowed).toBe(true);
    expect(needsReview.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('Needs review')]),
    );

    await pool.query(
      `INSERT INTO workflow_run_commands
        (command_id, organization_id, environment_id, target_worker_id, artifact_id,
         encrypted_payload)
       VALUES ('queued-before-removal', 'org_loss', 'development', 'worker-loss', $1, 'cipher')`,
      [artifactId],
    );
    await pool.query(
      `UPDATE environment_capability_observations
       SET availability_status = 'removed', freshness_status = 'fresh',
           status_reason = 'operation-absent-from-successful-discovery'
       WHERE organization_id = 'org_loss' AND environment_id = 'development'
         AND capability_version_id = $1`,
      [pin],
    );

    await expect(readWorkflowCapabilityLossProtection(pool, scope())).resolves.toMatchObject({
      allowed: false,
      removedCapabilityVersionIds: [pin],
      blockers: [expect.stringContaining('confirmed removed in development')],
    });
    await expect(readRunIntakeReadiness(pool, scope())).resolves.toMatchObject({
      ready: false,
      blockers: [expect.stringContaining('confirmed removed in development')],
    });
    await expect(
      queueWebhookRunCommand(pool, {
        organizationId: 'org_loss',
        environmentId: 'development',
        deliveryId: 'loss-blocked-delivery',
        payloadFingerprint: '1'.repeat(64),
        encryptedPayload: `rsa-oaep:${Buffer.from('cipher').toString('base64')}`,
      }),
    ).rejects.toBeInstanceOf(WebhookRunUnavailable);
    await expect(
      claimNextRunCommand(pool, {
        organizationId: 'org_loss',
        environmentId: 'development',
        workerId: 'worker-loss',
      }),
    ).resolves.toBeUndefined();
    await expect(
      readWorkflowCapabilityLossProtection(pool, {
        ...scope(),
        environmentId: 'production',
      }),
    ).resolves.toMatchObject({ allowed: true, blockers: [] });
    await expect(
      pool.query(
        `SELECT lifecycle_status FROM workflow_environment_versions
         WHERE organization_id = 'org_loss' AND environment_id = 'development'
           AND workflow_version_id = 'loss-workflow@1'`,
      ),
    ).resolves.toMatchObject({ rows: [{ lifecycle_status: 'action-required' }] });
    const riskNotifications = await pool.query<{
      id: string;
      kind: string;
      severity: string;
      affected_workflows: unknown[];
      occurrence_count: number;
    }>(
      `SELECT id, kind, severity, affected_workflows, occurrence_count
       FROM notifications WHERE organization_id = 'org_loss' AND environment_id = 'development'
         AND kind IN ('capability-removal', 'workflow-risk') ORDER BY kind`,
    );
    expect(riskNotifications.rows).toEqual([
      expect.objectContaining({
        kind: 'capability-removal',
        severity: 'critical',
        affected_workflows: [expect.objectContaining({ workflowVersionId: 'loss-workflow@1' })],
      }),
      expect.objectContaining({ kind: 'workflow-risk', severity: 'critical' }),
    ]);

    const removalId = riskNotifications.rows[0]!.id;
    await pool.query(
      `UPDATE environment_capability_observations
       SET availability_status = 'available', freshness_status = 'fresh'
       WHERE organization_id = 'org_loss' AND environment_id = 'development'
         AND capability_version_id = $1`,
      [pin],
    );
    await pool.query(
      `UPDATE environment_capability_observations
       SET availability_status = 'removed', freshness_status = 'fresh'
       WHERE organization_id = 'org_loss' AND environment_id = 'development'
         AND capability_version_id = $1`,
      [pin],
    );
    await expect(
      pool.query(
        `SELECT id, resolved_at, occurrence_count FROM notifications
         WHERE organization_id = 'org_loss' AND environment_id = 'development'
           AND kind = 'capability-removal'`,
      ),
    ).resolves.toMatchObject({
      rows: [{ id: removalId, resolved_at: null, occurrence_count: expect.any(Number) }],
    });

    await pool.query(
      `UPDATE environment_capability_observations
       SET availability_status = 'removed', freshness_status = 'fresh'
       WHERE organization_id = 'org_loss' AND environment_id = 'production'
         AND capability_version_id = $1`,
      [pin],
    );
    await pool.query(
      `INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
         projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
       VALUES ('org_loss', 'production', 'loss-workflow@1', repeat('d', 64), 'policy-v1',
         repeat('e', 64), 'admin_loss', 'current', $1,
         '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{}}}}}')`,
      [artifactId],
    );
    await pool.query(
      `INSERT INTO workflow_environment_versions
        (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active)
       VALUES ('org_loss', 'production', 'loss-workflow@1', 'active', true)`,
    );
    await expect(
      pool.query(
        `SELECT lifecycle_status FROM workflow_environment_versions
         WHERE organization_id = 'org_loss' AND environment_id = 'production'
           AND workflow_version_id = 'loss-workflow@1'`,
      ),
    ).resolves.toMatchObject({ rows: [{ lifecycle_status: 'action-required' }] });

    await seedWorkflow(pin, 'late-loss-workflow@1', 'f'.repeat(64), false);
    await expect(
      pool.query(
        `SELECT lifecycle_status FROM workflow_environment_versions
         WHERE organization_id = 'org_loss' AND environment_id = 'development'
           AND workflow_version_id = 'late-loss-workflow@1'`,
      ),
    ).resolves.toMatchObject({ rows: [{ lifecycle_status: 'action-required' }] });
    await expect(
      pool.query(
        `SELECT affected_workflows FROM notifications
         WHERE organization_id = 'org_loss' AND environment_id = 'development'
           AND condition_key = 'capability-removal:' || (
             SELECT capability_identity_id::text FROM capability_versions
             WHERE organization_id = 'org_loss' AND capability_version_id = $1)
           AND resolved_at IS NULL`,
        [pin],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          affected_workflows: expect.arrayContaining([
            expect.objectContaining({ workflowVersionId: 'late-loss-workflow@1' }),
          ]),
        },
      ],
    });

    await pool.query(
      `UPDATE environment_capability_observations
       SET availability_status = 'available', freshness_status = 'fresh'
       WHERE organization_id = 'org_loss' AND environment_id = 'development'
         AND capability_version_id = $1`,
      [pin],
    );
    await expect(
      pool.query(
        `SELECT count(*)::int AS unresolved FROM notifications
         WHERE organization_id = 'org_loss' AND environment_id = 'development'
           AND kind IN ('capability-removal', 'workflow-risk') AND resolved_at IS NULL`,
      ),
    ).resolves.toMatchObject({ rows: [{ unresolved: 0 }] });
    await pool.query(
      `UPDATE environment_capability_observations
       SET availability_status = 'removed', freshness_status = 'fresh'
       WHERE organization_id = 'org_loss' AND environment_id = 'development'
         AND capability_version_id = $1`,
      [pin],
    );
  });

  it('supports an audited Admin override, revocation, and automatic expiration', async () => {
    const pin = currentPin();
    const auditWindow = await pool.query<{ started_at: Date }>(
      'SELECT current_timestamp AS started_at',
    );
    const created = await app.request('/v1/capability-loss-overrides', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope(),
        capabilityVersionId: pin,
        reason: 'Emergency settlement window',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    expect(created.status).toBe(201);
    const override = (await created.json()) as { overrideId: string; warning: string };
    expect(override.warning).toContain('may no longer exist');

    const active = await readWorkflowCapabilityLossProtection(pool, scope());
    expect(active.allowed).toBe(true);
    expect(active.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('ADMIN OVERRIDE')]),
    );
    const claimed = await claimNextRunCommand(pool, {
      organizationId: 'org_loss',
      environmentId: 'development',
      workerId: 'worker-loss',
    });
    expect(claimed?.commandId).toBe('queued-before-removal');

    const revoked = await app.request(
      `/v1/capability-loss-overrides/${override.overrideId}/revocation`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_loss', environmentId: 'development' }),
      },
    );
    expect(revoked.status).toBe(204);
    expect((await readWorkflowCapabilityLossProtection(pool, scope())).allowed).toBe(false);

    const expiring = await app.request('/v1/capability-loss-overrides', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({
        ...scope(),
        capabilityVersionId: pin,
        reason: 'Short emergency window',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    });
    const expiringOverride = (await expiring.json()) as { overrideId: string };
    await pool.query(
      `UPDATE workflow_capability_loss_overrides
       SET expires_at = current_timestamp - interval '1 second' WHERE id = $1`,
      [expiringOverride.overrideId],
    );
    expect((await readWorkflowCapabilityLossProtection(pool, scope())).allowed).toBe(false);

    const audit = await pool.query<{ action: string }>(
      `SELECT details->>'action' AS action FROM audit_entries
       WHERE organization_id = 'org_loss' AND event_type = 'capability-loss-override'
         AND subject_id = ANY($1::text[])
         AND recorded_at >= $2
       ORDER BY id`,
      [[override.overrideId, expiringOverride.overrideId], auditWindow.rows[0]!.started_at],
    );
    expect(audit.rows.map(({ action }) => action)).toEqual(['created', 'revoked', 'created']);
  });

  it('allows a migrated and approved workflow version pinned to a valid capability', async () => {
    const replacement = await ingestCapabilities(
      pool,
      replacementCapabilityRequest(),
      'development',
    );
    const replacementPin = replacement.capabilities[0]!.capabilityVersionId;
    await seedWorkflow(replacementPin, 'loss-workflow@2', 'c'.repeat(64));
    await expect(
      readRunIntakeReadiness(pool, {
        organizationId: 'org_loss',
        environmentId: 'development',
        workflowVersionId: 'loss-workflow@2',
      }),
    ).resolves.toMatchObject({ ready: true, blockers: [] });
    expect(
      (
        await readWorkflowCapabilityLossProtection(pool, {
          organizationId: 'org_loss',
          environmentId: 'development',
          workflowVersionId: 'loss-workflow@2',
        })
      ).allowed,
    ).toBe(true);
  });

  it('keeps workflow risk conditions distinct for each removed capability', async () => {
    const replacement = await ingestCapabilities(
      pool,
      replacementCapabilityRequest(),
      'development',
    );
    const replacementPin = replacement.capabilities[0]!.capabilityVersionId;
    await pool.query(
      `INSERT INTO workflow_capability_dependencies
        (organization_id, workflow_version_id, step_id, capability_version_id)
       VALUES ('org_loss', 'loss-workflow@1', 'invoke-second', $1)`,
      [replacementPin],
    );
    await pool.query(
      `UPDATE environment_capability_observations
       SET availability_status = 'removed', freshness_status = 'fresh'
       WHERE organization_id = 'org_loss' AND environment_id = 'development'
         AND capability_version_id = $1`,
      [replacementPin],
    );
    await expect(
      pool.query(
        `SELECT count(DISTINCT condition_key)::int AS risks
         FROM notifications WHERE organization_id = 'org_loss'
           AND environment_id = 'development' AND kind = 'workflow-risk'
           AND details->>'workflowVersionId' = 'loss-workflow@1'
           AND resolved_at IS NULL`,
      ),
    ).resolves.toMatchObject({ rows: [{ risks: 2 }] });
  });
});

function scope() {
  return {
    organizationId: 'org_loss',
    environmentId: 'development',
    workflowVersionId: 'loss-workflow@1',
  };
}

function currentPin() {
  return capabilityVersionId;
}

async function seedWorkflow(
  pin: string,
  workflowVersionId = 'loss-workflow@1',
  artifact = artifactId,
  isActive = true,
) {
  await pool.query(
    `INSERT INTO workflow_versions
      (organization_id, workflow_version_id, ir_hash, compiled_workflow)
     VALUES ('org_loss', $1, repeat('d', 64), '{}')`,
    [workflowVersionId],
  );
  await pool.query(
    `INSERT INTO workflow_approvals
      (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
       projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
     VALUES ('org_loss', 'development', $1, repeat('d', 64), 'policy-v1', repeat('e', 64),
       'admin_loss', 'current', $2,
       '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{}}}}}')`,
    [workflowVersionId, artifact],
  );
  await pool.query(
    `INSERT INTO workflow_environment_versions
      (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active)
     VALUES ('org_loss', 'development', $1, 'active', $2)`,
    [workflowVersionId, isActive],
  );
  await pool.query(
    `INSERT INTO workflow_capability_dependencies
      (organization_id, workflow_version_id, step_id, capability_version_id)
     VALUES ('org_loss', $1, 'invoke', $2)`,
    [workflowVersionId, pin],
  );
  await pool.query(
    `INSERT INTO environment_workers
      (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version,
       run_command_public_key)
     VALUES ('org_loss', 'development', 'worker-loss', 1, 1, 'public-key')
     ON CONFLICT (organization_id, environment_id, worker_id) DO NOTHING`,
  );
}

function capabilityRequest() {
  return requestFor('payments', 'getPayment', '/payments', 'get-payment-v1');
}

function replacementCapabilityRequest() {
  return requestFor(
    'replacement',
    'getReplacementPayment',
    '/replacement-payments',
    'replacement-v1',
  );
}

function requestFor(serviceId: string, operationId: string, path: string, commit: string) {
  return {
    organizationId: 'org_loss',
    serviceId,
    source: {
      format: 'openapi',
      document: {
        openapi: '3.1.0',
        info: { title: serviceId, version: '1.0.0' },
        paths: {
          [path]: {
            get: {
              operationId,
              responses: { '200': { description: 'ok' } },
            },
          },
        },
      },
      repository: 'https://github.com/atlas/capability-loss-test',
      commit,
      path: `${serviceId}.json`,
    },
    manifest: {
      source: {
        repository: 'https://github.com/atlas/capability-loss-test',
        commit,
        path: `${serviceId}-manifest.json`,
      },
      annotations: [
        {
          capability: { operationId },
          owner: 'payments',
          secretAlias: null,
          businessSemantics: {},
          idempotencyField: null,
          compensatedBy: null,
          irreversibleAfter: false,
        },
      ],
    },
  };
}
