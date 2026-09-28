exports.up = (pgm) => {
  pgm.createTable('atlas_workflow_bundles', {
    artifact_id: { type: 'char(64)', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    bundle_bytes: { type: 'bytea', notNull: true },
    activation_artifact_id: { type: 'char(64)', notNull: true },
    approval_binding: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.createIndex('atlas_workflow_bundles', ['organization_id', 'environment_id', 'artifact_id']);
  pgm.createTable('atlas_bundle_verification_events', {
    id: { type: 'bigserial', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    artifact_id: { type: 'char(64)' },
    outcome: { type: 'text', notNull: true },
    reason: { type: 'text' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('atlas_bundle_verification_events');
  pgm.dropTable('atlas_workflow_bundles');
};
