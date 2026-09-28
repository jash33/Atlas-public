exports.up = (pgm) => {
  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check:
      "event_type IN ('discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment', 'organization-settings', 'secret-reference', 'membership', 'capability-safety-approval', 'capability-host-policy', 'repair')",
  });

  pgm.sql(`
    INSERT INTO audit_entries
      (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
       details, recorded_at)
    SELECT organization_id, environment_id, 'repair', 'workflow-run', run_id, operator_id,
      jsonb_build_object(
        'repairId', repair_id,
        'action', action,
        'stepId', step_id,
        'reason', reason,
        'warning', warning,
        'status', status,
        'error', error),
      COALESCE(completed_at, created_at)
    FROM workflow_run_repairs;

    CREATE FUNCTION audit_workflow_repair() RETURNS trigger AS $$
    BEGIN
      INSERT INTO audit_entries
        (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
         details, recorded_at)
      VALUES
        (NEW.organization_id, NEW.environment_id, 'repair', 'workflow-run', NEW.run_id,
         NEW.operator_id,
         jsonb_build_object(
           'repairId', NEW.repair_id,
           'action', NEW.action,
           'stepId', NEW.step_id,
           'reason', NEW.reason,
           'warning', NEW.warning,
           'status', NEW.status,
           'error', NEW.error),
         CASE WHEN TG_OP = 'UPDATE' THEN COALESCE(NEW.completed_at, current_timestamp)
           ELSE NEW.created_at END);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_workflow_repair_insert
      AFTER INSERT ON workflow_run_repairs
      FOR EACH ROW EXECUTE FUNCTION audit_workflow_repair();

    CREATE TRIGGER audit_workflow_repair_status_update
      AFTER UPDATE OF status ON workflow_run_repairs
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION audit_workflow_repair();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER audit_workflow_repair_status_update ON workflow_run_repairs;
    DROP TRIGGER audit_workflow_repair_insert ON workflow_run_repairs;
    DROP FUNCTION audit_workflow_repair();
    ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_append_only;
    DELETE FROM audit_entries WHERE event_type = 'repair';
    ALTER TABLE audit_entries ENABLE TRIGGER audit_entries_append_only;
  `);
  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check:
      "event_type IN ('discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment', 'organization-settings', 'secret-reference', 'membership', 'capability-safety-approval', 'capability-host-policy')",
  });
};
