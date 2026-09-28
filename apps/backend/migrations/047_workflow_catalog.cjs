exports.up = (pgm) => {
  pgm.createTable('workflow_identities', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    workflow_id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true, check: 'length(trim(name)) > 0' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_identities', 'workflow_identities_pk', {
    primaryKey: ['organization_id', 'workflow_id'],
  });

  pgm.addColumn('workflow_versions', {
    workflow_id: { type: 'text' },
  });

  // The old model allowed one current workflow version per organization/environment, so all
  // pre-Catalog versions for an organization are one preserved history. The backfill deliberately
  // uses opaque stored keys; it never parses version IDs or display text to invent grouping.
  pgm.sql(`
    INSERT INTO workflow_identities (organization_id, workflow_id, name, created_at, updated_at)
    SELECT organization_id,
           'legacy-' || md5(organization_id),
           'Imported workflow',
           min(created_at),
           max(created_at)
    FROM workflow_versions
    GROUP BY organization_id;

    UPDATE workflow_versions
    SET workflow_id = 'legacy-' || md5(organization_id);
  `);

  pgm.addColumn('workflow_approvals', { workflow_id: { type: 'text' } });
  pgm.sql(`
    UPDATE workflow_approvals approval
    SET workflow_id = version.workflow_id
    FROM workflow_versions version
    WHERE version.organization_id = approval.organization_id
      AND version.workflow_version_id = approval.workflow_version_id;
  `);
  pgm.alterColumn('workflow_approvals', 'workflow_id', { notNull: true });
  pgm.addConstraint('workflow_approvals', 'workflow_approvals_identity_fk', {
    foreignKeys: {
      columns: ['organization_id', 'workflow_id'],
      references: 'workflow_identities(organization_id, workflow_id)',
      onDelete: 'cascade',
    },
  });
  pgm.sql(`
    DROP INDEX workflow_approvals_one_current;
    CREATE UNIQUE INDEX workflow_approvals_one_current
      ON workflow_approvals (organization_id, environment_id, workflow_id)
      WHERE lifecycle_status = 'current';

    CREATE FUNCTION bind_workflow_approval_identity() RETURNS trigger AS $$
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

    CREATE TRIGGER bind_workflow_approval_identity_before_insert
      BEFORE INSERT ON workflow_approvals
      FOR EACH ROW EXECUTE FUNCTION bind_workflow_approval_identity();
  `);
  pgm.alterColumn('workflow_versions', 'workflow_id', { notNull: true });
  pgm.addConstraint('workflow_versions', 'workflow_versions_identity_fk', {
    foreignKeys: {
      columns: ['organization_id', 'workflow_id'],
      references: 'workflow_identities(organization_id, workflow_id)',
      onDelete: 'cascade',
    },
  });
  pgm.createIndex('workflow_versions', ['organization_id', 'workflow_id', 'created_at']);

  // Compatibility for existing internal writers while they migrate to the explicit Catalog save
  // interface. The fallback is one identity per opaque version key and deliberately does not parse
  // it. New user-facing creation supplies workflow_id and a human name before these writers run.
  pgm.sql(`
    CREATE FUNCTION assign_unscoped_workflow_identity() RETURNS trigger AS $$
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

    CREATE TRIGGER assign_unscoped_workflow_identity_before_insert
      BEFORE INSERT ON workflow_versions
      FOR EACH ROW EXECUTE FUNCTION assign_unscoped_workflow_identity();
  `);

  pgm.createTable('workflow_environment_versions', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    lifecycle_status: {
      type: 'text',
      notNull: true,
      check:
        "lifecycle_status IN ('draft', 'testing', 'awaiting-approval', 'approved-inactive', 'active', 'blocked')",
    },
    is_active: { type: 'boolean', notNull: true, default: false },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_environment_versions', 'workflow_environment_versions_pk', {
    primaryKey: ['organization_id', 'environment_id', 'workflow_version_id'],
  });
  pgm.addConstraint('workflow_environment_versions', 'workflow_environment_versions_version_fk', {
    foreignKeys: {
      columns: ['organization_id', 'workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
      onDelete: 'cascade',
    },
  });
  pgm.createIndex('workflow_environment_versions', [
    'organization_id',
    'environment_id',
    'updated_at',
  ]);

  pgm.sql(`
    WITH evidence AS (
      SELECT organization_id, environment_id, workflow_version_id, approved_at AS observed_at,
             CASE WHEN lifecycle_status = 'current' THEN 'active'
                  ELSE 'approved-inactive' END AS lifecycle_status,
             CASE WHEN lifecycle_status = 'current' THEN 50 ELSE 40 END AS precedence
      FROM workflow_approvals
      UNION ALL
      SELECT organization_id, environment_id, workflow_version_id, updated_at,
             'awaiting-approval', 30
      FROM workflow_migration_candidates
      UNION ALL
      SELECT test.organization_id, test.environment_id, test.workflow_version_id, test.tested_at,
             CASE WHEN test.status = 'failed' THEN 'blocked' ELSE 'testing' END,
             CASE WHEN test.status = 'failed' THEN 60 ELSE 20 END
      FROM workflow_sandbox_test_runs test
      JOIN workflow_versions version
        ON version.organization_id = test.organization_id
       AND version.workflow_version_id = test.workflow_version_id
      UNION ALL
      SELECT organization_id, environment_id, workflow_version_id, updated_at,
             'approved-inactive', 10
      FROM workflow_runs
      UNION ALL
      SELECT organization_id, environment_id, workflow_version_id, quarantined_at,
             'blocked', 70
      FROM workflow_quarantines
      WHERE lifted_at IS NULL
    ), ranked AS (
      SELECT organization_id, environment_id, workflow_version_id, lifecycle_status, observed_at,
             row_number() OVER (
               PARTITION BY organization_id, environment_id, workflow_version_id
               ORDER BY precedence DESC, observed_at DESC
             ) AS position,
             max(observed_at) OVER (
               PARTITION BY organization_id, environment_id, workflow_version_id
             ) AS updated_at
      FROM evidence
    )
    INSERT INTO workflow_environment_versions
      (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active,
       updated_at)
    SELECT ranked.organization_id, ranked.environment_id, ranked.workflow_version_id,
           ranked.lifecycle_status,
           EXISTS (
             SELECT 1 FROM workflow_approvals approval
             WHERE approval.organization_id = ranked.organization_id
               AND approval.environment_id = ranked.environment_id
               AND approval.workflow_version_id = ranked.workflow_version_id
               AND approval.lifecycle_status = 'current'
           ),
           ranked.updated_at
    FROM ranked
    WHERE position = 1;

    INSERT INTO workflow_environment_versions
      (organization_id, environment_id, workflow_version_id, lifecycle_status, updated_at)
    SELECT version.organization_id, 'production', version.workflow_version_id, 'draft',
           version.created_at
    FROM workflow_versions version
    WHERE NOT EXISTS (
      SELECT 1 FROM workflow_environment_versions scoped
      WHERE scoped.organization_id = version.organization_id
        AND scoped.workflow_version_id = version.workflow_version_id
    );
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_environment_versions');
  pgm.sql(`
    DROP TRIGGER bind_workflow_approval_identity_before_insert ON workflow_approvals;
    DROP FUNCTION bind_workflow_approval_identity();
    DROP INDEX workflow_approvals_one_current;
    CREATE UNIQUE INDEX workflow_approvals_one_current
      ON workflow_approvals (organization_id, environment_id)
      WHERE lifecycle_status = 'current';
  `);
  pgm.dropConstraint('workflow_approvals', 'workflow_approvals_identity_fk');
  pgm.dropColumn('workflow_approvals', 'workflow_id');
  pgm.sql(`
    DROP TRIGGER assign_unscoped_workflow_identity_before_insert ON workflow_versions;
    DROP FUNCTION assign_unscoped_workflow_identity();
  `);
  pgm.dropConstraint('workflow_versions', 'workflow_versions_identity_fk');
  pgm.dropIndex('workflow_versions', ['organization_id', 'workflow_id', 'created_at']);
  pgm.dropColumn('workflow_versions', 'workflow_id');
  pgm.dropTable('workflow_identities');
};
