import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { changeCustomerAdmin, type CustomerAdminChange } from './customer-sso-admin.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schema = `customer_admin_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const tenantId = '11111111-1111-1111-1111-111111111111';
const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
const change: CustomerAdminChange = {
  action: 'provision-admin',
  organizationId: 'customer',
  provider: { provider: 'entra', tenantId },
  userId: 'first-admin',
  subject: 'verified-subject',
  operator: 'installation-operator',
  reason: 'Approved installation request 255',
  email: 'admin@example.com',
  name: 'Customer Admin',
};

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema, lockValue: 2551 });
  await pool.query("INSERT INTO organizations (id) VALUES ('customer'), ('other-customer')");
});

afterAll(async () => {
  await pool.end();
});

describe('customer SSO operator recovery', () => {
  it.each([
    {
      config: { provider: 'google' as const, hostedDomain: 'customer.example' },
      issuer: 'https://accounts.google.com',
    },
    {
      config: { provider: 'okta' as const, issuer: 'https://customer.okta.com' },
      issuer: 'https://customer.okta.com',
    },
  ])('binds $config.provider users to the canonical provider issuer', async (selected) => {
    await changeCustomerAdmin(pool, {
      action: 'provision-user',
      role: 'author',
      organizationId: change.organizationId,
      provider: selected.config,
      userId: `${selected.config.provider}-user`,
      subject: 'same-subject-across-providers',
      email: `${selected.config.provider}@example.com`,
      name: 'Provider User',
      operator: change.operator,
      reason: change.reason,
    });
    expect(
      (
        await pool.query('SELECT issuer FROM customer_sso_identities WHERE user_id = $1', [
          `${selected.config.provider}-user`,
        ])
      ).rows,
    ).toEqual([{ issuer: selected.issuer }]);
  });

  it('rejects malformed provider configuration before creating a user', async () => {
    await expect(
      changeCustomerAdmin(pool, {
        ...change,
        provider: { provider: 'okta', issuer: 'http://customer.okta.com' },
        userId: 'invalid-provider',
        email: 'invalid-provider@example.com',
      }),
    ).rejects.toThrow(
      'ATLAS_SSO_OKTA_ISSUER must be the HTTPS Okta organization origin without a path',
    );
    expect((await pool.query("SELECT id FROM users WHERE id = 'invalid-provider'")).rowCount).toBe(
      0,
    );
  });

  it('provisions ordinary users without granting administrator access', async () => {
    await changeCustomerAdmin(pool, {
      ...change,
      action: 'provision-user',
      role: 'author',
      userId: 'ordinary-user',
      subject: 'ordinary-subject',
      email: 'author@example.com',
    });
    expect(
      (
        await pool.query(
          "SELECT role FROM organization_memberships WHERE user_id = 'ordinary-user'",
        )
      ).rows,
    ).toEqual([{ role: 'author' }]);
  });

  it('creates the first admin with an explicit identity and audit record', async () => {
    await changeCustomerAdmin(pool, change);
    const result = await pool.query(
      "SELECT role FROM organization_memberships WHERE user_id = 'first-admin'",
    );
    expect(result.rows).toEqual([{ role: 'admin' }]);
    const audit = await pool.query(
      "SELECT details FROM audit_entries WHERE subject_id = 'first-admin'",
    );
    expect(audit.rows[0].details).toMatchObject({
      action: 'provision-admin',
      operator: change.operator,
      reason: change.reason,
    });
  });

  it('cannot claim another user identity and rolls back the new user', async () => {
    await expect(
      changeCustomerAdmin(pool, { ...change, userId: 'intruder', email: 'intruder@example.com' }),
    ).rejects.toThrow('already bound');
    expect((await pool.query("SELECT id FROM users WHERE id = 'intruder'")).rowCount).toBe(0);
  });

  it('never uses a matching email to link an existing user', async () => {
    await expect(
      changeCustomerAdmin(pool, {
        ...change,
        userId: 'duplicate-email',
        subject: 'different-subject',
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect((await pool.query("SELECT id FROM users WHERE id = 'duplicate-email'")).rowCount).toBe(
      0,
    );
  });

  it('recovery removes the previous login and sessions but preserves another organization', async () => {
    await pool.query(
      "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ('other-customer', 'first-admin', 'author')",
    );
    await pool.query(
      "INSERT INTO customer_sso_identities (organization_id, issuer, subject, user_id) VALUES ('other-customer', $1, 'verified-subject', 'first-admin')",
      [issuer],
    );
    await pool.query(
      `INSERT INTO customer_sessions (id_hash, client_id, organization_id, issuer, subject, expires_at)
      VALUES ('old-session', 'client', 'customer', $1, 'verified-subject', now() + interval '1 hour'),
             ('other-session', 'client', 'other-customer', $1, 'verified-subject', now() + interval '1 hour')`,
      [issuer],
    );
    const { email: _email, name: _name, ...existing } = change;
    await pool.query(
      `INSERT INTO customer_access_requests
       (id,organization_id,auth_scope,issuer,subject,display_name,status,browser_hash,expires_at,approved_user_id)
       VALUES ('old-approval','customer','customer-scope',$1,'verified-subject','Customer Admin','approved','old-browser',now()+interval '1 day','first-admin'),
              ('other-approval','other-customer','other-scope',$1,'verified-subject','Customer Admin','approved','other-browser',now()+interval '1 day','first-admin')`,
      [issuer],
    );
    await changeCustomerAdmin(pool, {
      ...existing,
      action: 'recover-admin',
      subject: 'replacement-subject',
    });
    expect((await pool.query('SELECT id_hash FROM customer_sessions')).rows).toEqual([
      { id_hash: 'other-session' },
    ]);
    expect(
      (
        await pool.query(
          "SELECT subject FROM customer_sso_identities WHERE organization_id = 'customer' AND user_id = 'first-admin'",
        )
      ).rows,
    ).toEqual([{ subject: 'replacement-subject' }]);
    expect(
      (
        await pool.query(
          'SELECT id,approved_user_id,status,expires_at > now() AS active FROM customer_access_requests ORDER BY id',
        )
      ).rows,
    ).toEqual([
      { id: 'old-approval', approved_user_id: null, status: 'rejected', active: false },
      { id: 'other-approval', approved_user_id: 'first-admin', status: 'approved', active: true },
    ]);
  });

  it('session revocation preserves the identity and role', async () => {
    await pool.query(
      `INSERT INTO customer_sessions (id_hash, client_id, organization_id, issuer, subject, expires_at)
      VALUES ('new-session', 'client', 'customer', $1, 'replacement-subject', now() + interval '1 hour')`,
      [issuer],
    );
    await changeCustomerAdmin(pool, {
      action: 'revoke-sessions',
      organizationId: 'customer',
      provider: { provider: 'entra', tenantId },
      userId: 'first-admin',
      operator: change.operator,
      reason: 'Security review',
    });
    expect(
      (await pool.query("SELECT id_hash FROM customer_sessions WHERE organization_id = 'customer'"))
        .rows,
    ).toEqual([]);
    expect(
      (
        await pool.query(
          "SELECT subject FROM customer_sso_identities WHERE organization_id = 'customer' AND user_id = 'first-admin'",
        )
      ).rowCount,
    ).toBe(1);
  });
});
