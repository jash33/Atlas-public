exports.up = (pgm) => {
  pgm.dropConstraint('source_documents', 'source_documents_format_check');
  pgm.addConstraint('source_documents', 'source_documents_format_check', {
    check: "format IN ('openapi', 'asyncapi', 'atlas-manifest')",
  });

  pgm.addColumns('manifest_annotations', {
    source_document_id: { type: 'bigint', references: 'source_documents' },
    compensated_by_identity_id: { type: 'bigint', references: 'capability_identities' },
  });
  pgm.dropColumn('manifest_annotations', 'compensated_by');

  pgm.createTable('capability_version_provenance', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    capability_version_id: { type: 'char(64)', notNull: true },
    source_document_id: { type: 'bigint', notNull: true, references: 'source_documents' },
    manifest_source_document_id: { type: 'bigint', references: 'source_documents' },
  });
  pgm.addConstraint('capability_version_provenance', 'capability_version_provenance_pk', {
    primaryKey: ['organization_id', 'capability_version_id', 'source_document_id'],
  });
  pgm.addConstraint('capability_version_provenance', 'capability_version_provenance_version_fk', {
    foreignKeys: {
      columns: ['organization_id', 'capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
      onDelete: 'cascade',
    },
  });
  pgm.sql(`
    INSERT INTO capability_version_provenance
      (organization_id, capability_version_id, source_document_id)
    SELECT organization_id, capability_version_id, source_document_id
    FROM capability_versions
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('capability_version_provenance');
  pgm.addColumn('manifest_annotations', {
    compensated_by: { type: 'jsonb' },
  });
  pgm.dropColumns('manifest_annotations', ['source_document_id', 'compensated_by_identity_id']);
  pgm.dropConstraint('source_documents', 'source_documents_format_check');
  pgm.addConstraint('source_documents', 'source_documents_format_check', {
    check: "format IN ('openapi', 'asyncapi')",
  });
};
