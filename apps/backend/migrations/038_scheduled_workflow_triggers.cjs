exports.up = (pgm) => {
  pgm.createTable('workflow_schedules', {
    schedule_id: { type: 'text', primaryKey: true },
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    interval_seconds: { type: 'integer', notNull: true, check: 'interval_seconds >= 60' },
    encrypted_payload: { type: 'text', notNull: true },
    enabled: { type: 'boolean', notNull: true, default: true },
    next_run_at: { type: 'timestamptz', notNull: true },
    created_by: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_schedules', 'workflow_schedules_environment_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });
  pgm.createIndex('workflow_schedules', ['enabled', 'next_run_at']);

  pgm.addColumns('workflow_run_commands', {
    trigger_schedule_id: { type: 'text' },
    trigger_scheduled_for: { type: 'timestamptz' },
  });
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check', {
    ifExists: true,
  });
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check', {
    ifExists: true,
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook', 'schedule')",
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL AND trigger_payload_fingerprint IS NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL AND trigger_payload_fingerprint IS NOT NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'schedule' AND trigger_delivery_id IS NULL AND trigger_payload_fingerprint IS NULL AND trigger_schedule_id IS NOT NULL AND trigger_scheduled_for IS NOT NULL)",
  });
  pgm.createIndex(
    'workflow_run_commands',
    ['organization_id', 'environment_id', 'trigger_schedule_id', 'trigger_scheduled_for'],
    {
      name: 'workflow_run_commands_schedule_occurrence_unique',
      unique: true,
      where: "trigger_type = 'schedule'",
    },
  );

  pgm.addColumns('workflow_runs', {
    trigger_schedule_id: { type: 'text' },
    trigger_scheduled_for: { type: 'timestamptz' },
  });
  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check', {
    ifExists: true,
  });
  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_type_check', { ifExists: true });
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook', 'schedule')",
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'schedule' AND trigger_delivery_id IS NULL AND trigger_schedule_id IS NOT NULL AND trigger_scheduled_for IS NOT NULL)",
  });

  pgm.createTable('workflow_schedule_occurrences', {
    schedule_id: {
      type: 'text',
      notNull: true,
      references: 'workflow_schedules',
      onDelete: 'cascade',
    },
    scheduled_for: { type: 'timestamptz', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      check: "status IN ('queued', 'unavailable')",
    },
    command_id: { type: 'text', references: 'workflow_run_commands' },
    error: { type: 'text' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_schedule_occurrences', 'workflow_schedule_occurrences_pk', {
    primaryKey: ['schedule_id', 'scheduled_for'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_schedule_occurrences');

  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check');
  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_type_check');
  pgm.dropColumns('workflow_runs', ['trigger_schedule_id', 'trigger_scheduled_for']);
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook')",
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL)",
  });

  pgm.dropIndex(
    'workflow_run_commands',
    ['organization_id', 'environment_id', 'trigger_schedule_id', 'trigger_scheduled_for'],
    { name: 'workflow_run_commands_schedule_occurrence_unique' },
  );
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check');
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check');
  pgm.dropColumns('workflow_run_commands', ['trigger_schedule_id', 'trigger_scheduled_for']);
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook')",
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL AND trigger_payload_fingerprint IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL AND trigger_payload_fingerprint IS NOT NULL)",
  });
  pgm.dropTable('workflow_schedules');
};
