exports.up = (pgm) => {
  pgm.createTable('organizations', {
    id: { type: 'text', primaryKey: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });

  pgm.createTable('source_documents', {
    id: 'id',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    service_id: { type: 'text', notNull: true },
    format: { type: 'text', notNull: true, check: "format IN ('openapi', 'asyncapi')" },
    document: { type: 'jsonb', notNull: true },
    document_hash: { type: 'char(64)', notNull: true },
    repository: { type: 'text', notNull: true },
    commit_sha: { type: 'text', notNull: true },
    path: { type: 'text', notNull: true },
    ingested_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('source_documents', 'source_documents_provenance_unique', {
    unique: ['organization_id', 'repository', 'commit_sha', 'path'],
  });

  pgm.createTable('capability_identities', {
    id: 'id',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    kind: { type: 'text', notNull: true, check: "kind IN ('openapi', 'asyncapi')" },
    service_id: { type: 'text', notNull: true },
    operation_id: { type: 'text', notNull: true },
    channel_address: { type: 'text' },
    message_key: { type: 'text' },
  });
  pgm.sql(`CREATE UNIQUE INDEX capability_identity_unique
    ON capability_identities (
      organization_id, kind, service_id, operation_id,
      COALESCE(channel_address, ''), COALESCE(message_key, '')
    )`);

  pgm.createTable('manifest_annotations', {
    id: 'id',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    capability_identity_id: {
      type: 'bigint',
      notNull: true,
      references: 'capability_identities',
      onDelete: 'cascade',
    },
    annotation_hash: { type: 'char(64)', notNull: true },
    owner: { type: 'text', notNull: true },
    secret_alias: { type: 'text' },
    business_semantics: { type: 'jsonb', notNull: true },
    idempotency_field: { type: 'text' },
    compensated_by: { type: 'jsonb' },
    irreversible_after: { type: 'boolean', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('manifest_annotations', 'manifest_annotation_unique', {
    unique: ['organization_id', 'capability_identity_id', 'annotation_hash'],
  });

  pgm.createTable('capability_versions', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    capability_version_id: { type: 'char(64)', notNull: true },
    capability_identity_id: { type: 'bigint', notNull: true, references: 'capability_identities' },
    source_document_id: { type: 'bigint', notNull: true, references: 'source_documents' },
    manifest_annotation_id: { type: 'bigint', notNull: true, references: 'manifest_annotations' },
    capability_fragment_hash: { type: 'char(64)', notNull: true },
    capability_fragment: { type: 'jsonb', notNull: true },
    published_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('capability_versions', 'capability_versions_pk', {
    primaryKey: ['organization_id', 'capability_version_id'],
  });
  pgm.createIndex('capability_versions', ['organization_id', 'capability_identity_id']);

  pgm.createTable('compatibility_diffs', {
    id: 'id',
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    capability_identity_id: { type: 'bigint', notNull: true, references: 'capability_identities' },
    from_capability_version_id: { type: 'char(64)', notNull: true },
    to_capability_version_id: { type: 'char(64)', notNull: true },
    classification: {
      type: 'text',
      notNull: true,
      check: "classification IN ('compatible', 'conditional', 'breaking')",
    },
    diff: { type: 'jsonb', notNull: true },
    computed_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('compatibility_diffs', 'compatibility_diff_unique', {
    unique: ['organization_id', 'from_capability_version_id', 'to_capability_version_id'],
  });

  pgm.createTable('capability_approvals', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    capability_version_id: { type: 'char(64)', notNull: true },
    approved_by: { type: 'text', notNull: true },
    approved_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('capability_approvals', 'capability_approvals_pk', {
    primaryKey: ['organization_id', 'capability_version_id'],
  });
  pgm.addConstraint('capability_approvals', 'capability_approvals_version_fk', {
    foreignKeys: {
      columns: ['organization_id', 'capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
      onDelete: 'cascade',
    },
  });

  pgm.createTable('workflow_versions', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    workflow_version_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('workflow_versions', 'workflow_versions_pk', {
    primaryKey: ['organization_id', 'workflow_version_id'],
  });

  pgm.createTable('workflow_capability_dependencies', {
    organization_id: { type: 'text', notNull: true },
    workflow_version_id: { type: 'text', notNull: true },
    step_id: { type: 'text', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
  });
  pgm.addConstraint('workflow_capability_dependencies', 'workflow_capability_dependencies_pk', {
    primaryKey: ['organization_id', 'workflow_version_id', 'step_id'],
  });
  pgm.addConstraint('workflow_capability_dependencies', 'workflow_dependency_workflow_fk', {
    foreignKeys: {
      columns: ['organization_id', 'workflow_version_id'],
      references: 'workflow_versions(organization_id, workflow_version_id)',
      onDelete: 'cascade',
    },
  });
  pgm.addConstraint('workflow_capability_dependencies', 'workflow_dependency_capability_fk', {
    foreignKeys: {
      columns: ['organization_id', 'capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
  pgm.createIndex('workflow_capability_dependencies', ['organization_id', 'capability_version_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('workflow_capability_dependencies');
  pgm.dropTable('workflow_versions');
  pgm.dropTable('capability_approvals');
  pgm.dropTable('compatibility_diffs');
  pgm.dropTable('capability_versions');
  pgm.dropTable('manifest_annotations');
  pgm.dropTable('capability_identities');
  pgm.dropTable('source_documents');
  pgm.dropTable('organizations');
};
