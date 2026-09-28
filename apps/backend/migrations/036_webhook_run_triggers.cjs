exports.up = (pgm) => {
  pgm.addColumns('workflow_run_commands', {
    trigger_type: { type: 'text', notNull: true, default: 'manual' },
    trigger_delivery_id: { type: 'text' },
    trigger_payload_fingerprint: { type: 'char(64)' },
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook')",
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL AND trigger_payload_fingerprint IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL AND trigger_payload_fingerprint IS NOT NULL)",
  });
  pgm.createIndex(
    'workflow_run_commands',
    ['organization_id', 'environment_id', 'trigger_delivery_id'],
    {
      name: 'workflow_run_commands_webhook_delivery_unique',
      unique: true,
      where: "trigger_type = 'webhook'",
    },
  );
  pgm.addColumns('workflow_runs', {
    trigger_type: { type: 'text', notNull: true, default: 'manual' },
    trigger_delivery_id: { type: 'text' },
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_type_check', {
    check: "trigger_type IN ('manual', 'webhook')",
  });
  pgm.addConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check', {
    check:
      "(trigger_type = 'manual' AND trigger_delivery_id IS NULL) OR " +
      "(trigger_type = 'webhook' AND trigger_delivery_id IS NOT NULL)",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_provenance_check');
  pgm.dropConstraint('workflow_runs', 'workflow_runs_trigger_type_check');
  pgm.dropColumns('workflow_runs', ['trigger_type', 'trigger_delivery_id']);
  pgm.dropIndex(
    'workflow_run_commands',
    ['organization_id', 'environment_id', 'trigger_delivery_id'],
    { name: 'workflow_run_commands_webhook_delivery_unique' },
  );
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_provenance_check');
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_trigger_type_check');
  pgm.dropColumns('workflow_run_commands', [
    'trigger_type',
    'trigger_delivery_id',
    'trigger_payload_fingerprint',
  ]);
};
