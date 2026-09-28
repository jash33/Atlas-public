exports.up = (pgm) => {
  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check:
      "event_type IN ('discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment', 'organization-settings', 'secret-reference', 'membership', 'capability-safety-approval')",
  });
  pgm.addColumns('organizations', {
    name: { type: 'text', notNull: true, default: 'Atlas' },
    settings: { type: 'jsonb', notNull: true, default: '{}' },
  });

  pgm.createTable('users', {
    id: { type: 'text', primaryKey: true },
    email: { type: 'text', notNull: true, unique: true },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.createTable('organization_memberships', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    user_id: { type: 'text', notNull: true, references: 'users', onDelete: 'cascade' },
    role: {
      type: 'text',
      notNull: true,
      check: "role IN ('author', 'operator', 'admin')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('organization_memberships', 'organization_memberships_pk', {
    primaryKey: ['organization_id', 'user_id'],
  });

  pgm.createTable('teams', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('teams', 'teams_pk', { primaryKey: ['organization_id', 'id'] });
  pgm.createTable('team_memberships', {
    organization_id: { type: 'text', notNull: true },
    team_id: { type: 'text', notNull: true },
    user_id: { type: 'text', notNull: true, references: 'users', onDelete: 'cascade' },
  });
  pgm.addConstraint('team_memberships', 'team_memberships_pk', {
    primaryKey: ['organization_id', 'team_id', 'user_id'],
  });
  pgm.addConstraint('team_memberships', 'team_memberships_team_fk', {
    foreignKeys: {
      columns: ['organization_id', 'team_id'],
      references: 'teams(organization_id, id)',
      onDelete: 'cascade',
    },
  });
  pgm.addConstraint('team_memberships', 'team_memberships_org_member_fk', {
    foreignKeys: {
      columns: ['organization_id', 'user_id'],
      references: 'organization_memberships(organization_id, user_id)',
      onDelete: 'cascade',
    },
  });

  pgm.createTable('environments', {
    organization_id: {
      type: 'text',
      notNull: true,
      references: 'organizations',
      onDelete: 'cascade',
    },
    id: { type: 'text', notNull: true },
    name: { type: 'text', notNull: true },
    kind: {
      type: 'text',
      notNull: true,
      check: "kind IN ('development', 'production')",
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('environments', 'environments_pk', {
    primaryKey: ['organization_id', 'id'],
  });

  pgm.createTable('secret_references', {
    organization_id: { type: 'text', notNull: true },
    environment_id: { type: 'text', notNull: true },
    alias: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    updated_by: { type: 'text', notNull: true, references: 'users' },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('current_timestamp') },
  });
  pgm.addConstraint('secret_references', 'secret_references_pk', {
    primaryKey: ['organization_id', 'environment_id', 'alias'],
  });
  pgm.addConstraint('secret_references', 'secret_references_environment_fk', {
    foreignKeys: {
      columns: ['organization_id', 'environment_id'],
      references: 'environments(organization_id, id)',
      onDelete: 'cascade',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('secret_references');
  pgm.dropTable('environments');
  pgm.dropTable('team_memberships');
  pgm.dropTable('teams');
  pgm.dropTable('organization_memberships');
  pgm.dropTable('users');
  pgm.dropColumns('organizations', ['name', 'settings']);
  pgm.dropConstraint('audit_entries', 'audit_entries_event_type_check');
  pgm.addConstraint('audit_entries', 'audit_entries_event_type_check', {
    check:
      "event_type IN ('discovery', 'classification', 'reverse-lookup', 'generation', 'validation', 'approval', 'activation', 'rollback', 'abandonment')",
  });
};
