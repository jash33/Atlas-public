function approvalAuditFunction(outcome) {
  return `
    CREATE OR REPLACE FUNCTION audit_workflow_approval() RETURNS trigger AS $$
    BEGIN
      INSERT INTO audit_entries
        (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
         details, recorded_at)
      VALUES
        (NEW.organization_id, NEW.environment_id, 'approval', 'workflow-version',
         NEW.workflow_version_id, NEW.approved_by,
         jsonb_build_object(
           'irHash', trim(NEW.ir_hash),
           'policyVersion', NEW.policy_version${outcome}),
         NEW.approved_at);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;`;
}

function activationAuditFunction(outcome) {
  return `
    CREATE OR REPLACE FUNCTION audit_workflow_activation() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_entries
          (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
           details, recorded_at)
        VALUES
          (NEW.organization_id, NEW.environment_id, 'activation', 'workflow-activation',
           NEW.id::text, NEW.activated_by,
           jsonb_build_object(
             'previousWorkflowVersionId', NEW.previous_workflow_version_id,
             'currentWorkflowVersionId', NEW.current_workflow_version_id,
             'previousCapabilityVersionId', trim(NEW.previous_capability_version_id),
             'currentCapabilityVersionId', trim(NEW.current_capability_version_id)${outcome}),
           NEW.activated_at);
      ELSIF OLD.rolled_back_at IS NULL AND NEW.rolled_back_at IS NOT NULL THEN
        INSERT INTO audit_entries
          (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
           details, recorded_at)
        VALUES
          (NEW.organization_id, NEW.environment_id, 'rollback', 'workflow-activation',
           NEW.id::text, NEW.rolled_back_by,
           jsonb_build_object(
             'restoredWorkflowVersionId', NEW.previous_workflow_version_id,
             'restoredCapabilityVersionId', trim(NEW.previous_capability_version_id),
             'replacedWorkflowVersionId', NEW.current_workflow_version_id,
             'replacedCapabilityVersionId', trim(NEW.current_capability_version_id)${outcome}),
           NEW.rolled_back_at);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;`;
}

exports.up = (pgm) => {
  pgm.sql(approvalAuditFunction(", 'outcome', 'succeeded'"));
  pgm.sql(activationAuditFunction(", 'outcome', 'succeeded'"));
};

exports.down = (pgm) => {
  pgm.sql(approvalAuditFunction(''));
  pgm.sql(activationAuditFunction(''));
};
