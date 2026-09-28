exports.up = (pgm) => {
  pgm.addColumn('workflow_migration_candidates', {
    planner_authored_literal_paths: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'[]'::jsonb`),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('workflow_migration_candidates', 'planner_authored_literal_paths');
};
