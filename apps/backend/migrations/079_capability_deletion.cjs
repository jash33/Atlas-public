exports.up = (pgm) => {
  pgm.addColumns('environment_capability_observations', {
    deleted_at: { type: 'timestamptz' },
    deleted_by: { type: 'text' },
  });
  pgm.sql(`
    CREATE FUNCTION keep_deleted_capabilities_removed() RETURNS trigger AS $$
    BEGIN
      IF NEW.deleted_at IS NOT NULL THEN
        NEW.availability_status := 'removed';
        NEW.freshness_status := 'fresh';
        NEW.status_reason := 'deleted-by-user';
        IF TG_OP = 'UPDATE' AND OLD.deleted_at IS NOT NULL THEN
          NEW.capability_version_id := OLD.capability_version_id;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER keep_deleted_capabilities_removed
      BEFORE INSERT OR UPDATE ON environment_capability_observations
      FOR EACH ROW EXECUTE FUNCTION keep_deleted_capabilities_removed();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER keep_deleted_capabilities_removed ON environment_capability_observations;
    DROP FUNCTION keep_deleted_capabilities_removed();
  `);
  pgm.dropColumns('environment_capability_observations', ['deleted_at', 'deleted_by']);
};
