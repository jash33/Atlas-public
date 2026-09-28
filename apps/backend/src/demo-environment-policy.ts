interface Queryable {
  query(text: string, values: readonly unknown[]): Promise<unknown>;
}

/**
 * Opens each demo environment for validation. Workflow inputs are not part of
 * this policy: every workflow declares its own inputs, or inherits leftover
 * required fields from its steps (see workflow-input-schema.ts).
 */
export async function seedDemoEnvironmentPolicies(
  pool: Queryable,
  organizationId: string,
  environmentIds: readonly string[],
) {
  await pool.query(
    `INSERT INTO organization_environment_policies
       (organization_id, environment_id, policy_version, approved_by)
     SELECT $1, environment_id, 'mvp-validation-v1', 'atlas-admin'
     FROM unnest($2::text[]) AS target(environment_id)
     ON CONFLICT (organization_id, environment_id) DO UPDATE
     SET policy_version = EXCLUDED.policy_version,
         approved_by = EXCLUDED.approved_by,
         revoked_at = NULL`,
    [organizationId, environmentIds],
  );
}
