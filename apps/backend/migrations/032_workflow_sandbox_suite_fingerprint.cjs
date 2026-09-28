exports.up = (pgm) => {
  pgm.addColumn('workflow_sandbox_test_runs', {
    suite_fingerprint: { type: 'char(64)' },
  });
  pgm.sql(`UPDATE workflow_sandbox_test_runs
    SET suite_fingerprint = repeat('0', 64)
    WHERE suite_fingerprint IS NULL`);
  pgm.alterColumn('workflow_sandbox_test_runs', 'suite_fingerprint', { notNull: true });
};

exports.down = (pgm) => {
  pgm.dropColumn('workflow_sandbox_test_runs', 'suite_fingerprint');
};
