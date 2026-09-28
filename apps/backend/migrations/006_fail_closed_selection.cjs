exports.up = (pgm) => {
  pgm.createTable('manifest_annotation_approvals', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    manifest_annotation_id: {
      type: 'bigint',
      notNull: true,
      references: 'manifest_annotations',
      onDelete: 'cascade',
    },
    approved_by: { type: 'text', notNull: true },
    approved_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('manifest_annotation_approvals', 'manifest_annotation_approvals_pk', {
    primaryKey: ['organization_id', 'manifest_annotation_id'],
  });

  pgm.createTable('capability_identity_heads', {
    organization_id: { type: 'text', notNull: true },
    capability_identity_id: { type: 'bigint', notNull: true },
    capability_version_id: { type: 'char(64)', notNull: true },
  });
  pgm.addConstraint('capability_identity_heads', 'capability_identity_heads_pk', {
    primaryKey: ['organization_id', 'capability_identity_id'],
  });
  pgm.addConstraint('capability_identity_heads', 'capability_identity_heads_identity_fk', {
    foreignKeys: {
      columns: ['capability_identity_id'],
      references: 'capability_identities(id)',
      onDelete: 'cascade',
    },
  });
  pgm.addConstraint('capability_identity_heads', 'capability_identity_heads_version_fk', {
    foreignKeys: {
      columns: ['organization_id', 'capability_version_id'],
      references: 'capability_versions(organization_id, capability_version_id)',
    },
  });
  pgm.sql(`
    INSERT INTO capability_identity_heads
      (organization_id, capability_identity_id, capability_version_id)
    SELECT DISTINCT ON (organization_id, capability_identity_id)
      organization_id, capability_identity_id, capability_version_id
    FROM capability_versions
    ORDER BY organization_id, capability_identity_id, published_at DESC, capability_version_id DESC
  `);

  pgm.createTable('capability_host_policies', {
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
    hostname: { type: 'text', notNull: true },
    approved_by: { type: 'text', notNull: true },
    approved_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('capability_host_policies', 'capability_host_policies_pk', {
    primaryKey: ['organization_id', 'capability_identity_id', 'hostname'],
  });
};

exports.down = (pgm) => {
  pgm.dropTable('capability_host_policies');
  pgm.dropTable('capability_identity_heads');
  pgm.dropTable('manifest_annotation_approvals');
};
