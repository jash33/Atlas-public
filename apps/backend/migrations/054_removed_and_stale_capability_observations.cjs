exports.up = (pgm) => {
  pgm.addColumns('environment_capability_observations', {
    availability_status: { type: 'text', notNull: true, default: 'available' },
    freshness_status: { type: 'text', notNull: true, default: 'fresh' },
    status_reason: { type: 'text', notNull: true, default: 'successful-discovery' },
    status_changed_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
  });
  pgm.addConstraint(
    'environment_capability_observations',
    'environment_capability_observations_availability_check',
    { check: "availability_status IN ('available', 'removed')" },
  );
  pgm.addConstraint(
    'environment_capability_observations',
    'environment_capability_observations_freshness_check',
    { check: "freshness_status IN ('fresh', 'stale')" },
  );

  pgm.dropConstraint('capability_discovery_changes', 'capability_discovery_changes_pk');
  pgm.dropConstraint('capability_discovery_changes', 'capability_discovery_change_to_fk');
  pgm.alterColumn('capability_discovery_changes', 'to_capability_version_id', { notNull: false });
  pgm.addColumns('capability_discovery_changes', {
    change_kind: { type: 'text', notNull: true, default: 'version-change' },
  });
  pgm.addConstraint('capability_discovery_changes', 'capability_discovery_changes_kind_check', {
    check: "change_kind IN ('version-change', 'removal')",
  });
  pgm.addConstraint('capability_discovery_changes', 'capability_discovery_changes_pk', {
    primaryKey: ['discovery_id', 'from_capability_version_id'],
  });
  pgm.addConstraint('capability_discovery_changes', 'capability_discovery_change_to_fk', {
    foreignKeys: {
      columns: ['organization_id', 'to_capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM capability_discovery_changes WHERE to_capability_version_id IS NULL`);
  pgm.dropConstraint('capability_discovery_changes', 'capability_discovery_changes_pk');
  pgm.dropConstraint('capability_discovery_changes', 'capability_discovery_change_to_fk');
  pgm.dropConstraint('capability_discovery_changes', 'capability_discovery_changes_kind_check');
  pgm.dropColumns('capability_discovery_changes', ['change_kind']);
  pgm.alterColumn('capability_discovery_changes', 'to_capability_version_id', { notNull: true });
  pgm.addConstraint('capability_discovery_changes', 'capability_discovery_changes_pk', {
    primaryKey: ['discovery_id', 'to_capability_version_id'],
  });
  pgm.addConstraint('capability_discovery_changes', 'capability_discovery_change_to_fk', {
    foreignKeys: {
      columns: ['organization_id', 'to_capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
  pgm.dropConstraint(
    'environment_capability_observations',
    'environment_capability_observations_availability_check',
  );
  pgm.dropConstraint(
    'environment_capability_observations',
    'environment_capability_observations_freshness_check',
  );
  pgm.dropColumns('environment_capability_observations', [
    'availability_status',
    'freshness_status',
    'status_reason',
    'status_changed_at',
  ]);
};
