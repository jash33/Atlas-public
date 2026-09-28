import type { Pool } from 'pg';

export async function deleteCapability(
  pool: Pool,
  scope: {
    organizationId: string;
    environmentId: string;
    capabilityIdentityId: string;
    actorId: string;
  },
) {
  const client = await pool.connect();
  const params = [scope.organizationId, scope.environmentId, scope.capabilityIdentityId];
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT 1 FROM environment_capability_observations
       WHERE organization_id = $1 AND environment_id = $2 AND capability_identity_id = $3
         AND deleted_at IS NULL FOR UPDATE`,
      params,
    );
    if (!existing.rowCount) {
      await client.query('ROLLBACK');
      return 'not-found' as const;
    }
    const dependencies = await client.query(
      `SELECT 1 FROM workflow_capability_dependencies dependency
       JOIN capability_versions version ON version.organization_id = dependency.organization_id
         AND version.capability_version_id = dependency.capability_version_id
       WHERE version.organization_id = $1 AND version.capability_identity_id = $2 LIMIT 1`,
      [scope.organizationId, scope.capabilityIdentityId],
    );
    if (dependencies.rowCount) {
      await client.query('ROLLBACK');
      return 'in-use' as const;
    }
    await client.query(
      `UPDATE environment_capability_observations SET deleted_at = current_timestamp,
         deleted_by = $4, availability_status = 'removed', freshness_status = 'fresh',
         status_reason = 'deleted-by-user', status_changed_at = current_timestamp
       WHERE organization_id = $1 AND environment_id = $2 AND capability_identity_id = $3`,
      [...params, scope.actorId],
    );
    await client.query(
      `INSERT INTO audit_entries
       (organization_id, environment_id, event_type, subject_type, subject_id, actor_id, details)
       VALUES ($1, $2, 'organization-settings', 'capability', $3, $4, $5)`,
      [...params, scope.actorId, { action: 'deleted' }],
    );
    await client.query('COMMIT');
    return 'deleted' as const;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
