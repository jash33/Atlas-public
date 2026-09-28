exports.up = (pgm) => {
  pgm.createTable('organization_environment_policies', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    environment_id: { type: 'text', notNull: true },
    policy_version: { type: 'text', notNull: true },
    approved_by: { type: 'text', notNull: true },
    approved_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    revoked_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('organization_environment_policies', 'organization_environment_policies_pk', {
    primaryKey: ['organization_id', 'environment_id'],
  });

  pgm.addColumn('capability_host_policies', {
    environment_id: { type: 'text', notNull: true, default: 'production' },
  });
  pgm.dropConstraint('capability_host_policies', 'capability_host_policies_pk');
  pgm.addConstraint('capability_host_policies', 'capability_host_policies_pk', {
    primaryKey: ['organization_id', 'capability_identity_id', 'environment_id', 'hostname'],
  });
};

exports.down = (pgm) => {
  pgm.dropConstraint('capability_host_policies', 'capability_host_policies_pk');
  pgm.dropColumn('capability_host_policies', 'environment_id');
  pgm.addConstraint('capability_host_policies', 'capability_host_policies_pk', {
    primaryKey: ['organization_id', 'capability_identity_id', 'hostname'],
  });
  pgm.dropTable('organization_environment_policies');
};
