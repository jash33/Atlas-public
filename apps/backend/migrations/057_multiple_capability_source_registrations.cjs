exports.up = (pgm) => {
  pgm.dropConstraint(
    'capability_source_registrations',
    'capability_source_registrations_scope_unique',
  );
  pgm.addColumn('capability_source_registrations', {
    source_key: { type: 'text', notNull: true, default: 'legacy' },
  });
  pgm.sql(`ALTER TABLE capability_source_registrations
    ADD CONSTRAINT capability_source_registrations_scope_source_unique
    UNIQUE NULLS NOT DISTINCT (organization_id, service_id, environment_id, source_key)`);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM capability_source_registrations registration
    USING capability_source_registrations newer
    WHERE registration.organization_id = newer.organization_id
      AND registration.service_id = newer.service_id
      AND registration.environment_id IS NOT DISTINCT FROM newer.environment_id
      AND (registration.updated_at, registration.ctid) < (newer.updated_at, newer.ctid)
  `);
  pgm.dropConstraint(
    'capability_source_registrations',
    'capability_source_registrations_scope_source_unique',
  );
  pgm.dropColumn('capability_source_registrations', 'source_key');
  pgm.sql(`ALTER TABLE capability_source_registrations
    ADD CONSTRAINT capability_source_registrations_scope_unique
    UNIQUE NULLS NOT DISTINCT (organization_id, service_id, environment_id)`);
};
