exports.up = (pgm) => {
  pgm.dropConstraint('capability_version_provenance', 'capability_version_provenance_pk');
  pgm.addColumn('capability_version_provenance', {
    id: { type: 'bigserial', primaryKey: true },
  });
  pgm.createIndex(
    'capability_version_provenance',
    [
      'organization_id',
      'capability_version_id',
      'source_document_id',
      'manifest_source_document_id',
    ],
    { unique: true, name: 'capability_version_provenance_unique', nullsNotDistinct: true },
  );

  pgm.dropTrigger('capability_versions', 'capability_versions_are_immutable');
  pgm.createTrigger('capability_versions', 'capability_versions_are_immutable', {
    when: 'BEFORE',
    operation: ['UPDATE', 'DELETE'],
    level: 'ROW',
    function: 'reject_capability_version_update',
  });
};

exports.down = (pgm) => {
  pgm.dropTrigger('capability_versions', 'capability_versions_are_immutable');
  pgm.createTrigger('capability_versions', 'capability_versions_are_immutable', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'reject_capability_version_update',
  });
  pgm.dropIndex('capability_version_provenance', [], {
    name: 'capability_version_provenance_unique',
  });
  pgm.dropColumn('capability_version_provenance', 'id');
  pgm.addConstraint('capability_version_provenance', 'capability_version_provenance_pk', {
    primaryKey: ['organization_id', 'capability_version_id', 'source_document_id'],
  });
};
