import { requestJson } from './api.js';
import type { Surface } from './router.js';
import type { EnvironmentId } from './session.js';

export type NotificationSeverity = 'info' | 'warning' | 'critical';
export type NotificationKind =
  | 'general'
  | 'capability-removal'
  | 'workflow-risk'
  | 'stale-source'
  | 'source-conflict'
  | 'environment-difference'
  | 'discovery-summary'
  | 'runtime-contract-mismatch';
export type NotificationNavigationTarget =
  | '#/'
  | `#/${Exclude<Surface, 'home'>}${'' | `?${string}`}`;

export interface ConsoleNotification {
  readonly id: string;
  readonly organizationId: string;
  readonly environmentId: EnvironmentId;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly message: string;
  readonly navigationTarget: NotificationNavigationTarget;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly resolvedAt: string | null;
  readonly kind: NotificationKind;
  readonly conditionKey: string | null;
  readonly subjectLabel: string | null;
  readonly nextAction: string | null;
  readonly affectedWorkflows: readonly {
    readonly workflowId?: string;
    readonly workflowVersionId?: string;
    readonly name?: string;
  }[];
  readonly details: Readonly<Record<string, unknown>>;
  readonly occurrenceCount: number;
  readonly updatedAt: string;
  readonly resolvedBy: string | null;
  readonly resolutionReason: string | null;
}

export interface NotificationFeed {
  readonly notifications: readonly ConsoleNotification[];
  readonly unreadCount: number;
  readonly urgentUnreadCount: number;
}

export function notificationQuery(organizationId: string, environmentId?: string) {
  return new URLSearchParams({
    organizationId,
    ...(environmentId ? { environmentId } : {}),
  });
}

export function loadNotifications(
  organizationId: string,
  environmentId: string | undefined,
  token: string,
  signal: AbortSignal,
) {
  return requestJson<NotificationFeed>(
    `/v1/notifications?${notificationQuery(organizationId, environmentId)}`,
    { signal, headers: { authorization: `Bearer ${token}` } },
  );
}

export function markNotificationRead(
  organizationId: string,
  notificationId: string,
  token: string,
) {
  return requestJson<ConsoleNotification>(
    `/v1/notifications/${encodeURIComponent(notificationId)}/read`,
    {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId }),
    },
  );
}

export function clearNotifications(organizationId: string, token: string) {
  return requestJson<{ clearedCount: number }>('/v1/notifications', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId }),
  });
}

export function resolveNotification(
  organizationId: string,
  notificationId: string,
  reason: string,
  token: string,
) {
  return requestJson<ConsoleNotification>(
    `/v1/notifications/${encodeURIComponent(notificationId)}/resolve`,
    {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, reason }),
    },
  );
}
