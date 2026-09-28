exports.up = (pgm) => {
  pgm.createTable('notifications', {
    id: { type: 'text', primaryKey: true },
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    severity: {
      type: 'text',
      notNull: true,
      check: "severity IN ('info', 'warning', 'critical')",
    },
    title: { type: 'text', notNull: true },
    message: { type: 'text', notNull: true },
    navigation_target: { type: 'text', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('current_timestamp'),
    },
    read_at: { type: 'timestamptz' },
    resolved_at: { type: 'timestamptz' },
  });
  pgm.createIndex('notifications', ['organization_id', 'created_at']);
  pgm.createIndex('notifications', ['organization_id', 'environment_id', 'created_at']);
  pgm.addConstraint('notifications', 'notifications_environment_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('notifications');
};
