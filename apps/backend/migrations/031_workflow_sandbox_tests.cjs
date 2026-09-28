exports.up = (pgm) => {
  pgm.createTable('workflow_sandbox_test_runs', {
    id: 'id',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    ir_hash: { type: 'char(64)', notNull: true },
    status: { type: 'text', notNull: true, check: "status IN ('passed', 'failed')" },
    provider_contracts: { type: 'jsonb', notNull: true },
    tests: { type: 'jsonb', notNull: true },
    tested_by: { type: 'text', notNull: true },
    tested_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.createIndex('workflow_sandbox_test_runs', [
    'organization_id',
    'environment_id',
    'workflow_version_id',
    'ir_hash',
  ]);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_sandbox_test_runs');
};
