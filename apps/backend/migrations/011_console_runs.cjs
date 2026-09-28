exports.up = (pgm) => {
  pgm.createTable('workflow_runs', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    run_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    intake_key: { type: 'text', notNull: true },
    state: {
      type: 'text',
      notNull: true,
      check:
        "state IN ('running', 'completed', 'validation_failed', 'manual_review', 'repair_required')",
    },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_pk', {
    primaryKey: ['organization_id', 'environment_id', 'run_id'],
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_version_fk', {
    foreignKeys: {
      columns: ['organization_id', 'workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
      onDelete: 'cascade',
    },
  });
  pgm.createIndex('workflow_runs', ['organization_id', 'environment_id', 'state', 'started_at']);
  pgm.createIndex('workflow_runs', ['organization_id', 'environment_id', 'intake_key']);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_runs');
};
