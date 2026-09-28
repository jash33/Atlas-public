import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `notifications_test_${process.pid}`;
const pool = new Pool({
  connectionString: databaseUrl,
  options: `-c search_path=${schemaName}`,
  application_name: schemaName,
});
let app: ReturnType<typeof createApp>;
const authorizer = {
  authorize: async ({
    authorizationHeader,
    action,
  }: {
    authorizationHeader: string | undefined;
    action: string;
  }) => {
    if (authorizationHeader === 'Bearer admin-token') {
      return { actorId: 'user_admin', role: 'admin' as const };
    }
    return authorizationHeader === 'Bearer member-token' && action === 'view-organization'
      ? { actorId: 'user_member', role: 'operator' as const }
      : null;
  },
};

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 141 });
  await pool.query(`
    INSERT INTO organizations (id) VALUES ('org_notifications');
    INSERT INTO environments (organization_id, id, name, kind)
    VALUES ('org_notifications', 'development', 'Development', 'development'),
           ('org_notifications', 'production', 'Production', 'production');
  `);
  app = createApp(pool, undefined, undefined, undefined, undefined, authorizer);
});

afterAll(async () => {
  await pool.end();
});

describe('notification API', () => {
  it('protects notification streams with the existing authorization checks', async () => {
    const denied = await app.request('/v1/notifications/stream?organizationId=org_notifications');
    expect(denied.status).toBe(403);
    const invalid = await app.request('/v1/notifications/stream', {
      headers: { authorization: 'Bearer member-token' },
    });
    expect(invalid.status).toBe(400);
  });

  it('pushes committed changes from another connection and recovers current state on reconnect', async () => {
    const writer = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    const org = 'org_notification_stream';
    await writer.query(`INSERT INTO organizations (id) VALUES ($1); `, [org]);
    await writer.query(
      `INSERT INTO environments (organization_id, id, name, kind)
      VALUES ($1, 'development', 'Development', 'development')`,
      [org],
    );
    const url = `/v1/notifications/stream?organizationId=${org}`;
    const open = () => app.request(url, { headers: { authorization: 'Bearer member-token' } });
    const response = await open();
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const received: string[] = [];
    const reading = (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        received.push(new TextDecoder().decode(result.value));
      }
    })();
    try {
      await vi.waitFor(() => expect(received).toHaveLength(1));
      expect(received[0]).toContain('"notifications":[]');
      const second = await open();
      const secondReader = second.body!.getReader();
      await secondReader.read();
      const listening = await writer.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND query = 'LISTEN atlas_notifications'`,
        [schemaName],
      );
      expect(listening.rows).toHaveLength(1);
      await secondReader.cancel();
      const transaction = await writer.connect();
      try {
        await transaction.query('BEGIN');
        await transaction.query(
          `INSERT INTO notifications
          (id, organization_id, environment_id, severity, title, message, navigation_target)
          VALUES ('rolled-back-notice', $1, 'development', 'info', 'Rolled back', 'Hidden', '#/runs')`,
          [org],
        );
        await transaction.query('ROLLBACK');
      } finally {
        transaction.release();
      }
      // Unrelated organization changes must not refresh this stream.
      await writer.query(`INSERT INTO notifications
        (id, organization_id, environment_id, severity, title, message, navigation_target)
        VALUES ('other-stream-notice', 'org_notifications', 'development', 'info', 'Other organization', 'Hidden', '#/runs')`);
      await writer.query(
        `INSERT INTO notifications
        (id, organization_id, environment_id, severity, title, message, navigation_target)
        VALUES ('stream-notice', $1, 'development', 'info', 'Live notification', 'Ready', '#/runs')`,
        [org],
      );
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[1]).toContain('Live notification');
      expect(received.join('')).not.toContain('Rolled back');
      expect(received.join('')).not.toContain('Other organization');
      await writer.query(`DELETE FROM notifications WHERE id = 'other-stream-notice'`);
      await writer.query(`UPDATE notifications SET read_at = now() WHERE id = 'stream-notice'`);
      await vi.waitFor(() => expect(received).toHaveLength(3));
      expect(received[2]).toContain('"unreadCount":0');
      await reader.cancel();
      await reading;
      const reconnected = await open();
      const recoveredReader = reconnected.body!.getReader();
      const recovered = await recoveredReader.read();
      expect(new TextDecoder().decode(recovered.value)).toContain('Live notification');
      await writer.query(`DELETE FROM notifications WHERE id = 'stream-notice'`);
      const cleared = await recoveredReader.read();
      expect(new TextDecoder().decode(cleared.value)).toContain('"notifications":[]');
      await writer.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE application_name = $1 AND query = 'LISTEN atlas_notifications'`,
        [schemaName],
      );
      expect((await recoveredReader.read()).done).toBe(true);
      await recoveredReader.cancel();
      const afterFailure = await open();
      const afterFailureReader = afterFailure.body!.getReader();
      expect(new TextDecoder().decode((await afterFailureReader.read()).value)).toContain(
        '"notifications":[]',
      );
      await afterFailureReader.cancel();
    } finally {
      await reader.cancel();
      await reading;
      await writer.end();
    }
  });

  it('persists organization notifications and filters their visible environment', async () => {
    for (const notification of [
      {
        id: 'notice-development',
        organizationId: 'org_notifications',
        environmentId: 'development',
        severity: 'info',
        title: 'Discovery complete',
        message: 'Fresh capabilities are available.',
        navigationTarget: '#/capabilities',
      },
      {
        id: 'notice-production',
        organizationId: 'org_notifications',
        environmentId: 'production',
        severity: 'warning',
        title: 'Run requires attention',
        message: 'Review the failed step.',
        navigationTarget: '#/runs',
      },
    ] as const) {
      const response = await app.request('/v1/notifications', {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify(notification),
      });
      expect(response.status).toBe(201);
    }

    const reloadedApp = createApp(pool, undefined, undefined, undefined, undefined, authorizer);
    const response = await reloadedApp.request(
      '/v1/notifications?organizationId=org_notifications&environmentId=development',
      { headers: { authorization: 'Bearer member-token' } },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      notifications: [
        {
          id: 'notice-development',
          organizationId: 'org_notifications',
          environmentId: 'development',
          severity: 'info',
          navigationTarget: '#/capabilities',
          readAt: null,
          resolvedAt: null,
        },
      ],
      unreadCount: 2,
      urgentUnreadCount: 1,
    });
  });

  it('marks a notification read without resolving its underlying condition', async () => {
    const response = await app.request('/v1/notifications/notice-production/read', {
      method: 'PATCH',
      headers: { authorization: 'Bearer member-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_notifications' }),
    });

    expect(response.status).toBe(200);
    const notification = (await response.json()) as {
      readAt: string | null;
      resolvedAt: string | null;
    };
    expect(notification.readAt).not.toBeNull();
    expect(notification.resolvedAt).toBeNull();

    const feed = await app.request('/v1/notifications?organizationId=org_notifications', {
      headers: { authorization: 'Bearer member-token' },
    });
    await expect(feed.json()).resolves.toMatchObject({ unreadCount: 1, urgentUnreadCount: 0 });
  });

  it('allows an organization member to clear the entire notification feed', async () => {
    await pool.query(`
      INSERT INTO organizations (id) VALUES ('org_other_notifications');
      INSERT INTO environments (organization_id, id, name, kind)
      VALUES ('org_other_notifications', 'development', 'Development', 'development');
      INSERT INTO notifications
        (id, organization_id, environment_id, severity, title, message, navigation_target)
      VALUES ('notice-other-organization', 'org_other_notifications', 'development', 'info',
        'Other organization notice', 'This notification must remain.', '#/activity');
    `);
    const before = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM notifications WHERE organization_id = $1`,
      ['org_notifications'],
    );
    expect(before.rows[0]!.count).toBeGreaterThan(0);

    const denied = await app.request('/v1/notifications', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_notifications' }),
    });
    expect(denied.status).toBe(403);

    const response = await app.request('/v1/notifications', {
      method: 'DELETE',
      headers: { authorization: 'Bearer member-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_notifications' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ clearedCount: before.rows[0]!.count });
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM notifications WHERE organization_id = $1`,
        ['org_notifications'],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    await expect(
      pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM notifications WHERE organization_id = $1`,
        ['org_other_notifications'],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 1 }] });
  });

  it('enforces organization membership when authorization is configured', async () => {
    const denied = await app.request('/v1/notifications?organizationId=org_notifications');
    expect(denied.status).toBe(403);

    const allowed = await app.request('/v1/notifications?organizationId=org_notifications', {
      headers: { authorization: 'Bearer member-token' },
    });
    expect(allowed.status).toBe(200);

    const unconfigured = createApp(pool);
    const unavailable = await unconfigured.request(
      '/v1/notifications?organizationId=org_notifications',
    );
    expect(unavailable.status).toBe(503);
  });

  it('resolves the underlying condition independently from read state', async () => {
    const created = await app.request('/v1/notifications', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'notice-resolved-unread',
        organizationId: 'org_notifications',
        environmentId: 'development',
        severity: 'warning',
        title: 'Temporary warning',
        message: 'The condition can recover before the notice is read.',
        navigationTarget: '#/activity',
      }),
    });
    expect(created.status).toBe(201);

    const response = await app.request('/v1/notifications/notice-resolved-unread/resolve', {
      method: 'PATCH',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_notifications' }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'notice-resolved-unread',
      readAt: null,
      resolvedAt: expect.any(String),
      resolvedBy: 'user_admin',
      resolutionReason: 'Explicit administrative resolution',
    });
    const audit = await app.request(
      '/v1/audit-entries?organizationId=org_notifications&environmentId=development',
      { headers: { authorization: 'Bearer admin-token' } },
    );
    await expect(audit.json()).resolves.toMatchObject({
      entries: [
        expect.objectContaining({
          eventType: 'notification-resolution',
          subjectId: 'notice-resolved-unread',
          actorId: 'user_admin',
          details: expect.objectContaining({ reason: 'Explicit administrative resolution' }),
        }),
      ],
    });
  });
});
