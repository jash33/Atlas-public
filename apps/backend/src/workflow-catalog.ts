import {
  objectSchemaSchema,
  versionedCompiledWorkflowVersionSchema,
  type ObjectSchema,
} from '@atlas/workflow-ir';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { readWorkflowInvocationExample } from './workflow-invocation-example.js';

export const workflowCatalogQuerySchema = z
  .object({
    organizationId: z.string().trim().min(1),
    environmentId: z.string().trim().min(1),
  })
  .strict();

export const workflowLifecycleStatusSchema = z.enum([
  'draft',
  'testing',
  'awaiting-approval',
  'approved-inactive',
  'active',
  'blocked',
  'action-required',
]);

export const saveWorkflowCatalogVersionSchema = z
  .object({
    organizationId: z.string().trim().min(1),
    environmentId: z.string().trim().min(1),
    workflowId: z.string().trim().min(1),
    name: z.string().trim().min(1),
    status: workflowLifecycleStatusSchema,
    draft: z.unknown(),
  })
  .strict();

export class WorkflowCatalogVersionConflict extends Error {}
export class WorkflowCatalogWorkflowNotFound extends Error {}

export type WorkflowNameResolution =
  | { status: 'resolved'; workflowId: string; name: string }
  | { status: 'none' }
  | { status: 'ambiguous'; workflowIds: readonly string[]; name: string };

export async function resolveWorkflowIdentityByName(
  pool: Pick<Pool, 'query'>,
  input: { readonly organizationId: string; readonly name: string },
): Promise<WorkflowNameResolution> {
  const result = await pool.query<{ workflow_id: string; name: string }>(
    `SELECT workflow_id, name
     FROM workflow_identities
     WHERE organization_id = $1 AND name = $2
     ORDER BY workflow_id`,
    [input.organizationId, input.name],
  );
  if (result.rows.length === 0) return { status: 'none' };
  if (result.rows.length === 1) {
    const row = result.rows[0]!;
    return { status: 'resolved', workflowId: row.workflow_id, name: row.name };
  }
  return {
    status: 'ambiguous',
    workflowIds: result.rows.map((row) => row.workflow_id),
    name: input.name,
  };
}

type CatalogQueryClient = Pick<PoolClient, 'query'>;

export async function recordWorkflowLifecycle(
  client: CatalogQueryClient,
  input: {
    organizationId: string;
    environmentId: string;
    workflowVersionId: string;
    status: z.infer<typeof workflowLifecycleStatusSchema>;
    isActive?: boolean;
    observedAt?: string | Date;
  },
) {
  await client.query(
    `INSERT INTO workflow_environment_versions
      (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active,
       updated_at)
     SELECT $1, $2, version.workflow_version_id, $4, COALESCE($6, false),
            COALESCE($5, current_timestamp)
     FROM workflow_versions version
     WHERE version.organization_id = $1 AND version.workflow_version_id = $3
     ON CONFLICT (organization_id, environment_id, workflow_version_id) DO UPDATE
       SET lifecycle_status = CASE
             WHEN workflow_environment_versions.lifecycle_status = 'action-required'
             THEN 'action-required'
             ELSE EXCLUDED.lifecycle_status
           END,
           is_active = COALESCE($6, workflow_environment_versions.is_active),
           updated_at = EXCLUDED.updated_at`,
    [
      input.organizationId,
      input.environmentId,
      input.workflowVersionId,
      input.status,
      input.observedAt ?? null,
      input.isActive ?? null,
    ],
  );
}

export async function demoteActiveWorkflowVersions(
  client: CatalogQueryClient,
  input: { organizationId: string; environmentId: string; replacingWorkflowVersionId: string },
) {
  await client.query(
    `UPDATE workflow_environment_versions scoped
     SET lifecycle_status = 'approved-inactive', is_active = false,
         updated_at = current_timestamp
     FROM workflow_versions replacement
     JOIN workflow_versions previous
       ON previous.organization_id = replacement.organization_id
      AND previous.workflow_id = replacement.workflow_id
     WHERE replacement.organization_id = $1
       AND replacement.workflow_version_id = $3
       AND scoped.organization_id = previous.organization_id
       AND scoped.environment_id = $2
       AND scoped.workflow_version_id = previous.workflow_version_id
       AND scoped.is_active`,
    [input.organizationId, input.environmentId, input.replacingWorkflowVersionId],
  );
}

export async function saveWorkflowCatalogVersion(
  pool: Pool,
  input: z.infer<typeof saveWorkflowCatalogVersionSchema>,
  expectedEditorRevision?: number,
) {
  const workflow = versionedCompiledWorkflowVersionSchema.parse(input.draft);
  if (workflow.executionRequirements.organizationId !== input.organizationId) {
    throw new WorkflowCatalogVersionConflict('Workflow organization does not match Catalog scope');
  }
  const client = await pool.connect();
  let savedStatus = input.status;
  try {
    await client.query('BEGIN');
    if (expectedEditorRevision !== undefined) {
      const workingDraft = await client.query<{ revision: number }>(
        `SELECT revision FROM workflow_editor_drafts
         WHERE organization_id = $1 AND environment_id = $2 AND workflow_id = $3 FOR UPDATE`,
        [input.organizationId, input.environmentId, input.workflowId],
      );
      if (workingDraft.rows[0]?.revision !== expectedEditorRevision) {
        throw new WorkflowCatalogVersionConflict(
          'This draft changed. Reload before creating a version.',
        );
      }
    }
    await persistIdentity(client, input);
    const version = await client.query(
      `INSERT INTO workflow_versions
        (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, workflow_version_id) DO UPDATE
         SET workflow_id = EXCLUDED.workflow_id,
             ir_hash = COALESCE(workflow_versions.ir_hash, EXCLUDED.ir_hash),
             compiled_workflow = COALESCE(workflow_versions.compiled_workflow, EXCLUDED.compiled_workflow)
         WHERE workflow_versions.workflow_id = EXCLUDED.workflow_id
           AND (workflow_versions.ir_hash IS NULL OR workflow_versions.ir_hash = EXCLUDED.ir_hash)
       RETURNING workflow_version_id`,
      [
        input.organizationId,
        workflow.workflowVersionId,
        input.workflowId,
        workflow.irHash,
        workflow,
      ],
    );
    if (!version.rows[0]) {
      throw new WorkflowCatalogVersionConflict(
        'Workflow version is already bound to another identity or immutable artifact',
      );
    }
    if (input.status === 'draft' || expectedEditorRevision !== undefined) {
      // Saving an immutable artifact again must not undo approval, activation, or checks.
      await client.query(
        `INSERT INTO workflow_environment_versions
          (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, environment_id, workflow_version_id) DO NOTHING`,
        [
          input.organizationId,
          input.environmentId,
          workflow.workflowVersionId,
          input.status,
          input.status === 'active',
        ],
      );
    } else {
      await recordWorkflowLifecycle(client, {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workflowVersionId: workflow.workflowVersionId,
        status: input.status,
        isActive: input.status === 'active',
      });
    }
    const persisted = await client.query<{
      lifecycle_status: z.infer<typeof workflowLifecycleStatusSchema>;
    }>(
      `SELECT lifecycle_status FROM workflow_environment_versions
       WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3`,
      [input.organizationId, input.environmentId, workflow.workflowVersionId],
    );
    savedStatus = persisted.rows[0]!.lifecycle_status;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return {
    workflowId: input.workflowId,
    name: input.name,
    workflowVersionId: workflow.workflowVersionId,
    status: savedStatus,
  };
}

async function persistIdentity(
  client: PoolClient,
  input: z.infer<typeof saveWorkflowCatalogVersionSchema>,
) {
  const identity = await client.query(
    `INSERT INTO workflow_identities (organization_id, workflow_id, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, workflow_id) DO UPDATE
       SET name = EXCLUDED.name, updated_at = current_timestamp
     RETURNING workflow_id`,
    [input.organizationId, input.workflowId, input.name],
  );
  if (!identity.rows[0])
    throw new WorkflowCatalogVersionConflict('Workflow identity was not saved');
}

interface CatalogRow {
  workflow_id: string;
  name: string;
  active_workflow_version_id: string | null;
  latest_workflow_version_id: string;
  latest_lifecycle_status: z.infer<typeof workflowLifecycleStatusSchema>;
  run_id: string | null;
  run_workflow_version_id: string | null;
  run_state: string | null;
  run_started_at: Date | null;
  updated_at: Date;
}

export async function readWorkflowCatalog(
  pool: Pick<Pool, 'query'>,
  query: z.infer<typeof workflowCatalogQuerySchema>,
) {
  const result = await pool.query<CatalogRow>(
    `SELECT identity.workflow_id, identity.name,
            active.workflow_version_id AS active_workflow_version_id,
            latest.workflow_version_id AS latest_workflow_version_id,
            latest.lifecycle_status AS latest_lifecycle_status,
            recent_run.run_id, recent_run.workflow_version_id AS run_workflow_version_id,
            recent_run.state AS run_state, recent_run.started_at AS run_started_at,
            GREATEST(identity.updated_at, latest.updated_at,
                     COALESCE(active.updated_at, '-infinity'::timestamptz),
                     COALESCE(recent_run.updated_at, '-infinity'::timestamptz)) AS updated_at
     FROM workflow_identities identity
     JOIN LATERAL (
       SELECT version.workflow_version_id, scoped.lifecycle_status, scoped.updated_at
       FROM workflow_versions version
       JOIN workflow_environment_versions scoped
         ON scoped.organization_id = version.organization_id
        AND scoped.workflow_version_id = version.workflow_version_id
       WHERE version.organization_id = identity.organization_id
         AND version.workflow_id = identity.workflow_id
         AND scoped.environment_id = $2
       ORDER BY version.created_at DESC, version.workflow_version_id DESC
       LIMIT 1
     ) latest ON true
     LEFT JOIN LATERAL (
       SELECT version.workflow_version_id, scoped.updated_at
       FROM workflow_versions version
       JOIN workflow_environment_versions scoped
         ON scoped.organization_id = version.organization_id
        AND scoped.workflow_version_id = version.workflow_version_id
       WHERE version.organization_id = identity.organization_id
         AND version.workflow_id = identity.workflow_id
         AND scoped.environment_id = $2
         AND scoped.is_active
       ORDER BY scoped.updated_at DESC
       LIMIT 1
     ) active ON true
     LEFT JOIN LATERAL (
       SELECT run.run_id, run.workflow_version_id, run.state, run.started_at, run.updated_at
       FROM workflow_runs run
       JOIN workflow_versions version
         ON version.organization_id = run.organization_id
        AND version.workflow_version_id = run.workflow_version_id
       WHERE run.organization_id = identity.organization_id
         AND run.environment_id = $2
         AND version.workflow_id = identity.workflow_id
       ORDER BY run.started_at DESC, run.run_id DESC
       LIMIT 1
     ) recent_run ON true
     WHERE identity.organization_id = $1
     ORDER BY updated_at DESC, identity.workflow_id`,
    [query.organizationId, query.environmentId],
  );

  return {
    workflows: result.rows.map((row) => ({
      workflowId: row.workflow_id,
      name: row.name,
      activeVersion: row.active_workflow_version_id
        ? { workflowVersionId: row.active_workflow_version_id }
        : null,
      latestVersion: {
        workflowVersionId: row.latest_workflow_version_id,
        status: row.latest_lifecycle_status,
      },
      mostRecentRun:
        row.run_id && row.run_workflow_version_id && row.run_state && row.run_started_at
          ? {
              runId: row.run_id,
              workflowVersionId: row.run_workflow_version_id,
              state: row.run_state,
              startedAt: row.run_started_at.toISOString(),
            }
          : null,
      updatedAt: row.updated_at.toISOString(),
    })),
  };
}

interface WorkflowDetailVersionRow {
  workflow_id: string;
  name: string;
  identity_updated_at: Date;
  workflow_version_id: string;
  lifecycle_status: z.infer<typeof workflowLifecycleStatusSchema>;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  compiled_input_schema: unknown;
  artifact_input_schema: unknown;
}

interface WorkflowDetailRunRow {
  run_id: string;
  workflow_version_id: string;
  state: string;
  trigger_type: 'manual' | 'webhook' | 'schedule' | 'api';
  trigger_delivery_id: string | null;
  trigger_schedule_id: string | null;
  trigger_scheduled_for: Date | null;
  started_at: Date;
  updated_at: Date;
  lifecycle_duration_ms: number | null;
  lifecycle_outcome: 'succeeded' | 'failed' | null;
}

export async function readWorkflowCatalogDetail(
  pool: Pick<Pool, 'query'>,
  query: z.infer<typeof workflowCatalogQuerySchema> & { workflowId: string },
) {
  const versionsResult = await pool.query<WorkflowDetailVersionRow>(
    `SELECT identity.workflow_id, identity.name, identity.updated_at AS identity_updated_at,
            version.workflow_version_id, scoped.lifecycle_status, scoped.is_active,
            version.created_at, scoped.updated_at, approval.approved_by, approval.approved_at,
            version.compiled_workflow->'executable'->'inputSchema' AS compiled_input_schema,
            approval.artifact_manifest->'workflow'->'executable'->'inputSchema'
              AS artifact_input_schema
     FROM workflow_identities identity
     JOIN workflow_versions version
       ON version.organization_id = identity.organization_id
      AND version.workflow_id = identity.workflow_id
     JOIN workflow_environment_versions scoped
       ON scoped.organization_id = version.organization_id
      AND scoped.workflow_version_id = version.workflow_version_id
      AND scoped.environment_id = $3
     LEFT JOIN workflow_approvals approval
       ON approval.organization_id = version.organization_id
      AND approval.environment_id = scoped.environment_id
      AND approval.workflow_version_id = version.workflow_version_id
     WHERE identity.organization_id = $1 AND identity.workflow_id = $2
     ORDER BY version.created_at DESC, version.workflow_version_id DESC`,
    [query.organizationId, query.workflowId, query.environmentId],
  );
  const latestVersionRow = versionsResult.rows[0];
  if (!latestVersionRow) {
    throw new WorkflowCatalogWorkflowNotFound('Workflow is unavailable in the selected scope');
  }

  const runsResult = await pool.query<WorkflowDetailRunRow>(
    `SELECT run.run_id, run.workflow_version_id, run.state, run.trigger_type,
            run.trigger_delivery_id, run.trigger_schedule_id, run.trigger_scheduled_for,
            run.started_at, run.updated_at,
            lifecycle.duration_ms AS lifecycle_duration_ms,
            lifecycle.outcome AS lifecycle_outcome
     FROM workflow_runs run
     JOIN workflow_versions version
       ON version.organization_id = run.organization_id
      AND version.workflow_version_id = run.workflow_version_id
     LEFT JOIN workflow_run_lifecycles lifecycle
       ON lifecycle.organization_id = run.organization_id
      AND lifecycle.environment_id = run.environment_id
      AND lifecycle.run_id = run.run_id
     WHERE run.organization_id = $1 AND run.environment_id = $3
       AND version.workflow_id = $2
     ORDER BY run.started_at DESC, run.run_id DESC
     LIMIT 10`,
    [query.organizationId, query.workflowId, query.environmentId],
  );

  const active = versionsResult.rows.find((version) => version.is_active);
  const updatedAt = [
    latestVersionRow.identity_updated_at,
    ...versionsResult.rows.map((version) => version.updated_at),
    ...runsResult.rows.map((run) => run.updated_at),
  ].reduce((latestDate, candidate) => (candidate > latestDate ? candidate : latestDate));

  return {
    workflowId: latestVersionRow.workflow_id,
    name: latestVersionRow.name,
    activeVersion: active ? { workflowVersionId: active.workflow_version_id } : null,
    invocationExample: active
      ? await readWorkflowInvocationExample(pool, {
          ...query,
          workflowVersionId: active.workflow_version_id,
        })
      : null,
    inputSchema: active
      ? readCatalogInputSchema(active.artifact_input_schema, active.compiled_input_schema)
      : null,
    latestVersion: {
      workflowVersionId: latestVersionRow.workflow_version_id,
      status: latestVersionRow.lifecycle_status,
    },
    updatedAt: updatedAt.toISOString(),
    versions: versionsResult.rows.map((version) => ({
      workflowVersionId: version.workflow_version_id,
      status: version.lifecycle_status,
      isActive: version.is_active,
      createdAt: version.created_at.toISOString(),
      updatedAt: version.updated_at.toISOString(),
      approval:
        version.approved_by && version.approved_at
          ? {
              approvedBy: version.approved_by,
              approvedAt: version.approved_at.toISOString(),
            }
          : null,
    })),
    recentRuns: runsResult.rows.map((run) => ({
      runId: run.run_id,
      workflowVersionId: run.workflow_version_id,
      trigger:
        run.trigger_type === 'webhook'
          ? { type: 'webhook' as const, deliveryId: run.trigger_delivery_id! }
          : run.trigger_type === 'api'
            ? { type: 'api' as const, deliveryId: run.trigger_delivery_id! }
            : run.trigger_type === 'schedule'
              ? {
                  type: 'schedule' as const,
                  scheduleId: run.trigger_schedule_id!,
                  scheduledFor: run.trigger_scheduled_for!.toISOString(),
                }
              : { type: 'manual' as const },
      state: run.state,
      startedAt: run.started_at.toISOString(),
      ...(run.lifecycle_duration_ms === null ? {} : { durationMs: run.lifecycle_duration_ms }),
      ...(run.lifecycle_outcome === null ? {} : { outcome: run.lifecycle_outcome }),
    })),
  };
}

function readCatalogInputSchema(
  artifactInputSchema: unknown,
  compiledInputSchema: unknown,
): ObjectSchema | null {
  const artifact = objectSchemaSchema.safeParse(artifactInputSchema);
  if (artifact.success) return artifact.data;
  const compiled = objectSchemaSchema.safeParse(compiledInputSchema);
  return compiled.success ? compiled.data : null;
}

export async function readWorkflowCatalogVersion(
  pool: Pick<Pool, 'query'>,
  query: z.infer<typeof workflowCatalogQuerySchema> & {
    workflowId: string;
    workflowVersionId: string;
  },
) {
  const result = await pool.query<{ compiled_workflow: unknown }>(
    `SELECT version.compiled_workflow
     FROM workflow_versions version
     JOIN workflow_environment_versions scoped
       ON scoped.organization_id = version.organization_id
      AND scoped.workflow_version_id = version.workflow_version_id
      AND scoped.environment_id = $4
     WHERE version.organization_id = $1 AND version.workflow_id = $2
       AND version.workflow_version_id = $3`,
    [query.organizationId, query.workflowId, query.workflowVersionId, query.environmentId],
  );
  const draft = result.rows[0]?.compiled_workflow;
  if (!draft) {
    throw new WorkflowCatalogWorkflowNotFound('Workflow version is unavailable in selected scope');
  }
  return { draft };
}
