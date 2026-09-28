exports.up = (pgm) => {
  pgm.createTable('capability_rediscovery_requests', {
    id: { type: 'bigserial', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
    step_id: { type: 'text', notNull: true },
    trigger: { type: 'text', notNull: true, default: 'run-drift' },
    requested_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint(
    'capability_rediscovery_requests',
    'capability_rediscovery_requests_trigger_check',
    { check: "trigger = 'run-drift'" },
  );
  pgm.addConstraint(
    'capability_rediscovery_requests',
    'capability_rediscovery_requests_capability_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
      },
    },
  );
};

exports.down = (pgm) => {
  pgm.dropTable('capability_rediscovery_requests');
};
