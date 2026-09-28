exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE github_repository_connections
      ADD COLUMN progress jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN notify_environment_id text,
      ADD COLUMN last_notification_key text,
      ADD CONSTRAINT repository_notification_environment_fk
        FOREIGN KEY (organization_id, notify_environment_id)
        REFERENCES environments(organization_id, id) ON DELETE SET NULL (notify_environment_id);
    ALTER TABLE repository_analysis_runs ADD COLUMN progress jsonb NOT NULL DEFAULT '{}';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE repository_analysis_runs DROP COLUMN progress;
    ALTER TABLE github_repository_connections
      DROP COLUMN progress, DROP COLUMN notify_environment_id, DROP COLUMN last_notification_key;
  `);
};
