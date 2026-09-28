import type { Pool } from 'pg';
import { z } from 'zod';

export const auditHistoryQuerySchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1).optional(),
  })
  .strict();

export const auditEventTypeSchema = z.enum([
  'discovery',
  'classification',
  'reverse-lookup',
  'generation',
  'validation',
  'approval',
  'activation',
  'rollback',
  'abandonment',
  'organization-settings',
  'secret-reference',
  'membership',
  'capability-safety-approval',
  'capability-host-policy',
  'repair',
  'capability-source-authority',
  'capability-loss-override',
  'notification-resolution',
]);

interface AuditEntryRow {
  readonly id: string;
  readonly environment_id: string | null;
  readonly event_type: z.infer<typeof auditEventTypeSchema>;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly subject_name: string | null;
  readonly actor_id: string | null;
  readonly actor_name: string | null;
  readonly details: Record<string, unknown>;
  readonly recorded_at: Date;
}

export async function readAuditHistory(pool: Pool, query: z.infer<typeof auditHistoryQuerySchema>) {
  const identityTable = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.users') IS NOT NULL AS exists`,
  );
  const identityColumns = identityTable.rows[0]?.exists
    ? ', actor.name AS actor_name, subject.name AS subject_name'
    : ', NULL::text AS actor_name, NULL::text AS subject_name';
  const identityJoins = identityTable.rows[0]?.exists
    ? `LEFT JOIN users actor ON actor.id = audit.actor_id
       LEFT JOIN users subject ON audit.subject_type = 'membership'
         AND subject.id = audit.subject_id`
    : '';
  const result = await pool.query<AuditEntryRow>(
    `SELECT audit.id, audit.environment_id, audit.event_type, audit.subject_type,
            audit.subject_id, audit.actor_id, audit.details, audit.recorded_at
            ${identityColumns}
     FROM audit_entries audit
     ${identityJoins}
     WHERE audit.organization_id = $1
       AND ($2::text IS NULL OR audit.environment_id = $2 OR audit.environment_id IS NULL)
     ORDER BY audit.recorded_at DESC, audit.id DESC`,
    [query.organizationId, query.environmentId ?? null],
  );
  return {
    entries: result.rows.map((entry) => ({
      id: entry.id,
      eventType: auditEventTypeSchema.parse(entry.event_type),
      subjectType: entry.subject_type,
      subjectId: entry.subject_id,
      subjectName: entry.subject_name,
      actorId: entry.actor_id,
      actorName: entry.actor_name,
      environmentId: entry.environment_id,
      details: entry.details,
      recordedAt: entry.recorded_at.toISOString(),
    })),
  };
}
