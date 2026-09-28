exports.up = (pgm) => {
  pgm.createTable('environment_workers', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    worker_id: { type: 'text', notNull: true },
    minimum_ir_version: { type: 'integer', notNull: true },
    maximum_ir_version: { type: 'integer', notNull: true },
    declared_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('environment_workers', 'environment_workers_pk', {
    primaryKey: ['organization_id', 'environment_id', 'worker_id'],
  });
  pgm.addConstraint('environment_workers', 'environment_workers_ir_range_check', {
    check: 'minimum_ir_version > 0 AND maximum_ir_version >= minimum_ir_version',
  });
};

exports.down = (pgm) => {
  pgm.dropTable('environment_workers');
};
