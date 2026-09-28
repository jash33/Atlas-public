exports.up = (pgm) => {
  pgm.createTable('capability_source_registrations', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    service_id: { type: 'text', notNull: true },
    discovery_input: { type: 'jsonb', notNull: true },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_source_registrations', 'capability_source_registrations_pk', {
    primaryKey: ['organization_id', 'service_id'],
  });
  pgm.addColumns('capability_rediscovery_requests', {
    discovery_id: { type: 'bigint', references: 'capability_discoveries' },
    processed_at: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('capability_rediscovery_requests', ['discovery_id', 'processed_at']);
  pgm.dropTable('capability_source_registrations');
};
