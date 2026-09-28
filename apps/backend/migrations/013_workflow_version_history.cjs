exports.up = (pgm) => {
  pgm.addColumns('workflow_approvals', {
    lifecycle_status: { type: 'text', notNull: true, default: 'approved' },
  });
  pgm.addConstraint('workflow_approvals', 'workflow_approvals_lifecycle_status_check', {
    check: "lifecycle_status IN ('approved', 'superseded', 'current')",
  });
  pgm.sql(`
    WITH ranked AS (
      SELECT organization_id, environment_id, workflow_version_id,
             row_number() OVER (
               PARTITION BY organization_id, environment_id
               ORDER BY approved_at DESC, workflow_version_id DESC
             ) AS position
      FROM workflow_approvals
    )
    UPDATE workflow_approvals approval
    SET lifecycle_status = CASE WHEN ranked.position = 1 THEN 'current' ELSE 'superseded' END
    FROM ranked
    WHERE approval.organization_id = ranked.organization_id
      AND approval.environment_id = ranked.environment_id
      AND approval.workflow_version_id = ranked.workflow_version_id
  `);
  pgm.sql(`CREATE UNIQUE INDEX workflow_approvals_one_current
    ON workflow_approvals (organization_id, environment_id)
    WHERE lifecycle_status = 'current'`);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX workflow_approvals_one_current');
  pgm.dropConstraint('workflow_approvals', 'workflow_approvals_lifecycle_status_check');
  pgm.dropColumns('workflow_approvals', ['lifecycle_status']);
};
