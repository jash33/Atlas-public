import type { Pool } from 'pg';
import { z } from 'zod';

export const runLifecycleStartedEventSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    event: z.literal('started'),
    workflowName: z.string(),
    occurredAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const runLifecycleEndedEventSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    event: z.literal('ended'),
    workflowName: z.string(),
    occurredAt: z.iso.datetime({ offset: true }),
    durationMs: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    outcome: z.enum(['succeeded', 'failed']),
  })
  .strict();

export const runLifecycleEventSchema = z.discriminatedUnion('event', [
  runLifecycleStartedEventSchema,
  runLifecycleEndedEventSchema,
]);

export type RunLifecycleStartedEvent = z.infer<typeof runLifecycleStartedEventSchema>;
export type RunLifecycleEndedEvent = z.infer<typeof runLifecycleEndedEventSchema>;
export type RunLifecycleEvent = z.infer<typeof runLifecycleEventSchema>;

export type RunLifecycleSummary = {
  readonly workflowName: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly retryCount: number | null;
  readonly outcome: 'succeeded' | 'failed' | null;
  readonly inProgress: boolean;
};

type LifecycleRow = {
  readonly workflow_name: string;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly duration_ms: number | null;
  readonly retry_count: number | null;
  readonly outcome: 'succeeded' | 'failed' | null;
};

async function resolveWorkflowNameFallback(
  pool: Pick<Pool, 'query'>,
  input: {
    readonly organizationId: string;
    readonly environmentId: string;
    readonly runId: string;
  },
): Promise<string> {
  const result = await pool.query<{ name: string }>(
    `SELECT identity.name
     FROM workflow_runs run
     JOIN workflow_versions version
       ON version.organization_id = run.organization_id
      AND version.workflow_version_id = run.workflow_version_id
     JOIN workflow_identities identity
       ON identity.organization_id = version.organization_id
      AND identity.workflow_id = version.workflow_id
     WHERE run.organization_id = $1
       AND run.environment_id = $2
       AND run.run_id = $3`,
    [input.organizationId, input.environmentId, input.runId],
  );
  return result.rows[0]?.name ?? '';
}

async function resolveWorkflowName(
  pool: Pick<Pool, 'query'>,
  runId: string,
  input: {
    readonly organizationId: string;
    readonly environmentId: string;
    readonly workflowName: string;
  },
): Promise<string> {
  const providedName = input.workflowName.trim();
  if (providedName.length > 0) return providedName;
  return resolveWorkflowNameFallback(pool, {
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    runId,
  });
}

async function readLifecycleRow(
  pool: Pick<Pool, 'query'>,
  input: {
    readonly organizationId: string;
    readonly environmentId: string;
    readonly runId: string;
  },
): Promise<LifecycleRow> {
  const stored = await pool.query<LifecycleRow>(
    `SELECT workflow_name, started_at, ended_at, duration_ms, retry_count, outcome
     FROM workflow_run_lifecycles
     WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3`,
    [input.organizationId, input.environmentId, input.runId],
  );
  return stored.rows[0]!;
}

export async function recordRunLifecycleStarted(
  pool: Pick<Pool, 'query'>,
  runId: string,
  input: RunLifecycleStartedEvent,
): Promise<RunLifecycleSummary> {
  const workflowName = await resolveWorkflowName(pool, runId, input);

  await pool.query(
    `INSERT INTO workflow_run_lifecycles
      (organization_id, environment_id, run_id, workflow_name, started_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz)
     ON CONFLICT (organization_id, environment_id, run_id) DO NOTHING`,
    [input.organizationId, input.environmentId, runId, workflowName, input.occurredAt],
  );

  return presentRunLifecycle(
    await readLifecycleRow(pool, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      runId,
    }),
  );
}

export async function recordRunLifecycleEnded(
  pool: Pick<Pool, 'query'>,
  runId: string,
  input: RunLifecycleEndedEvent,
): Promise<RunLifecycleSummary> {
  const workflowName = await resolveWorkflowName(pool, runId, input);
  const startedAt = new Date(Date.parse(input.occurredAt) - input.durationMs).toISOString();

  // Prefer completing an in-progress row; if started was lost, insert a complete summary.
  const updated = await pool.query(
    `UPDATE workflow_run_lifecycles
     SET ended_at = $4::timestamptz,
         duration_ms = $5,
         retry_count = $6,
         outcome = $7
     WHERE organization_id = $1
       AND environment_id = $2
       AND run_id = $3
       AND ended_at IS NULL`,
    [
      input.organizationId,
      input.environmentId,
      runId,
      input.occurredAt,
      input.durationMs,
      input.retryCount,
      input.outcome,
    ],
  );

  if (updated.rowCount === 0) {
    await pool.query(
      `INSERT INTO workflow_run_lifecycles
        (organization_id, environment_id, run_id, workflow_name, started_at,
         ended_at, duration_ms, retry_count, outcome)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9)
       ON CONFLICT (organization_id, environment_id, run_id) DO NOTHING`,
      [
        input.organizationId,
        input.environmentId,
        runId,
        workflowName,
        startedAt,
        input.occurredAt,
        input.durationMs,
        input.retryCount,
        input.outcome,
      ],
    );
  }

  return presentRunLifecycle(
    await readLifecycleRow(pool, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      runId,
    }),
  );
}

export function presentRunLifecycle(row: LifecycleRow): RunLifecycleSummary {
  return {
    workflowName: row.workflow_name,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
    retryCount: row.retry_count,
    outcome: row.outcome,
    inProgress: row.ended_at === null,
  };
}
