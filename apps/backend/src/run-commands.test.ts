import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { readRunIntakeReadiness } from './run-commands.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'run_commands_v2_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const app = createApp(
  pool,
  { allowedHosts: [] },
  undefined,
  undefined,
  {
    approvalAuthorizer: {
      async authorize() {
        return null;
      },
    },
    workerAuthorizer: {
      async authorize({ authorizationHeader, environmentId }) {
        return (
          authorizationHeader === 'Bearer development-token' && environmentId === 'development'
        );
      },
    },
    executionGrantIssuer: {
      async issueForRun() {
        throw new Error('not used');
      },
    },
  },
  {
    async authorize({ authorizationHeader, organizationId, action }) {
      return authorizationHeader === 'Bearer author-token' &&
        organizationId === 'org_atlas' &&
        action === 'start-workflow-run'
        ? { actorId: 'author', role: 'author' as const }
        : null;
    },
  },
);

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 62 });
  await pool.query(`
    TRUNCATE organizations RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas');
    INSERT INTO environments (organization_id, id, name, kind)
    VALUES ('org_atlas', 'development', 'Development', 'development');
  `);
});

afterAll(async () => pool.end());

describe('outbound run commands', () => {
  it('retires the manual queueing and readiness endpoints', async () => {
    const deniedQueue = await app.request('/v1/run-commands', {
      method: 'POST',
      headers: {
        authorization: 'Bearer author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        targetWorkerId: 'worker-development',
        artifactId: 'c'.repeat(64),
        encryptedPayload: 'opaque-ciphertext',
      }),
    });
    expect(deniedQueue.status).toBe(404);

    const readiness = await app.request(
      '/v1/manual-run-readiness?organizationId=org_atlas&environmentId=development',
      { headers: { authorization: 'Bearer author-token' } },
    );
    expect(readiness.status).toBe(404);
  });

  it('claims and acknowledges a historical manual-provenance command', async () => {
    const commandId = '11111111-1111-4111-8111-111111111111';
    await pool.query(
      `INSERT INTO workflow_run_commands
        (command_id, organization_id, environment_id, target_worker_id, artifact_id,
         encrypted_payload, trigger_type)
       VALUES ($1, 'org_atlas', 'development', 'worker-development', $2, 'opaque-ciphertext',
               'manual')`,
      [commandId, 'c'.repeat(64)],
    );

    const denied = await app.request(
      '/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=worker-development',
    );
    expect(denied.status).toBe(403);

    const wrongWorker = await app.request(
      '/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=rotated-worker',
      { headers: { authorization: 'Bearer development-token' } },
    );
    expect(wrongWorker.status).toBe(204);

    const claimed = await app.request(
      '/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=worker-development',
      { headers: { authorization: 'Bearer development-token' } },
    );
    await expect(claimed.json()).resolves.toEqual({
      commandId,
      encryptedPayload: 'opaque-ciphertext',
      artifactId: 'c'.repeat(64),
      workflowName: '',
      trigger: { type: 'manual' },
    });

    const completed = await app.request(`/v1/run-commands/${commandId}`, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer development-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        status: 'completed',
        workflowRunId: 'atlas:run:stable-id',
        intakeStatus: 'accepted',
      }),
    });
    expect(completed.status).toBe(204);

    const status = await app.request(
      `/v1/run-command-status/${commandId}?organizationId=org_atlas&environmentId=development`,
      { headers: { authorization: 'Bearer author-token' } },
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      commandId,
      status: 'completed',
      workflowRunId: 'atlas:run:stable-id',
      intakeStatus: 'accepted',
    });
  });

  it('binds run intake readiness to the exact active artifact and customer worker key', async () => {
    await pool.query(`
      INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
      VALUES
        ('org_atlas', 'manual-demo@1', repeat('a', 64), '{}'),
        ('org_atlas', 'another-demo@1', repeat('d', 64), '{}');
      INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
         projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
      VALUES ('org_atlas', 'development', 'manual-demo@1', repeat('a', 64), 'policy-v1',
        repeat('b', 64), 'admin', 'current', repeat('c', 64),
        '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{"paymentId":{"type":"string"}}}}}}'),
        ('org_atlas', 'development', 'another-demo@1', repeat('d', 64), 'policy-v1',
        repeat('e', 64), 'admin', 'current', repeat('f', 64),
        '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{}}}}}');
      INSERT INTO environment_workers
        (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version,
         run_command_public_key)
      VALUES ('org_atlas', 'development', 'worker-development', 1, 1, 'public-key')
      ON CONFLICT (organization_id, environment_id, worker_id) DO UPDATE
        SET run_command_public_key = EXCLUDED.run_command_public_key,
            minimum_ir_version = 1, maximum_ir_version = 1;
    `);

    await expect(
      readRunIntakeReadiness(pool, {
        organizationId: 'org_atlas',
        environmentId: 'development',
        workflowVersionId: 'manual-demo@1',
      }),
    ).resolves.toEqual({
      ready: true,
      workflowVersionId: 'manual-demo@1',
      artifactId: 'c'.repeat(64),
      targetWorkerId: 'worker-development',
      runCommandPublicKey: 'public-key',
      blockers: [],
    });
    await pool.query(
      `DELETE FROM workflow_approvals
       WHERE organization_id = 'org_atlas' AND workflow_version_id = 'another-demo@1';
       DELETE FROM workflow_versions
       WHERE organization_id = 'org_atlas' AND workflow_version_id = 'another-demo@1'`,
    );
  });

  it('reports an active artifact unavailable when no receiving worker supports its IR version', async () => {
    await pool.query(`
      INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
      VALUES ('org_atlas', 'unsupported-demo@1', repeat('7', 64), '{}');
      INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
         projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
      VALUES ('org_atlas', 'development', 'unsupported-demo@1', repeat('7', 64), 'policy-v1',
        repeat('8', 64), 'admin', 'current', repeat('9', 64),
        '{"workflow":{"executable":{"irVersion":2,"inputSchema":{"required":{}}}}}');
    `);

    try {
      await expect(
        readRunIntakeReadiness(pool, {
          organizationId: 'org_atlas',
          environmentId: 'development',
          workflowVersionId: 'unsupported-demo@1',
        }),
      ).resolves.toMatchObject({
        ready: false,
        workflowVersionId: 'unsupported-demo@1',
        targetWorkerId: null,
        runCommandPublicKey: null,
        blockers: [
          "No customer worker in environment 'development' supports workflow IR version 2.",
        ],
      });
    } finally {
      await pool.query(`
        DELETE FROM workflow_approvals
        WHERE organization_id = 'org_atlas' AND workflow_version_id = 'unsupported-demo@1';
        DELETE FROM workflow_versions
        WHERE organization_id = 'org_atlas' AND workflow_version_id = 'unsupported-demo@1';
      `);
    }
  });

  it('queues one governed command for a redelivered webhook and rejects a conflicting delivery', async () => {
    const webhook = {
      organizationId: 'org_atlas',
      environmentId: 'development',
      deliveryId: 'stripe-event-100',
      payloadFingerprint: '1'.repeat(64),
      encryptedPayload: `rsa-oaep:${Buffer.from('opaque payment payload').toString('base64')}`,
    };
    const first = await app.request('/v1/webhook-runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...webhook,
        encryptedPayload: `rsa-oaep:${Buffer.from('fresh encryption of the same payload').toString('base64')}`,
      }),
    });
    expect(first.status).toBe(202);
    const accepted = (await first.json()) as { commandId: string };
    expect(accepted).toMatchObject({ duplicate: false });

    const duplicate = await app.request('/v1/webhook-runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(webhook),
    });
    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toEqual({
      commandId: accepted.commandId,
      status: 'queued',
      duplicate: true,
    });

    const conflict = await app.request('/v1/webhook-runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...webhook,
        payloadFingerprint: '2'.repeat(64),
        encryptedPayload: `rsa-oaep:${Buffer.from('different payload').toString('base64')}`,
      }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: 'conflicting-webhook-delivery' });

    const claimed = await app.request(
      '/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=worker-development',
      { headers: { authorization: 'Bearer development-token' } },
    );
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      commandId: accepted.commandId,
      artifactId: 'c'.repeat(64),
      workflowId: expect.stringMatching(/^unassigned-/),
      workflowName: 'Imported workflow',
      trigger: { type: 'webhook', deliveryId: 'stripe-event-100' },
      inputSchema: { required: { paymentId: { type: 'string' } } },
    });

    const rejected = await app.request(`/v1/run-commands/${accepted.commandId}`, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer development-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        status: 'failed',
        error: 'invalid-trigger-payload',
        errorDetails: {
          issues: [{ path: '$.paymentId', message: 'Expected string.' }],
        },
      }),
    });
    expect(rejected.status).toBe(204);
    const status = await app.request(
      `/v1/run-command-status/${accepted.commandId}?organizationId=org_atlas&environmentId=development`,
      { headers: { authorization: 'Bearer author-token' } },
    );
    await expect(status.json()).resolves.toMatchObject({
      status: 'failed',
      error: 'invalid-trigger-payload',
      errorDetails: {
        issues: [{ path: '$.paymentId', message: 'Expected string.' }],
      },
    });
  });

  it('rejects an invalid webhook payload before it reaches the customer worker', async () => {
    const response = await app.request('/v1/webhook-runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        deliveryId: 'stripe-event-invalid',
        encryptedPayload: 'plaintext is not accepted',
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid-webhook-payload' });
  });

  it('scopes readiness to one workflow identity and ignores other current approvals', async () => {
    await pool.query(`
      DELETE FROM workflow_approvals
      WHERE organization_id = 'org_atlas' AND environment_id = 'development'
        AND lifecycle_status = 'current';
      INSERT INTO workflow_identities (organization_id, workflow_id, name)
      VALUES
        ('org_atlas', 'workflow_settle', 'Settle payments'),
        ('org_atlas', 'workflow_refund', 'Refund payments')
      ON CONFLICT (organization_id, workflow_id) DO UPDATE SET name = EXCLUDED.name;
      INSERT INTO workflow_versions
        (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
      VALUES
        ('org_atlas', 'settle@1', 'workflow_settle', repeat('a', 64), '{}'),
        ('org_atlas', 'refund@1', 'workflow_refund', repeat('d', 64), '{}')
      ON CONFLICT (organization_id, workflow_version_id) DO UPDATE
        SET workflow_id = EXCLUDED.workflow_id;
      INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, workflow_id, ir_hash,
         policy_version, projection_fingerprint, approved_by, approved_at, lifecycle_status,
         artifact_id, artifact_manifest)
      VALUES
        ('org_atlas', 'development', 'settle@1', 'workflow_settle', repeat('a', 64), 'policy-v1',
         repeat('b', 64), 'admin', current_timestamp - interval '1 day', 'current', repeat('c', 64),
         '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{"paymentId":{"type":"string"}}}}}}'),
        ('org_atlas', 'development', 'refund@1', 'workflow_refund', repeat('d', 64), 'policy-v1',
         repeat('e', 64), 'admin', current_timestamp, 'current', repeat('f', 64),
         '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{}}}}}');
      INSERT INTO environment_workers
        (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version,
         run_command_public_key)
      VALUES ('org_atlas', 'development', 'worker-development', 1, 1, 'public-key')
      ON CONFLICT (organization_id, environment_id, worker_id) DO UPDATE
        SET run_command_public_key = EXCLUDED.run_command_public_key,
            minimum_ir_version = 1, maximum_ir_version = 1;
    `);

    try {
      await expect(
        readRunIntakeReadiness(pool, {
          organizationId: 'org_atlas',
          environmentId: 'development',
          workflowId: 'workflow_settle',
        }),
      ).resolves.toEqual({
        ready: true,
        workflowVersionId: 'settle@1',
        artifactId: 'c'.repeat(64),
        targetWorkerId: 'worker-development',
        runCommandPublicKey: 'public-key',
        blockers: [],
      });

      await expect(
        readRunIntakeReadiness(pool, {
          organizationId: 'org_atlas',
          environmentId: 'development',
        }),
      ).resolves.toMatchObject({
        ready: true,
        workflowVersionId: 'refund@1',
        artifactId: 'f'.repeat(64),
      });
    } finally {
      await pool.query(`
        DELETE FROM workflow_approvals
        WHERE organization_id = 'org_atlas'
          AND workflow_version_id IN ('settle@1', 'refund@1');
        DELETE FROM workflow_versions
        WHERE organization_id = 'org_atlas'
          AND workflow_version_id IN ('settle@1', 'refund@1');
        DELETE FROM workflow_identities
        WHERE organization_id = 'org_atlas'
          AND workflow_id IN ('workflow_settle', 'workflow_refund');
      `);
    }
  });

  it('queues a delivery-triggered command pinned to a workflow identity', async () => {
    await pool.query(`
      DELETE FROM workflow_approvals
      WHERE organization_id = 'org_atlas' AND environment_id = 'development'
        AND lifecycle_status = 'current';
      INSERT INTO workflow_identities (organization_id, workflow_id, name)
      VALUES
        ('org_atlas', 'workflow_pin_a', 'Pinned A'),
        ('org_atlas', 'workflow_pin_b', 'Pinned B')
      ON CONFLICT (organization_id, workflow_id) DO UPDATE SET name = EXCLUDED.name;
      INSERT INTO workflow_versions
        (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
      VALUES
        ('org_atlas', 'pin-a@1', 'workflow_pin_a', repeat('1', 64), '{}'),
        ('org_atlas', 'pin-b@1', 'workflow_pin_b', repeat('2', 64), '{}')
      ON CONFLICT (organization_id, workflow_version_id) DO UPDATE
        SET workflow_id = EXCLUDED.workflow_id;
      INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, workflow_id, ir_hash,
         policy_version, projection_fingerprint, approved_by, approved_at, lifecycle_status,
         artifact_id, artifact_manifest)
      VALUES
        ('org_atlas', 'development', 'pin-a@1', 'workflow_pin_a', repeat('1', 64), 'policy-v1',
         repeat('3', 64), 'admin', current_timestamp - interval '1 day', 'current', repeat('4', 64),
         '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{"orderId":{"type":"string"}}}}}}'),
        ('org_atlas', 'development', 'pin-b@1', 'workflow_pin_b', repeat('2', 64), 'policy-v1',
         repeat('5', 64), 'admin', current_timestamp, 'current', repeat('6', 64),
         '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{"refundId":{"type":"string"}}}}}}');
      INSERT INTO environment_workers
        (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version,
         run_command_public_key)
      VALUES ('org_atlas', 'development', 'worker-development', 1, 1, 'public-key')
      ON CONFLICT (organization_id, environment_id, worker_id) DO UPDATE
        SET run_command_public_key = EXCLUDED.run_command_public_key,
            minimum_ir_version = 1, maximum_ir_version = 1;
    `);

    try {
      const queued = await app.request('/v1/webhook-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer author-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          deliveryId: 'pin-delivery-1',
          payloadFingerprint: 'a'.repeat(64),
          encryptedPayload: `rsa-oaep:${Buffer.from('pinned payload').toString('base64')}`,
          workflowId: 'workflow_pin_a',
        }),
      });
      expect(queued.status).toBe(202);
      const { commandId } = (await queued.json()) as { commandId: string };

      const claimed = await app.request(
        '/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=worker-development',
        { headers: { authorization: 'Bearer development-token' } },
      );
      expect(claimed.status).toBe(200);
      await expect(claimed.json()).resolves.toMatchObject({
        commandId,
        artifactId: '4'.repeat(64),
        workflowId: 'workflow_pin_a',
        workflowName: 'Pinned A',
        trigger: { type: 'webhook', deliveryId: 'pin-delivery-1' },
        inputSchema: { required: { orderId: { type: 'string' } } },
      });
    } finally {
      await pool.query(`
        DELETE FROM workflow_run_commands
        WHERE organization_id = 'org_atlas' AND trigger_delivery_id = 'pin-delivery-1';
        DELETE FROM workflow_approvals
        WHERE organization_id = 'org_atlas'
          AND workflow_version_id IN ('pin-a@1', 'pin-b@1');
        DELETE FROM workflow_versions
        WHERE organization_id = 'org_atlas'
          AND workflow_version_id IN ('pin-a@1', 'pin-b@1');
        DELETE FROM workflow_identities
        WHERE organization_id = 'org_atlas'
          AND workflow_id IN ('workflow_pin_a', 'workflow_pin_b');
      `);
    }
  });
});

describe('API workflow start by name', () => {
  async function seedNamedWorkflow(options?: {
    readonly name?: string;
    readonly workflowId?: string;
    readonly includeInputSchema?: boolean;
  }) {
    const name = options?.name ?? 'Settle payments';
    const workflowId = options?.workflowId ?? 'workflow_api_settle';
    const includeInputSchema = options?.includeInputSchema ?? true;
    const manifest = includeInputSchema
      ? '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{"orderId":{"type":"string"}}}}}}'
      : '{"workflow":{"executable":{"irVersion":1}}}';
    await pool.query(`
      DELETE FROM workflow_approvals
      WHERE organization_id = 'org_atlas' AND environment_id = 'development'
        AND lifecycle_status = 'current';
      INSERT INTO workflow_identities (organization_id, workflow_id, name)
      VALUES ('org_atlas', '${workflowId}', '${name}')
      ON CONFLICT (organization_id, workflow_id) DO UPDATE SET name = EXCLUDED.name;
      INSERT INTO workflow_versions
        (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
      VALUES ('org_atlas', 'api-settle@1', '${workflowId}', repeat('a', 64), '{}')
      ON CONFLICT (organization_id, workflow_version_id) DO UPDATE
        SET workflow_id = EXCLUDED.workflow_id;
      INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, workflow_id, ir_hash,
         policy_version, projection_fingerprint, approved_by, approved_at, lifecycle_status,
         artifact_id, artifact_manifest)
      VALUES
        ('org_atlas', 'development', 'api-settle@1', '${workflowId}', repeat('a', 64), 'policy-v1',
         repeat('b', 64), 'admin', current_timestamp, 'current', repeat('c', 64),
         '${manifest}'::jsonb);
      INSERT INTO environment_workers
        (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version,
         run_command_public_key)
      VALUES ('org_atlas', 'development', 'worker-development', 1, 1, 'public-key')
      ON CONFLICT (organization_id, environment_id, worker_id) DO UPDATE
        SET run_command_public_key = EXCLUDED.run_command_public_key,
            minimum_ir_version = 1, maximum_ir_version = 1;
    `);
    return { name, workflowId };
  }

  async function cleanupNamedWorkflow(workflowId = 'workflow_api_settle') {
    await pool.query(`
      DELETE FROM workflow_run_commands
      WHERE organization_id = 'org_atlas' AND trigger_type = 'api';
      DELETE FROM workflow_approvals
      WHERE organization_id = 'org_atlas' AND workflow_version_id = 'api-settle@1';
      DELETE FROM workflow_versions
      WHERE organization_id = 'org_atlas' AND workflow_version_id = 'api-settle@1';
      DELETE FROM workflow_identities
      WHERE organization_id = 'org_atlas' AND workflow_id = '${workflowId}';
    `);
  }

  it('resolves readiness by workflow name and rejects unknown or ambiguous names', async () => {
    const { name, workflowId } = await seedNamedWorkflow();
    try {
      const ready = await app.request(
        `/v1/api-run-readiness?organizationId=org_atlas&environmentId=development&workflowName=${encodeURIComponent(name)}`,
        { headers: { authorization: 'Bearer author-token' } },
      );
      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toEqual({
        workflowId,
        name,
        ready: true,
        workflowVersionId: 'api-settle@1',
        artifactId: 'c'.repeat(64),
        targetWorkerId: 'worker-development',
        runCommandPublicKey: 'public-key',
        inputSchema: { required: { orderId: { type: 'string' } } },
        blockers: [],
      });

      const unknown = await app.request(
        '/v1/api-run-readiness?organizationId=org_atlas&environmentId=development&workflowName=Missing',
        { headers: { authorization: 'Bearer author-token' } },
      );
      expect(unknown.status).toBe(404);
      await expect(unknown.json()).resolves.toEqual({ error: 'unknown-workflow-name' });

      await pool.query(`
        INSERT INTO workflow_identities (organization_id, workflow_id, name)
        VALUES
          ('org_atlas', 'workflow_api_dup_a', 'Duplicate name'),
          ('org_atlas', 'workflow_api_dup_b', 'Duplicate name')
        ON CONFLICT (organization_id, workflow_id) DO UPDATE SET name = EXCLUDED.name;
      `);
      const ambiguous = await app.request(
        '/v1/api-run-readiness?organizationId=org_atlas&environmentId=development&workflowName=Duplicate%20name',
        { headers: { authorization: 'Bearer author-token' } },
      );
      expect(ambiguous.status).toBe(409);
      await expect(ambiguous.json()).resolves.toEqual({
        error: 'ambiguous-workflow-name',
        workflowIds: ['workflow_api_dup_a', 'workflow_api_dup_b'],
      });
    } finally {
      await pool.query(`
        DELETE FROM workflow_identities
        WHERE organization_id = 'org_atlas'
          AND workflow_id IN ('workflow_api_dup_a', 'workflow_api_dup_b');
      `);
      await cleanupNamedWorkflow(workflowId);
    }
  });

  it('queues API runs with idempotency dedupe and fingerprint conflict', async () => {
    const { workflowId } = await seedNamedWorkflow();
    try {
      const request = {
        organizationId: 'org_atlas',
        environmentId: 'development',
        workflowId,
        idempotencyKey: 'api-key-100',
        payloadFingerprint: '1'.repeat(64),
        encryptedPayload: `rsa-oaep:${Buffer.from('api payload').toString('base64')}`,
      };
      const first = await app.request('/v1/api-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer author-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      expect(first.status).toBe(202);
      const accepted = (await first.json()) as { commandId: string };
      expect(accepted).toMatchObject({ duplicate: false });

      const duplicate = await app.request('/v1/api-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer author-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...request,
          encryptedPayload: `rsa-oaep:${Buffer.from('re-encrypted same payload').toString('base64')}`,
        }),
      });
      expect(duplicate.status).toBe(202);
      await expect(duplicate.json()).resolves.toEqual({
        commandId: accepted.commandId,
        status: 'queued',
        duplicate: true,
      });

      const conflict = await app.request('/v1/api-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer author-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...request,
          payloadFingerprint: '2'.repeat(64),
        }),
      });
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toEqual({ error: 'conflicting-api-delivery' });

      const claimed = await app.request(
        '/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=worker-development',
        { headers: { authorization: 'Bearer development-token' } },
      );
      expect(claimed.status).toBe(200);
      await expect(claimed.json()).resolves.toMatchObject({
        commandId: accepted.commandId,
        artifactId: 'c'.repeat(64),
        workflowId,
        workflowName: 'Settle payments',
        trigger: { type: 'api', deliveryId: 'api-key-100' },
        inputSchema: { required: { orderId: { type: 'string' } } },
      });
    } finally {
      await cleanupNamedWorkflow(workflowId);
    }
  });

  it('provides authenticated webhook readiness by workflow ID and rejects cross-workflow redelivery', async () => {
    const { workflowId, name } = await seedNamedWorkflow();
    try {
      const path = `/v1/webhook-run-readiness?organizationId=org_atlas&environmentId=development&workflowId=${workflowId}`;
      expect((await app.request(path)).status).toBe(403);
      const ready = await app.request(path, { headers: { authorization: 'Bearer author-token' } });
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({
        workflowId,
        name,
        ready: true,
        runCommandPublicKey: 'public-key',
        inputSchema: { required: { orderId: { type: 'string' } } },
      });
      expect(
        (
          await app.request(path.replace(workflowId, 'missing'), {
            headers: { authorization: 'Bearer author-token' },
          })
        ).status,
      ).toBe(404);
      const delivery = {
        organizationId: 'org_atlas',
        environmentId: 'development',
        workflowId,
        deliveryId: 'builder-webhook-delivery',
        payloadFingerprint: 'a'.repeat(64),
        encryptedPayload: `rsa-oaep:${Buffer.from('payload').toString('base64')}`,
      };
      const request = (body: typeof delivery) =>
        app.request('/v1/webhook-runs', {
          method: 'POST',
          headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await request(delivery)).status).toBe(202);
      const repeated = await request(delivery);
      expect(repeated.status).toBe(202);
      expect(await repeated.json()).toMatchObject({ duplicate: true });
      const conflict = await request({ ...delivery, workflowId: 'another-workflow' });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ error: 'conflicting-webhook-delivery' });
      const lookup = `/v1/webhook-runs/deliveries/${delivery.deliveryId}?organizationId=org_atlas&environmentId=development&workflowId=${workflowId}&payloadFingerprint=${delivery.payloadFingerprint}`;
      expect((await app.request(lookup)).status).toBe(403);
      const lookupHeaders = { authorization: 'Bearer author-token' };
      expect(
        (
          await app.request(lookup.replace(delivery.deliveryId, 'missing-delivery'), {
            headers: lookupHeaders,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await app.request(lookup.replace(workflowId, 'another-workflow'), {
            headers: lookupHeaders,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await app.request(lookup.replace(delivery.payloadFingerprint, 'b'.repeat(64)), {
            headers: lookupHeaders,
          })
        ).status,
      ).toBe(409);
      await pool.query(
        `UPDATE workflow_approvals SET lifecycle_status = 'superseded' WHERE organization_id = 'org_atlas' AND workflow_version_id = 'api-settle@1'`,
      );
      const existing = await app.request(lookup, { headers: lookupHeaders });
      expect(existing.status).toBe(200);
      expect(await existing.json()).toMatchObject({ duplicate: true, status: 'queued' });
    } finally {
      await pool.query(
        `DELETE FROM workflow_run_commands WHERE trigger_delivery_id = 'builder-webhook-delivery'`,
      );
      await cleanupNamedWorkflow(workflowId);
    }
  });

  it('refuses API queueing when the active artifact lacks an input schema', async () => {
    const { workflowId } = await seedNamedWorkflow({ includeInputSchema: false });
    try {
      const readiness = await app.request(
        '/v1/api-run-readiness?organizationId=org_atlas&environmentId=development&workflowName=Settle%20payments',
        { headers: { authorization: 'Bearer author-token' } },
      );
      expect(readiness.status).toBe(200);
      await expect(readiness.json()).resolves.toMatchObject({
        ready: false,
        inputSchema: null,
        blockers: ['The active workflow does not declare an input schema for intake validation.'],
      });

      const response = await app.request('/v1/api-runs', {
        method: 'POST',
        headers: {
          authorization: 'Bearer author-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          workflowId,
          idempotencyKey: 'api-key-no-schema',
          payloadFingerprint: '3'.repeat(64),
          encryptedPayload: `rsa-oaep:${Buffer.from('payload').toString('base64')}`,
        }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: 'api-run-unavailable',
        blockers: ['The active workflow does not declare an input schema for intake validation.'],
      });
    } finally {
      await cleanupNamedWorkflow(workflowId);
    }
  });
});
