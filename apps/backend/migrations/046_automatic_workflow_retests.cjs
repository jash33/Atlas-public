exports.up = (pgm) => {
  pgm.addColumns('workflow_sandbox_test_runs', {
    stale_at: { type: 'timestamptz' },
    stale_trigger: { type: 'jsonb' },
  });

  pgm.createTable('workflow_sandbox_retest_policies', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    max_age_hours: { type: 'integer', notNull: true, check: 'max_age_hours > 0' },
    enabled: { type: 'boolean', notNull: true, default: true },
    configured_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_sandbox_retest_policies', 'workflow_sandbox_retest_policies_pk', {
    primaryKey: ['organization_id', 'environment_id'],
  });
  pgm.addConstraint('workflow_sandbox_retest_policies', 'workflow_sandbox_retest_policy_env_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });

  pgm.createTable('workflow_sandbox_retest_jobs', {
    id: 'id',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    ir_hash: { type: 'char(64)', notNull: true },
    trigger: {
      type: 'text',
      notNull: true,
      check: "trigger IN ('capability-rediscovery', 'expiration')",
    },
    trigger_detail: { type: 'jsonb', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'queued',
      check: "status IN ('queued', 'running', 'passed', 'failed', 'unavailable')",
    },
    test_run_id: { type: 'bigint', references: 'workflow_sandbox_test_runs' },
    setup_binding: { type: 'jsonb' },
    unavailable_reason: { type: 'text' },
    queued_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    started_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('workflow_sandbox_retest_jobs', 'workflow_sandbox_retest_job_workflow_fk', {
    foreignKeys: {
      columns: ['organization_id', 'workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
      onDelete: 'cascade',
    },
  });
  pgm.sql(`CREATE UNIQUE INDEX workflow_sandbox_retest_one_active
    ON workflow_sandbox_retest_jobs (organization_id, environment_id, workflow_version_id, ir_hash)
    WHERE status IN ('queued', 'running')`);
  pgm.createIndex('workflow_sandbox_retest_jobs', ['status', 'queued_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_sandbox_retest_jobs');
  pgm.dropTable('workflow_sandbox_retest_policies');
  pgm.dropColumns('workflow_sandbox_test_runs', ['stale_at', 'stale_trigger']);
};
