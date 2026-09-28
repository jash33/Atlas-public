exports.up = (pgm) => {
  pgm.dropConstraint(
    'workflow_environment_versions',
    'workflow_environment_versions_lifecycle_status_check',
  );
  pgm.addConstraint(
    'workflow_environment_versions',
    'workflow_environment_versions_lifecycle_status_check',
    {
      check:
        "lifecycle_status IN ('draft', 'testing', 'awaiting-approval', 'approved-inactive', 'active', 'blocked', 'action-required')",
    },
  );

  pgm.createTable('workflow_capability_loss_overrides', {
    id: 'bigserial',
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
    reason: { type: 'text', notNull: true, check: 'length(trim(reason)) > 0' },
    created_by: { type: 'text', notNull: true, references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    expires_at: { type: 'timestamptz' },
    revoked_by: { type: 'text', references: 'users' },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('workflow_capability_loss_overrides', 'workflow_capability_loss_overrides_pk', {
    primaryKey: ['id'],
  });
  pgm.addConstraint(
    'workflow_capability_loss_overrides',
    'workflow_capability_loss_overrides_environment_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'environment_id'],
        references: 'environments(organization_id, id)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.addConstraint(
    'workflow_capability_loss_overrides',
    'workflow_capability_loss_overrides_workflow_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'workflow_version_id'],
        references: 'workflow_versions(organization_id, workflow_version_id)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.addConstraint(
    'workflow_capability_loss_overrides',
    'workflow_capability_loss_overrides_capability_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
      },
    },
  );
  pgm.addConstraint(
    'workflow_capability_loss_overrides',
    'workflow_capability_loss_overrides_revocation_check',
    {
      check:
        '(revoked_at IS NULL AND revoked_by IS NULL) OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)',
    },
  );
  pgm.createIndex('workflow_capability_loss_overrides', [
    'organization_id',
    'environment_id',
    'workflow_version_id',
    'capability_version_id',
  ]);

  pgm.sql(`
    CREATE VIEW confirmed_workflow_capability_losses AS
    SELECT dependency.organization_id, observation.environment_id,
           dependency.workflow_version_id, dependency.capability_version_id
    FROM workflow_capability_dependencies dependency
    JOIN capability_versions version
      ON version.organization_id = dependency.organization_id
     AND version.capability_version_id = dependency.capability_version_id
    JOIN environment_capability_observations observation
      ON observation.organization_id = dependency.organization_id
     AND observation.capability_identity_id = version.capability_identity_id
     AND observation.capability_version_id = dependency.capability_version_id
    WHERE observation.availability_status = 'removed'
      AND observation.freshness_status = 'fresh';

    CREATE VIEW active_workflow_capability_loss_overrides AS
    SELECT id, organization_id, environment_id, workflow_version_id,
           capability_version_id, expires_at
    FROM workflow_capability_loss_overrides
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > current_timestamp);
  `);

  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check:
      "event_type IN ('discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment', 'organization-settings', 'secret-reference', 'membership', 'capability-safety-approval', 'capability-host-policy', 'repair', 'capability-source-authority', 'capability-loss-override')",
  });

  pgm.sql(`
    CREATE FUNCTION mark_workflows_for_confirmed_capability_loss() RETURNS trigger AS $$
    BEGIN
      IF NEW.availability_status = 'removed' AND NEW.freshness_status = 'fresh'
         AND (TG_OP = 'INSERT' OR OLD.availability_status IS DISTINCT FROM NEW.availability_status
              OR OLD.freshness_status IS DISTINCT FROM NEW.freshness_status) THEN
        UPDATE workflow_environment_versions scoped
        SET lifecycle_status = 'action-required', updated_at = current_timestamp
        FROM workflow_capability_dependencies dependency
        WHERE dependency.organization_id = NEW.organization_id
          AND dependency.capability_version_id = NEW.capability_version_id
          AND scoped.organization_id = dependency.organization_id
          AND scoped.environment_id = NEW.environment_id
          AND scoped.workflow_version_id = dependency.workflow_version_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER mark_workflows_for_confirmed_capability_loss
      AFTER INSERT OR UPDATE OF availability_status, freshness_status
      ON environment_capability_observations
      FOR EACH ROW EXECUTE FUNCTION mark_workflows_for_confirmed_capability_loss();

    CREATE FUNCTION mark_new_dependency_for_confirmed_capability_loss() RETURNS trigger AS $$
    BEGIN
      UPDATE workflow_environment_versions scoped
      SET lifecycle_status = 'action-required', updated_at = current_timestamp
      FROM confirmed_workflow_capability_losses loss
      WHERE loss.organization_id = NEW.organization_id
        AND loss.workflow_version_id = NEW.workflow_version_id
        AND loss.capability_version_id = NEW.capability_version_id
        AND scoped.organization_id = loss.organization_id
        AND scoped.environment_id = loss.environment_id
        AND scoped.workflow_version_id = loss.workflow_version_id;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER mark_new_dependency_for_confirmed_capability_loss
      AFTER INSERT OR UPDATE OF capability_version_id ON workflow_capability_dependencies
      FOR EACH ROW EXECUTE FUNCTION mark_new_dependency_for_confirmed_capability_loss();

    CREATE FUNCTION protect_new_workflow_environment_version() RETURNS trigger AS $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM confirmed_workflow_capability_losses loss
        WHERE loss.organization_id = NEW.organization_id
          AND loss.environment_id = NEW.environment_id
          AND loss.workflow_version_id = NEW.workflow_version_id
      ) THEN
        NEW.lifecycle_status := 'action-required';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER protect_new_workflow_environment_version
      BEFORE INSERT OR UPDATE ON workflow_environment_versions
      FOR EACH ROW EXECUTE FUNCTION protect_new_workflow_environment_version();

    UPDATE workflow_environment_versions scoped
    SET lifecycle_status = 'action-required', updated_at = current_timestamp
    FROM confirmed_workflow_capability_losses loss
    WHERE scoped.organization_id = loss.organization_id
      AND scoped.environment_id = loss.environment_id
      AND scoped.workflow_version_id = loss.workflow_version_id;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER protect_new_workflow_environment_version
      ON workflow_environment_versions;
    DROP FUNCTION protect_new_workflow_environment_version();
    DROP TRIGGER mark_new_dependency_for_confirmed_capability_loss
      ON workflow_capability_dependencies;
    DROP FUNCTION mark_new_dependency_for_confirmed_capability_loss();
    DROP TRIGGER mark_workflows_for_confirmed_capability_loss
      ON environment_capability_observations;
    DROP FUNCTION mark_workflows_for_confirmed_capability_loss();
    UPDATE workflow_environment_versions
    SET lifecycle_status = CASE WHEN is_active THEN 'active' ELSE 'approved-inactive' END
    WHERE lifecycle_status = 'action-required';
  `);
  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check:
      "event_type IN ('discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment', 'organization-settings', 'secret-reference', 'membership', 'capability-safety-approval', 'capability-host-policy', 'repair', 'capability-source-authority')",
  });
  pgm.sql('DROP VIEW active_workflow_capability_loss_overrides');
  pgm.sql('DROP VIEW confirmed_workflow_capability_losses');
  pgm.dropTable('workflow_capability_loss_overrides');
  pgm.dropConstraint(
    'workflow_environment_versions',
    'workflow_environment_versions_lifecycle_status_check',
  );
  pgm.addConstraint(
    'workflow_environment_versions',
    'workflow_environment_versions_lifecycle_status_check',
    {
      check:
        "lifecycle_status IN ('draft', 'testing', 'awaiting-approval', 'approved-inactive', 'active', 'blocked')",
    },
  );
};
