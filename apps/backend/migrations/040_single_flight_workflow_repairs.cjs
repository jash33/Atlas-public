exports.up = (pgm) => {
  pgm.createIndex('workflow_run_repairs', ['organization_id', 'environment_id', 'run_id'], {
    name: 'workflow_run_repairs_active_run_unique',
    unique: true,
    where: "status IN ('queued', 'dispatched')",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('workflow_run_repairs', [], {
    name: 'workflow_run_repairs_active_run_unique',
  });
};
