exports.up = (pgm) => {
  pgm.addConstraint('capability_discoveries', 'capability_discoveries_pk', {
    primaryKey: ['id'],
  });
  pgm.createTable('capability_discovery_changes', {
    discovery_id: {
      type: 'bigint',
      notNull: true,
      references: 'capability_discoveries',
      onDelete: 'cascade',
    },
    organization_id: { type: 'text', notNull: true },
    from_capability_version_id: { type: 'char(64)', notNull: true },
    to_capability_version_id: { type: 'char(64)', notNull: true },
    classification: {
      type: 'text',
      notNull: true,
      check: "classification IN ('compatible', 'conditional', 'breaking')",
    },
    field_changes: { type: 'jsonb', notNull: true },
    affected_workflows: { type: 'jsonb', notNull: true },
  });
  pgm.addConstraint('capability_discovery_changes', 'capability_discovery_changes_pk', {
    primaryKey: ['discovery_id', 'to_capability_version_id'],
  });
  pgm.addConstraint('capability_discovery_changes', 'capability_discovery_change_from_fk', {
    foreignKeys: {
      columns: ['organization_id', 'from_capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
  pgm.addConstraint('capability_discovery_changes', 'capability_discovery_change_to_fk', {
    foreignKeys: {
      columns: ['organization_id', 'to_capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('capability_discovery_changes');
  pgm.dropConstraint('capability_discoveries', 'capability_discoveries_pk');
};
