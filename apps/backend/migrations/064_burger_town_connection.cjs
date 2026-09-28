exports.up = (pgm) => {
  pgm.createTable('capability_polling_definitions', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
    definition_key: { type: 'text', notNull: true },
    revision: { type: 'integer', notNull: true, check: 'revision > 0' },
    application_url: { type: 'text', notNull: true },
    method: { type: 'text', notNull: true },
    path: { type: 'text', notNull: true },
    request_body: { type: 'jsonb', notNull: true },
    expected_success: { type: 'jsonb', notNull: true },
    recognized_error: { type: 'jsonb', notNull: true },
    configured_by: { type: 'text', notNull: true },
    configured_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_polling_definitions', 'capability_polling_definitions_pk', {
    primaryKey: ['organization_id', 'environment_id', 'definition_key', 'revision'],
  });
  pgm.addConstraint(
    'capability_polling_definitions',
    'capability_polling_definitions_capability_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.addConstraint(
    'capability_polling_definitions',
    'capability_polling_definitions_environment_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'environment_id'],
        references: 'environments(organization_id, id)',
        onDelete: 'cascade',
      },
    },
  );

  pgm.createTable('capability_monitoring_state', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    state: {
      type: 'text',
      notNull: true,
      default: 'stopped',
      check: "state IN ('unavailable', 'stopped', 'starting', 'active', 'stopping')",
    },
    changed_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_monitoring_state', 'capability_monitoring_state_pk', {
    primaryKey: ['organization_id', 'environment_id'],
  });
  pgm.addConstraint('capability_monitoring_state', 'capability_monitoring_state_environment_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });

  pgm.sql(`
    CREATE FUNCTION reject_polling_definition_update() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'polling definition revisions are immutable';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER polling_definitions_are_immutable
      BEFORE UPDATE ON capability_polling_definitions
      FOR EACH ROW EXECUTE FUNCTION reject_polling_definition_update();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER polling_definitions_are_immutable ON capability_polling_definitions;
    DROP FUNCTION reject_polling_definition_update();
  `);
  pgm.dropTable('capability_monitoring_state');
  pgm.dropTable('capability_polling_definitions');
};
