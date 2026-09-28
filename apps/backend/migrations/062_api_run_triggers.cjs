exports.up = (pgm) => {
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check', {
    ifExists: true,
  });
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check', {
    ifExists: true,
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook', 'schedule', 'api')",
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL AND trigger_payload_fingerprint IS NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL AND trigger_payload_fingerprint IS NOT NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'api' AND trigger_delivery_id IS NOT NULL AND trigger_payload_fingerprint IS NOT NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'schedule' AND trigger_delivery_id IS NULL AND trigger_payload_fingerprint IS NULL AND trigger_schedule_id IS NOT NULL AND trigger_scheduled_for IS NOT NULL)",
  });
  pgm.createIndex(
    'workflow_run_commands',
    ['organization_id', 'environment_id', 'trigger_delivery_id'],
    {
      name: 'workflow_run_commands_api_delivery_unique',
      unique: true,
      where: "trigger_type = 'api'",
    },
  );

  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check', {
    ifExists: true,
  });
  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_type_check', { ifExists: true });
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook', 'schedule', 'api')",
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'api' AND trigger_delivery_id IS NOT NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'schedule' AND trigger_delivery_id IS NULL AND trigger_schedule_id IS NOT NULL AND trigger_scheduled_for IS NOT NULL)",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex(
    'workflow_run_commands',
    ['organization_id', 'environment_id', 'trigger_delivery_id'],
    { name: 'workflow_run_commands_api_delivery_unique' },
  );
  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check');
  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_type_check');
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook', 'schedule')",
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'schedule' AND trigger_delivery_id IS NULL AND trigger_schedule_id IS NOT NULL AND trigger_scheduled_for IS NOT NULL)",
  });

  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check');
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check');
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook', 'schedule')",
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL AND trigger_payload_fingerprint IS NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL AND trigger_payload_fingerprint IS NOT NULL AND trigger_schedule_id IS NULL AND trigger_scheduled_for IS NULL) OR " +
      "(trigger_type = 'schedule' AND trigger_delivery_id IS NULL AND trigger_payload_fingerprint IS NULL AND trigger_schedule_id IS NOT NULL AND trigger_scheduled_for IS NOT NULL)",
  });
};
