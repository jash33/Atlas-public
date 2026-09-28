// Workflow inputs are declared per workflow (or taken from the first step's
// required request fields), never fixed by environment policy.
exports.up = (pgm) => {
  pgm.dropColumn('organization_environment_policies', 'workflow_start_input_schema');
};

exports.down = (pgm) => {
  pgm.addColumn('organization_environment_policies', {
    workflow_start_input_schema: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'{"required":{}}'::jsonb`),
    },
  });
};
