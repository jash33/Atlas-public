import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { z } from 'zod';

import { readRunIntakeReadiness } from './run-commands.js';

export const workflowScheduleCreateSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    intervalSeconds: z.number().int().min(60).max(31_536_000),
    startsAt: z.iso.datetime({ offset: true }),
    encryptedPayload: z.string().regex(/^rsa-oaep:[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();

export const workflowScheduleUpdateSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    enabled: z.boolean().optional(),
    encryptedPayload: z
      .string()
      .regex(/^rsa-oaep:[A-Za-z0-9+/]+={0,2}$/)
      .optional(),
  })
  .strict()
  .refine((request) => request.enabled !== undefined || request.encryptedPayload !== undefined, {
    message: 'At least one schedule setting must be supplied',
  });

export const workflowSchedulesQuerySchema = z.object({
  organizationId: z.string().min(1),
  environmentId: z.string().min(1),
});

export class WorkflowScheduleNotFound extends Error {}

interface ScheduleRow {
  schedule_id: string;
  name: string;
  interval_seconds: number;
  enabled: boolean;
  next_run_at: Date;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  occurrence_scheduled_for: Date | null;
  occurrence_status: 'queued' | 'unavailable' | null;
  occurrence_command_id: string | null;
  occurrence_error: string | null;
}

export async function createWorkflowSchedule(
  pool: Pool,
  input: z.infer<typeof workflowScheduleCreateSchema>,
  actorId: string,
) {
  const scheduleId = randomUUID();
  await pool.query(
    `INSERT INTO workflow_schedules
      (schedule_id, organization_id, environment_id, name, interval_seconds, encrypted_payload,
       next_run_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      scheduleId,
      input.organizationId,
      input.environmentId,
      input.name,
      input.intervalSeconds,
      input.encryptedPayload,
      input.startsAt,
      actorId,
    ],
  );
  return readWorkflowSchedule(pool, scheduleId, input);
}

export async function readWorkflowSchedules(
  pool: Pool,
  scope: z.infer<typeof workflowSchedulesQuerySchema>,
) {
  const result = await pool.query<ScheduleRow>(
    `${scheduleSelect()}
     WHERE schedule.organization_id = $1 AND schedule.environment_id = $2
     ORDER BY schedule.created_at, schedule.schedule_id`,
    [scope.organizationId, scope.environmentId],
  );
  return { schedules: result.rows.map(serializeSchedule) };
}

export async function updateWorkflowSchedule(
  pool: Pool,
  scheduleId: string,
  input: z.infer<typeof workflowScheduleUpdateSchema>,
) {
  const result = await pool.query(
    `UPDATE workflow_schedules
     SET enabled = COALESCE($4, enabled), encrypted_payload = COALESCE($5, encrypted_payload),
         updated_at = current_timestamp
     WHERE schedule_id = $1 AND organization_id = $2 AND environment_id = $3`,
    [
      scheduleId,
      input.organizationId,
      input.environmentId,
      input.enabled ?? null,
      input.encryptedPayload ?? null,
    ],
  );
  if ((result.rowCount ?? 0) === 0) throw new WorkflowScheduleNotFound();
  return readWorkflowSchedule(pool, scheduleId, input);
}

async function readWorkflowSchedule(
  pool: Pool,
  scheduleId: string,
  scope: { organizationId: string; environmentId: string },
) {
  const result = await pool.query<ScheduleRow>(
    `${scheduleSelect()}
     WHERE schedule.schedule_id = $1 AND schedule.organization_id = $2
       AND schedule.environment_id = $3`,
    [scheduleId, scope.organizationId, scope.environmentId],
  );
  const row = result.rows[0];
  if (!row) throw new WorkflowScheduleNotFound();
  return serializeSchedule(row);
}

function scheduleSelect() {
  return `SELECT schedule.schedule_id, schedule.name, schedule.interval_seconds, schedule.enabled,
                 schedule.next_run_at, schedule.created_by, schedule.created_at,
                 schedule.updated_at, occurrence.scheduled_for AS occurrence_scheduled_for,
                 occurrence.status AS occurrence_status, occurrence.command_id AS occurrence_command_id,
                 occurrence.error AS occurrence_error
          FROM workflow_schedules schedule
          LEFT JOIN LATERAL (
            SELECT scheduled_for, status, command_id, error
            FROM workflow_schedule_occurrences
            WHERE schedule_id = schedule.schedule_id
            ORDER BY scheduled_for DESC
            LIMIT 1
          ) occurrence ON true`;
}

function serializeSchedule(row: ScheduleRow) {
  return {
    scheduleId: row.schedule_id,
    name: row.name,
    intervalSeconds: row.interval_seconds,
    enabled: row.enabled,
    nextRunAt: row.next_run_at.toISOString(),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastOccurrence:
      row.occurrence_scheduled_for && row.occurrence_status
        ? {
            scheduledFor: row.occurrence_scheduled_for.toISOString(),
            status: row.occurrence_status,
            commandId: row.occurrence_command_id,
            error: row.occurrence_error,
          }
        : null,
  };
}

interface DueScheduleRow {
  schedule_id: string;
  organization_id: string;
  environment_id: string;
  interval_seconds: number;
  encrypted_payload: string;
  next_run_at: Date;
}

export async function dispatchDueWorkflowSchedules(
  pool: Pool,
  now = new Date(),
  options: { limit?: number } = {},
) {
  let dispatched = 0;
  let unavailable = 0;
  const limit = options.limit ?? 100;
  for (let index = 0; index < limit; index += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const due = await client.query<DueScheduleRow>(
        `SELECT schedule_id, organization_id, environment_id, interval_seconds,
                encrypted_payload, next_run_at
         FROM workflow_schedules
         WHERE enabled = true AND next_run_at <= $1
         ORDER BY next_run_at, schedule_id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [now],
      );
      const schedule = due.rows[0];
      if (!schedule) {
        await client.query('COMMIT');
        break;
      }

      const readiness = await readRunIntakeReadiness(client, {
        organizationId: schedule.organization_id,
        environmentId: schedule.environment_id,
      });
      const scheduledFor = schedule.next_run_at;
      if (
        readiness.ready &&
        readiness.targetWorkerId &&
        readiness.artifactId &&
        readiness.runCommandPublicKey
      ) {
        const commandId = randomUUID();
        await client.query(
          `INSERT INTO workflow_run_commands
            (command_id, organization_id, environment_id, target_worker_id, artifact_id,
             encrypted_payload, trigger_type, trigger_schedule_id, trigger_scheduled_for)
           VALUES ($1, $2, $3, $4, $5, $6, 'schedule', $7, $8)`,
          [
            commandId,
            schedule.organization_id,
            schedule.environment_id,
            readiness.targetWorkerId,
            readiness.artifactId,
            schedule.encrypted_payload,
            schedule.schedule_id,
            scheduledFor,
          ],
        );
        await client.query(
          `INSERT INTO workflow_schedule_occurrences
            (schedule_id, scheduled_for, status, command_id)
           VALUES ($1, $2, 'queued', $3)`,
          [schedule.schedule_id, scheduledFor, commandId],
        );
        dispatched += 1;
      } else {
        await client.query(
          `INSERT INTO workflow_schedule_occurrences
            (schedule_id, scheduled_for, status, error)
           VALUES ($1, $2, 'unavailable', $3)`,
          [schedule.schedule_id, scheduledFor, readiness.blockers.join(' ')],
        );
        unavailable += 1;
      }
      await client.query(
        `UPDATE workflow_schedules
         SET next_run_at = $2::timestamptz + interval '1 second' * interval_seconds,
             updated_at = current_timestamp
         WHERE schedule_id = $1`,
        [schedule.schedule_id, scheduledFor],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { dispatched, unavailable };
}

export function startWorkflowScheduleDispatcher(
  pool: Pool,
  options: { pollMs?: number; now?: () => Date } = {},
) {
  let running = false;
  const poll = setInterval(() => {
    if (running) return;
    running = true;
    void dispatchDueWorkflowSchedules(pool, options.now?.() ?? new Date())
      .catch((error: unknown) => console.error('Workflow schedule dispatch failed', error))
      .finally(() => {
        running = false;
      });
  }, options.pollMs ?? 1_000);
  poll.unref();
  return () => clearInterval(poll);
}
