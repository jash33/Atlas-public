import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  EnvironmentColorEditor,
  EnvironmentPicker,
  environmentThemeStyles,
  ProfileMenu,
  shouldKeepWorkflowsMounted,
} from './AppShell.js';
import {
  applyNotificationRefresh,
  followNotification,
  LiveMismatchAlert,
  notificationActivationTarget,
  notificationActionTarget,
  notificationActionLabel,
  NotificationPopover,
  NotificationPopoverView,
  refreshedMismatchAlert,
  updateMismatchAlertState,
} from './NotificationCenter.js';
import type { ConsoleNotification } from './notifications.js';
import { demoProfileDetails } from './session.js';

const notificationMetadata = {
  kind: 'general' as const,
  conditionKey: null,
  subjectLabel: null,
  nextAction: null,
  affectedWorkflows: [],
  details: {},
  occurrenceCount: 1,
  updatedAt: '2026-08-27T12:00:00.000Z',
  resolvedBy: null,
  resolutionReason: null,
};

const runtimeMismatchNotification: ConsoleNotification = {
  ...notificationMetadata,
  kind: 'runtime-contract-mismatch',
  conditionKey: 'runtime:payments:createPayment:extraLettuce',
  details: {
    runtimeMismatchId: 'runtime-mismatch-1',
    capabilityIdentityId: 'payments-create-payment',
    capabilityVersionId: 'payments-create-payment-v1',
    pollingDefinitionRevision: 1,
    operation: 'createPayment',
    reason: 'required-field-missing',
    fieldPath: 'extraLettuce',
    status: 400,
    affectedEndpointCount: 2,
    affectedWorkflowCount: 1,
  },
  id: 'runtime-notice-1',
  organizationId: 'org_atlas',
  environmentId: 'development',
  severity: 'critical',
  title: 'createPayment request is broken',
  message: 'createPayment now requires extraLettuce. 2 endpoints in 1 workflow will fail.',
  navigationTarget:
    '#/capabilities?view=map&environmentId=development&focusType=runtime-mismatch&focusId=runtime-mismatch-1',
  subjectLabel: 'createPayment',
  nextAction: 'View the blast radius and update the request.',
  affectedWorkflows: [
    { workflowId: 'prepare-order', workflowVersionId: 'prepare-order-v1', name: 'Prepare order' },
  ],
  createdAt: '2026-09-04T15:00:01.000Z',
  updatedAt: '2026-09-04T15:00:01.000Z',
  readAt: null,
  resolvedAt: null,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Console header controls', () => {
  it('keeps the workflow workspace mounted after navigating away', () => {
    expect(shouldKeepWorkflowsMounted(false, 'home')).toBe(false);
    expect(shouldKeepWorkflowsMounted(false, 'workflows')).toBe(true);
    expect(shouldKeepWorkflowsMounted(true, 'capabilities')).toBe(true);
  });

  it('exposes the global urgent indicator and accessible environment filtering', () => {
    const html = renderToStaticMarkup(
      createElement(NotificationPopover, {
        feed: {
          unreadCount: 2,
          urgentUnreadCount: 1,
          notifications: [
            {
              ...notificationMetadata,
              id: 'notice-production',
              organizationId: 'org_atlas',
              environmentId: 'production',
              severity: 'warning',
              title: 'Run requires attention',
              message: 'Review the failed step.',
              navigationTarget: '#/runs',
              createdAt: '2026-08-27T12:00:00.000Z',
              readAt: null,
              resolvedAt: null,
            },
          ],
        },
        filter: 'production',
        canClear: true,
        clearing: false,
        loading: false,
        onClear: vi.fn<() => void>(),
        onFilterChange: vi.fn<(filter: 'all' | 'development' | 'production') => void>(),
        onRead: vi.fn<(notification: ConsoleNotification) => void>(),
      }),
    );

    expect(html).toContain('aria-label="Notifications, 1 urgent unread"');
    expect(html).toContain('aria-label="Notification center"');
    expect(html).toContain('aria-label="Notification scope"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('notification-severity-warning');
    expect(html).toContain('notification-environment-production');
    expect(html).toContain('notification-scope-production');
    expect(html).toContain('Unread · Unresolved');
    expect(html).toContain('Development');
    expect(html).toContain('Production');
    expect(html).toContain('notification-filter-development');
    expect(html).toContain('notification-filter-production');
    expect(html).toContain('Clear all');
  });

  it('wires the environment filter and notification link as interactive controls', () => {
    const onFilterChange = vi.fn<(filter: 'all' | 'development' | 'production') => void>();
    const onRead = vi.fn<(notification: ConsoleNotification) => void>();
    const notification = {
      ...notificationMetadata,
      id: 'notice-production',
      organizationId: 'org_atlas',
      environmentId: 'production' as const,
      severity: 'warning' as const,
      title: 'Run requires attention',
      message: 'Review the failed step.',
      navigationTarget: '#/runs' as const,
      createdAt: '2026-08-27T12:00:00.000Z',
      readAt: null,
      resolvedAt: null,
    };
    const popover = NotificationPopoverView({
      feed: { unreadCount: 1, urgentUnreadCount: 1, notifications: [notification] },
      filter: 'all',
      canClear: true,
      clearing: false,
      loading: false,
      onClear: vi.fn<() => void>(),
      onFilterChange,
      onRead,
    });
    const section = popover.props.children[1];
    const filterChildren = section.props.children[0].props.children[1].props.children as [
      { props: { onClick: () => void } },
      Array<{ props: { onClick: () => void } }>,
    ];
    const filterButtons = [filterChildren[0], ...filterChildren[1]];
    const notificationArticle = section.props.children[1].props.children[3][0] as {
      props: {
        children: Array<{
          props: {
            onClick: (event: { currentTarget: { closest: () => null; href: string } }) => void;
          };
        }>;
      };
    };
    const notificationLink = notificationArticle.props.children[0]!;

    filterButtons[1]!.props.onClick();
    notificationLink.props.onClick({ currentTarget: { closest: () => null, href: '' } });

    expect(onFilterChange).toHaveBeenCalledWith('development');
    expect(onRead).toHaveBeenCalledWith(notification);
  });

  it('does not expose demo provenance in notification presentation', () => {
    const notification = {
      ...notificationMetadata,
      id: 'notice-real',
      organizationId: 'org_atlas',
      environmentId: 'development' as const,
      severity: 'info' as const,
      title: 'Discovery complete',
      message: 'Fresh evidence is available.',
      navigationTarget: '#/capabilities' as const,
      createdAt: '2026-08-27T12:00:00.000Z',
      readAt: null,
      resolvedAt: null,
    };

    const html = renderToStaticMarkup(
      createElement(NotificationPopover, {
        feed: {
          unreadCount: 1,
          urgentUnreadCount: 0,
          notifications: [
            {
              ...notification,
              details: { seeded: true, source: 'demo-seed' },
              id: 'demo-visible',
            },
          ],
        },
        filter: 'all',
        canClear: true,
        clearing: false,
        loading: false,
        onClear: vi.fn<() => void>(),
        onFilterChange: vi.fn<(filter: 'all' | 'development' | 'production') => void>(),
        onRead: vi.fn<(notification: ConsoleNotification) => void>(),
      }),
    );
    expect(html).not.toContain('Demo data');
    expect(html).not.toContain('notification-origin-demo');
  });

  it('links capability risks to the affected capability with the notification context', () => {
    const notification = {
      ...notificationMetadata,
      details: { capabilityIdentityId: 'capability-invoice-paid' },
      id: 'notice-risk',
      organizationId: 'org_atlas',
      environmentId: 'production' as const,
      severity: 'critical' as const,
      title: 'Workflow action required',
      message: 'A removed capability blocks this workflow.',
      nextAction: 'Rediscover the source or migrate affected workflows.',
      navigationTarget: '#/workflow-catalog' as const,
      createdAt: '2026-08-27T12:00:00.000Z',
      readAt: null,
      resolvedAt: null,
    };
    const props = {
      feed: { unreadCount: 1, urgentUnreadCount: 1, notifications: [notification] },
      filter: 'all' as const,
      canClear: true,
      clearing: false,
      loading: false,
      onClear: vi.fn<() => void>(),
      onFilterChange: vi.fn<(filter: 'all' | 'development' | 'production') => void>(),
      onRead: vi.fn<(notification: ConsoleNotification) => void>(),
    };
    const html = renderToStaticMarkup(createElement(NotificationPopover, props));
    const target = notificationActionTarget(notification);

    expect(html).toContain('notification-severity-critical');
    expect(html).toContain('View capability');
    expect(html).not.toContain('Resolve risk');
    expect(target).toContain('#/capabilities?');
    expect(target).toContain('capability=capability-invoice-paid');
    expect(target).toContain('noticeMessage=A+removed+capability+blocks+this+workflow.');
    expect(notificationActivationTarget(notification, 'first')).not.toBe(
      notificationActivationTarget(notification, 'second'),
    );
  });

  it('keeps a broken-request notification pointed at its exact red map', () => {
    expect(notificationActionTarget(runtimeMismatchNotification)).toBe(
      runtimeMismatchNotification.navigationTarget,
    );
    expect(notificationActionLabel(runtimeMismatchNotification)).toBe('View blast radius');
  });

  it('shows one accessible alert for a new broken request and not for repeated observations', () => {
    const first = updateMismatchAlertState(new Map(), [runtimeMismatchNotification]);
    const repeated = updateMismatchAlertState(first.states, [
      { ...runtimeMismatchNotification, occurrenceCount: 2, updatedAt: '2026-09-04T15:00:02.000Z' },
    ]);
    const html = renderToStaticMarkup(
      createElement(LiveMismatchAlert, {
        notification: first.notification!,
        onDismiss: vi.fn<() => void>(),
        onRead: vi.fn<(notification: ConsoleNotification) => void>(),
      }),
    );

    expect(first.notification?.id).toBe('runtime-notice-1');
    expect(repeated.notification).toBeNull();
    expect(html).toContain('role="alert"');
    expect(html).toContain('createPayment request is broken');
    expect(html).toContain('extraLettuce');
    expect(html).toContain('View blast radius');
    expect(html).toContain(runtimeMismatchNotification.navigationTarget.replaceAll('&', '&amp;'));
  });

  it('updates the open alert counts without announcing the same condition again', () => {
    const repeatedNotification = {
      ...runtimeMismatchNotification,
      message: 'createPayment now requires extraLettuce. 3 endpoints in 2 workflows will fail.',
      occurrenceCount: 2,
      updatedAt: '2026-09-04T15:00:02.000Z',
    };

    expect(refreshedMismatchAlert(runtimeMismatchNotification, [repeatedNotification])).toEqual(
      repeatedNotification,
    );
    expect(
      updateMismatchAlertState(new Map([[runtimeMismatchNotification.id, true]]), [
        repeatedNotification,
      ]).notification,
    ).toBeNull();
  });

  it('turns successive notification responses into one updated alert for an open Console', () => {
    const initial = applyNotificationRefresh(new Map(), null, []);
    const detected = applyNotificationRefresh(initial.states, initial.alert, [
      runtimeMismatchNotification,
    ]);
    const repeatedNotification = {
      ...runtimeMismatchNotification,
      message: 'createPayment now requires extraLettuce. 3 endpoints in 2 workflows will fail.',
      occurrenceCount: 2,
      updatedAt: '2026-09-04T15:00:02.000Z',
    };
    const repeated = applyNotificationRefresh(detected.states, detected.alert, [
      repeatedNotification,
    ]);

    expect(initial.alert).toBeNull();
    expect(detected.alert?.notification).toEqual(runtimeMismatchNotification);
    expect(repeated.alert?.notification).toEqual(repeatedNotification);
    expect(repeated.alert?.announcement).toBe(detected.alert?.announcement);
    expect(repeated.states).toEqual(detected.states);
  });

  it('does not repeat a read alert after reload and leaves a second new condition for later', () => {
    const alreadyRead = {
      ...runtimeMismatchNotification,
      readAt: '2026-09-04T15:00:03.000Z',
    };
    const second = {
      ...runtimeMismatchNotification,
      conditionKey: 'runtime:kitchen:createOrder:orderType',
      id: 'runtime-notice-2',
      readAt: null,
    };
    const third = {
      ...runtimeMismatchNotification,
      conditionKey: 'runtime:kitchen:cancelOrder:reason',
      id: 'runtime-notice-3',
      readAt: null,
    };
    const firstRefresh = updateMismatchAlertState(new Map(), [alreadyRead, second, third]);
    const nextRefresh = updateMismatchAlertState(firstRefresh.states, [alreadyRead, second, third]);

    expect(firstRefresh.notification?.id).toBe('runtime-notice-2');
    expect(nextRefresh.notification?.id).toBe('runtime-notice-3');
  });

  it('follows and dismisses the broken-request alert without resolving it', () => {
    const onDismiss = vi.fn<() => void>();
    const onRead = vi.fn<(notification: ConsoleNotification) => void>();
    const alert = LiveMismatchAlert({
      notification: runtimeMismatchNotification,
      onDismiss,
      onRead,
    });
    const actions = alert.props.children[2];
    const link = actions.props.children[0];
    const currentTarget = { href: '' };

    link.props.onClick({ currentTarget });

    expect(currentTarget.href).toContain('focusType=runtime-mismatch');
    expect(currentTarget.href).toContain('focusId=runtime-mismatch-1');
    expect(currentTarget.href).toContain('open=');
    expect(onRead).toHaveBeenCalledWith(runtimeMismatchNotification);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('allows a later independent regression to alert after the earlier condition recovers', () => {
    const first = updateMismatchAlertState(new Map(), [runtimeMismatchNotification]);
    const recovered = updateMismatchAlertState(first.states, [
      {
        ...runtimeMismatchNotification,
        readAt: '2026-09-04T15:00:03.000Z',
        resolvedAt: '2026-09-04T15:00:03.000Z',
      },
    ]);
    const regressed = updateMismatchAlertState(recovered.states, [
      {
        ...runtimeMismatchNotification,
        createdAt: '2026-09-04T15:00:04.000Z',
        updatedAt: '2026-09-04T15:00:04.000Z',
      },
    ]);

    expect(recovered.notification).toBeNull();
    expect(regressed.notification?.id).toBe('runtime-notice-1');
  });

  it('puts the demo identity, active role, and all role switches in the profile menu', () => {
    const setRole = vi.fn<(role: 'author' | 'admin' | 'operator') => void>();
    const html = renderToStaticMarkup(
      createElement(ProfileMenu, {
        profile: demoProfileDetails.sample,
        role: 'admin',
        setRole,
      }),
    );

    expect(html).toContain('aria-label="Demo profile, Admin role"');
    expect(html).toContain('User Profile');
    expect(html).toContain('user@atlas.demo');
    expect(html).toContain('Active role: Admin');
    expect(html).toContain('aria-label="Demo role"');
    expect(html).toContain('Author');
    expect(html).toContain('Admin');
    expect(html).toContain('Operator');

    const menu = ProfileMenu({ profile: demoProfileDetails.sample, role: 'admin', setRole });
    const roleButtons = menu.props.children[1].props.children[2].props.children as Array<{
      props: { onClick: () => void };
    }>;
    roleButtons[2]!.props.onClick();
    expect(setRole).toHaveBeenCalledWith('operator');
  });

  it('shows the Burger Town identity selected by the preparation link', () => {
    const html = renderToStaticMarkup(
      createElement(ProfileMenu, {
        profile: demoProfileDetails['burger-town'],
        role: 'author',
        setRole: vi.fn<(role: 'author' | 'admin' | 'operator') => void>(),
      }),
    );

    expect(html).toContain('Burger Town Demo');
    expect(html).toContain('demo@burgertown.local');
    expect(html).not.toContain('user@atlas.demo');
  });

  it('offers six curated saved color choices for both environments', () => {
    const colors = { development: '#7556a8', production: '#277d86' };
    const html = renderToStaticMarkup(
      createElement(EnvironmentColorEditor, {
        colors,
        onSave: vi.fn<(nextColors: typeof colors) => void>(),
      }),
    );

    expect(html).toContain('Environment colors');
    expect(html).toContain('aria-label="Development: Violet"');
    expect(html).toContain('aria-label="Production: Graphite"');
    expect(html.match(/type="radio"/g)).toHaveLength(12);
    expect(html).not.toContain('type="color"');
    expect(html).toContain('Save colors');
  });

  it('shows every environment as a styled option before selection', () => {
    const html = renderToStaticMarkup(
      createElement(EnvironmentPicker, {
        environmentId: 'development',
        onChange: vi.fn<(environmentId: 'development' | 'production') => void>(),
      }),
    );

    expect(html).toContain('role="menu"');
    expect(html).toContain('role="menuitemradio"');
    expect(html).toContain('environment-option-development');
    expect(html).toContain('environment-option-production');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-checked="false"');
  });

  it('regenerates notification background tints from saved environment colors', () => {
    const styles = environmentThemeStyles({
      development: '#256d9b',
      production: '#8f416f',
    }) as Record<string, string>;

    expect(styles['--environment-development-soft']).toContain('#256d9b 12%');
    expect(styles['--environment-development-hover']).toContain('#256d9b 20%');
    expect(styles['--environment-production-soft']).toContain('#8f416f 12%');
    expect(styles['--environment-production-hover']).toContain('#8f416f 20%');
  });

  it('switches environment and persists read state before reloading the target scope', async () => {
    const setEnvironmentId = vi.fn<(environmentId: 'development' | 'production') => void>();
    const persistRead = vi.fn<(notificationId: string) => Promise<undefined>>(
      async () => undefined,
    );
    const reload = vi.fn<
      (environmentId: 'development' | 'production') => Promise<{
        notifications: never[];
        unreadCount: number;
        urgentUnreadCount: number;
      }>
    >(async () => ({
      notifications: [],
      unreadCount: 0,
      urgentUnreadCount: 0,
    }));
    await followNotification(
      {
        ...notificationMetadata,
        id: 'notice-production',
        organizationId: 'org_atlas',
        environmentId: 'production',
        severity: 'warning',
        title: 'Run requires attention',
        message: 'Review the failed step.',
        navigationTarget: '#/runs',
        createdAt: '2026-08-27T12:00:00.000Z',
        readAt: null,
        resolvedAt: null,
      },
      { setEnvironmentId, persistRead, reload },
    );

    expect(setEnvironmentId).toHaveBeenCalledWith('production');
    expect(persistRead).toHaveBeenCalledWith('notice-production');
    expect(reload).toHaveBeenCalledWith('production');
  });

  it('keeps the current feed when following an already-read notification', async () => {
    const actions = {
      setEnvironmentId: vi.fn<(environmentId: 'development' | 'production') => void>(),
      persistRead: vi.fn<(notificationId: string) => Promise<undefined>>(async () => undefined),
      reload: vi.fn<
        (environmentId: 'development' | 'production') => Promise<{
          notifications: never[];
          unreadCount: number;
          urgentUnreadCount: number;
        }>
      >(async () => ({
        notifications: [],
        unreadCount: 0,
        urgentUnreadCount: 0,
      })),
    };

    const nextFeed = await followNotification(
      {
        ...notificationMetadata,
        id: 'notice-read',
        organizationId: 'org_atlas',
        environmentId: 'development',
        severity: 'info',
        title: 'Discovery complete',
        message: 'Fresh capabilities are available.',
        navigationTarget: '#/capabilities',
        createdAt: '2026-08-27T12:00:00.000Z',
        readAt: '2026-08-27T12:01:00.000Z',
        resolvedAt: null,
      },
      actions,
    );

    expect(nextFeed).toBeUndefined();
    expect(actions.setEnvironmentId).toHaveBeenCalledWith('development');
    expect(actions.persistRead).not.toHaveBeenCalled();
    expect(actions.reload).not.toHaveBeenCalled();
  });
});
