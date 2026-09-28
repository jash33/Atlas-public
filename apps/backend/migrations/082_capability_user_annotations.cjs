exports.up = (pgm) => {
  pgm.createTable('capability_user_annotations', {
    id: 'id',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    capability_identity_id: {
      type: 'bigint',
      notNull: true,
      references: 'capability_identities',
      onDelete: 'cascade',
    },
    body: { type: 'text', notNull: true },
    created_by: { type: 'text', notNull: true },
    updated_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_user_annotations', 'capability_user_annotation_body', {
    check: 'char_length(trim(body)) BETWEEN 1 AND 2000',
  });
  pgm.createIndex('capability_user_annotations', [
    'organization_id',
    'capability_identity_id',
    'created_at',
  ]);
};

exports.down = (pgm) => {
  pgm.dropTable('capability_user_annotations');
};
