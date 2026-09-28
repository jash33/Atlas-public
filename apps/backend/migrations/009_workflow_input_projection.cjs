exports.up = (pgm) => {
  pgm.addColumn('organization_environment_policies', {
    workflow_start_input_schema: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'{"required":{}}'::jsonb`),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('organization_environment_policies', 'workflow_start_input_schema');
};
