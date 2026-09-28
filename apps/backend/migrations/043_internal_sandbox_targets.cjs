exports.up = (pgm) => {
  pgm.createTable('capability_sandbox_target_revisions', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    capability_version_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    target_key: { type: 'text', notNull: true },
    revision: { type: 'integer', notNull: true, check: 'revision > 0' },
    base_url: { type: 'text', notNull: true },
    hostname: { type: 'text', notNull: true },
    health_path: { type: 'text', notNull: true, default: '/health' },
    secret_alias: { type: 'text' },
    configured_by: { type: 'text', notNull: true },
    configured_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_sandbox_target_revisions', 'capability_sandbox_targets_pk', {
    primaryKey: ['organization_id', 'capability_version_id', 'target_key', 'revision'],
  });
  pgm.addConstraint(
    'capability_sandbox_target_revisions',
    'capability_sandbox_targets_capability_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.addConstraint(
    'capability_sandbox_target_revisions',
    'capability_sandbox_targets_environment_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'environment_id'],
        references: 'environments(organization_id, id)',
        onDelete: 'cascade',
      },
    },
  );

  pgm.createTable('capability_test_data_profile_versions', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    capability_version_id: { type: 'text', notNull: true },
    profile_key: { type: 'text', notNull: true },
    version: { type: 'integer', notNull: true, check: 'version > 0' },
    inputs: { type: 'jsonb', notNull: true },
    setup_assumptions: { type: 'jsonb', notNull: true },
    safe_for_non_production: { type: 'boolean', notNull: true, default: true },
    configured_by: { type: 'text', notNull: true },
    configured_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_test_data_profile_versions', 'capability_test_data_profiles_pk', {
    primaryKey: ['organization_id', 'capability_version_id', 'profile_key', 'version'],
  });
  pgm.addConstraint(
    'capability_test_data_profile_versions',
    'capability_test_data_profiles_capability_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
        onDelete: 'cascade',
      },
    },
  );

  pgm.addColumn('workflow_sandbox_test_runs', {
    target_bindings: { type: 'jsonb', notNull: true, default: '[]' },
  });

  pgm.sql(`
    CREATE FUNCTION reject_sandbox_test_configuration_update() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'sandbox target and test-data revisions are immutable';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER sandbox_target_revisions_are_immutable
      BEFORE UPDATE ON capability_sandbox_target_revisions
      FOR EACH ROW EXECUTE FUNCTION reject_sandbox_test_configuration_update();
    CREATE TRIGGER test_data_profile_versions_are_immutable
      BEFORE UPDATE ON capability_test_data_profile_versions
      FOR EACH ROW EXECUTE FUNCTION reject_sandbox_test_configuration_update();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER test_data_profile_versions_are_immutable
      ON capability_test_data_profile_versions;
    DROP TRIGGER sandbox_target_revisions_are_immutable
      ON capability_sandbox_target_revisions;
    DROP FUNCTION reject_sandbox_test_configuration_update();
  `);
  pgm.dropColumn('workflow_sandbox_test_runs', 'target_bindings');
  pgm.dropTable('capability_test_data_profile_versions');
  pgm.dropTable('capability_sandbox_target_revisions');
};
