import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createCustomerAuth } from './customer-auth.js';
import { createCustomerEnrollment, type CustomerAccessRequest } from './customer-enrollment.js';
import { approveCustomerAccessRequest } from './customer-sso-admin.js';
import {
  customerAuthIssuer,
  customerAuthScope,
  type CustomerAuthConfig,
} from './customer-sso-provider.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const schema = `customer_enrollment_test_${process.pid}`;
const databaseUrl = resolveTestDatabaseUrl();
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const config: CustomerAuthConfig = {
  provider: 'google',
  hostedDomain: 'customer.example',
  clientId: 'client',
  clientSecret: 'secret',
  organizationId: 'customer',
  publicOrigin: 'https://atlas.example',
  sessionMaxAgeSeconds: 3600,
};
const service = createCustomerEnrollment(pool, config);
const issuer = customerAuthIssuer(config);
let adminCookie: string;
let adminId: string;
let currentIdentity = {
  issuer,
  subject: 'first-admin',
  scope: customerAuthScope(config),
  displayName: 'First Admin',
  email: 'first-admin@customer.example',
};
const auth = createCustomerAuth(pool, config, {
  authorizationUrl: async (login) =>
    new URL(`https://identity.example/authorize?state=${login.state}`),
  verify: async () => currentIdentity,
});
const cookieFrom = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${name}=`) && !cookie.includes('Max-Age=0'))
    ?.split(';')[0];
async function signIn(subject: string, email = `${subject}@customer.example`) {
  currentIdentity = {
    issuer,
    subject,
    scope: customerAuthScope(config),
    displayName: `User ${subject}`,
    email,
  };
  const login = await auth.routes.request('/auth/login');
  const state = new URL(login.headers.get('location')!).searchParams.get('state');
  return auth.routes.request(`${config.publicOrigin}/auth/callback?code=test&state=${state}`, {
    headers: { cookie: cookieFrom(login, '__Host-atlas-login')! },
  });
}
async function pending(subject: string = randomUUID(), email?: string) {
  const response = await signIn(subject, email);
  const cookie = cookieFrom(response, '__Host-atlas-enrollment')!;
  const session = await auth.routes.request('/auth/session', { headers: { cookie } });
  const body = (await session.json()) as { user: null; enrollment: CustomerAccessRequest };
  expect(body.user).toBeNull();
  expect(body.enrollment.status).toBe('pending');
  return { request: body.enrollment, cookie, subject };
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema, lockValue: 277 });
  await pool.query("INSERT INTO organizations(id,name) VALUES ('customer','Customer')");
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

it('enrolls the first admin through verified sign-in and a protected operator approval', async () => {
  const enrollment = await pending('first-admin');
  expect(
    await auth.authenticate(
      new Request(config.publicOrigin, { headers: { cookie: enrollment.cookie } }),
    ),
  ).toBeNull();
  expect(await service.findForBrowser(enrollment.request.id)).toBeNull();
  expect((await pool.query('SELECT * FROM organization_memberships')).rows).toHaveLength(0);
  await approveCustomerAccessRequest(pool, config, {
    requestId: enrollment.request.id,
    role: 'admin',
    operator: 'installer',
    reason: 'First customer administrator',
  });
  const status = await auth.routes.request('/auth/session', {
    headers: { cookie: enrollment.cookie },
  });
  expect((await status.json()).enrollment.status).toBe('approved');
  const signedIn = await signIn('first-admin');
  adminCookie = cookieFrom(signedIn, '__Host-atlas-session')!;
  const actor = await auth.authenticate(
    new Request(config.publicOrigin, { headers: { cookie: adminCookie } }),
  );
  expect(actor?.role).toBe('admin');
  adminId = actor!.actorId;
  expect(
    (await pool.query("SELECT details FROM audit_entries WHERE subject_type='access-request'"))
      .rows[0].details,
  ).toMatchObject({ operator: 'installer', outcome: 'succeeded' });
});

it('lets only current administrators approve a requested role and rejects cross-origin decisions', async () => {
  const enrollment = await pending();
  const path = `/auth/access-requests/${enrollment.request.id}/approve`;
  expect(
    (await auth.routes.request('/auth/access-requests', { headers: { cookie: enrollment.cookie } }))
      .status,
  ).toBe(403);
  expect(
    (
      await auth.routes.request(path, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: 'https://evil.example' },
        body: JSON.stringify({ role: 'admin' }),
      })
    ).status,
  ).toBe(403);
  const approval = await auth.routes.request(path, {
    method: 'POST',
    headers: {
      cookie: adminCookie,
      origin: config.publicOrigin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ role: 'operator', organizationId: 'other' }),
  });
  expect(approval.status).toBe(200);
  const cookie = cookieFrom(await signIn(enrollment.subject), '__Host-atlas-session')!;
  expect(
    (await auth.authenticate(new Request(config.publicOrigin, { headers: { cookie } })))?.role,
  ).toBe('operator');
  expect((await auth.routes.request('/auth/access-requests', { headers: { cookie } })).status).toBe(
    403,
  );
  const replay = await auth.routes.request(path, {
    method: 'POST',
    headers: { cookie: adminCookie, origin: config.publicOrigin },
    body: JSON.stringify({ role: 'admin' }),
  });
  expect(replay.status).toBe(409);
});

it('keeps rejected requests unprivileged and does not auto-link duplicate email addresses', async () => {
  const rejected = await pending();
  expect(
    (
      await auth.routes.request(`/auth/access-requests/${rejected.request.id}/reject`, {
        method: 'POST',
        headers: { cookie: adminCookie, origin: config.publicOrigin },
      })
    ).status,
  ).toBe(200);
  expect((await service.findForBrowser(rejected.cookie.split('=')[1]))?.status).toBe('rejected');
  const again = await signIn(rejected.subject);
  expect(cookieFrom(again, '__Host-atlas-session')).toBeUndefined();
  const conflict = await pending(randomUUID(), 'first-admin@customer.example');
  await expect(
    approveCustomerAccessRequest(pool, config, {
      requestId: conflict.request.id,
      role: 'admin',
      operator: 'installer',
      reason: 'Duplicate email attempt',
    }),
  ).rejects.toThrow('existing account');
  expect(
    (
      await pool.query('SELECT status FROM customer_access_requests WHERE id=$1', [
        conflict.request.id,
      ])
    ).rows[0].status,
  ).toBe('pending');
  expect(
    (
      await pool.query('SELECT user_id FROM customer_sso_identities WHERE subject=$1', [
        conflict.subject,
      ])
    ).rows,
  ).toHaveLength(0);
});

it('rejects expired and other-installation requests without trusting their reference IDs', async () => {
  const enrollment = await pending();
  const other = createCustomerEnrollment(pool, { ...config, hostedDomain: 'other.example' });
  expect(await other.findForBrowser(enrollment.cookie.split('=')[1])).toBeNull();
  await expect(
    other.decide({
      requestId: enrollment.request.id,
      decision: 'approve',
      role: 'admin',
      operator: 'installer',
      reason: 'Wrong config',
    }),
  ).rejects.toThrow('unavailable');
  await pool.query(
    "UPDATE customer_access_requests SET expires_at=now()-interval '1 second' WHERE id=$1",
    [enrollment.request.id],
  );
  expect(await service.findForBrowser(enrollment.cookie.split('=')[1])).toBeNull();
  await expect(
    service.decide({
      requestId: enrollment.request.id,
      decision: 'approve',
      role: 'admin',
      operator: 'installer',
      reason: 'Expired request',
    }),
  ).rejects.toThrow('expired');
});

it('recovers an existing admin with an explicit request and revokes the former identity and session', async () => {
  const enrollment = await pending('replacement-admin');
  await approveCustomerAccessRequest(pool, config, {
    requestId: enrollment.request.id,
    role: 'admin',
    existingUserId: adminId,
    operator: 'installer',
    reason: 'Directory account recovery',
  });
  expect(
    await auth.authenticate(new Request(config.publicOrigin, { headers: { cookie: adminCookie } })),
  ).toBeNull();
  expect(
    (await pool.query('SELECT subject FROM customer_sso_identities WHERE user_id=$1', [adminId]))
      .rows,
  ).toEqual([{ subject: 'replacement-admin' }]);
  adminCookie = cookieFrom(await signIn('replacement-admin'), '__Host-atlas-session')!;
  expect(
    (
      await auth.authenticate(
        new Request(config.publicOrigin, { headers: { cookie: adminCookie } }),
      )
    )?.actorId,
  ).toBe(adminId);
});

it('removes membership and sessions while protecting the last administrator', async () => {
  expect(
    (
      await auth.routes.request(`/auth/members/${adminId}`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: config.publicOrigin },
      })
    ).status,
  ).toBe(409);
  const enrollment = await pending();
  await service.decide({
    requestId: enrollment.request.id,
    decision: 'approve',
    role: 'author',
    operator: adminId,
    authorizedActorId: adminId,
    reason: 'New author',
  });
  const cookie = cookieFrom(await signIn(enrollment.subject), '__Host-atlas-session')!;
  const user = await auth.authenticate(new Request(config.publicOrigin, { headers: { cookie } }));
  expect(
    (
      await auth.routes.request(`/auth/members/${user!.actorId}`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: config.publicOrigin },
      })
    ).status,
  ).toBe(200);
  expect(
    await auth.authenticate(new Request(config.publicOrigin, { headers: { cookie } })),
  ).toBeNull();
  const readmission = await pending(enrollment.subject);
  expect(readmission.request.id).not.toBe(enrollment.request.id);
  await service.decide({
    requestId: readmission.request.id,
    decision: 'approve',
    role: 'author',
    operator: adminId,
    authorizedActorId: adminId,
    reason: 'Readmit the same verified identity',
  });
  const readmittedCookie = cookieFrom(await signIn(enrollment.subject), '__Host-atlas-session')!;
  expect(
    (
      await auth.authenticate(
        new Request(config.publicOrigin, { headers: { cookie: readmittedCookie } }),
      )
    )?.actorId,
  ).toBe(user!.actorId);
});

it('approves a profile without email without linking another account and permits only one concurrent decision', async () => {
  const subject = randomUUID();
  const requested = await service.request({
    issuer,
    scope: customerAuthScope(config),
    subject,
    displayName: 'No Email',
  });
  const change = {
    requestId: requested.request.id,
    decision: 'approve' as const,
    role: 'author' as const,
    operator: adminId,
    authorizedActorId: adminId,
    reason: 'Approve one user',
  };
  const outcomes = await Promise.allSettled([service.decide(change), service.decide(change)]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  const users = await pool.query(
    'SELECT u.email FROM users u JOIN customer_sso_identities i ON i.user_id=u.id WHERE i.subject=$1',
    [subject],
  );
  expect(users.rows).toHaveLength(1);
  expect(users.rows[0].email).toMatch(/@sso\.invalid$/);
});

it('revokes the enrollment browser cookie on logout without withdrawing the review request', async () => {
  const enrollment = await pending();
  const response = await auth.routes.request('/auth/logout', {
    method: 'POST',
    headers: { cookie: enrollment.cookie, origin: config.publicOrigin },
  });
  expect(response.status).toBe(200);
  expect(await service.findForBrowser(enrollment.cookie.split('=')[1])).toBeNull();
  expect((await service.list()).some((request) => request.id === enrollment.request.id)).toBe(true);
});

it('prevents recovery from demoting the last admin and checks current admin membership inside approval', async () => {
  const enrollment = await pending();
  await expect(
    approveCustomerAccessRequest(pool, config, {
      requestId: enrollment.request.id,
      role: 'author',
      existingUserId: adminId,
      operator: 'installer',
      reason: 'Unsafe admin downgrade',
    }),
  ).rejects.toThrow('last administrator');
  await expect(
    service.decide({
      requestId: enrollment.request.id,
      decision: 'approve',
      role: 'admin',
      operator: 'removed-admin',
      authorizedActorId: 'removed-admin',
      reason: 'Stale administrator',
    }),
  ).rejects.toThrow('Administrator access');
  expect(
    (
      await auth.authenticate(
        new Request(config.publicOrigin, { headers: { cookie: adminCookie } }),
      )
    )?.role,
  ).toBe('admin');
});
