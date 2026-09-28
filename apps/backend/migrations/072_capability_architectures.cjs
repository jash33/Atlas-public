exports.up = (pgm) => {
  pgm.createTable('capability_architectures', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    service_id: { type: 'text', notNull: true },
    source_url: { type: 'text', notNull: true },
    document_hash: { type: 'char(64)', notNull: true },
    document_yaml: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    confirmed_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_architectures', 'capability_architectures_pk', {
    primaryKey: ['organization_id', 'environment_id'],
  });
  pgm.addConstraint('capability_architectures', 'capability_architectures_environment_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('capability_architectures');
};
