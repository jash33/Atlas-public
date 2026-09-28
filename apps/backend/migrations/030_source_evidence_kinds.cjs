exports.up = (pgm) => {
  pgm.dropConstraint('source_documents', 'source_documents_provenance_unique');
  pgm.alterColumn('source_documents', 'repository', { notNull: false });
  pgm.alterColumn('source_documents', 'commit_sha', { notNull: false });
  pgm.alterColumn('source_documents', 'path', { notNull: false });
  pgm.addColumns('source_documents', {
    evidence_kind: { type: 'text', notNull: true, default: 'repository' },
    evidence_label: { type: 'text' },
    confirmed_by: { type: 'text' },
    confirmed_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('source_documents', 'source_documents_evidence_shape', {
    check: `(
      evidence_kind IN ('repository', 'github')
      AND repository IS NOT NULL AND commit_sha IS NOT NULL AND path IS NOT NULL
      AND evidence_label IS NULL AND confirmed_by IS NULL AND confirmed_at IS NULL
    ) OR (
      evidence_kind = 'human-confirmed'
      AND repository IS NULL AND commit_sha IS NULL AND path IS NULL
      AND evidence_label IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
    )`,
  });
  pgm.sql(`CREATE UNIQUE INDEX source_documents_evidence_unique
    ON source_documents (
      organization_id, service_id, format, evidence_kind,
      repository, commit_sha, path, evidence_label, confirmed_by, confirmed_at
    ) NULLS NOT DISTINCT`);
  pgm.dropConstraint('capability_source_registrations', 'capability_source_registrations_pk');
  pgm.addColumns('capability_source_registrations', {
    environment_id: { type: 'text' },
  });
  pgm.sql(`ALTER TABLE capability_source_registrations
    ADD CONSTRAINT capability_source_registrations_scope_unique
    UNIQUE NULLS NOT DISTINCT (organization_id, service_id, environment_id)`);
};

exports.down = (pgm) => {
  pgm.dropConstraint(
    'capability_source_registrations',
    'capability_source_registrations_scope_unique',
  );
  pgm.dropColumns('capability_source_registrations', ['environment_id']);
  pgm.addConstraint('capability_source_registrations', 'capability_source_registrations_pk', {
    primaryKey: ['organization_id', 'service_id'],
  });
  pgm.dropIndex('source_documents', [], { name: 'source_documents_evidence_unique' });
  pgm.dropConstraint('source_documents', 'source_documents_evidence_shape');
  pgm.dropColumns('source_documents', [
    'evidence_kind',
    'evidence_label',
    'confirmed_by',
    'confirmed_at',
  ]);
  pgm.alterColumn('source_documents', 'repository', { notNull: true });
  pgm.alterColumn('source_documents', 'commit_sha', { notNull: true });
  pgm.alterColumn('source_documents', 'path', { notNull: true });
  pgm.addConstraint('source_documents', 'source_documents_provenance_unique', {
    unique: ['organization_id', 'repository', 'commit_sha', 'path'],
  });
};
