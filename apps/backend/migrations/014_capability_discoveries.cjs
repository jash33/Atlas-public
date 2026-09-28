exports.up = (pgm) => {
  pgm.createTable('capability_discoveries', {
    id: 'bigserial',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    service_id: { type: 'text', notNull: true },
    trigger: {
      type: 'text',
      notNull: true,
      check: "trigger IN ('repository-push', 'daily-poll', 'run-drift')",
    },
    discovered_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('capability_discoveries');
};
