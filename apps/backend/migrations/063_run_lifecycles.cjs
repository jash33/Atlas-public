exports.up = (pgm) => {
  pgm.createTable('workflow_run_lifecycles', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    run_id: { type: 'text', notNull: true },
    workflow_name: { type: 'text', notNull: true, default: '' },
    started_at: { type: 'timestamptz', notNull: true },
    // Ended fields land in #211; nullable here so started rows can render as in-progress.
    ended_at: { type: 'timestamptz' },
    duration_ms: { type: 'integer', check: 'duration_ms IS NULL OR duration_ms >= 0' },
    retry_count: { type: 'integer', check: 'retry_count IS NULL OR retry_count >= 0' },
    outcome: {
      type: 'text',
      check: "outcome IS NULL OR outcome IN ('succeeded', 'failed')",
    },
  });
  pgm.addConstraint('workflow_run_lifecycles', 'workflow_run_lifecycles_pk', {
    primaryKey: ['organization_id', 'environment_id', 'run_id'],
  });
  pgm.addConstraint('workflow_run_lifecycles', 'workflow_run_lifecycles_environment_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });
  pgm.addConstraint('workflow_run_lifecycles', 'workflow_run_lifecycles_ended_complete', {
    check:
      '(ended_at IS NULL AND duration_ms IS NULL AND retry_count IS NULL AND outcome IS NULL) OR (ended_at IS NOT NULL AND duration_ms IS NOT NULL AND retry_count IS NOT NULL AND outcome IS NOT NULL)',
  });
  pgm.createIndex('workflow_run_lifecycles', ['organization_id', 'environment_id', 'started_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_run_lifecycles');
};
