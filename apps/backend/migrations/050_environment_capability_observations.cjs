exports.up = (pgm) => {
  pgm.createTable('environment_capability_observations', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    capability_identity_id: {
      type: 'bigint',
      notNull: true,
      references: 'capability_identities',
      onDelete: 'cascade',
    },
    capability_version_id: { type: 'char(64)', notNull: true },
    observed_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint(
    'environment_capability_observations',
    'environment_capability_observations_pk',
    { primaryKey: ['organization_id', 'environment_id', 'capability_identity_id'] },
  );
  pgm.addConstraint(
    'environment_capability_observations',
    'environment_capability_observations_version_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
      },
    },
  );
  pgm.sql(`
    INSERT INTO environment_capability_observations
      (organization_id, environment_id, capability_identity_id, capability_version_id)
    SELECT organization_id, 'production', capability_identity_id, capability_version_id
    FROM capability_identity_heads
  `);
  pgm.addColumn('capability_discoveries', {
    environment_id: { type: 'text', notNull: true, default: 'production' },
  });
  pgm.createIndex('capability_discoveries', ['organization_id', 'environment_id', 'discovered_at']);
};

exports.down = (pgm) => {
  pgm.dropColumn('capability_discoveries', 'environment_id');
  pgm.dropTable('environment_capability_observations');
};
