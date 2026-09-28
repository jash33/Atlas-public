exports.up = (pgm) => {
  pgm.addColumns('capability_monitoring_state', {
    last_completed_sweep_at: { type: 'timestamptz' },
    readiness_message: { type: 'text' },
  });

  pgm.createTable('capability_polling_baselines', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    definition_key: { type: 'text', notNull: true },
    revision: { type: 'integer', notNull: true },
    last_succeeded_at: { type: 'timestamptz', notNull: true },
  });
  pgm.addConstraint('capability_polling_baselines', 'capability_polling_baselines_pk', {
    primaryKey: ['organization_id', 'environment_id', 'definition_key', 'revision'],
  });
  pgm.addConstraint('capability_polling_baselines', 'capability_polling_baselines_definition_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id', 'definition_key', 'revision'],
      references:
        'capability_polling_definitions(organization_id, environment_id, definition_key, revision)',
      onDelete: 'cascade',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('capability_polling_baselines');
  pgm.dropColumns('capability_monitoring_state', ['last_completed_sweep_at', 'readiness_message']);
};
