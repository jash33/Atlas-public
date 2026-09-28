exports.up = (pgm) => {
  pgm.createTable('workflow_run_commands', {
    command_id: { type: 'text', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    encrypted_payload: { type: 'text', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: 'queued',
      check: "status IN ('queued', 'dispatched', 'completed', 'failed')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    claimed_at: { type: 'timestamptz' },
    completed_at: { type: 'timestamptz' },
    error: { type: 'text' },
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_environment_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });
  pgm.createIndex('workflow_run_commands', [
    'organization_id',
    'environment_id',
    'status',
    'created_at',
  ]);
};
