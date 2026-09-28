exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION notify_notification_change() RETURNS trigger AS $$
    BEGIN
      PERFORM pg_notify('atlas_notifications', json_build_object(
        'schema', TG_TABLE_SCHEMA,
        'organizationId', CASE WHEN TG_OP = 'DELETE' THEN OLD.organization_id ELSE NEW.organization_id END
      )::text);
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER notification_changed AFTER INSERT OR UPDATE OR DELETE ON notifications
      FOR EACH ROW EXECUTE FUNCTION notify_notification_change();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER notification_changed ON notifications;
    DROP FUNCTION notify_notification_change();`);
};
