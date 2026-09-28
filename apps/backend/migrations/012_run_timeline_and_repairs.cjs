exports.up = (pgm) => {
  pgm.addColumns('workflow_runs', {
    failure_bucket: { type: 'text' },
    failure_type: { type: 'text' },
    failed_step_id: { type: 'text' },
    disposition: { type: 'text', notNull: true, default: 'active' },
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_failure_bucket_check', {
    check:
      "failure_bucket IS NULL OR failure_bucket IN ('retryable-transient', 'permanent-validation', 'permanent-operational')",
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_disposition_check', {
    check: "disposition IN ('active', 'abandoned')",
  });

  pgm.createTable('workflow_run_step_attempts', {
    id: { type: 'bigserial', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    run_id: { type: 'text', notNull: true },
    step_id: { type: 'text', notNull: true },
    capability_version_id: { type: 'text', notNull: true },
    attempt: { type: 'integer', notNull: true, check: 'attempt > 0' },
    duration_ms: { type: 'integer', notNull: true, check: 'duration_ms >= 0' },
    status: { type: 'text', notNull: true, check: "status IN ('succeeded', 'failed')" },
    redacted_input: { type: 'jsonb', notNull: true },
    redacted_output: { type: 'jsonb' },
    failure_type: { type: 'text' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_run_step_attempts', 'workflow_run_step_attempts_run_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id', 'run_id'],
      references: 'workflow_runs(organization_id, environment_id, run_id)',
      onDelete: 'cascade',
    },
  });
  pgm.createIndex('workflow_run_step_attempts', [
    'organization_id',
    'environment_id',
    'run_id',
    'id',
  ]);

  pgm.createTable('workflow_run_repairs', {
    repair_id: { type: 'text', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    run_id: { type: 'text', notNull: true },
    action: {
      type: 'text',
      notNull: true,
      check: "action IN ('retry_step', 'resume_run', 'abandon_run')",
    },
    step_id: { type: 'text' },
    reason: { type: 'text' },
    operator_id: { type: 'text', notNull: true },
    warning: { type: 'jsonb', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'queued',
      check: "status IN ('queued', 'dispatched', 'completed', 'failed')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    completed_at: { type: 'timestamptz' },
    error: { type: 'text' },
  });
  pgm.addConstraint('workflow_run_repairs', 'workflow_run_repairs_run_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id', 'run_id'],
      references: 'workflow_runs(organization_id, environment_id, run_id)',
      onDelete: 'cascade',
    },
  });
  pgm.createIndex('workflow_run_repairs', [
    'organization_id',
    'environment_id',
    'status',
    'created_at',
  ]);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_run_repairs');
  pgm.dropTable('workflow_run_step_attempts');
  pgm.dropConstraint('workflow_runs', 'workflow_runs_disposition_check');
  pgm.dropConstraint('workflow_runs', 'workflow_runs_failure_bucket_check');
  pgm.dropColumns('workflow_runs', [
    'failure_bucket',
    'failure_type',
    'failed_step_id',
    'disposition',
  ]);
};
