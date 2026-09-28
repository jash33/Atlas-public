exports.up = (pgm) => {
  pgm.addColumn('workflow_run_commands', {
    error_details: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('workflow_run_commands', 'error_details');
};
