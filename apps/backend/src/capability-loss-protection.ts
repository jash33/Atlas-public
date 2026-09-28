import type { Pool } from 'pg';
import { z } from 'zod';

export const capabilityLossOverrideSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    workflowVersionId: z.string().min(1),
    capabilityVersionId: z.string().regex(/^[a-f0-9]{64}$/),
    reason: z.string().trim().min(1).max(500),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const revokeCapabilityLossOverrideSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();

export class CapabilityLossOverrideConflict extends Error {}
export class CapabilityLossOverrideNotFound extends Error {}
export class WorkflowCapabilityLossBlocked extends Error {
  constructor(readonly blockers: readonly string[]) {
    super(blockers[0] ?? 'Workflow capability loss blocks new runs');
  }
}

interface LossRow {
  capability_version_id: string;
  availability_status: 'available' | 'removed';
  freshness_status: 'fresh' | 'stale';
  status_reason: string;
  override_id: string | null;
  override_expires_at: Date | null;
  confirmed_removal: boolean;
}

export async function readWorkflowCapabilityLossProtection(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string; workflowVersionId: string },
) {
  const result = await pool.query<LossRow>(
    `SELECT dependency.capability_version_id, observation.availability_status,
            observation.freshness_status, observation.status_reason,
            override.id AS override_id, override.expires_at AS override_expires_at,
            loss.workflow_version_id IS NOT NULL AS confirmed_removal
     FROM workflow_capability_dependencies dependency
     JOIN capability_versions version
       ON version.organization_id = dependency.organization_id
      AND version.capability_version_id = dependency.capability_version_id
     LEFT JOIN environment_capability_observations observation
       ON observation.organization_id = dependency.organization_id
      AND observation.environment_id = $2
      AND observation.capability_identity_id = version.capability_identity_id
      AND observation.capability_version_id = dependency.capability_version_id
     LEFT JOIN confirmed_workflow_capability_losses loss
       ON loss.organization_id = dependency.organization_id
      AND loss.environment_id = $2
      AND loss.workflow_version_id = dependency.workflow_version_id
      AND loss.capability_version_id = dependency.capability_version_id
     LEFT JOIN LATERAL (
       SELECT id, expires_at
       FROM active_workflow_capability_loss_overrides candidate
       WHERE candidate.organization_id = dependency.organization_id
         AND candidate.environment_id = $2
         AND candidate.workflow_version_id = dependency.workflow_version_id
         AND candidate.capability_version_id = dependency.capability_version_id
       ORDER BY candidate.id DESC LIMIT 1
     ) override ON true
     WHERE dependency.organization_id = $1 AND dependency.workflow_version_id = $3
     ORDER BY dependency.capability_version_id`,
    [scope.organizationId, scope.environmentId, scope.workflowVersionId],
  );
  const removed = result.rows.filter((row) => row.confirmed_removal);
  const blocking = removed.filter((row) => !row.override_id);
  const needsReview = await pool.query<{ capability_version_id: string }>(
    `SELECT DISTINCT change.from_capability_version_id AS capability_version_id
     FROM capability_discovery_changes change
     JOIN capability_discoveries discovery ON discovery.id = change.discovery_id
     JOIN workflow_capability_dependencies dependency
       ON dependency.organization_id = change.organization_id
      AND dependency.capability_version_id = change.from_capability_version_id
     WHERE change.organization_id = $1 AND discovery.environment_id = $2
       AND dependency.workflow_version_id = $3
       AND change.classification = 'conditional' AND change.change_kind = 'version-change'`,
    [scope.organizationId, scope.environmentId, scope.workflowVersionId],
  );
  const warnings = [
    ...result.rows
      .filter((row) => row.freshness_status === 'stale')
      .map(
        (row) =>
          `Capability ${row.capability_version_id.trim()} is stale (${row.status_reason}); its last observation is retained.`,
      ),
    ...needsReview.rows.map(
      (row) =>
        `Capability ${row.capability_version_id.trim()} has a declared-contract change that Needs review; this evidence does not prove removal.`,
    ),
    ...removed
      .filter((row) => row.override_id)
      .map(
        (row) =>
          `ADMIN OVERRIDE: capability ${row.capability_version_id.trim()} was confirmed removed; the underlying operation may no longer exist${row.override_expires_at ? ` (override expires ${row.override_expires_at.toISOString()})` : ''}.`,
      ),
  ];
  return {
    allowed: blocking.length === 0,
    blockers: blocking.map(
      (row) =>
        `Capability ${row.capability_version_id.trim()} was confirmed removed in ${scope.environmentId}; migrate and approve this workflow or obtain an Admin override.`,
    ),
    warnings,
    removedCapabilityVersionIds: removed.map((row) => row.capability_version_id.trim()),
  };
}

export async function assertWorkflowCapabilityLossOpen(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string; workflowVersionId: string },
) {
  const protection = await readWorkflowCapabilityLossProtection(pool, scope);
  if (!protection.allowed) throw new WorkflowCapabilityLossBlocked(protection.blockers);
  return protection;
}

export async function createCapabilityLossOverride(
  pool: Pool,
  input: z.infer<typeof capabilityLossOverrideSchema>,
  actorId: string,
) {
  if (input.expiresAt && new Date(input.expiresAt) <= new Date()) {
    throw new CapabilityLossOverrideConflict('Override expiration must be in the future');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const confirmed = await client.query(
      `SELECT 1 FROM confirmed_workflow_capability_losses
       WHERE organization_id = $1 AND environment_id = $2
         AND workflow_version_id = $3 AND capability_version_id = $4`,
      [
        input.organizationId,
        input.environmentId,
        input.workflowVersionId,
        input.capabilityVersionId,
      ],
    );
    if (!confirmed.rows[0]) {
      throw new CapabilityLossOverrideConflict(
        'An override requires a workflow pin with confirmed removal in this environment',
      );
    }
    const inserted = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO workflow_capability_loss_overrides
        (organization_id, environment_id, workflow_version_id, capability_version_id,
         reason, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [
        input.organizationId,
        input.environmentId,
        input.workflowVersionId,
        input.capabilityVersionId,
        input.reason,
        actorId,
        input.expiresAt ?? null,
      ],
    );
    const row = inserted.rows[0]!;
    await client.query(
      `INSERT INTO audit_entries
        (organization_id, environment_id, event_type, subject_type, subject_id, actor_id, details)
       VALUES ($1, $2, 'capability-loss-override', 'workflow-capability-loss-override', $3, $4, $5)`,
      [
        input.organizationId,
        input.environmentId,
        row.id,
        actorId,
        {
          action: 'created',
          workflowVersionId: input.workflowVersionId,
          capabilityVersionId: input.capabilityVersionId,
          reason: input.reason,
          expiresAt: input.expiresAt ?? null,
          warning: 'The underlying operation may no longer exist.',
        },
      ],
    );
    await client.query('COMMIT');
    return {
      overrideId: row.id,
      workflowVersionId: input.workflowVersionId,
      capabilityVersionId: input.capabilityVersionId,
      createdBy: actorId,
      createdAt: row.created_at.toISOString(),
      expiresAt: input.expiresAt ?? null,
      warning: 'The underlying operation may no longer exist.',
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeCapabilityLossOverride(
  pool: Pool,
  overrideId: string,
  input: z.infer<typeof revokeCapabilityLossOverrideSchema>,
  actorId: string,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const revoked = await client.query<{
      workflow_version_id: string;
      capability_version_id: string;
    }>(
      `UPDATE workflow_capability_loss_overrides
       SET revoked_by = $4, revoked_at = current_timestamp
       WHERE id = $1 AND organization_id = $2 AND environment_id = $3
         AND revoked_at IS NULL
       RETURNING workflow_version_id, capability_version_id`,
      [overrideId, input.organizationId, input.environmentId, actorId],
    );
    const row = revoked.rows[0];
    if (!row) throw new CapabilityLossOverrideNotFound();
    await client.query(
      `INSERT INTO audit_entries
        (organization_id, environment_id, event_type, subject_type, subject_id, actor_id, details)
       VALUES ($1, $2, 'capability-loss-override', 'workflow-capability-loss-override', $3, $4, $5)`,
      [
        input.organizationId,
        input.environmentId,
        overrideId,
        actorId,
        {
          action: 'revoked',
          workflowVersionId: row.workflow_version_id,
          capabilityVersionId: row.capability_version_id.trim(),
        },
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
