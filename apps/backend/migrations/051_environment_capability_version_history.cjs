exports.up = (pgm) => {
  pgm.createTable('environment_capability_version_observations', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
    first_observed_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
  pgm.addConstraint(
    'environment_capability_version_observations',
    'environment_capability_version_observations_pk',
    { primaryKey: ['organization_id', 'environment_id', 'capability_version_id'] },
  );
  pgm.addConstraint(
    'environment_capability_version_observations',
    'environment_capability_version_observations_version_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
      },
    },
  );
  pgm.sql(`
    INSERT INTO environment_capability_version_observations
      (organization_id, environment_id, capability_version_id)
    SELECT organization_id, environment_id, capability_version_id
    FROM environment_capability_observations
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('environment_capability_version_observations');
};
