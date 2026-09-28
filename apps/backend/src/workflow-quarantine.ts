import type { Pool } from 'pg';

type Queryable = Pick<Pool, 'query'>;

export class WorkflowQuarantined extends Error {}

export async function quarantineWorkflowsForBreakingDrift(
  pool: Queryable,
  organizationId: string,
  fromCapabilityVersionId: string,
  toCapabilityVersionId: string,
) {
  await pool.query(
    `INSERT INTO workflow_quarantines
       (organization_id, environment_id, workflow_version_id,
        from_capability_version_id, to_capability_version_id)
     SELECT approval.organization_id, approval.environment_id, approval.workflow_version_id,
       $2, $3
     FROM workflow_approvals approval
     JOIN workflow_capability_dependencies dependency
       ON dependency.organization_id = approval.organization_id
      AND dependency.workflow_version_id = approval.workflow_version_id
      AND dependency.capability_version_id = $2
     WHERE approval.organization_id = $1 AND approval.lifecycle_status = 'current'
     ON CONFLICT (organization_id, environment_id, workflow_version_id,
       from_capability_version_id, to_capability_version_id)
       WHERE lifted_at IS NULL
     DO NOTHING`,
    [organizationId, fromCapabilityVersionId, toCapabilityVersionId],
  );
}

export async function assertWorkflowIntakeOpen(
  pool: Queryable,
  organizationId: string,
  environmentId: string,
  workflowVersionId: string,
) {
  const quarantine = await pool.query(
    `SELECT 1 FROM workflow_quarantines
     WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3
       AND lifted_at IS NULL
     UNION ALL
     SELECT 1
     FROM workflow_capability_dependencies dependency
     JOIN capability_versions pinned
       ON pinned.organization_id = dependency.organization_id
      AND pinned.capability_version_id = dependency.capability_version_id
     JOIN capability_identity_heads head
       ON head.organization_id = pinned.organization_id
      AND head.capability_identity_id = pinned.capability_identity_id
      AND head.capability_version_id <> pinned.capability_version_id
     JOIN compatibility_diffs diff
       ON diff.organization_id = dependency.organization_id
      AND diff.from_capability_version_id = dependency.capability_version_id
      AND diff.to_capability_version_id = head.capability_version_id
      AND diff.classification = 'breaking'
     WHERE dependency.organization_id = $1 AND dependency.workflow_version_id = $3
     LIMIT 1`,
    [organizationId, environmentId, workflowVersionId],
  );
  if (quarantine.rows[0]) throw new WorkflowQuarantined('Workflow intake is quarantined');
}
