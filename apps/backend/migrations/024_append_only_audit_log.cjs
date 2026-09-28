exports.up = (pgm) => {
  pgm.createTable('audit_entries', {
    id: 'bigserial',
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text' },
    event_type: {
      type: 'text',
      notNull: true,
      check:
        "event_type IN ('discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment')",
    },
    subject_type: { type: 'text', notNull: true },
    subject_id: { type: 'text', notNull: true },
    actor_id: { type: 'text' },
    details: { type: 'jsonb', notNull: true, default: '{}' },
    recorded_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('audit_entries', 'audit_entries_pk', { primaryKey: ['id'] });
  pgm.createIndex('audit_entries', ['organization_id', 'recorded_at', 'id']);

  pgm.sql(`
    INSERT INTO audit_entries
      (organization_id, event_type, subject_type, subject_id, details, recorded_at)
    SELECT organization_id, 'discovery', 'capability-discovery', id::text,
      jsonb_build_object('serviceId', service_id, 'trigger', trigger), discovered_at
    FROM capability_discoveries;

    INSERT INTO audit_entries
      (organization_id, event_type, subject_type, subject_id, details, recorded_at)
    SELECT change.organization_id, event.event_type, 'capability-change',
      change.discovery_id::text || ':' || trim(change.to_capability_version_id),
      CASE event.event_type
        WHEN 'classification' THEN jsonb_build_object(
          'discoveryId', change.discovery_id::text,
          'trigger', discovery.trigger,
          'fromCapabilityVersionId', trim(change.from_capability_version_id),
          'toCapabilityVersionId', trim(change.to_capability_version_id),
          'classification', change.classification,
          'fieldChanges', change.field_changes)
        ELSE jsonb_build_object(
          'discoveryId', change.discovery_id::text,
          'trigger', discovery.trigger,
          'toCapabilityVersionId', trim(change.to_capability_version_id),
          'affectedWorkflows', change.affected_workflows)
      END,
      discovery.discovered_at
    FROM capability_discovery_changes change
    JOIN capability_discoveries discovery ON discovery.id = change.discovery_id
    CROSS JOIN (VALUES ('classification'), ('reverse-lookup')) event(event_type);

    INSERT INTO audit_entries
      (organization_id, environment_id, event_type, subject_type, subject_id, details,
       recorded_at)
    SELECT candidate.organization_id, candidate.environment_id, event.event_type,
      'migration-candidate', candidate.id::text,
      CASE event.event_type
        WHEN 'generation' THEN jsonb_build_object(
          'author', candidate.author,
          'sourceWorkflowVersionId', candidate.source_workflow_version_id,
          'workflowVersionId', candidate.workflow_version_id,
          'fromCapabilityVersionId', trim(candidate.from_capability_version_id),
          'toCapabilityVersionId', trim(candidate.to_capability_version_id))
        ELSE jsonb_build_object('result', candidate.validation)
      END,
      CASE event.event_type WHEN 'generation' THEN candidate.created_at ELSE candidate.updated_at END
    FROM workflow_migration_candidates candidate
    CROSS JOIN (VALUES ('generation'), ('validation')) event(event_type);

    INSERT INTO audit_entries
      (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
       details, recorded_at)
    SELECT organization_id, environment_id, 'approval', 'workflow-version',
      workflow_version_id, approved_by,
      jsonb_build_object('irHash', trim(ir_hash), 'policyVersion', policy_version), approved_at
    FROM workflow_approvals;

    INSERT INTO audit_entries
      (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
       details, recorded_at)
    SELECT activation.organization_id, activation.environment_id, event.event_type,
      'workflow-activation', activation.id::text,
      CASE event.event_type WHEN 'activation' THEN activation.activated_by
        ELSE activation.rolled_back_by END,
      CASE event.event_type
        WHEN 'activation' THEN jsonb_build_object(
          'previousWorkflowVersionId', activation.previous_workflow_version_id,
          'currentWorkflowVersionId', activation.current_workflow_version_id,
          'previousCapabilityVersionId', trim(activation.previous_capability_version_id),
          'currentCapabilityVersionId', trim(activation.current_capability_version_id))
        ELSE jsonb_build_object(
          'restoredWorkflowVersionId', activation.previous_workflow_version_id,
          'restoredCapabilityVersionId', trim(activation.previous_capability_version_id),
          'replacedWorkflowVersionId', activation.current_workflow_version_id,
          'replacedCapabilityVersionId', trim(activation.current_capability_version_id))
      END,
      CASE event.event_type WHEN 'activation' THEN activation.activated_at
        ELSE activation.rolled_back_at END
    FROM workflow_activations activation
    CROSS JOIN LATERAL (
      VALUES ('activation'),
        (CASE WHEN activation.rolled_back_at IS NOT NULL THEN 'rollback' END)
    ) event(event_type)
    WHERE event.event_type IS NOT NULL;

    INSERT INTO audit_entries
      (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
       details, recorded_at)
    SELECT organization_id, environment_id, 'abandonment', 'workflow-run', run_id,
      operator_id, jsonb_build_object('repairId', repair_id, 'reason', reason), created_at
    FROM workflow_run_repairs
    WHERE action = 'abandon_run';

    CREATE FUNCTION reject_audit_entry_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit entries are append-only';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_entries_append_only
      BEFORE UPDATE OR DELETE ON audit_entries
      FOR EACH ROW EXECUTE FUNCTION reject_audit_entry_mutation();

    CREATE TRIGGER audit_entries_no_truncate
      BEFORE TRUNCATE ON audit_entries
      FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_entry_mutation();

    CREATE FUNCTION audit_capability_discovery() RETURNS trigger AS $$
    BEGIN
      INSERT INTO audit_entries
        (organization_id, event_type, subject_type, subject_id, details, recorded_at)
      VALUES
        (NEW.organization_id, 'discovery', 'capability-discovery', NEW.id::text,
         jsonb_build_object('serviceId', NEW.service_id, 'trigger', NEW.trigger),
         NEW.discovered_at);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_capability_discovery_insert
      AFTER INSERT ON capability_discoveries
      FOR EACH ROW EXECUTE FUNCTION audit_capability_discovery();

    CREATE FUNCTION audit_capability_discovery_change() RETURNS trigger AS $$
    BEGIN
      INSERT INTO audit_entries
        (organization_id, event_type, subject_type, subject_id, details)
      VALUES
        (NEW.organization_id, 'classification', 'capability-change',
         NEW.discovery_id::text || ':' || trim(NEW.to_capability_version_id),
         jsonb_build_object(
           'discoveryId', NEW.discovery_id::text,
           'trigger', (SELECT trigger FROM capability_discoveries WHERE id = NEW.discovery_id),
           'fromCapabilityVersionId', trim(NEW.from_capability_version_id),
           'toCapabilityVersionId', trim(NEW.to_capability_version_id),
           'classification', NEW.classification,
           'fieldChanges', NEW.field_changes)),
        (NEW.organization_id, 'reverse-lookup', 'capability-change',
         NEW.discovery_id::text || ':' || trim(NEW.to_capability_version_id),
         jsonb_build_object(
           'discoveryId', NEW.discovery_id::text,
           'trigger', (SELECT trigger FROM capability_discoveries WHERE id = NEW.discovery_id),
           'toCapabilityVersionId', trim(NEW.to_capability_version_id),
           'affectedWorkflows', NEW.affected_workflows));
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_capability_discovery_change_insert
      AFTER INSERT ON capability_discovery_changes
      FOR EACH ROW EXECUTE FUNCTION audit_capability_discovery_change();

    CREATE FUNCTION audit_migration_candidate() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_entries
          (organization_id, environment_id, event_type, subject_type, subject_id, details,
           recorded_at)
        VALUES
          (NEW.organization_id, NEW.environment_id, 'generation', 'migration-candidate',
           NEW.id::text,
           jsonb_build_object(
             'author', NEW.author,
             'sourceWorkflowVersionId', NEW.source_workflow_version_id,
             'workflowVersionId', NEW.workflow_version_id,
             'fromCapabilityVersionId', trim(NEW.from_capability_version_id),
             'toCapabilityVersionId', trim(NEW.to_capability_version_id)),
           NEW.created_at);
      END IF;
      INSERT INTO audit_entries
        (organization_id, environment_id, event_type, subject_type, subject_id, details,
         recorded_at)
      VALUES
        (NEW.organization_id, NEW.environment_id, 'validation', 'migration-candidate',
         NEW.id::text, jsonb_build_object('result', NEW.validation), NEW.updated_at);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_migration_candidate_insert
      AFTER INSERT ON workflow_migration_candidates
      FOR EACH ROW EXECUTE FUNCTION audit_migration_candidate();

    CREATE TRIGGER audit_migration_candidate_validation_update
      AFTER UPDATE OF validation ON workflow_migration_candidates
      FOR EACH ROW WHEN (OLD.validation IS DISTINCT FROM NEW.validation)
      EXECUTE FUNCTION audit_migration_candidate();

    CREATE FUNCTION audit_workflow_approval() RETURNS trigger AS $$
    BEGIN
      INSERT INTO audit_entries
        (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
         details, recorded_at)
      VALUES
        (NEW.organization_id, NEW.environment_id, 'approval', 'workflow-version',
         NEW.workflow_version_id, NEW.approved_by,
         jsonb_build_object('irHash', trim(NEW.ir_hash), 'policyVersion', NEW.policy_version),
         NEW.approved_at);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_workflow_approval_insert
      AFTER INSERT ON workflow_approvals
      FOR EACH ROW EXECUTE FUNCTION audit_workflow_approval();

    CREATE FUNCTION audit_workflow_activation() RETURNS trigger AS $$
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
             'currentCapabilityVersionId', trim(NEW.current_capability_version_id)),
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
             'replacedCapabilityVersionId', trim(NEW.current_capability_version_id)),
           NEW.rolled_back_at);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_workflow_activation_insert
      AFTER INSERT ON workflow_activations
      FOR EACH ROW EXECUTE FUNCTION audit_workflow_activation();

    CREATE TRIGGER audit_workflow_activation_rollback
      AFTER UPDATE OF rolled_back_at ON workflow_activations
      FOR EACH ROW EXECUTE FUNCTION audit_workflow_activation();

    CREATE FUNCTION audit_workflow_abandonment() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = 'abandon_run' THEN
        INSERT INTO audit_entries
          (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
           details, recorded_at)
        VALUES
          (NEW.organization_id, NEW.environment_id, 'abandonment', 'workflow-run',
           NEW.run_id, NEW.operator_id,
           jsonb_build_object('repairId', NEW.repair_id, 'reason', NEW.reason),
           NEW.created_at);
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_workflow_abandonment_insert
      AFTER INSERT ON workflow_run_repairs
      FOR EACH ROW EXECUTE FUNCTION audit_workflow_abandonment();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER audit_workflow_abandonment_insert ON workflow_run_repairs;
    DROP FUNCTION audit_workflow_abandonment();
    DROP TRIGGER audit_workflow_activation_rollback ON workflow_activations;
    DROP TRIGGER audit_workflow_activation_insert ON workflow_activations;
    DROP FUNCTION audit_workflow_activation();
    DROP TRIGGER audit_workflow_approval_insert ON workflow_approvals;
    DROP FUNCTION audit_workflow_approval();
    DROP TRIGGER audit_migration_candidate_validation_update ON workflow_migration_candidates;
    DROP TRIGGER audit_migration_candidate_insert ON workflow_migration_candidates;
    DROP FUNCTION audit_migration_candidate();
    DROP TRIGGER audit_capability_discovery_change_insert ON capability_discovery_changes;
    DROP FUNCTION audit_capability_discovery_change();
    DROP TRIGGER audit_capability_discovery_insert ON capability_discoveries;
    DROP FUNCTION audit_capability_discovery();
    DROP TRIGGER audit_entries_no_truncate ON audit_entries;
    DROP TRIGGER audit_entries_append_only ON audit_entries;
    DROP FUNCTION reject_audit_entry_mutation();
  `);
  pgm.dropTable('audit_entries');
};
