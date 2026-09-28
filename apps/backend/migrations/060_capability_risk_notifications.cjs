const priorAuditEvents =
  "'discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment', 'organization-settings', 'secret-reference', 'membership', 'capability-safety-approval', 'capability-host-policy', 'repair', 'capability-source-authority', 'capability-loss-override'";

exports.up = (pgm) => {
  pgm.addColumns('notifications', {
    kind: { type: 'text', notNull: true, default: 'general' },
    condition_key: { type: 'text' },
    subject_label: { type: 'text' },
    next_action: { type: 'text' },
    affected_workflows: { type: 'jsonb', notNull: true, default: '[]' },
    details: { type: 'jsonb', notNull: true, default: '{}' },
    occurrence_count: { type: 'integer', notNull: true, default: 1 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    resolved_by: { type: 'text' },
    resolution_reason: { type: 'text' },
  });
  pgm.sql(`CREATE UNIQUE INDEX notifications_one_condition
    ON notifications (organization_id, environment_id, condition_key)
    WHERE condition_key IS NOT NULL`);
  pgm.addConstraint('notifications', 'notifications_kind_check', {
    check:
      "kind IN ('general', 'capability-removal', 'workflow-risk', 'stale-source', 'source-conflict', 'environment-difference', 'discovery-summary')",
  });

  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check: `event_type IN (${priorAuditEvents}, 'notification-resolution')`,
  });

  pgm.sql(`
    CREATE FUNCTION upsert_risk_notification(
      p_organization_id text, p_environment_id text, p_condition_key text,
      p_notification jsonb
    ) RETURNS void AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM environments
        WHERE organization_id = p_organization_id AND id = p_environment_id
      ) THEN
        RETURN;
      END IF;
      INSERT INTO notifications
        (id, organization_id, environment_id, kind, condition_key, severity, title, message,
         navigation_target, subject_label, next_action, affected_workflows, details)
      VALUES
        ('risk-' || md5(p_organization_id || ':' || p_environment_id || ':' || p_condition_key),
         p_organization_id, p_environment_id, p_notification->>'kind', p_condition_key,
         p_notification->>'severity', p_notification->>'title', p_notification->>'message',
         p_notification->>'navigationTarget', p_notification->>'subjectLabel',
         p_notification->>'nextAction',
         COALESCE(p_notification->'affectedWorkflows', '[]'::jsonb),
         COALESCE(p_notification->'details', '{}'::jsonb))
      ON CONFLICT (organization_id, environment_id, condition_key)
        WHERE condition_key IS NOT NULL
      DO UPDATE SET kind = EXCLUDED.kind, severity = EXCLUDED.severity,
        title = EXCLUDED.title, message = EXCLUDED.message,
        navigation_target = EXCLUDED.navigation_target,
        subject_label = EXCLUDED.subject_label, next_action = EXCLUDED.next_action,
        affected_workflows = EXCLUDED.affected_workflows, details = EXCLUDED.details,
        read_at = CASE WHEN notifications.resolved_at IS NOT NULL THEN NULL
                       ELSE notifications.read_at END,
        resolved_at = NULL, resolved_by = NULL, resolution_reason = NULL,
        occurrence_count = notifications.occurrence_count +
          CASE WHEN notifications.resolved_at IS NOT NULL THEN 1 ELSE 0 END,
        updated_at = current_timestamp;
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION upsert_workflow_risk_notification(
      p_organization_id text, p_environment_id text, p_capability_identity_id text,
      p_capability_label text, p_workflow jsonb
    ) RETURNS void AS $$
    BEGIN
      PERFORM upsert_risk_notification(p_organization_id, p_environment_id,
        'workflow-risk:' || (p_workflow->>'workflowId') || ':' || p_capability_identity_id,
        jsonb_build_object(
          'kind', 'workflow-risk', 'severity', 'critical',
          'title', 'Workflow action required',
          'message', (p_workflow->>'name') || ' pins removed capability ' || p_capability_label || '.',
          'navigationTarget', '#/workflow-catalog?workflowId=' || (p_workflow->>'workflowId'),
          'subjectLabel', p_workflow->>'name',
          'nextAction', 'Migrate and approve the workflow against a valid capability.',
          'affectedWorkflows', jsonb_build_array(p_workflow),
          'details', jsonb_build_object('workflowId', p_workflow->>'workflowId',
            'workflowVersionId', p_workflow->>'workflowVersionId',
            'capabilityIdentityId', p_capability_identity_id)));
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION resolve_risk_notification(
      p_organization_id text, p_environment_id text, p_condition_key text, p_reason text
    ) RETURNS void AS $$
    BEGIN
      UPDATE notifications SET resolved_at = COALESCE(resolved_at, current_timestamp),
        resolution_reason = COALESCE(resolution_reason, p_reason), updated_at = current_timestamp
      WHERE organization_id = p_organization_id AND environment_id = p_environment_id
        AND condition_key = p_condition_key AND resolved_at IS NULL;
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION notify_capability_observation_risk() RETURNS trigger AS $$
    DECLARE
      capability_label text;
      workflows jsonb;
      workflow_entry record;
      counterpart record;
      comparison_state text;
      comparison_notification_environment text;
    BEGIN
      SELECT COALESCE(identity.operation_id, identity.channel_address || ' / ' || identity.message_key,
                      identity.service_id)
        INTO capability_label
      FROM capability_identities identity WHERE identity.id = NEW.capability_identity_id;

      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
               'workflowVersionId', dependency.workflow_version_id,
               'stepId', dependency.step_id,
               'workflowId', version.workflow_id,
               'name', workflow_identity.name)) FILTER (WHERE dependency.workflow_version_id IS NOT NULL),
             '[]'::jsonb)
        INTO workflows
      FROM workflow_capability_dependencies dependency
      JOIN workflow_versions version ON version.organization_id = dependency.organization_id
        AND version.workflow_version_id = dependency.workflow_version_id
      JOIN workflow_identities workflow_identity
        ON workflow_identity.organization_id = version.organization_id
        AND workflow_identity.workflow_id = version.workflow_id
      JOIN workflow_environment_versions scoped ON scoped.organization_id = dependency.organization_id
        AND scoped.environment_id = NEW.environment_id
        AND scoped.workflow_version_id = dependency.workflow_version_id
      WHERE dependency.organization_id = NEW.organization_id
        AND dependency.capability_version_id = NEW.capability_version_id;

      IF NEW.availability_status = 'removed' AND NEW.freshness_status = 'fresh' THEN
        PERFORM upsert_risk_notification(NEW.organization_id, NEW.environment_id,
          'capability-removal:' || NEW.capability_identity_id, jsonb_build_object(
          'kind', 'capability-removal',
          'severity', CASE WHEN jsonb_array_length(workflows) > 0 THEN 'critical' ELSE 'warning' END,
          'title', CASE WHEN jsonb_array_length(workflows) > 0
            THEN 'Removed capability blocks workflows' ELSE 'Capability removed' END,
          'message', capability_label || ' is absent from a successful discovery. ' ||
            CASE WHEN jsonb_array_length(workflows) > 0
              THEN jsonb_array_length(workflows) || ' workflow dependency record(s) require action.'
              ELSE 'It is excluded from new planning.' END,
          'navigationTarget', '#/capabilities?capability=' || NEW.capability_identity_id,
          'subjectLabel', capability_label,
          'nextAction', 'Rediscover the source or migrate affected workflows.',
          'affectedWorkflows', workflows,
          'details', jsonb_build_object('capabilityIdentityId', NEW.capability_identity_id,
            'capabilityVersionId', trim(NEW.capability_version_id),
            'reason', NEW.status_reason)));
        FOR workflow_entry IN SELECT * FROM jsonb_array_elements(workflows) LOOP
          PERFORM upsert_workflow_risk_notification(
            NEW.organization_id, NEW.environment_id, NEW.capability_identity_id::text,
            capability_label, workflow_entry.value);
        END LOOP;
      ELSE
        PERFORM resolve_risk_notification(NEW.organization_id, NEW.environment_id,
          'capability-removal:' || NEW.capability_identity_id, 'successful-rediscovery');
        UPDATE notifications SET resolved_at = COALESCE(resolved_at, current_timestamp),
          resolution_reason = COALESCE(resolution_reason, 'successful-rediscovery'),
          updated_at = current_timestamp
        WHERE organization_id = NEW.organization_id AND environment_id = NEW.environment_id
          AND kind = 'workflow-risk'
          AND details->>'capabilityIdentityId' = NEW.capability_identity_id::text
          AND resolved_at IS NULL;
      END IF;

      IF NEW.freshness_status = 'stale' THEN
        PERFORM upsert_risk_notification(NEW.organization_id, NEW.environment_id,
          'stale-source:' || NEW.capability_identity_id, jsonb_build_object(
          'kind', 'stale-source', 'severity', 'warning',
          'title', 'Capability source is stale',
          'message', capability_label || ' retains its last observation because ' ||
            replace(NEW.status_reason, '-', ' ') || '.',
          'navigationTarget', '#/capabilities?capability=' || NEW.capability_identity_id,
          'subjectLabel', capability_label,
          'nextAction', 'Reconnect or successfully rediscover the source.',
          'affectedWorkflows', workflows,
          'details', jsonb_build_object('capabilityIdentityId', NEW.capability_identity_id,
            'reason', NEW.status_reason)));
      ELSE
        PERFORM resolve_risk_notification(NEW.organization_id, NEW.environment_id,
          'stale-source:' || NEW.capability_identity_id, 'successful-rediscovery');
      END IF;

      IF NEW.source_resolution_status = 'conflicting' THEN
        PERFORM upsert_risk_notification(NEW.organization_id, NEW.environment_id,
          'source-conflict:' || NEW.capability_identity_id, jsonb_build_object(
          'kind', 'source-conflict', 'severity', 'warning',
          'title', 'Conflicting capability sources',
          'message', 'Multiple sources claim different current contracts for ' || capability_label || '.',
          'navigationTarget', '#/capabilities?capability=' || NEW.capability_identity_id,
          'subjectLabel', capability_label,
          'nextAction', 'Designate an authoritative source or correct the registrations.',
          'affectedWorkflows', workflows,
          'details', jsonb_build_object('capabilityIdentityId', NEW.capability_identity_id)));
      ELSE
        PERFORM resolve_risk_notification(NEW.organization_id, NEW.environment_id,
          'source-conflict:' || NEW.capability_identity_id, 'conflict-resolved');
      END IF;

      SELECT observation.* INTO counterpart
      FROM environment_capability_observations observation
      WHERE observation.organization_id = NEW.organization_id
        AND observation.capability_identity_id = NEW.capability_identity_id
        AND observation.environment_id <> NEW.environment_id
      ORDER BY observation.environment_id LIMIT 1;
      comparison_notification_environment := CASE WHEN EXISTS (
        SELECT 1 FROM environments WHERE organization_id = NEW.organization_id
          AND id = 'development'
      ) THEN 'development' ELSE NEW.environment_id END;
      IF FOUND THEN
        comparison_state := CASE
          WHEN trim(NEW.capability_version_id) = trim(counterpart.capability_version_id)
            AND NEW.availability_status = counterpart.availability_status
            AND NEW.freshness_status = counterpart.freshness_status
            AND NEW.source_resolution_status = counterpart.source_resolution_status THEN 'matching'
          WHEN NEW.source_resolution_status = 'conflicting' OR counterpart.source_resolution_status = 'conflicting' THEN 'conflicting'
          WHEN NEW.availability_status = 'removed' OR counterpart.availability_status = 'removed' THEN 'removed'
          WHEN NEW.freshness_status = 'stale' OR counterpart.freshness_status = 'stale' THEN 'stale'
          ELSE 'different' END;
        IF comparison_state = 'matching' THEN
          UPDATE notifications SET resolved_at = COALESCE(resolved_at, current_timestamp),
            resolution_reason = COALESCE(resolution_reason, 'environments-converged'),
            updated_at = current_timestamp
          WHERE organization_id = NEW.organization_id
            AND condition_key = 'environment-difference:' || NEW.capability_identity_id
            AND resolved_at IS NULL;
        ELSE
          PERFORM upsert_risk_notification(NEW.organization_id, comparison_notification_environment,
            'environment-difference:' || NEW.capability_identity_id, jsonb_build_object(
            'kind', 'environment-difference', 'severity', 'warning',
            'title', 'Capability environments differ',
            'message', capability_label || ' has a ' || comparison_state ||
              ' Development / Production comparison.',
            'navigationTarget', '#/capabilities?comparison=different&capability=' || NEW.capability_identity_id,
            'subjectLabel', capability_label,
            'nextAction', 'Compare both observations and converge them deliberately.',
            'affectedWorkflows', workflows,
            'details', jsonb_build_object('capabilityIdentityId', NEW.capability_identity_id,
              'comparisonState', comparison_state)));
        END IF;
      ELSE
        comparison_state := CASE WHEN NEW.environment_id = 'development'
          THEN 'missing-in-production' ELSE 'missing-in-development' END;
        PERFORM upsert_risk_notification(NEW.organization_id, comparison_notification_environment,
          'environment-difference:' || NEW.capability_identity_id, jsonb_build_object(
          'kind', 'environment-difference', 'severity', 'warning',
          'title', 'Capability missing from an environment',
          'message', capability_label || ' is ' || replace(comparison_state, '-', ' ') || '.',
          'navigationTarget', '#/capabilities?comparison=different&capability=' || NEW.capability_identity_id,
          'subjectLabel', capability_label,
          'nextAction', 'Discover the missing environment or confirm its intended absence.',
          'affectedWorkflows', workflows,
          'details', jsonb_build_object('capabilityIdentityId', NEW.capability_identity_id,
            'comparisonState', comparison_state)));
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER notify_capability_observation_risk
      AFTER INSERT OR UPDATE OF capability_version_id, availability_status, freshness_status,
        source_resolution_status ON environment_capability_observations
      FOR EACH ROW EXECUTE FUNCTION notify_capability_observation_risk();

    CREATE FUNCTION refresh_removed_capability_risk_for_workflow(
      p_organization_id text, p_workflow_version_id text
    ) RETURNS void AS $$
    DECLARE
      risk record;
      affected_workflow jsonb;
    BEGIN
      FOR risk IN
        SELECT observation.environment_id, observation.capability_identity_id,
          identity.operation_id AS capability_label, version.workflow_id,
          identity_workflow.name AS workflow_name, dependency.step_id
        FROM workflow_capability_dependencies dependency
        JOIN capability_versions capability
          ON capability.organization_id = dependency.organization_id
         AND capability.capability_version_id = dependency.capability_version_id
        JOIN capability_identities identity ON identity.id = capability.capability_identity_id
        JOIN environment_capability_observations observation
          ON observation.organization_id = dependency.organization_id
         AND observation.capability_identity_id = capability.capability_identity_id
         AND observation.capability_version_id = dependency.capability_version_id
        JOIN workflow_versions version
          ON version.organization_id = dependency.organization_id
         AND version.workflow_version_id = dependency.workflow_version_id
        JOIN workflow_identities identity_workflow
          ON identity_workflow.organization_id = version.organization_id
         AND identity_workflow.workflow_id = version.workflow_id
        JOIN workflow_environment_versions scoped
          ON scoped.organization_id = dependency.organization_id
         AND scoped.environment_id = observation.environment_id
         AND scoped.workflow_version_id = dependency.workflow_version_id
        WHERE dependency.organization_id = p_organization_id
          AND dependency.workflow_version_id = p_workflow_version_id
          AND observation.availability_status = 'removed'
          AND observation.freshness_status = 'fresh'
      LOOP
        affected_workflow := jsonb_build_object(
          'workflowVersionId', p_workflow_version_id, 'stepId', risk.step_id,
          'workflowId', risk.workflow_id, 'name', risk.workflow_name);
        UPDATE notifications SET
          severity = 'critical', title = 'Removed capability blocks workflows',
          message = risk.capability_label ||
            ' is absent from a successful discovery. Workflow dependencies require action.',
          affected_workflows = CASE
            WHEN affected_workflows @> jsonb_build_array(affected_workflow) THEN affected_workflows
            ELSE affected_workflows || jsonb_build_array(affected_workflow) END,
          updated_at = current_timestamp
        WHERE organization_id = p_organization_id
          AND environment_id = risk.environment_id
          AND condition_key = 'capability-removal:' || risk.capability_identity_id;
        PERFORM upsert_workflow_risk_notification(
          p_organization_id, risk.environment_id, risk.capability_identity_id::text,
          risk.capability_label, affected_workflow);
      END LOOP;
    END;
    $$ LANGUAGE plpgsql;

    CREATE FUNCTION refresh_risk_after_workflow_dependency() RETURNS trigger AS $$
    BEGIN
      PERFORM refresh_removed_capability_risk_for_workflow(
        NEW.organization_id, NEW.workflow_version_id);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER refresh_risk_after_workflow_dependency
      AFTER INSERT OR UPDATE OF capability_version_id ON workflow_capability_dependencies
      FOR EACH ROW EXECUTE FUNCTION refresh_risk_after_workflow_dependency();

    CREATE FUNCTION notify_capability_discovery_summary() RETURNS trigger AS $$
    DECLARE
      environment text;
      service text;
      change_count integer;
      workflows jsonb;
      change_details jsonb;
      summary_severity text;
    BEGIN
      SELECT environment_id, service_id INTO environment, service
      FROM capability_discoveries WHERE id = NEW.discovery_id;
      SELECT count(DISTINCT change.from_capability_version_id),
        COALESCE(jsonb_agg(DISTINCT workflow) FILTER (WHERE workflow <> 'null'::jsonb), '[]'::jsonb),
        COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
          'fromCapabilityVersionId', trim(change.from_capability_version_id),
          'toCapabilityVersionId', trim(change.to_capability_version_id),
          'classification', change.classification,
          'fieldChanges', change.field_changes)) FILTER (WHERE change.discovery_id IS NOT NULL), '[]'::jsonb),
        CASE WHEN bool_or(change.classification IN ('breaking', 'conditional'))
          THEN 'warning' ELSE 'info' END
        INTO change_count, workflows, change_details, summary_severity
      FROM capability_discovery_changes change
      LEFT JOIN LATERAL jsonb_array_elements(change.affected_workflows) workflow ON true
      WHERE change.discovery_id = NEW.discovery_id AND change.change_kind = 'version-change';
      IF change_count > 0 THEN
        PERFORM upsert_risk_notification(NEW.organization_id, environment,
          'discovery:' || NEW.discovery_id, jsonb_build_object(
          'kind', 'discovery-summary', 'severity', summary_severity,
          'title', service || ' contract changes',
          'message', change_count || ' declared-contract change(s) were observed in one discovery.',
          'navigationTarget', '#/changes?discoveryId=' || NEW.discovery_id,
          'subjectLabel', service,
          'nextAction', 'Review the grouped change details and affected workflows.',
          'affectedWorkflows', workflows,
          'details', jsonb_build_object('discoveryId', NEW.discovery_id,
            'changeCount', change_count, 'changes', change_details)));
        UPDATE notifications SET occurrence_count = 1
        WHERE organization_id = NEW.organization_id AND environment_id = environment
          AND condition_key = 'discovery:' || NEW.discovery_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER notify_capability_discovery_summary
      AFTER INSERT ON capability_discovery_changes
      FOR EACH ROW EXECUTE FUNCTION notify_capability_discovery_summary();

    CREATE FUNCTION resolve_migrated_workflow_risk() RETURNS trigger AS $$
    DECLARE workflow_id_value text;
    BEGIN
      PERFORM refresh_removed_capability_risk_for_workflow(
        NEW.organization_id, NEW.workflow_version_id);
      IF NEW.is_active AND NEW.lifecycle_status = 'active' THEN
        SELECT workflow_id INTO workflow_id_value FROM workflow_versions
        WHERE organization_id = NEW.organization_id
          AND workflow_version_id = NEW.workflow_version_id;
        IF NOT EXISTS (
          SELECT 1
          FROM workflow_capability_dependencies dependency
          JOIN capability_versions version
            ON version.organization_id = dependency.organization_id
           AND version.capability_version_id = dependency.capability_version_id
          JOIN environment_capability_observations observation
            ON observation.organization_id = dependency.organization_id
           AND observation.environment_id = NEW.environment_id
           AND observation.capability_identity_id = version.capability_identity_id
           AND observation.capability_version_id = dependency.capability_version_id
          WHERE dependency.organization_id = NEW.organization_id
            AND dependency.workflow_version_id = NEW.workflow_version_id
            AND observation.availability_status = 'removed'
            AND observation.freshness_status = 'fresh'
        ) THEN
          UPDATE notifications SET resolved_at = COALESCE(resolved_at, current_timestamp),
            resolution_reason = COALESCE(resolution_reason, 'workflow-migrated'),
            updated_at = current_timestamp
          WHERE organization_id = NEW.organization_id AND environment_id = NEW.environment_id
            AND kind = 'workflow-risk' AND details->>'workflowId' = workflow_id_value
            AND resolved_at IS NULL;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER resolve_migrated_workflow_risk
      AFTER INSERT OR UPDATE OF lifecycle_status, is_active ON workflow_environment_versions
      FOR EACH ROW EXECUTE FUNCTION resolve_migrated_workflow_risk();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER resolve_migrated_workflow_risk ON workflow_environment_versions;
    DROP FUNCTION resolve_migrated_workflow_risk();
    DROP TRIGGER notify_capability_discovery_summary ON capability_discovery_changes;
    DROP FUNCTION notify_capability_discovery_summary();
    DROP TRIGGER refresh_risk_after_workflow_dependency ON workflow_capability_dependencies;
    DROP FUNCTION refresh_risk_after_workflow_dependency();
    DROP FUNCTION refresh_removed_capability_risk_for_workflow(text, text);
    DROP TRIGGER notify_capability_observation_risk ON environment_capability_observations;
    DROP FUNCTION notify_capability_observation_risk();
    DROP FUNCTION resolve_risk_notification(text, text, text, text);
    DROP FUNCTION upsert_workflow_risk_notification(text, text, text, text, jsonb);
    DROP FUNCTION upsert_risk_notification(text, text, text, jsonb);
  `);
  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check: `event_type IN (${priorAuditEvents})`,
  });
  pgm.sql('DROP INDEX notifications_one_condition');
  pgm.dropConstraint('notifications', 'notifications_kind_check');
  pgm.dropColumns('notifications', [
    'kind',
    'condition_key',
    'subject_label',
    'next_action',
    'affected_workflows',
    'details',
    'occurrence_count',
    'updated_at',
    'resolved_by',
    'resolution_reason',
  ]);
};
