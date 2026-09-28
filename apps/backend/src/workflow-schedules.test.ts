import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import { dispatchDueWorkflowSchedules } from './workflow-schedules.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_schedules_test';
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
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 41 });
  await pool.query(`
    TRUNCATE organizations RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas');
    INSERT INTO environments (organization_id, id, name, kind)
    VALUES ('org_atlas', 'development', 'Development', 'development');
    INSERT INTO workflow_versions
      (organization_id, workflow_version_id, ir_hash, compiled_workflow)
    VALUES ('org_atlas', 'scheduled-demo@1', repeat('a', 64), '{}');
    INSERT INTO workflow_approvals
      (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
       projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
    VALUES ('org_atlas', 'development', 'scheduled-demo@1', repeat('a', 64), 'policy-v1',
      repeat('b', 64), 'admin', 'current', repeat('c', 64),
      '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{"paymentId":{"type":"string"}}}}}}');
    INSERT INTO environment_workers
      (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version,
       run_command_public_key)
    VALUES ('org_atlas', 'development', 'worker-development', 1, 1, 'public-key');
  `);
});

afterAll(async () => pool.end());

describe('scheduled workflow triggers', () => {
  it('creates, inspects, disables, and enables a schedule through the authorized API', async () => {
    const created = await app.request('/v1/workflow-schedules', {
      method: 'POST',
      headers: {
        authorization: 'Bearer author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        name: 'Daily payment follow-up',
        intervalSeconds: 86_400,
        startsAt: '2026-08-17T12:00:00.000Z',
        encryptedPayload: 'rsa-oaep:YWJjZA==',
      }),
    });
    expect(created.status).toBe(201);
    const schedule = (await created.json()) as { scheduleId: string };

    const list = await app.request(
      '/v1/workflow-schedules?organizationId=org_atlas&environmentId=development',
      { headers: { authorization: 'Bearer author-token' } },
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual({
      schedules: [
        expect.objectContaining({
          scheduleId: schedule.scheduleId,
          name: 'Daily payment follow-up',
          enabled: true,
          nextRunAt: '2026-08-17T12:00:00.000Z',
          lastOccurrence: null,
        }),
      ],
    });

    for (const enabled of [false, true, false]) {
      const updated = await app.request(`/v1/workflow-schedules/${schedule.scheduleId}`, {
        method: 'PATCH',
        headers: {
          authorization: 'Bearer author-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          enabled,
        }),
      });
      expect(updated.status).toBe(200);
      await expect(updated.json()).resolves.toMatchObject({ enabled });
    }
  });

  it('dispatches one command for a due occurrence with immutable scheduled provenance', async () => {
    const created = await app.request('/v1/workflow-schedules', {
      method: 'POST',
      headers: {
        authorization: 'Bearer author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        name: 'Hourly payment check',
        intervalSeconds: 3_600,
        startsAt: '2026-08-17T13:00:00.000Z',
        encryptedPayload: 'rsa-oaep:ZWZnaA==',
      }),
    });
    const { scheduleId } = (await created.json()) as { scheduleId: string };

    const reencrypted = await app.request(`/v1/workflow-schedules/${scheduleId}`, {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        encryptedPayload: 'rsa-oaep:cm90YXRlZA==',
      }),
    });
    expect(reencrypted.status).toBe(200);

    await pool.query(`
      UPDATE workflow_approvals
      SET lifecycle_status = 'superseded'
      WHERE organization_id = 'org_atlas' AND environment_id = 'development'
        AND lifecycle_status = 'current';
      INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
      VALUES ('org_atlas', 'scheduled-demo@2', repeat('d', 64), '{}');
      INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
         projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
      VALUES ('org_atlas', 'development', 'scheduled-demo@2', repeat('d', 64), 'policy-v1',
        repeat('e', 64), 'admin', 'current', repeat('f', 64),
        '{"workflow":{"executable":{"irVersion":1,"inputSchema":{"required":{"paymentId":{"type":"string"}}}}}}');
    `);

    await expect(
      dispatchDueWorkflowSchedules(pool, new Date('2026-08-17T13:00:00.000Z')),
    ).resolves.toEqual({ dispatched: 1, unavailable: 0 });
    await expect(
      dispatchDueWorkflowSchedules(pool, new Date('2026-08-17T13:00:00.000Z')),
    ).resolves.toEqual({ dispatched: 0, unavailable: 0 });

    const claimed = await app.request(
      '/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=worker-development',
      { headers: { authorization: 'Bearer development-token' } },
    );
    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      artifactId: 'f'.repeat(64),
      encryptedPayload: 'rsa-oaep:cm90YXRlZA==',
      trigger: {
        type: 'schedule',
        scheduleId,
        scheduledFor: '2026-08-17T13:00:00.000Z',
      },
    });

    const duplicate = await app.request(
      '/v1/run-commands/next?organizationId=org_atlas&environmentId=development&workerId=worker-development',
      { headers: { authorization: 'Bearer development-token' } },
    );
    expect(duplicate.status).toBe(204);

    const list = await app.request(
      '/v1/workflow-schedules?organizationId=org_atlas&environmentId=development',
      { headers: { authorization: 'Bearer author-token' } },
    );
    const body = (await list.json()) as {
      schedules: Array<{ scheduleId: string; nextRunAt: string; lastOccurrence: unknown }>;
    };
    expect(body.schedules.find((item) => item.scheduleId === scheduleId)).toMatchObject({
      nextRunAt: '2026-08-17T14:00:00.000Z',
      lastOccurrence: {
        scheduledFor: '2026-08-17T13:00:00.000Z',
        status: 'queued',
      },
    });
  });
});
