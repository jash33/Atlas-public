exports.up = (pgm) => {
  pgm.addColumn('environment_workers', {
    run_command_public_key: { type: 'text' },
  });
  pgm.addColumns('workflow_run_commands', {
    workflow_run_id: { type: 'text' },
    intake_status: { type: 'text' },
  });
  pgm.addConstraint('workflow_run_commands', 'workflow_run_commands_intake_status_check', {
    check: "intake_status IS NULL OR intake_status IN ('accepted', 'duplicate', 'conflict')",
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('workflow_run_commands', 'workflow_run_commands_intake_status_check');
  pgm.dropColumns('workflow_run_commands', ['workflow_run_id', 'intake_status']);
  pgm.dropColumn('environment_workers', 'run_command_public_key');
};
