import { versionedCompiledWorkflowVersionSchema } from '@atlas/workflow-ir';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { WorkflowSandboxTargetBinding } from './capability-sandbox-targets.js';
import {
  runWorkflowSandboxTests,
  type WorkflowSandboxExecutor,
  type WorkflowSandboxSetupBinding,
} from './workflow-sandbox.js';

type RetestTrigger = 'capability-rediscovery' | 'expiration';
type RetestStatus = 'queued' | 'running' | 'passed' | 'failed' | 'unavailable';

interface RetestCandidate {
  readonly organization_id: string;
  readonly environment_id: string;
  readonly workflow_version_id: string;
  readonly ir_hash: string;
}

interface ClaimedRetest extends RetestCandidate {
  readonly id: string;
  readonly compiled_workflow: unknown;
  readonly target_bindings: WorkflowSandboxTargetBinding[];
}

export const workflowSandboxRetestPolicySchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    maxAgeHours: z.number().int().positive(),
    enabled: z.boolean().default(true),
  })
  .strict();

async function staleAndQueue(
  pool: Pick<Pool, 'query'>,
  candidates: readonly RetestCandidate[],
  trigger: RetestTrigger,
  triggerDetail: Readonly<Record<string, unknown>>,
) {
  let queued = 0;
  for (const candidate of candidates) {
    await pool.query(
      `UPDATE workflow_sandbox_test_runs
       SET stale_at = COALESCE(stale_at, current_timestamp), stale_trigger = COALESCE(stale_trigger, $5)
       WHERE organization_id = $1 AND environment_id = $2
         AND workflow_version_id = $3 AND ir_hash = $4 AND stale_at IS NULL`,
      [
        candidate.organization_id,
        candidate.environment_id,
        candidate.workflow_version_id,
        candidate.ir_hash,
        JSON.stringify({ trigger, ...triggerDetail }),
      ],
    );
    const inserted = await pool.query(
      `INSERT INTO workflow_sandbox_retest_jobs
        (organization_id, environment_id, workflow_version_id, ir_hash, trigger, trigger_detail)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, environment_id, workflow_version_id, ir_hash)
         WHERE status IN ('queued', 'running') DO NOTHING
       RETURNING id`,
      [
        candidate.organization_id,
        candidate.environment_id,
        candidate.workflow_version_id,
        candidate.ir_hash,
        trigger,
        JSON.stringify(triggerDetail),
      ],
    );
    if (inserted.rows[0]) queued += 1;
  }
  return queued;
}

export async function queueCapabilityRediscoveryRetests(
  pool: Pick<Pool, 'query'>,
  input: {
    readonly organizationId: string;
    readonly discoveryId: string;
    readonly fromCapabilityVersionId: string;
    readonly toCapabilityVersionId: string;
  },
) {
  const candidates = await pool.query<RetestCandidate>(
    `SELECT DISTINCT approval.organization_id, approval.environment_id,
            approval.workflow_version_id, trim(approval.ir_hash) AS ir_hash
     FROM workflow_approvals approval
     JOIN workflow_capability_dependencies dependency
       ON dependency.organization_id = approval.organization_id
      AND dependency.workflow_version_id = approval.workflow_version_id
     JOIN environments environment
       ON environment.organization_id = approval.organization_id
      AND environment.id = approval.environment_id
     JOIN capability_versions pinned
       ON pinned.organization_id = dependency.organization_id
      AND pinned.capability_version_id = dependency.capability_version_id
     JOIN capability_versions published
       ON published.organization_id = pinned.organization_id
      AND published.capability_identity_id = pinned.capability_identity_id
     WHERE approval.organization_id = $1
       AND published.capability_version_id = $2
       AND environment.kind IN ('development', 'production')`,
    [input.organizationId, input.toCapabilityVersionId],
  );
  return staleAndQueue(pool, candidates.rows, 'capability-rediscovery', {
    discoveryId: input.discoveryId,
    fromCapabilityVersionId: input.fromCapabilityVersionId,
    toCapabilityVersionId: input.toCapabilityVersionId,
  });
}

export async function configureWorkflowSandboxRetestPolicy(
  pool: Pick<Pool, 'query'>,
  raw: unknown,
) {
  const input = workflowSandboxRetestPolicySchema.parse(raw);
  await pool.query(
    `INSERT INTO workflow_sandbox_retest_policies
      (organization_id, environment_id, max_age_hours, enabled, configured_at)
     VALUES ($1, $2, $3, $4, current_timestamp)
     ON CONFLICT (organization_id, environment_id) DO UPDATE
       SET max_age_hours = EXCLUDED.max_age_hours, enabled = EXCLUDED.enabled,
           configured_at = current_timestamp`,
    [input.organizationId, input.environmentId, input.maxAgeHours, input.enabled],
  );
  return input;
}

export async function queueExpiredWorkflowSandboxRetests(pool: Pick<Pool, 'query'>) {
  const candidates = await pool.query<RetestCandidate & { tested_at: Date; max_age_hours: number }>(
    `SELECT approval.organization_id, approval.environment_id, approval.workflow_version_id,
            trim(approval.ir_hash) AS ir_hash, latest.tested_at, policy.max_age_hours
     FROM workflow_approvals approval
     JOIN workflow_sandbox_retest_policies policy
       ON policy.organization_id = approval.organization_id
      AND policy.environment_id = approval.environment_id AND policy.enabled
     JOIN LATERAL (
       SELECT run.tested_at, run.status, run.stale_at
       FROM workflow_sandbox_test_runs run
       WHERE run.organization_id = approval.organization_id
         AND run.environment_id = approval.environment_id
         AND run.workflow_version_id = approval.workflow_version_id
         AND run.ir_hash = approval.ir_hash
       ORDER BY run.tested_at DESC, run.id DESC LIMIT 1
     ) latest ON true
     WHERE latest.stale_at IS NULL
       AND latest.tested_at <= current_timestamp - make_interval(hours => policy.max_age_hours)`,
  );
  let queued = 0;
  for (const candidate of candidates.rows) {
    queued += await staleAndQueue(pool, [candidate], 'expiration', {
      maxAgeHours: candidate.max_age_hours,
      expiredTestedAt: candidate.tested_at.toISOString(),
    });
  }
  return queued;
}

async function claimRetest(pool: Pool): Promise<ClaimedRetest | undefined> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<ClaimedRetest>(
      `WITH claimed AS (
         SELECT id FROM workflow_sandbox_retest_jobs
         WHERE status = 'queued' ORDER BY queued_at, id
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE workflow_sandbox_retest_jobs job
       SET status = 'running', started_at = current_timestamp
       FROM claimed, workflow_versions version
       WHERE job.id = claimed.id
         AND version.organization_id = job.organization_id
         AND version.workflow_version_id = job.workflow_version_id
       RETURNING job.id, job.organization_id, job.environment_id, job.workflow_version_id,
                 trim(job.ir_hash) AS ir_hash, version.compiled_workflow,
                 COALESCE((
                   SELECT run.target_bindings FROM workflow_sandbox_test_runs run
                   WHERE run.organization_id = job.organization_id
                     AND run.environment_id = job.environment_id
                     AND run.workflow_version_id = job.workflow_version_id
                     AND run.ir_hash = job.ir_hash
                   ORDER BY run.tested_at DESC, run.id DESC LIMIT 1
                 ), '[]'::jsonb) AS target_bindings`,
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function currentSelections(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  bindings: readonly WorkflowSandboxTargetBinding[],
) {
  return Promise.all(
    bindings.map(async (binding) => {
      const revisions = await pool.query<{ target_revision: number; test_data_version: number }>(
        `SELECT
           (SELECT max(revision) FROM capability_sandbox_target_revisions
            WHERE organization_id = $1 AND capability_version_id = $2 AND target_key = $3)
             AS target_revision,
           (SELECT max(version) FROM capability_test_data_profile_versions
            WHERE organization_id = $1 AND capability_version_id = $2 AND profile_key = $4)
             AS test_data_version`,
        [
          organizationId,
          binding.capabilityVersionId,
          binding.targetKey,
          binding.testDataProfileKey,
        ],
      );
      const latest = revisions.rows[0];
      return {
        capabilityVersionId: binding.capabilityVersionId,
        targetKey: binding.targetKey,
        targetRevision: latest?.target_revision ?? binding.targetRevision,
        testDataProfileKey: binding.testDataProfileKey,
        testDataVersion: latest?.test_data_version ?? binding.testDataVersion,
      };
    }),
  );
}

async function finishUnavailable(pool: Pick<Pool, 'query'>, id: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : 'The automatic test runner is unavailable';
  await pool.query(
    `UPDATE workflow_sandbox_retest_jobs
     SET status = 'unavailable', unavailable_reason = $2, completed_at = current_timestamp
     WHERE id = $1`,
    [id, message.slice(0, 1_000)],
  );
}

export async function processNextWorkflowSandboxRetest(
  pool: Pool,
  executor: WorkflowSandboxExecutor,
) {
  const job = await claimRetest(pool);
  if (!job) return undefined;
  try {
    const draft = versionedCompiledWorkflowVersionSchema.parse(job.compiled_workflow);
    if (draft.irHash !== job.ir_hash) throw new TypeError('Approved workflow artifact changed');
    const result = await runWorkflowSandboxTests(
      pool,
      executor,
      {
        organizationId: job.organization_id,
        environmentId: job.environment_id,
        draft,
        targetSelections: await currentSelections(pool, job.organization_id, job.target_bindings),
      },
      'atlas:auto-retest',
    );
    await pool.query(
      `UPDATE workflow_sandbox_retest_jobs
       SET status = $2, test_run_id = $3, setup_binding = $4, completed_at = current_timestamp
       WHERE id = $1`,
      [job.id, result.status, result.testRunId, JSON.stringify(result.setupBinding)],
    );
    return { jobId: job.id, status: result.status, testRunId: result.testRunId };
  } catch (error) {
    await finishUnavailable(pool, job.id, error);
    return { jobId: job.id, status: 'unavailable' as const };
  }
}

export async function readWorkflowSandboxTestHistory(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string; workflowVersionId: string },
) {
  const [result, automatic] = await Promise.all([
    pool.query<{
      id: string;
      status: 'passed' | 'failed';
      tested_by: string;
      tested_at: Date;
      setup_binding: WorkflowSandboxSetupBinding | null;
      trigger: RetestTrigger | null;
      trigger_detail: Record<string, unknown> | null;
      queued_at: Date | null;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT run.id, run.status, run.tested_by, run.tested_at, run.setup_binding,
            job.trigger, job.trigger_detail, job.queued_at, job.started_at, job.completed_at
     FROM workflow_sandbox_test_runs run
     LEFT JOIN workflow_sandbox_retest_jobs job ON job.test_run_id = run.id
     WHERE run.organization_id = $1 AND run.environment_id = $2 AND run.workflow_version_id = $3
     ORDER BY run.tested_at DESC, run.id DESC`,
      [scope.organizationId, scope.environmentId, scope.workflowVersionId],
    ),
    pool.query<{
      id: string;
      status: RetestStatus;
      trigger: RetestTrigger;
      trigger_detail: Record<string, unknown>;
      test_run_id: string | null;
      setup_binding: WorkflowSandboxSetupBinding | null;
      unavailable_reason: string | null;
      queued_at: Date;
      started_at: Date | null;
      completed_at: Date | null;
    }>(
      `SELECT id, status, trigger, trigger_detail, test_run_id, setup_binding,
              unavailable_reason, queued_at, started_at, completed_at
       FROM workflow_sandbox_retest_jobs
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3
       ORDER BY queued_at DESC, id DESC`,
      [scope.organizationId, scope.environmentId, scope.workflowVersionId],
    ),
  ]);
  return {
    results: result.rows.map((row) => ({
      testRunId: row.id,
      status: row.status,
      testedBy: row.tested_by,
      testedAt: row.tested_at.toISOString(),
      trigger: row.trigger ?? 'manual',
      triggerDetail: row.trigger_detail ?? {},
      queuedAt: row.queued_at?.toISOString() ?? null,
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? row.tested_at.toISOString(),
      executionMethods: row.setup_binding?.executionMethods ?? [],
      setupBinding: row.setup_binding,
    })),
    automaticRuns: automatic.rows.map((row) => ({
      jobId: row.id,
      status: row.status,
      trigger: row.trigger,
      triggerDetail: row.trigger_detail,
      testRunId: row.test_run_id,
      setupBinding: row.setup_binding,
      executionMethods: row.setup_binding?.executionMethods ?? [],
      unavailableReason: row.unavailable_reason,
      queuedAt: row.queued_at.toISOString(),
      startedAt: row.started_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
    })),
  };
}

export async function readLatestWorkflowSandboxRetest(
  pool: Pick<Pool, 'query'>,
  scope: RetestCandidate,
) {
  const result = await pool.query<{
    id: string;
    status: RetestStatus;
    trigger: RetestTrigger;
    trigger_detail: Record<string, unknown>;
    unavailable_reason: string | null;
    queued_at: Date;
    started_at: Date | null;
    completed_at: Date | null;
  }>(
    `SELECT id, status, trigger, trigger_detail, unavailable_reason,
            queued_at, started_at, completed_at
     FROM workflow_sandbox_retest_jobs
     WHERE organization_id = $1 AND environment_id = $2
       AND workflow_version_id = $3 AND ir_hash = $4
     ORDER BY queued_at DESC, id DESC LIMIT 1`,
    [scope.organization_id, scope.environment_id, scope.workflow_version_id, scope.ir_hash],
  );
  return result.rows[0];
}

export function startAutomaticWorkflowSandboxRetests(
  pool: Pool,
  executor: WorkflowSandboxExecutor,
  options: { pollMs?: number; expirationPollMs?: number } = {},
) {
  let processing = false;
  const process = setInterval(() => {
    if (processing) return;
    processing = true;
    void processNextWorkflowSandboxRetest(pool, executor)
      .catch((error: unknown) => console.error('Automatic workflow retest failed', error))
      .finally(() => {
        processing = false;
      });
  }, options.pollMs ?? 1_000);
  const expiration = setInterval(() => {
    void queueExpiredWorkflowSandboxRetests(pool).catch((error: unknown) =>
      console.error('Workflow retest expiration scan failed', error),
    );
  }, options.expirationPollMs ?? 3_600_000);
  process.unref();
  expiration.unref();
  return () => {
    clearInterval(process);
    clearInterval(expiration);
  };
}
