exports.up = (pgm) => {
  pgm.createTable('workflow_activations', {
    id: 'bigserial',
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    migration_candidate_id: {
      type: 'bigint',
      notNull: true,
      references: 'workflow_migration_candidates',
    },
    previous_workflow_version_id: { type: 'text', notNull: true },
    current_workflow_version_id: { type: 'text', notNull: true },
    previous_capability_version_id: { type: 'char(64)', notNull: true },
    current_capability_version_id: { type: 'char(64)', notNull: true },
    activated_by: { type: 'text', notNull: true },
    activated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    rolled_back_by: { type: 'text' },
    rolled_back_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('workflow_activations', 'workflow_activations_pk', {
    primaryKey: ['id'],
  });
  pgm.addConstraint('workflow_activations', 'workflow_activations_candidate_unique', {
    unique: ['migration_candidate_id'],
  });
  pgm.addConstraint('workflow_activations', 'workflow_activations_previous_workflow_fk', {
    foreignKeys: {
      columns: ['organization_id', 'previous_workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
    },
  });
  pgm.addConstraint('workflow_activations', 'workflow_activations_current_workflow_fk', {
    foreignKeys: {
      columns: ['organization_id', 'current_workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_activations');
};
