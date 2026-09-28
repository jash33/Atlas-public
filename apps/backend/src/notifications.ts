import type { Pool } from 'pg';
import { z } from 'zod';

import type { RuntimeMismatchNotifier } from './burger-town-monitor.js';
import { readCapabilityOverview } from './capability-overview.js';
import { sha256 } from './capability-versioning.js';

export const notificationSeveritySchema = z.enum(['info', 'warning', 'critical']);
export const notificationKindSchema = z.enum([
  'general',
  'capability-removal',
  'workflow-risk',
  'stale-source',
  'source-conflict',
  'environment-difference',
  'discovery-summary',
  'runtime-contract-mismatch',
]);

export const notificationsQuerySchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1).optional(),
  })
  .strict();

export const createNotificationSchema = z
  .object({
    id: z.string().min(1).optional(),
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    severity: notificationSeveritySchema,
    title: z.string().min(1),
    message: z.string().min(1),
    navigationTarget: z
      .string()
      .regex(
        /^#\/(?:workflows|workflow-catalog|capabilities|runs|changes|activity|settings)?(?:\?.*)?$/,
      ),
    createdAt: z.iso.datetime().optional(),
  })
  .strict();

export const readNotificationSchema = z.object({ organizationId: z.string().min(1) }).strict();
export const clearNotificationsSchema = readNotificationSchema;
export const resolveNotificationSchema = z
  .object({
    organizationId: z.string().min(1),
    reason: z.string().trim().min(1).default('Explicit administrative resolution'),
  })
  .strict();

interface NotificationRow {
  readonly id: string;
  readonly organization_id: string;
  readonly environment_id: string;
  readonly severity: z.infer<typeof notificationSeveritySchema>;
  readonly title: string;
  readonly message: string;
  readonly navigation_target: string;
  readonly created_at: Date;
  readonly read_at: Date | null;
  readonly resolved_at: Date | null;
  readonly kind: z.infer<typeof notificationKindSchema>;
  readonly condition_key: string | null;
  readonly subject_label: string | null;
  readonly next_action: string | null;
  readonly affected_workflows: unknown[];
  readonly details: Record<string, unknown>;
  readonly occurrence_count: number;
  readonly updated_at: Date;
  readonly resolved_by: string | null;
  readonly resolution_reason: string | null;
}

interface StoredRuntimeMismatchRow {
  id: string;
  condition_key: string;
  capability_identity_id: string;
  operation_id: string;
  first_seen_at: Date;
  last_seen_at: Date;
  occurrence_count: number;
}

function presentNotification(row: NotificationRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    environmentId: row.environment_id,
    severity: notificationSeveritySchema.parse(row.severity),
    title: row.title,
    message: row.message,
    navigationTarget: row.navigation_target,
    createdAt: row.created_at.toISOString(),
    readAt: row.read_at?.toISOString() ?? null,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    kind: notificationKindSchema.parse(row.kind),
    conditionKey: row.condition_key,
    subjectLabel: row.subject_label,
    nextAction: row.next_action,
    affectedWorkflows: row.affected_workflows,
    details: row.details,
    occurrenceCount: row.occurrence_count,
    updatedAt: row.updated_at.toISOString(),
    resolvedBy: row.resolved_by,
    resolutionReason: row.resolution_reason,
  };
}

export async function createNotification(
  pool: Pool,
  input: z.infer<typeof createNotificationSchema>,
) {
  const result = await pool.query<NotificationRow>(
    `INSERT INTO notifications
       (id, organization_id, environment_id, severity, title, message,
        navigation_target, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, current_timestamp))
     RETURNING *`,
    [
      input.id ?? crypto.randomUUID(),
      input.organizationId,
      input.environmentId,
      input.severity,
      input.title,
      input.message,
      input.navigationTarget,
      input.createdAt ?? null,
    ],
  );
  return presentNotification(result.rows[0]!);
}

export async function readNotifications(
  pool: Pool,
  query: z.infer<typeof notificationsQuerySchema>,
) {
  const [notifications, counts] = await Promise.all([
    pool.query<NotificationRow>(
      `SELECT * FROM notifications
       WHERE organization_id = $1
         AND ($2::text IS NULL OR environment_id = $2)
       ORDER BY created_at DESC, id DESC`,
      [query.organizationId, query.environmentId ?? null],
    ),
    pool.query<{ urgent_unread_count: string; unread_count: string }>(
      `SELECT
         count(*) FILTER (WHERE read_at IS NULL) AS unread_count,
         count(*) FILTER (
           WHERE read_at IS NULL AND resolved_at IS NULL
             AND severity IN ('warning', 'critical')
         ) AS urgent_unread_count
       FROM notifications
       WHERE organization_id = $1`,
      [query.organizationId],
    ),
  ]);
  return {
    notifications: notifications.rows.map(presentNotification),
    unreadCount: Number(counts.rows[0]?.unread_count ?? 0),
    urgentUnreadCount: Number(counts.rows[0]?.urgent_unread_count ?? 0),
  };
}

export async function markNotificationRead(pool: Pool, id: string, organizationId: string) {
  const result = await pool.query<NotificationRow>(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, current_timestamp)
     WHERE id = $1 AND organization_id = $2
     RETURNING *`,
    [id, organizationId],
  );
  return result.rows[0] ? presentNotification(result.rows[0]) : undefined;
}

export async function clearNotifications(pool: Pool, organizationId: string) {
  const result = await pool.query(
    `DELETE FROM notifications
     WHERE organization_id = $1`,
    [organizationId],
  );
  return { clearedCount: result.rowCount ?? 0 };
}

export async function resolveNotification(
  pool: Pool,
  id: string,
  organizationId: string,
  actorId: string,
  reason: string,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<NotificationRow>(
      `UPDATE notifications
       SET resolved_at = COALESCE(resolved_at, current_timestamp), resolved_by = $3,
         resolution_reason = COALESCE(resolution_reason, $4), updated_at = current_timestamp
       WHERE id = $1 AND organization_id = $2 AND resolved_at IS NULL
       RETURNING *`,
      [id, organizationId, actorId, reason],
    );
    const notification = result.rows[0];
    if (notification) {
      await client.query(
        `INSERT INTO audit_entries
          (organization_id, environment_id, event_type, subject_type, subject_id, actor_id, details)
         VALUES ($1, $2, 'notification-resolution', 'notification', $3, $4,
           jsonb_build_object('reason', $5::text, 'conditionKey', $6::text))`,
        [
          organizationId,
          notification.environment_id,
          id,
          actorId,
          reason,
          notification.condition_key,
        ],
      );
    }
    await client.query('COMMIT');
    return notification ? presentNotification(notification) : undefined;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function seedDemoNotifications(pool: Pool, organizationId: string) {
  await pool.query(
    `INSERT INTO notifications
       (id, organization_id, environment_id, severity, title, message, navigation_target,
        created_at)
     VALUES
       ('demo-production-warning', $1, 'production', 'warning',
        'Payment recovery needs attention',
        'A production run is waiting for an operator to review its failed step.',
        '#/runs', current_timestamp - interval '4 minutes'),
       ('demo-development-info', $1, 'development', 'info',
        'Capability discovery completed',
        'The development capability catalog has fresh source evidence.',
        '#/capabilities', current_timestamp - interval '18 minutes')
     ON CONFLICT (id) DO NOTHING`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO notifications
       (id, organization_id, environment_id, severity, title, message, navigation_target,
        created_at, read_at, resolved_at)
     VALUES ('demo-development-resolved', $1, 'development', 'info',
       'Workflow checks recovered',
       'A previously failing development check is healthy again.',
       '#/workflow-catalog', current_timestamp - interval '1 hour',
       current_timestamp - interval '52 minutes', current_timestamp - interval '50 minutes')
     ON CONFLICT (id) DO NOTHING`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO notifications
       (id, organization_id, environment_id, kind, condition_key, severity, title, message,
        navigation_target, subject_label, next_action, affected_workflows, details, created_at)
     VALUES
       ('demo-capability-removal-risk', $1, 'production', 'capability-removal',
        'demo:capability-removal', 'critical', 'Removed capability blocks workflows',
        'markInvoicePaid is absent from a successful discovery. One workflow requires action.',
        '#/workflow-catalog?workflowId=payment-to-billing', 'markInvoicePaid',
        'Migrate and approve the workflow against a valid capability.',
        '[{"workflowId":"payment-to-billing","workflowVersionId":"payment-to-billing@1","name":"Payment to billing"}]',
        jsonb_build_object('capabilityIdentityId', (
          SELECT id::text FROM capability_identities
          WHERE organization_id = $1 AND operation_id = 'markInvoicePaid'
          ORDER BY service_id LIMIT 1
        )),
        current_timestamp - interval '2 minutes'),
       ('demo-discovery-change-summary', $1, 'development', 'discovery-summary',
        'demo:discovery-summary', 'warning', 'Billing contract changes',
        'Two declared-contract changes were observed in one discovery.',
        '#/changes', 'billing', 'Review the grouped details and affected workflows.',
        '[]', '{"changeCount":2,"classifications":["compatible","conditional"]}',
        current_timestamp - interval '12 minutes')
     ON CONFLICT (id) DO UPDATE SET details = EXCLUDED.details`,
    [organizationId],
  );
  await pool.query(
    `UPDATE notifications
     SET details = details || '{"seeded":true,"source":"demo-seed"}'::jsonb
     WHERE organization_id = $1
       AND id IN (
         'demo-production-warning',
         'demo-development-info',
         'demo-development-resolved',
         'demo-capability-removal-risk',
         'demo-discovery-change-summary'
       )`,
    [organizationId],
  );
}

export function createPostgresRuntimeMismatchNotifier(pool: Pool): RuntimeMismatchNotifier {
  return {
    async notify(scope, target, mismatch, mismatchId) {
      const storedResult = await pool.query<StoredRuntimeMismatchRow>(
        `SELECT id, condition_key, capability_identity_id::text AS capability_identity_id,
                operation_id, first_seen_at, last_seen_at, occurrence_count
         FROM runtime_contract_mismatches
         WHERE id = $1 AND organization_id = $2 AND environment_id = $3 AND state = 'active'`,
        [mismatchId, scope.organizationId, scope.environmentId],
      );
      const stored = storedResult.rows[0];
      if (!stored) return;
      const overview = await readCapabilityOverview(
        pool,
        scope.organizationId,
        scope.environmentId,
        {
          type: 'runtime-mismatch',
          id: stored.id,
        },
      );
      if (!overview.impact || overview.impact.type !== 'runtime-mismatch') return;
      const affectedWorkflows = [
        ...new Map(
          overview.nodes
            .flatMap((node) => node.impact?.usages ?? [])
            .map((usage) => [
              usage.workflowVersionId,
              {
                workflowId: usage.workflowId,
                workflowVersionId: usage.workflowVersionId,
                name: usage.workflowName,
              },
            ]),
        ).values(),
      ];
      const endpointWord = overview.impact.affectedEndpointCount === 1 ? 'endpoint' : 'endpoints';
      const workflowWord = overview.impact.affectedWorkflowCount === 1 ? 'workflow' : 'workflows';
      const impactMessage =
        overview.impact.affectedWorkflowCount === 0
          ? 'No Atlas workflows currently use this capability.'
          : `${overview.impact.affectedEndpointCount} ${endpointWord} in ${overview.impact.affectedWorkflowCount} ${workflowWord} will fail.`;
      const navigationTarget = `#/capabilities?view=map&environmentId=${encodeURIComponent(
        scope.environmentId,
      )}&focusType=runtime-mismatch&focusId=${encodeURIComponent(stored.id)}`;
      await pool.query(
        `INSERT INTO notifications
          (id, organization_id, environment_id, kind, condition_key, severity, title, message,
           navigation_target, subject_label, next_action, affected_workflows, details,
           occurrence_count, created_at, updated_at)
         VALUES ($1, $2, $3, 'runtime-contract-mismatch', $4, 'critical', $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14)
         ON CONFLICT (organization_id, environment_id, condition_key)
           WHERE condition_key IS NOT NULL
         DO UPDATE SET severity = 'critical', title = EXCLUDED.title, message = EXCLUDED.message,
           navigation_target = EXCLUDED.navigation_target,
           subject_label = EXCLUDED.subject_label, next_action = EXCLUDED.next_action,
           affected_workflows = EXCLUDED.affected_workflows, details = EXCLUDED.details,
           occurrence_count = EXCLUDED.occurrence_count, updated_at = EXCLUDED.updated_at,
           resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL`,
        [
          `runtime-mismatch-notification-${sha256(stored.condition_key)}`,
          scope.organizationId,
          scope.environmentId,
          stored.condition_key,
          `${stored.operation_id} request is broken`,
          `${stored.operation_id} now requires ${mismatch.fieldPath}. ${impactMessage}`,
          navigationTarget,
          stored.operation_id,
          'View the blast radius and update the request.',
          JSON.stringify(affectedWorkflows),
          JSON.stringify({
            runtimeMismatchId: stored.id,
            capabilityIdentityId: stored.capability_identity_id,
            capabilityVersionId: target.capabilityVersionId,
            pollingDefinitionRevision: target.revision,
            operation: stored.operation_id,
            reason: mismatch.reason,
            fieldPath: mismatch.fieldPath,
            status: mismatch.status,
            firstSeenAt: stored.first_seen_at.toISOString(),
            lastSeenAt: stored.last_seen_at.toISOString(),
            affectedEndpointCount: overview.impact.affectedEndpointCount,
            affectedWorkflowCount: overview.impact.affectedWorkflowCount,
          }),
          stored.occurrence_count,
          stored.first_seen_at,
          stored.last_seen_at,
        ],
      );
    },

    async recover(scope, mismatches, recoveredAt) {
      if (mismatches.length === 0) return;
      await pool.query(
        `UPDATE notifications
         SET resolved_at = COALESCE(resolved_at, $4), updated_at = $4,
             resolution_reason = COALESCE(
               resolution_reason,
               'Burger Town accepted the prepared request again.'
             )
         WHERE organization_id = $1 AND environment_id = $2
           AND kind = 'runtime-contract-mismatch'
           AND condition_key = ANY($3::text[])`,
        [
          scope.organizationId,
          scope.environmentId,
          mismatches.map((mismatch) => mismatch.conditionKey),
          recoveredAt,
        ],
      );
    },
  };
}
