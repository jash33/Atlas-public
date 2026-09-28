exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION reject_capability_version_update() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'published capability versions are immutable';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER capability_versions_are_immutable
      BEFORE UPDATE ON capability_versions
      FOR EACH ROW EXECUTE FUNCTION reject_capability_version_update();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER capability_versions_are_immutable ON capability_versions;
    DROP FUNCTION reject_capability_version_update();
  `);
};
