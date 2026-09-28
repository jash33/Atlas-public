const previousNotificationKinds =
  "'general', 'capability-removal', 'workflow-risk', 'stale-source', 'source-conflict', 'environment-difference', 'discovery-summary'";

exports.up = (pgm) => {
  pgm.createTable('capability_polling_failures', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    definition_key: { type: 'text', notNull: true },
    polling_definition_revision: { type: 'integer', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
    reason: {
      type: 'text',
      notNull: true,
      check: "reason IN ('unrecognized-response', 'timeout', 'unreachable')",
    },
    status_code: {
      type: 'integer',
      check: 'status_code IS NULL OR status_code BETWEEN 100 AND 599',
    },
    first_seen_at: { type: 'timestamptz', notNull: true },
    last_seen_at: { type: 'timestamptz', notNull: true },
    occurrence_count: { type: 'integer', notNull: true, default: 1, check: 'occurrence_count > 0' },
  });
  pgm.addConstraint('capability_polling_failures', 'capability_polling_failures_pk', {
    primaryKey: [
      'organization_id',
      'environment_id',
      'definition_key',
      'polling_definition_revision',
    ],
  });
  pgm.addConstraint('capability_polling_failures', 'capability_polling_failures_definition_fk', {
    foreignKeys: {
      columns: [
        'organization_id',
        'environment_id',
        'definition_key',
        'polling_definition_revision',
      ],
      references:
        'capability_polling_definitions(organization_id, environment_id, definition_key, revision)',
      onDelete: 'cascade',
    },
  });

  pgm.createTable('runtime_contract_mismatch_observations', {
    id: { type: 'text', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    capability_identity_id: { type: 'bigint', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
    definition_key: { type: 'text', notNull: true },
    polling_definition_revision: { type: 'integer', notNull: true },
    operation_id: { type: 'text', notNull: true },
    reason: {
      type: 'text',
      notNull: true,
      check: "reason IN ('required-field-missing')",
    },
    field_path: { type: 'text', notNull: true, check: 'length(field_path) <= 512' },
    status_code: {
      type: 'integer',
      notNull: true,
      check: 'status_code BETWEEN 100 AND 599',
    },
    observed_at: { type: 'timestamptz', notNull: true },
  });
  pgm.addConstraint(
    'runtime_contract_mismatch_observations',
    'runtime_contract_mismatch_observations_environment_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'environment_id'],
        references: 'environments(organization_id, id)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.addConstraint(
    'runtime_contract_mismatch_observations',
    'runtime_contract_mismatch_observations_capability_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.addConstraint(
    'runtime_contract_mismatch_observations',
    'runtime_contract_mismatch_observations_definition_fk',
    {
      foreignKeys: {
        columns: [
          'organization_id',
          'environment_id',
          'definition_key',
          'polling_definition_revision',
        ],
        references:
          'capability_polling_definitions(organization_id, environment_id, definition_key, revision)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.createIndex('runtime_contract_mismatch_observations', [
    'organization_id',
    'environment_id',
    'observed_at',
  ]);

  pgm.createTable('runtime_contract_mismatches', {
    id: { type: 'text', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    condition_key: { type: 'text', notNull: true },
    capability_identity_id: { type: 'bigint', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
    definition_key: { type: 'text', notNull: true },
    polling_definition_revision: { type: 'integer', notNull: true },
    operation_id: { type: 'text', notNull: true },
    reason: {
      type: 'text',
      notNull: true,
      check: "reason IN ('required-field-missing')",
    },
    field_path: { type: 'text', notNull: true, check: 'length(field_path) <= 512' },
    status_code: {
      type: 'integer',
      notNull: true,
      check: 'status_code BETWEEN 100 AND 599',
    },
    first_seen_at: { type: 'timestamptz', notNull: true },
    last_seen_at: { type: 'timestamptz', notNull: true },
    occurrence_count: { type: 'integer', notNull: true, default: 1, check: 'occurrence_count > 0' },
    state: {
      type: 'text',
      notNull: true,
      default: 'active',
      check: "state IN ('active', 'recovered')",
    },
    latest_observation_id: {
      type: 'text',
      notNull: true,
      references: 'runtime_contract_mismatch_observations',
      onDelete: 'cascade',
    },
  });
  pgm.addConstraint('runtime_contract_mismatches', 'runtime_contract_mismatches_scope_unique', {
    unique: ['organization_id', 'environment_id', 'condition_key'],
  });
  pgm.addConstraint('runtime_contract_mismatches', 'runtime_contract_mismatches_environment_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });
  pgm.addConstraint('runtime_contract_mismatches', 'runtime_contract_mismatches_capability_fk', {
    foreignKeys: {
      columns: ['organization_id', 'capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
      onDelete: 'cascade',
    },
  });

  pgm.dropConstraint('notifications', 'notifications_kind_check');
  pgm.addConstraint('notifications', 'notifications_kind_check', {
    check: `kind IN (${previousNotificationKinds}, 'runtime-contract-mismatch')`,
  });

  pgm.sql(`
    CREATE FUNCTION reject_runtime_mismatch_observation_update() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'runtime contract mismatch observations are immutable';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER runtime_mismatch_observations_are_immutable
      BEFORE UPDATE ON runtime_contract_mismatch_observations
      FOR EACH ROW EXECUTE FUNCTION reject_runtime_mismatch_observation_update();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER runtime_mismatch_observations_are_immutable
      ON runtime_contract_mismatch_observations;
    DROP FUNCTION reject_runtime_mismatch_observation_update();
  `);
  pgm.dropConstraint('notifications', 'notifications_kind_check');
  pgm.addConstraint('notifications', 'notifications_kind_check', {
    check: `kind IN (${previousNotificationKinds})`,
  });
  pgm.dropTable('runtime_contract_mismatches');
  pgm.dropTable('runtime_contract_mismatch_observations');
  pgm.dropTable('capability_polling_failures');
};
