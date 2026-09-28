exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE workflow_approvals ADD COLUMN IF NOT EXISTS workflow_id text;

    UPDATE workflow_approvals approval
    SET workflow_id = version.workflow_id
    FROM workflow_versions version
    WHERE version.organization_id = approval.organization_id
      AND version.workflow_version_id = approval.workflow_version_id
      AND approval.workflow_id IS NULL;

    ALTER TABLE workflow_approvals ALTER COLUMN workflow_id SET NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'workflow_approvals_identity_fk'
          AND conrelid = 'workflow_approvals'::regclass
      ) THEN
        ALTER TABLE workflow_approvals
          ADD CONSTRAINT workflow_approvals_identity_fk
          FOREIGN KEY (organization_id, workflow_id)
          REFERENCES workflow_identities(organization_id, workflow_id)
          ON DELETE CASCADE;
      END IF;
    END;
    $$;

    DROP INDEX IF EXISTS workflow_approvals_one_current;
    CREATE UNIQUE INDEX workflow_approvals_one_current
      ON workflow_approvals (organization_id, environment_id, workflow_id)
      WHERE lifecycle_status = 'current';

    CREATE OR REPLACE FUNCTION bind_workflow_approval_identity() RETURNS trigger AS $$
    DECLARE
      existing_workflow_id text;
      current_workflow_id text;
    BEGIN
      SELECT workflow_id INTO existing_workflow_id
      FROM workflow_versions
      WHERE organization_id = NEW.organization_id
        AND workflow_version_id = NEW.workflow_version_id;
      IF NEW.workflow_id IS NULL AND existing_workflow_id LIKE 'unassigned-%'
         AND NEW.lifecycle_status <> 'current' THEN
        SELECT workflow_id INTO current_workflow_id
        FROM workflow_approvals
        WHERE organization_id = NEW.organization_id
          AND environment_id = NEW.environment_id
          AND lifecycle_status = 'current';
        IF current_workflow_id IS NOT NULL THEN
          UPDATE workflow_versions SET workflow_id = current_workflow_id
          WHERE organization_id = NEW.organization_id
            AND workflow_version_id = NEW.workflow_version_id;
          existing_workflow_id := current_workflow_id;
        END IF;
      END IF;
      IF NEW.workflow_id IS NULL THEN
        NEW.workflow_id := existing_workflow_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS bind_workflow_approval_identity_before_insert ON workflow_approvals;
    CREATE TRIGGER bind_workflow_approval_identity_before_insert
      BEFORE INSERT ON workflow_approvals
      FOR EACH ROW EXECUTE FUNCTION bind_workflow_approval_identity();

    CREATE OR REPLACE FUNCTION assign_unscoped_workflow_identity() RETURNS trigger AS $$
    BEGIN
      IF NEW.workflow_id IS NULL THEN
        NEW.workflow_id := 'unassigned-' || md5(
          NEW.organization_id || ':' || NEW.workflow_version_id
        );
        INSERT INTO workflow_identities (organization_id, workflow_id, name)
        VALUES (NEW.organization_id, NEW.workflow_id, 'Imported workflow')
        ON CONFLICT (organization_id, workflow_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS assign_unscoped_workflow_identity_before_insert ON workflow_versions;
    CREATE TRIGGER assign_unscoped_workflow_identity_before_insert
      BEFORE INSERT ON workflow_versions
      FOR EACH ROW EXECUTE FUNCTION assign_unscoped_workflow_identity();

    ALTER TABLE workflow_environment_versions
      ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT false;

    UPDATE workflow_environment_versions scoped
    SET is_active = EXISTS (
      SELECT 1
      FROM workflow_approvals approval
      WHERE approval.organization_id = scoped.organization_id
        AND approval.environment_id = scoped.environment_id
        AND approval.workflow_version_id = scoped.workflow_version_id
        AND approval.lifecycle_status = 'current'
    );
  `);
};

// This migration converges multiple already-recorded forms of migration 047. Reversing it cannot
// safely distinguish repaired objects from objects created by the final 047 migration.
exports.down = () => {};
