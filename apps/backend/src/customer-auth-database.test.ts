import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import {
  createCustomerAuth,
  type CustomerAuthConfig,
  type CustomerOidcProvider,
} from './customer-auth.js';
import { customerAuthIssuer, customerAuthScope } from './customer-sso-provider.js';
import { createDemoAuth } from './demo-auth.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const schema = `customer_auth_test_${process.pid}`;
const databaseUrl = resolveTestDatabaseUrl();
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const config: CustomerAuthConfig = {
  provider: 'entra',
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: 'atlas-client',
  clientSecret: 'test-secret',
  organizationId: 'customer',
  publicOrigin: 'https://atlas.example',
  sessionMaxAgeSeconds: 3600,
};
const issuer = customerAuthIssuer(config);
const token = 'a'.repeat(43);
const idHash = createHash('sha256').update(token).digest('hex');
const request = () =>
  new Request(config.publicOrigin, { headers: { cookie: `__Host-atlas-session=${token}` } });
const auth = createCustomerAuth(pool, config);

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema, lockValue: 255 });
  await pool.query("INSERT INTO organizations (id,name) VALUES ('customer','Customer')");
  await pool.query(
    "INSERT INTO users (id,email,name) VALUES ('member','member@example.com','Member')",
  );
  await pool.query(
    "INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('customer','member','author')",
  );
  await pool.query(
    'INSERT INTO customer_sso_identities (organization_id,issuer,subject,user_id) VALUES ($1,$2,$3,$4)',
    ['customer', issuer, 'directory-subject', 'member'],
  );
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

it('accepts only environments owned by the signed-in organization', async () => {
  await pool.query(
    "INSERT INTO environments (organization_id,id,name,kind) VALUES ('customer','development','Development','development')",
  );
  expect(await auth.environmentsBelongToOrganization('customer', ['development'])).toBe(true);
  expect(await auth.environmentsBelongToOrganization('customer', ['development', 'unknown'])).toBe(
    false,
  );
  expect(await auth.environmentsBelongToOrganization('other-company', ['development'])).toBe(false);
});

it('uses real persisted membership, expiry, revocation, and client scope', async () => {
  await pool.query(
    `INSERT INTO customer_sessions (id_hash,organization_id,issuer,subject,client_id,auth_scope,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour')`,
    [idHash, 'customer', issuer, 'directory-subject', config.clientId, customerAuthScope(config)],
  );
  expect(await auth.authenticate(request())).toEqual({
    actorId: 'member',
    organizationId: 'customer',
    role: 'author',
    displayName: 'Member',
  });
  await pool.query("UPDATE organization_memberships SET role='operator' WHERE user_id='member'");
  expect((await auth.authenticate(request()))?.role).toBe('operator');
  expect(
    await createCustomerAuth(pool, { ...config, clientId: 'other-app' }).authenticate(request()),
  ).toBeNull();
  expect(
    await createCustomerAuth(pool, { ...config, organizationId: 'other-company' }).authenticate(
      request(),
    ),
  ).toBeNull();
  await pool.query("UPDATE customer_sessions SET expires_at=now()-interval '1 second'");
  expect(await auth.authenticate(request())).toBeNull();
  await pool.query("UPDATE customer_sessions SET expires_at=now()+interval '1 hour'");
  const logout = await auth.routes.request(`${config.publicOrigin}/auth/logout`, {
    method: 'POST',
    headers: { cookie: `__Host-atlas-session=${token}`, origin: config.publicOrigin },
  });
  expect(logout.status).toBe(200);
  expect(await auth.authenticate(request())).toBeNull();
});

it('signs a database user in with a password through the same customer session interface', async () => {
  await auth.passwords.setPassword({
    userId: 'member',
    username: 'Member',
    password: 'a-secure-test-password',
  });

  const rejected = await auth.routes.request(`${config.publicOrigin}/auth/password`, {
    method: 'POST',
    headers: { origin: config.publicOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member', password: 'wrong-password' }),
  });
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toMatchObject({
    error: 'invalid-credentials',
    message: 'The username or password is incorrect.',
  });
  expect(
    await pool.query<{ failed_attempts: number }>(
      "SELECT failed_attempts FROM customer_password_credentials WHERE organization_id='customer' AND username='member'",
    ),
  ).toMatchObject({ rows: [{ failed_attempts: 1 }] });

  await pool.query(
    "UPDATE customer_password_credentials SET failed_attempts=9, locked_until=NULL WHERE organization_id='customer' AND username='member'",
  );
  const lockingAttempt = await auth.routes.request(`${config.publicOrigin}/auth/password`, {
    method: 'POST',
    headers: { origin: config.publicOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member', password: 'wrong-password' }),
  });
  expect(lockingAttempt.status).toBe(401);
  const lockedCredential = await pool.query<{ locked_until: Date }>(
    "SELECT locked_until FROM customer_password_credentials WHERE organization_id='customer' AND username='member'",
  );
  expect(lockedCredential.rows[0]!.locked_until.getTime()).toBeGreaterThan(Date.now());

  const lockedAttempt = await auth.routes.request(`${config.publicOrigin}/auth/password`, {
    method: 'POST',
    headers: { origin: config.publicOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member', password: 'a-secure-test-password' }),
  });
  expect(lockedAttempt.status).toBe(401);
  expect(
    await pool.query<{ failed_attempts: number }>(
      "SELECT failed_attempts FROM customer_password_credentials WHERE organization_id='customer' AND username='member'",
    ),
  ).toMatchObject({ rows: [{ failed_attempts: 10 }] });
  await pool.query(
    "UPDATE customer_password_credentials SET locked_until=now()-interval '1 second' WHERE organization_id='customer' AND username='member'",
  );

  const accepted = await auth.routes.request(`${config.publicOrigin}/auth/password`, {
    method: 'POST',
    headers: { origin: config.publicOrigin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'MEMBER', password: 'a-secure-test-password' }),
  });
  expect(accepted.status).toBe(200);
  const cookie = accepted.headers
    .getSetCookie()
    .find((value) => value.startsWith('__Host-atlas-session='))!
    .split(';')[0]!;
  expect(
    await auth.authenticate(new Request(config.publicOrigin, { headers: { cookie } })),
  ).toMatchObject({ actorId: 'member', organizationId: 'customer' });

  const session = await auth.routes.request(`${config.publicOrigin}/auth/session`, {
    headers: { cookie },
  });
  expect(await session.json()).toMatchObject({
    mode: 'customer',
    user: { actorId: 'member' },
    methods: { password: true, sso: true, demo: false },
  });
});

it('keeps a local password session while offering the unrestricted demo separately', async () => {
  const demo = createDemoAuth(pool, 'customer');
  await demo.passwords.setPassword({
    userId: 'member',
    username: 'member',
    password: 'local-demo-password',
  });
  const origin = 'http://localhost:5173';
  const accepted = await demo.routes.request('http://localhost:4000/auth/password', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member', password: 'local-demo-password' }),
  });
  expect(accepted.status).toBe(200);
  const cookie = accepted.headers.get('set-cookie')!.split(';')[0]!;
  expect(cookie).toMatch(/^atlas-demo-session=/);

  const session = await demo.routes.request('http://localhost:4000/auth/session', {
    headers: { cookie },
  });
  expect(await session.json()).toMatchObject({
    mode: 'demo',
    user: { actorId: 'member' },
    methods: { password: true, sso: false, demo: true },
  });
});

it('revokes persisted sessions when an administrator removes the identity binding', async () => {
  await pool.query(
    `INSERT INTO customer_sessions (id_hash,organization_id,issuer,subject,client_id,auth_scope,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,now()+interval '1 hour')`,
    [idHash, 'customer', issuer, 'directory-subject', config.clientId, customerAuthScope(config)],
  );
  await pool.query("DELETE FROM customer_sso_identities WHERE user_id='member'");
  expect(await auth.authenticate(request())).toBeNull();
  expect((await pool.query('SELECT * FROM customer_sessions')).rows).toHaveLength(0);
});

it('completes a browser-bound login once and rejects expired requests, tampering and the wrong company', async () => {
  await pool.query(
    'INSERT INTO customer_sso_identities (organization_id,issuer,subject,user_id) VALUES ($1,$2,$3,$4)',
    ['customer', issuer, 'roundtrip-subject', 'member'],
  );
  let wrongCompany = false;
  const browserAuth = createCustomerAuth(pool, config, {
    authorizationUrl: async (login) =>
      new URL(`https://identity.example/authorize?state=${login.state}`),
    verify: async () => ({
      issuer,
      subject: 'roundtrip-subject',
      scope: wrongCompany ? 'other-company' : customerAuthScope(config),
    }),
  });
  const begin = async () => {
    const response = await browserAuth.routes.request('/auth/login');
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    return { cookie, callbackUrl: `${config.publicOrigin}/auth/callback?code=test&state=${state}` };
  };
  const login = await begin();
  const accepted = await browserAuth.routes.request(login.callbackUrl, {
    headers: { cookie: login.cookie },
  });
  expect(accepted.headers.get('location')).toBe(`${config.publicOrigin}/`);
  const sessionSetCookie = accepted.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith('__Host-atlas-session=') && !cookie.includes('Max-Age=0'))!;
  const sessionCookie = sessionSetCookie.split(';')[0]!;
  const persisted = await pool.query('SELECT id_hash FROM customer_sessions');
  expect(persisted.rows).toHaveLength(1);
  expect(persisted.rows[0].id_hash).not.toBe(sessionCookie.split('=')[1]);
  expect(
    (
      await browserAuth.authenticate(
        new Request(config.publicOrigin, { headers: { cookie: sessionCookie } }),
      )
    )?.actorId,
  ).toBe('member');
  const replay = await browserAuth.routes.request(login.callbackUrl, {
    headers: { cookie: login.cookie },
  });
  expect(replay.headers.get('location')).toContain('login=failed');
  const expired = await begin();
  await pool.query("UPDATE customer_login_requests SET expires_at=now()-interval '1 second'");
  expect(
    (
      await browserAuth.routes.request(expired.callbackUrl, { headers: { cookie: expired.cookie } })
    ).headers.get('location'),
  ).toContain('login=failed');
  const tampered = await begin();
  expect(
    (
      await browserAuth.routes.request(`${tampered.callbackUrl}forged`, {
        headers: { cookie: tampered.cookie },
      })
    ).headers.get('location'),
  ).toContain('login=failed');
  wrongCompany = true;
  const foreign = await begin();
  expect(
    (
      await browserAuth.routes.request(foreign.callbackUrl, {
        headers: { cookie: `${foreign.cookie}; ${sessionCookie}` },
      })
    ).headers.get('location'),
  ).toContain('login=failed');
  expect(
    await browserAuth.authenticate(
      new Request(config.publicOrigin, { headers: { cookie: sessionCookie } }),
    ),
  ).toBeNull();
  expect((await pool.query('SELECT * FROM customer_sessions')).rows).toHaveLength(0);
});

const providerConfigs: CustomerAuthConfig[] = [
  config,
  { ...config, provider: 'google', hostedDomain: 'customer.example' },
  { ...config, provider: 'okta', issuer: 'https://customer.okta.com' },
];

it.each(providerConfigs)(
  'supports the selected $provider provider with persisted sessions and logout',
  async (selected) => {
    const selectedIssuer = customerAuthIssuer(selected);
    const actorId = `${selected.provider}-member`;
    await pool.query('INSERT INTO users (id,email,name) VALUES ($1,$2,$3)', [
      actorId,
      `${actorId}@example.com`,
      actorId,
    ]);
    await pool.query(
      'INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)',
      ['customer', actorId, 'author'],
    );
    // Equal subjects from different providers must never identify the same user.
    await pool.query(
      'INSERT INTO customer_sso_identities (organization_id,issuer,subject,user_id) VALUES ($1,$2,$3,$4)',
      ['customer', selectedIssuer, 'shared-subject', actorId],
    );
    const verify = vi.fn<CustomerOidcProvider['verify']>(async () => ({
      issuer: selectedIssuer,
      subject: 'shared-subject',
      scope: customerAuthScope(selected),
    }));
    const selectedAuth = createCustomerAuth(pool, selected, {
      authorizationUrl: async (login) =>
        new URL(`https://identity.example/authorize?state=${login.state}`),
      verify,
    });
    const begin = async () => {
      const response = await selectedAuth.routes.request('/auth/login?provider=unselected');
      expect(response.status).toBe(302);
      const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
      return {
        cookie: response.headers.get('set-cookie')!.split(';')[0]!,
        callbackUrl: `${selected.publicOrigin}/auth/callback?code=test&state=${state}`,
      };
    };
    const login = await begin();
    const accepted = await selectedAuth.routes.request(login.callbackUrl, {
      headers: { cookie: login.cookie },
    });
    expect(accepted.headers.get('location')).toBe(`${selected.publicOrigin}/`);
    const sessionCookie = accepted.headers
      .getSetCookie()
      .find(
        (cookie) => cookie.startsWith('__Host-atlas-session=') && !cookie.includes('Max-Age=0'),
      )!
      .split(';')[0]!;
    const browserRequest = new Request(selected.publicOrigin, {
      headers: { cookie: sessionCookie },
    });
    expect((await selectedAuth.authenticate(browserRequest))?.actorId).toBe(actorId);
    const sessionResponse = await selectedAuth.routes.request('/auth/session', {
      headers: { cookie: sessionCookie },
    });
    expect(await sessionResponse.json()).toMatchObject({
      mode: 'customer',
      user: { actorId, organizationId: 'customer', role: 'author' },
    });

    const changed: CustomerAuthConfig =
      selected.provider === 'google'
        ? { ...selected, hostedDomain: 'another-company.example' }
        : selected.provider === 'okta'
          ? { ...selected, issuer: 'https://another-company.okta.com' }
          : { ...selected, tenantId: '22222222-2222-2222-2222-222222222222' };
    const otherAuth = createCustomerAuth(pool, changed, {
      authorizationUrl: async () => new URL('https://identity.example/authorize'),
      verify,
    });
    expect(await otherAuth.authenticate(browserRequest)).toBeNull();
    for (const other of providerConfigs.filter(
      (candidate) => candidate.provider !== selected.provider,
    )) {
      expect(await createCustomerAuth(pool, other).authenticate(browserRequest)).toBeNull();
    }
    const pending = await begin();
    const calls = verify.mock.calls.length;
    for (const callbackUrl of [
      `${selected.publicOrigin}/auth/callback`,
      `${selected.publicOrigin}/auth/callback?code=forged&state=forged`,
    ]) {
      const forgedCallback = await selectedAuth.routes.request(callbackUrl, {
        headers: { cookie: `${sessionCookie}; ${pending.cookie}` },
      });
      expect(forgedCallback.headers.get('location')).toContain('login=failed');
      expect((await selectedAuth.authenticate(browserRequest))?.actorId).toBe(actorId);
    }
    const pendingHash = createHash('sha256').update(pending.cookie.split('=')[1]!).digest('hex');
    expect(
      (
        await pool.query('SELECT id_hash FROM customer_login_requests WHERE id_hash=$1', [
          pendingHash,
        ])
      ).rowCount,
    ).toBe(1);
    expect(verify).toHaveBeenCalledTimes(calls);
    const wrongCompanyCallback = await otherAuth.routes.request(pending.callbackUrl, {
      headers: { cookie: pending.cookie },
    });
    expect(wrongCompanyCallback.headers.get('location')).toContain('login=failed');
    expect(verify).toHaveBeenCalledTimes(calls);

    const logout = await selectedAuth.routes.request('/auth/logout', {
      method: 'POST',
      headers: { cookie: `${sessionCookie}; ${pending.cookie}`, origin: selected.publicOrigin },
    });
    expect(logout.status).toBe(200);
    expect(await selectedAuth.authenticate(browserRequest)).toBeNull();
    const afterLogout = await selectedAuth.routes.request(pending.callbackUrl, {
      headers: { cookie: pending.cookie },
    });
    expect(afterLogout.headers.get('location')).toContain('login=failed');
  },
);

it('rejects sessions created before provider and company restrictions were recorded', async () => {
  await pool.query(
    `INSERT INTO customer_sessions (id_hash,organization_id,issuer,subject,client_id,expires_at)
    VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour')`,
    [idHash, 'customer', issuer, 'shared-subject', config.clientId],
  );
  expect(await auth.authenticate(request())).toBeNull();
  await pool.query('DELETE FROM customer_sessions WHERE id_hash=$1', [idHash]);
});
