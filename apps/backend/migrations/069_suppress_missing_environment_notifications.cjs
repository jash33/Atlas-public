exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM notifications
    WHERE kind = 'environment-difference'
      AND details->>'comparisonState' IN ('missing-in-development', 'missing-in-production');

    CREATE FUNCTION suppress_missing_environment_notification() RETURNS trigger AS $$
    BEGIN
      IF NEW.kind = 'environment-difference'
        AND NEW.details->>'comparisonState' IN ('missing-in-development', 'missing-in-production') THEN
        DELETE FROM notifications
        WHERE organization_id = NEW.organization_id
          AND condition_key = NEW.condition_key;
        RETURN NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER suppress_missing_environment_notification
      BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION suppress_missing_environment_notification();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER suppress_missing_environment_notification ON notifications;
    DROP FUNCTION suppress_missing_environment_notification();
  `);
};
