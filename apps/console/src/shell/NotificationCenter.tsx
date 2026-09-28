import { subscribeToNotifications } from './notification-stream.js';
import { useEffect, useRef, useState, type Ref } from 'react';

import { demoTokenForRole } from '../config.js';
import { useDismissibleDetails } from './dismissibleDetails.js';
import { environmentIds, environmentLabels, type EnvironmentId } from './session.js';
import {
  clearNotifications,
  loadNotifications,
  markNotificationRead,
  type ConsoleNotification,
  type NotificationFeed,
} from './notifications.js';

interface NotificationPopoverProps {
  readonly feed: NotificationFeed | undefined;
  readonly filter: 'all' | EnvironmentId;
  readonly canClear: boolean;
  readonly clearing: boolean;
  readonly loading: boolean;
  readonly onClear: () => void;
  readonly onFilterChange: (filter: 'all' | EnvironmentId) => void;
  readonly onRead: (notification: ConsoleNotification) => void;
}

interface NotificationPopoverViewProps extends NotificationPopoverProps {
  readonly detailsRef?: Ref<HTMLDetailsElement>;
}

function formatNotificationTime(timestamp: string) {
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export async function followNotification(
  notification: ConsoleNotification,
  actions: {
    setEnvironmentId: (environmentId: EnvironmentId) => void;
    persistRead: (notificationId: string) => Promise<unknown>;
    reload: (environmentId: EnvironmentId) => Promise<NotificationFeed>;
  },
) {
  actions.setEnvironmentId(notification.environmentId);
  if (notification.readAt) return undefined;
  await actions.persistRead(notification.id);
  return actions.reload(notification.environmentId);
}

function capabilityIdentityId(notification: ConsoleNotification): string | null {
  const value = notification.details.capabilityIdentityId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function notificationActionTarget(notification: ConsoleNotification): string {
  if (notification.kind === 'runtime-contract-mismatch') return notification.navigationTarget;

  const capabilityId = capabilityIdentityId(notification);
  if (!capabilityId) return notification.navigationTarget;

  const existing = new URLSearchParams(notification.navigationTarget.split('?')[1] ?? '');
  const parameters = new URLSearchParams({
    capability: capabilityId,
    noticeTitle: notification.title,
    noticeMessage: notification.message,
    noticeSeverity: notification.severity,
  });
  if (notification.subjectLabel) parameters.set('capabilityLabel', notification.subjectLabel);
  const comparison = existing.get('comparison');
  if (comparison) parameters.set('comparison', comparison);
  if (notification.nextAction) parameters.set('noticeNextAction', notification.nextAction);
  return `#/capabilities?${parameters}`;
}

export function notificationActionLabel(notification: ConsoleNotification): string {
  if (notification.kind === 'runtime-contract-mismatch') return 'View blast radius';
  return capabilityIdentityId(notification) ? 'View capability' : 'View details';
}

export function notificationActivationTarget(
  notification: ConsoleNotification,
  activationId: string,
): string {
  const target = notificationActionTarget(notification);
  const [path, query = ''] = target.split('?');
  const parameters = new URLSearchParams(query);
  parameters.set('open', activationId);
  return `${path}?${parameters}`;
}

function activateNotification(
  notification: ConsoleNotification,
  currentTarget: HTMLAnchorElement,
  onRead: (notification: ConsoleNotification) => void,
) {
  currentTarget.href = notificationActivationTarget(notification, crypto.randomUUID());
  onRead(notification);
}

export function NotificationPopoverView({
  detailsRef,
  feed,
  filter,
  canClear,
  clearing,
  loading,
  onClear,
  onFilterChange,
  onRead,
}: NotificationPopoverViewProps) {
  const follow = (notification: ConsoleNotification, currentTarget: HTMLAnchorElement) => {
    activateNotification(notification, currentTarget, onRead);
    currentTarget.closest('details')?.removeAttribute('open');
  };
  return (
    <details className="notification-center" ref={detailsRef}>
      <summary
        aria-label={`Notifications${feed?.urgentUnreadCount ? `, ${feed.urgentUnreadCount} urgent unread` : ''}`}
        className="notification-trigger"
      >
        <svg aria-hidden="true" className="notification-bell" fill="none" viewBox="0 0 24 24">
          <path
            d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
          />
        </svg>
        {!!feed?.urgentUnreadCount && (
          <span className="notification-badge">{feed.urgentUnreadCount}</span>
        )}
      </summary>
      <section aria-label="Notification center" className="notification-popover">
        <div className="notification-heading">
          <div>
            <strong>Notifications</strong>
            <small>In-app notifications only</small>
            <button
              className="notification-clear"
              disabled={!canClear || clearing}
              onClick={onClear}
              type="button"
            >
              {clearing ? 'Clearing…' : 'Clear all'}
            </button>
          </div>
          <div aria-label="Notification scope" className="notification-filters" role="group">
            <button
              aria-pressed={filter === 'all'}
              onClick={() => onFilterChange('all')}
              type="button"
            >
              All
            </button>
            {environmentIds.map((environmentId) => (
              <button
                aria-pressed={filter === environmentId}
                className={`notification-filter-${environmentId}`}
                key={environmentId}
                onClick={() => onFilterChange(environmentId)}
                type="button"
              >
                {environmentLabels[environmentId]}
              </button>
            ))}
          </div>
        </div>
        <div aria-live="polite" className="notification-list">
          {loading && <p className="notification-empty">Loading notifications...</p>}
          {!loading && !feed && (
            <p className="notification-empty">Notifications are temporarily unavailable.</p>
          )}
          {!loading && feed?.notifications.length === 0 && (
            <p className="notification-empty">No notifications in this scope.</p>
          )}
          {feed?.notifications.map((notification) => (
            <article
              className={`notification-item notification-${notification.severity} notification-scope-${notification.environmentId}${notification.readAt ? '' : ' notification-unread'}`}
              key={notification.id}
            >
              <a
                className="notification-link"
                href={notificationActionTarget(notification)}
                onClick={(event) => follow(notification, event.currentTarget)}
              >
                <span className="notification-item-topline">
                  <span
                    className={`notification-severity notification-severity-${notification.severity}`}
                  >
                    {notification.severity}
                  </span>
                  <span
                    className={`notification-environment notification-environment-${notification.environmentId}`}
                  >
                    {environmentLabels[notification.environmentId as EnvironmentId] ??
                      notification.environmentId}
                  </span>
                  <time dateTime={notification.createdAt}>
                    {formatNotificationTime(notification.createdAt)}
                  </time>
                </span>
                <strong>{notification.title}</strong>
                <span>{notification.message}</span>
                {notification.subjectLabel && <small>Subject: {notification.subjectLabel}</small>}
                {(notification.affectedWorkflows ?? []).length > 0 && (
                  <small>
                    Affected workflows:{' '}
                    {(notification.affectedWorkflows ?? [])
                      .map(
                        (workflow) =>
                          workflow.name ?? workflow.workflowVersionId ?? workflow.workflowId,
                      )
                      .filter(Boolean)
                      .join(', ')}
                  </small>
                )}
                {notification.nextAction && <small>Next action: {notification.nextAction}</small>}
                <small>
                  {notification.readAt ? 'Read' : 'Unread'} ·{' '}
                  {notification.resolvedAt ? 'Resolved' : 'Unresolved'}
                  {notification.occurrenceCount > 1
                    ? ` · observed ${notification.occurrenceCount} times`
                    : ''}
                </small>
              </a>
              <a
                className="notification-action"
                href={notificationActionTarget(notification)}
                onClick={(event) => follow(notification, event.currentTarget)}
              >
                {notificationActionLabel(notification)}
              </a>
            </article>
          ))}
        </div>
      </section>
    </details>
  );
}

export function NotificationPopover(props: NotificationPopoverProps) {
  const notificationDetailsRef = useDismissibleDetails();
  return <NotificationPopoverView {...props} detailsRef={notificationDetailsRef} />;
}

type MismatchAlertStates = ReadonlyMap<string, boolean>;
export interface ActiveMismatchAlert {
  readonly notification: ConsoleNotification;
  readonly announcement: string;
}

export function updateMismatchAlertState(
  currentStates: MismatchAlertStates,
  notifications: readonly ConsoleNotification[],
): { states: MismatchAlertStates; notification: ConsoleNotification | null } {
  const states = new Map(currentStates);
  let notification: ConsoleNotification | null = null;
  for (const candidate of notifications) {
    if (candidate.kind !== 'runtime-contract-mismatch') continue;
    const active = candidate.resolvedAt === null;
    if (!active) {
      states.set(candidate.id, false);
      continue;
    }
    if (states.get(candidate.id) === true) continue;
    if (candidate.readAt !== null) {
      states.set(candidate.id, true);
      continue;
    }
    if (notification === null) {
      notification = candidate;
      states.set(candidate.id, true);
    }
  }
  return { states, notification };
}

export function refreshedMismatchAlert(
  current: ConsoleNotification | null,
  notifications: readonly ConsoleNotification[],
): ConsoleNotification | null {
  if (!current) return null;
  const refreshed = notifications.find((candidate) => candidate.id === current.id);
  if (!refreshed) return current;
  return refreshed.resolvedAt === null ? refreshed : null;
}

export function applyNotificationRefresh(
  currentStates: MismatchAlertStates,
  currentAlert: ActiveMismatchAlert | null,
  notifications: readonly ConsoleNotification[],
): { states: MismatchAlertStates; alert: ActiveMismatchAlert | null } {
  const update = updateMismatchAlertState(currentStates, notifications);
  if (update.notification) {
    return {
      states: update.states,
      alert: {
        notification: update.notification,
        announcement: `${update.notification.title}. ${update.notification.message}`,
      },
    };
  }
  const refreshed = refreshedMismatchAlert(currentAlert?.notification ?? null, notifications);
  return {
    states: update.states,
    alert: refreshed && currentAlert ? { ...currentAlert, notification: refreshed } : null,
  };
}

export function LiveMismatchAlert({
  announcement,
  notification,
  onDismiss,
  onRead,
}: {
  announcement?: string;
  notification: ConsoleNotification;
  onDismiss: () => void;
  onRead: (notification: ConsoleNotification) => void;
}) {
  const follow = (currentTarget: HTMLAnchorElement) => {
    activateNotification(notification, currentTarget, onRead);
    onDismiss();
  };
  return (
    <aside aria-label="Request problem" className="live-mismatch-alert" role="region">
      <span className="visually-hidden" role="alert">
        {announcement ?? `${notification.title}. ${notification.message}`}
      </span>
      <div>
        <small>Request problem found</small>
        <strong>{notification.title}</strong>
        <p>{notification.message}</p>
      </div>
      <div className="live-mismatch-alert-actions">
        <a
          href={notificationActionTarget(notification)}
          onClick={(event) => follow(event.currentTarget)}
        >
          View blast radius
        </a>
        <button aria-label="Dismiss request alert" onClick={onDismiss} type="button">
          Dismiss
        </button>
      </div>
    </aside>
  );
}

export function filterNotificationFeed(
  feed: NotificationFeed | undefined,
  filter: 'all' | EnvironmentId,
): NotificationFeed | undefined {
  if (!feed || filter === 'all') return feed;
  return {
    ...feed,
    notifications: feed.notifications.filter(
      (notification) => notification.environmentId === filter,
    ),
  };
}

export function NotificationCenter({
  organizationId,
  role,
  setEnvironmentId,
}: {
  organizationId: string;
  role: 'author' | 'admin' | 'operator';
  setEnvironmentId: (environmentId: EnvironmentId) => void;
}) {
  const [filter, setFilter] = useState<'all' | EnvironmentId>('all');
  const [feed, setFeed] = useState<NotificationFeed>();
  const [feedOrganizationId, setFeedOrganizationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [liveAlert, setLiveAlert] = useState<ActiveMismatchAlert | null>(null);
  const liveAlertRef = useRef<ActiveMismatchAlert | null>(null);
  const mismatchAlertStates = useRef<MismatchAlertStates>(new Map());

  useEffect(() => {
    mismatchAlertStates.current = new Map();
    liveAlertRef.current = null;
    setLiveAlert(null);
  }, [organizationId]);

  useEffect(() => {
    setLoading(true);
    setFeed(undefined);
    setFeedOrganizationId(null);
    return subscribeToNotifications({
      organizationId,
      token: demoTokenForRole(role),
      onFeed: (nextFeed) => {
        const nextAlert = applyNotificationRefresh(
          mismatchAlertStates.current,
          liveAlertRef.current,
          nextFeed.notifications,
        );
        mismatchAlertStates.current = nextAlert.states;
        liveAlertRef.current = nextAlert.alert;
        setLiveAlert(nextAlert.alert);
        setFeed(nextFeed);
        setFeedOrganizationId(organizationId);
        setLoading(false);
      },
      onFailure: () => {
        setLoading(false);
      },
    });
  }, [organizationId, role]);

  const read = (notification: ConsoleNotification) => {
    void followNotification(notification, {
      setEnvironmentId,
      persistRead: (notificationId) =>
        markNotificationRead(organizationId, notificationId, demoTokenForRole(role)),
      reload: () =>
        loadNotifications(
          organizationId,
          undefined,
          demoTokenForRole(role),
          new AbortController().signal,
        ),
    })
      .then((nextFeed) => {
        if (nextFeed) setFeed(nextFeed);
      })
      .catch(() => undefined);
  };

  const clear = () => {
    setClearing(true);
    void clearNotifications(organizationId, demoTokenForRole(role))
      .then(() => {
        mismatchAlertStates.current = new Map();
        liveAlertRef.current = null;
        setLiveAlert(null);
        setFeed({ notifications: [], unreadCount: 0, urgentUnreadCount: 0 });
      })
      .catch(() => undefined)
      .finally(() => setClearing(false));
  };

  return (
    <>
      <NotificationPopover
        feed={
          feedOrganizationId === organizationId ? filterNotificationFeed(feed, filter) : undefined
        }
        filter={filter}
        canClear={feedOrganizationId === organizationId && Boolean(feed?.notifications.length)}
        clearing={clearing}
        loading={loading}
        onClear={clear}
        onFilterChange={setFilter}
        onRead={read}
      />
      {liveAlert?.notification.organizationId === organizationId && (
        <LiveMismatchAlert
          announcement={liveAlert.announcement}
          notification={liveAlert.notification}
          onDismiss={() => {
            liveAlertRef.current = null;
            setLiveAlert(null);
          }}
          onRead={read}
        />
      )}
    </>
  );
}
