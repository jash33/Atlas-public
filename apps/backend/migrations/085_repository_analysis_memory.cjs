exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE repository_analysis_runs ADD COLUMN analysis_memory jsonb`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE repository_analysis_runs DROP COLUMN analysis_memory`);
};
