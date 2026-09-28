exports.up = (pgm) => {
  pgm.createTable('workflow_migration_candidates', {
    id: 'bigserial',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    source_workflow_version_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    from_capability_version_id: { type: 'char(64)', notNull: true },
    to_capability_version_id: { type: 'char(64)', notNull: true },
    author: { type: 'text', notNull: true, check: "author IN ('compiler', 'planner')" },
    draft: { type: 'jsonb', notNull: true },
    validation: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_migration_candidates', 'workflow_migration_candidates_pk', {
    primaryKey: ['id'],
  });
  pgm.addConstraint('workflow_migration_candidates', 'workflow_migration_source_fk', {
    foreignKeys: {
      columns: ['organization_id', 'source_workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
    },
  });
  pgm.addConstraint('workflow_migration_candidates', 'workflow_migration_from_capability_fk', {
    foreignKeys: {
      columns: ['organization_id', 'from_capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
  pgm.addConstraint('workflow_migration_candidates', 'workflow_migration_to_capability_fk', {
    foreignKeys: {
      columns: ['organization_id', 'to_capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
  pgm.createIndex('workflow_migration_candidates', [
    'organization_id',
    'source_workflow_version_id',
  ]);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_migration_candidates');
};
