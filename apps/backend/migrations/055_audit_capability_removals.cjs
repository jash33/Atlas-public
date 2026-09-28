exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_capability_discovery_change() RETURNS trigger AS $$
    DECLARE
      subject text := NEW.discovery_id::text || ':' ||
        trim(COALESCE(NEW.to_capability_version_id, NEW.from_capability_version_id));
      base_details jsonb := jsonb_build_object(
        'discoveryId', NEW.discovery_id::text,
        'trigger', (SELECT trigger FROM capability_discoveries WHERE id = NEW.discovery_id),
        'fromCapabilityVersionId', trim(NEW.from_capability_version_id),
        'toCapabilityVersionId', CASE WHEN NEW.to_capability_version_id IS NULL
          THEN NULL ELSE trim(NEW.to_capability_version_id) END,
        'changeKind', NEW.change_kind);
    BEGIN
      INSERT INTO audit_entries
        (organization_id, event_type, subject_type, subject_id, details)
      VALUES
        (NEW.organization_id, 'classification', 'capability-change', subject,
         base_details || jsonb_build_object(
           'classification', NEW.classification,
           'fieldChanges', NEW.field_changes)),
        (NEW.organization_id, 'reverse-lookup', 'capability-change', subject,
         base_details || jsonb_build_object(
           'affectedWorkflows', NEW.affected_workflows));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION audit_capability_discovery_change() RETURNS trigger AS $$
    DECLARE
      subject text := NEW.discovery_id::text || ':' || trim(NEW.to_capability_version_id);
      base_details jsonb := jsonb_build_object(
        'discoveryId', NEW.discovery_id::text,
        'trigger', (SELECT trigger FROM capability_discoveries WHERE id = NEW.discovery_id),
        'toCapabilityVersionId', trim(NEW.to_capability_version_id));
    BEGIN
      INSERT INTO audit_entries
        (organization_id, event_type, subject_type, subject_id, details)
      VALUES
        (NEW.organization_id, 'classification', 'capability-change', subject,
         base_details || jsonb_build_object(
           'fromCapabilityVersionId', trim(NEW.from_capability_version_id),
           'classification', NEW.classification,
           'fieldChanges', NEW.field_changes)),
        (NEW.organization_id, 'reverse-lookup', 'capability-change', subject,
         base_details || jsonb_build_object(
           'affectedWorkflows', NEW.affected_workflows));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};
