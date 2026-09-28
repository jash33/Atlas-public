exports.up = (pgm) => {
  pgm.addColumns('workflow_run_commands', {
    target_worker_id: { type: 'text' },
    artifact_id: { type: 'char(64)' },
  });
  pgm.addColumn('workflow_runs', {
    duplicate_submission_count: { type: 'integer', notNull: true, default: 0 },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('workflow_runs', 'duplicate_submission_count');
  pgm.dropColumns('workflow_run_commands', ['target_worker_id', 'artifact_id']);
};
