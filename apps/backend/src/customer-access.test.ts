import { Hono } from 'hono';
import { describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { createCustomerAccess, type CustomerActor } from './customer-access.js';

const admin: CustomerActor = { actorId: 'alice', organizationId: 'customer', role: 'admin' };

function setup(actor: CustomerActor | null = admin) {
  const access = createCustomerAccess({
    authenticate: async () => actor,
    environmentsBelongToOrganization: async (organizationId, environmentIds) =>
      organizationId === 'customer' && environmentIds.every((id) => id === 'development'),
    isTrustedRequest: (request) => request.headers.get('origin') === 'https://atlas.example',
  });
  const app = new Hono().use('/v1/*', access.middleware);
  app.all('/v1/*', async (context) =>
    context.json({
      actor: await access.membershipAuthorizer.authorize({
        authorizationHeader: context.req.header('authorization'),
        organizationId: 'customer',
        action: 'manage-organization',
      }),
    }),
  );
  return { app, access };
}

describe('customer access', () => {
  it('limits saved workflow drafts and version creation to authors and admins', async () => {
    for (const [method, path] of [
      ['GET', '/v1/workflow-editor-drafts'],
      ['GET', '/v1/workflow-editor-drafts/one'],
      ['PUT', '/v1/workflow-editor-drafts/one'],
      ['POST', '/v1/workflow-editor-drafts/one/versions'],
      ['POST', '/v1/workflow-editor-drafts/one/validation'],
    ] as const) {
      const options = { method, headers: { origin: 'https://atlas.example' } };
      expect((await setup({ ...admin, role: 'author' }).app.request(path!, options)).status).toBe(
        200,
      );
      expect((await setup({ ...admin, role: 'operator' }).app.request(path!, options)).status).toBe(
        403,
      );
    }
  });
  it('allows authors to start, recover, and cancel drafts while rejecting operators', async () => {
    for (const method of ['PUT', 'GET', 'DELETE']) {
      const path = '/v1/draft-requests/one?organizationId=customer';
      const options = { method, headers: { origin: 'https://atlas.example' } };
      expect((await setup({ ...admin, role: 'author' }).app.request(path, options)).status).toBe(
        200,
      );
      expect((await setup({ ...admin, role: 'operator' }).app.request(path, options)).status).toBe(
        403,
      );
    }
  });

  it('scopes validation of unsaved workflow documents to the signed-in organization and environment', async () => {
    const { app } = setup({ ...admin, role: 'author' });
    for (const scope of [
      { organizationId: 'other', environmentId: 'development' },
      { organizationId: 'customer', environmentId: 'other' },
    ]) {
      const response = await app.request('/v1/workflow-editor-drafts/unsaved/validation', {
        method: 'POST',
        headers: { origin: 'https://atlas.example', 'content-type': 'application/json' },
        body: JSON.stringify(scope),
      });
      expect(response.status).toBe(403);
    }
  });

  it('requires sign-in on previously public read and write endpoints', async () => {
    const access = createCustomerAccess({
      authenticate: async () => null,
      environmentsBelongToOrganization: async () => false,
      isTrustedRequest: () => true,
    });
    const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, {
      customerAuth: { routes: new Hono(), middleware: access.middleware },
    });
    for (const path of [
      '/v1/capabilities',
      '/v1/runs',
      '/v1/workflow-drafts',
      '/v1/organizations/customer/admin-suite',
    ]) {
      const response = await app.request(path, {
        headers: { authorization: 'Bearer shared-demo-admin' },
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('takes identity and permissions from the session, ignoring claimed roles and tokens', async () => {
    const { app } = setup({ ...admin, role: 'author' });
    const response = await app.request('/v1/workflow-drafts', {
      method: 'POST',
      headers: {
        origin: 'https://atlas.example',
        authorization: 'Bearer shared-demo-admin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ organizationId: 'customer', role: 'admin', actorId: 'someone-else' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ actor: null });
  });

  it('rejects another organization in the path, query, or nested body', async () => {
    const { app } = setup();
    for (const path of [
      '/v1/organizations/other/admin-suite',
      '/v1/example?organizationId=customer&organizationId=other',
    ]) {
      expect((await app.request(path)).status).toBe(403);
    }
    const response = await app.request('/v1/example', {
      method: 'POST',
      headers: { origin: 'https://atlas.example' },
      body: JSON.stringify({ input: { organizationId: 'other' } }),
    });
    expect(response.status).toBe(403);
  });

  it('rejects another or unknown environment in the path, query, or nested body', async () => {
    const { app } = setup();
    for (const path of [
      '/v1/example?environmentId=other',
      '/v1/organizations/customer/environments/other/settings',
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'environment-access-rejected' });
    }
    const response = await app.request('/v1/example', {
      method: 'POST',
      headers: { origin: 'https://atlas.example', 'content-type': 'application/json' },
      body: JSON.stringify({ input: { environmentIds: ['development', 'other'] } }),
    });
    expect(response.status).toBe(403);
  });

  it('rejects writes without the configured origin, including missing Origin', async () => {
    const { app } = setup();
    expect((await app.request('/v1/example', { method: 'POST' })).status).toBe(403);
    expect(
      (
        await app.request('/v1/example', {
          method: 'POST',
          headers: { origin: 'https://attacker.example' },
        })
      ).status,
    ).toBe(403);
  });

  it('keeps worker access separate from the human identity context', async () => {
    const { app } = setup(null);
    expect(await (await app.request('/v1/run-commands/next')).json()).toEqual({ actor: null });
    expect((await app.request('/v1/workflow-versions')).status).toBe(401);
    expect((await app.request('/v1/run-commands/next', { method: 'POST' })).status).toBe(401);
    expect(
      (
        await app.request('/v1/organizations/customer/settings', {
          method: 'PATCH',
          headers: {
            authorization: 'Bearer worker-credential',
            origin: 'https://atlas.example',
          },
        })
      ).status,
    ).toBe(401);
  });

  it('does not retain identity after the request or share it between concurrent requests', async () => {
    const access = createCustomerAccess({
      authenticate: async (request) => ({
        ...admin,
        actorId: new URL(request.url).searchParams.get('actor')!,
      }),
      environmentsBelongToOrganization: async () => true,
      isTrustedRequest: () => true,
    });
    const authorize = () =>
      access.membershipAuthorizer.authorize({
        authorizationHeader: undefined,
        organizationId: 'customer',
        action: 'manage-organization',
      });
    const app = new Hono().use('/v1/*', access.middleware).get('/v1/example', async (context) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return context.json(await authorize());
    });
    const results = await Promise.all(
      ['alice', 'bob'].map(async (actor) =>
        (await app.request(`/v1/example?actor=${actor}`)).json(),
      ),
    );
    expect(results).toEqual([
      { actorId: 'alice', role: 'admin' },
      { actorId: 'bob', role: 'admin' },
    ]);
    expect(await authorize()).toBeNull();
  });

  it('reports session storage failures without exposing the underlying error', async () => {
    const access = createCustomerAccess({
      authenticate: async () => {
        throw new Error('secret connection string');
      },
      environmentsBelongToOrganization: async () => true,
      isTrustedRequest: () => true,
    });
    const app = new Hono()
      .use('/v1/*', access.middleware)
      .get('/v1/example', (context) => context.text('unexpected'));
    const response = await app.request('/v1/example');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
  });
});

it.each([
  ['author', '/v1/workflow-drafts', 200],
  ['author', '/v1/workflow-edits', 200],
  ['author', '/v1/workflow-sandbox-tests', 200],
  ['author', '/v1/workflow-approvals', 403],
  ['author', '/v1/capability-source-connections', 403],
  ['author', '/v1/runs/run-1/repairs', 403],
  ['operator', '/v1/workflow-drafts', 403],
  ['operator', '/v1/workflow-edits', 403],
  ['operator', '/v1/workflow-sandbox-tests', 403],
  ['operator', '/v1/workflow-approvals', 403],
  ['operator', '/v1/capability-source-connections', 403],
  ['operator', '/v1/runs/run-1/repairs', 200],
  ['admin', '/v1/workflow-approvals', 200],
  ['admin', '/v1/capability-source-connections', 200],
  ['admin', '/v1/runs/run-1/repairs', 200],
] as const)('enforces %s access to %s on direct requests', async (role, path, status) => {
  const { app } = setup({ ...admin, role });
  const response = await app.request(path, {
    method: 'POST',
    headers: { origin: 'https://atlas.example' },
    body: JSON.stringify({ organizationId: 'customer', role: 'admin' }),
  });
  expect(response.status).toBe(status);
});

it.each([
  ['author', 'PATCH', '/v1/workflow-migration-candidates/candidate', 200],
  ['author', 'PUT', '/v1/workflow-sandbox-test-requests/request-id', 200],
  ['author', 'DELETE', '/v1/workflow-sandbox-test-requests/request-id', 200],
  ['operator', 'PATCH', '/v1/workflow-migration-candidates/candidate', 403],
  ['operator', 'PUT', '/v1/workflow-sandbox-test-requests/request-id', 403],
  ['operator', 'DELETE', '/v1/workflow-sandbox-test-requests/request-id', 403],
  ['author', 'DELETE', '/v1/notifications', 200],
  ['operator', 'DELETE', '/v1/notifications', 200],
] as const)('allows existing %s actions: %s %s', async (role, method, path, status) => {
  const { app } = setup({ ...admin, role });
  expect(
    (await app.request(path, { method, headers: { origin: 'https://atlas.example' } })).status,
  ).toBe(status);
});

it.each(['author', 'operator'] as const)(
  'requires admin for unclassified writes by %s',
  async (role) => {
    const { app } = setup({ ...admin, role });
    expect(
      (
        await app.request('/v1/new-sensitive-route', {
          method: 'POST',
          headers: { origin: 'https://atlas.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/v1/organizations/customer/settings', {
          method: 'PATCH',
          headers: { origin: 'https://atlas.example' },
        })
      ).status,
    ).toBe(403);
  },
);
