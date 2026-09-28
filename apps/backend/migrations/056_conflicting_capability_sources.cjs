const priorAuditEvents =
  "'discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment', 'organization-settings', 'secret-reference', 'membership', 'capability-safety-approval', 'capability-host-policy', 'repair'";

exports.up = (pgm) => {
  pgm.addColumn('environment_capability_observations', {
    source_resolution_status: { type: 'text', notNull: true, default: 'uncontested' },
  });
  pgm.addConstraint(
    'environment_capability_observations',
    'environment_capability_observations_source_resolution_check',
    { check: "source_resolution_status IN ('uncontested', 'conflicting', 'authoritative')" },
  );

  pgm.createTable('environment_capability_source_claims', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    capability_identity_id: {
      type: 'bigint',
      notNull: true,
      references: 'capability_identities',
      onDelete: 'cascade',
    },
    source_key: { type: 'text', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
    source_document_id: { type: 'bigint', notNull: true, references: 'source_documents' },
    active: { type: 'boolean', notNull: true, default: true },
    observed_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint(
    'environment_capability_source_claims',
    'environment_capability_source_claims_pk',
    {
      primaryKey: ['organization_id', 'environment_id', 'capability_identity_id', 'source_key'],
    },
  );
  pgm.addConstraint(
    'environment_capability_source_claims',
    'environment_capability_source_claims_version_fk',
    {
      foreignKeys: {
        columns: ['organization_id', 'capability_version_id'],
        references: 'capability_versions(organization_id, capability_version_id)',
        onDelete: 'cascade',
      },
    },
  );
  pgm.createIndex('environment_capability_source_claims', [
    'organization_id',
    'environment_id',
    'capability_identity_id',
    'active',
  ]);

  pgm.createTable('environment_capability_source_authorities', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    capability_identity_id: {
      type: 'bigint',
      notNull: true,
      references: 'capability_identities',
      onDelete: 'cascade',
    },
    source_key: { type: 'text', notNull: true },
    designated_by: { type: 'text', notNull: true },
    designated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint(
    'environment_capability_source_authorities',
    'environment_capability_source_authorities_pk',
    {
      primaryKey: ['organization_id', 'environment_id', 'capability_identity_id'],
    },
  );

  pgm.sql(`
    INSERT INTO environment_capability_source_claims
      (organization_id, environment_id, capability_identity_id, source_key,
       capability_version_id, source_document_id, observed_at)
    SELECT observation.organization_id, observation.environment_id,
      observation.capability_identity_id, 'legacy:' || version.source_document_id::text,
      observation.capability_version_id, version.source_document_id, observation.observed_at
    FROM environment_capability_observations observation
    JOIN capability_versions version
      ON version.organization_id = observation.organization_id
     AND version.capability_version_id = observation.capability_version_id;
  `);

  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check: `event_type IN (${priorAuditEvents}, 'capability-source-authority')`,
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check: `event_type IN (${priorAuditEvents})`,
  });
  pgm.dropTable('environment_capability_source_authorities');
  pgm.dropTable('environment_capability_source_claims');
  pgm.dropConstraint(
    'environment_capability_observations',
    'environment_capability_observations_source_resolution_check',
  );
  pgm.dropColumn('environment_capability_observations', 'source_resolution_status');
};
