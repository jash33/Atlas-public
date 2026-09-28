exports.up = (pgm) => {
  pgm.addColumn('workflow_sandbox_test_runs', {
    setup_binding: { type: 'jsonb' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('workflow_sandbox_test_runs', 'setup_binding');
};
