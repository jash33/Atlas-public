exports.up = (pgm) => {
  pgm.addColumns('workflow_versions', {
    ir_hash: { type: 'char(64)' },
    compiled_workflow: { type: 'jsonb' },
  });

  pgm.createTable('workflow_approvals', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    ir_hash: { type: 'char(64)', notNull: true },
    policy_version: { type: 'text', notNull: true },
    projection_fingerprint: { type: 'char(64)', notNull: true },
    approved_by: { type: 'text', notNull: true },
    approved_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_approvals', 'workflow_approvals_pk', {
    primaryKey: ['organization_id', 'environment_id', 'workflow_version_id'],
  });
  pgm.addConstraint('workflow_approvals', 'workflow_approvals_version_fk', {
    foreignKeys: {
      columns: ['organization_id', 'workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
      onDelete: 'cascade',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_approvals');
  pgm.dropColumns('workflow_versions', ['ir_hash', 'compiled_workflow']);
};
