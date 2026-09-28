exports.up = (pgm) => {
  pgm.createTable('capability_execution_bindings', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    capability_identity_id: {
      type: 'bigint',
      notNull: true,
      references: 'capability_identities',
      onDelete: 'cascade',
    },
    base_url: { type: 'text', notNull: true },
    configured_by: { type: 'text', notNull: true },
    configured_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_execution_bindings', 'capability_execution_bindings_pk', {
    primaryKey: ['organization_id', 'environment_id', 'capability_identity_id'],
  });
  pgm.addConstraint(
    'capability_execution_bindings',
    'capability_execution_bindings_environment_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'environment_id'],
        references: 'environments(organization_id, id)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.sql(`
    INSERT INTO capability_execution_bindings
      (organization_id, environment_id, capability_identity_id, base_url, configured_by, configured_at)
    SELECT DISTINCT ON (definition.organization_id, definition.environment_id, version.capability_identity_id)
      definition.organization_id, definition.environment_id, version.capability_identity_id,
      definition.application_url, definition.configured_by, definition.configured_at
    FROM capability_polling_definitions definition
    JOIN capability_versions version ON version.organization_id = definition.organization_id
      AND version.capability_version_id = definition.capability_version_id
    ORDER BY definition.organization_id, definition.environment_id, version.capability_identity_id,
      definition.configured_at DESC, definition.revision DESC;
  `);
};

exports.down = (pgm) => pgm.dropTable('capability_execution_bindings');
