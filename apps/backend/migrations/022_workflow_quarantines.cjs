exports.up = (pgm) => {
  pgm.createTable('workflow_quarantines', {
    id: 'bigserial',
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    from_capability_version_id: { type: 'char(64)', notNull: true },
    to_capability_version_id: { type: 'char(64)', notNull: true },
    quarantined_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    lifted_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('workflow_quarantines', 'workflow_quarantines_pk', {
    primaryKey: ['id'],
  });
  pgm.addConstraint('workflow_quarantines', 'workflow_quarantines_workflow_fk', {
    foreignKeys: {
      columns: ['organization_id', 'workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
      onDelete: 'cascade',
    },
  });
  pgm.addConstraint('workflow_quarantines', 'workflow_quarantines_from_capability_fk', {
    foreignKeys: {
      columns: ['organization_id', 'from_capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
  pgm.addConstraint('workflow_quarantines', 'workflow_quarantines_to_capability_fk', {
    foreignKeys: {
      columns: ['organization_id', 'to_capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
  pgm.sql(`CREATE UNIQUE INDEX workflow_quarantines_one_active_change
    ON workflow_quarantines
      (organization_id, environment_id, workflow_version_id,
       from_capability_version_id, to_capability_version_id)
    WHERE lifted_at IS NULL`);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_quarantines');
};
