exports.up = (pgm) => {
  pgm.createTable('workflow_editor_drafts', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    workflow_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    revision: { type: 'integer', notNull: true, default: 1 },
    document: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_editor_drafts', 'workflow_editor_drafts_pkey', {
    primaryKey: ['organization_id', 'environment_id', 'workflow_id'],
  });
  pgm.addConstraint('workflow_editor_drafts', 'workflow_editor_drafts_revision_positive', {
    check: 'revision > 0',
  });
};

exports.down = (pgm) => pgm.dropTable('workflow_editor_drafts');
