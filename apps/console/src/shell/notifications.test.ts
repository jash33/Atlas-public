import { describe, expect, it, vi } from 'vite-plus/test';

import {
  clearNotifications,
  loadNotifications,
  markNotificationRead,
  notificationQuery,
  resolveNotification,
} from './notifications.js';

describe('notification API client', () => {
  it('supports organization-wide and selected-environment feeds', () => {
    expect(notificationQuery('org_atlas').toString()).toBe('organizationId=org_atlas');
    expect(notificationQuery('org_atlas', 'production').toString()).toBe(
      'organizationId=org_atlas&environmentId=production',
    );
  });

  it('loads a filtered feed and persists read state', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ notifications: [], unreadCount: 2, urgentUnreadCount: 1 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'notice/1', readAt: '2026-08-27T12:00:00.000Z' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'notice/1', resolvedAt: '2026-08-27T12:01:00.000Z' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ clearedCount: 1 }), {
          status: 200,
        }),
      );

    await loadNotifications(
      'org_atlas',
      'development',
      'operator-token',
      new AbortController().signal,
    );
    await markNotificationRead('org_atlas', 'notice/1', 'operator-token');
    await resolveNotification('org_atlas', 'notice/1', 'Risk accepted for demo', 'admin-token');
    await clearNotifications('org_atlas', 'operator-token');

    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/v1/notifications?organizationId=org_atlas&environmentId=development',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/v1/notifications/notice%2F1/read');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
      body: '{"organizationId":"org_atlas"}',
    });
    expect(fetchMock.mock.calls[2]?.[0]).toContain('/v1/notifications/notice%2F1/resolve');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ organizationId: 'org_atlas', reason: 'Risk accepted for demo' }),
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer operator-token' },
    });
    expect(fetchMock.mock.calls[3]).toMatchObject([
      expect.stringContaining('/v1/notifications'),
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ organizationId: 'org_atlas' }),
      }),
    ]);
  });
});
