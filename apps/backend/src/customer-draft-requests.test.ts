import { Hono } from 'hono';
import { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vite-plus/test';

import { createApp } from './app.js';
import { createPlanningMembershipAuthorizer } from './admin-suite.js';
import { createCustomerAccess } from './customer-access.js';
import { DraftRequests } from './draft-requests.js';

afterEach(() => vi.restoreAllMocks());

it('binds draft creation, recovery, and cancellation to the verified customer identity', async () => {
  const start = vi.spyOn(DraftRequests.prototype, 'start').mockResolvedValue(undefined);
  const read = vi.spyOn(DraftRequests.prototype, 'read').mockResolvedValue(undefined);
  const cancel = vi.spyOn(DraftRequests.prototype, 'cancel').mockResolvedValue(undefined);
  const pool = new Pool();
  const access = createCustomerAccess({
    authenticate: async (request) => ({
      actorId: request.headers.get('cookie') === 'session=alice' ? 'alice' : 'bob',
      organizationId: 'customer',
      role: 'author',
    }),
    environmentsBelongToOrganization: async () => true,
    isTrustedRequest: () => true,
  });
  const app = createApp(
    pool,
    undefined,
    {
      extractIntent: async () => undefined,
      draftWorkflow: async () => undefined,
      repairWorkflow: async () => undefined,
    },
    createPlanningMembershipAuthorizer(access.membershipAuthorizer),
    undefined,
    access.membershipAuthorizer,
    { customerAuth: { routes: new Hono(), ...access } },
  );
  const id = '12345678-1234-4234-8234-123456789abc';
  try {
    for (const actorId of ['alice', 'bob']) {
      for (const method of ['PUT', 'GET', 'DELETE']) {
        const response = await app.request(
          `/v1/draft-requests/${id}?organizationId=customer&environmentId=development`,
          {
            method,
            headers: { cookie: `session=${actorId}`, 'content-type': 'application/json' },
            ...(method === 'PUT'
              ? {
                  body: JSON.stringify({
                    organizationId: 'customer',
                    environmentId: 'development',
                    request: 'Read an invoice',
                    workflowVersionId: 'invoice@1',
                  }),
                }
              : {}),
          },
        );
        expect(response.status).toBe(404);
        const operation = method === 'PUT' ? start : method === 'GET' ? read : cancel;
        expect(operation.mock.lastCall?.[1]).toEqual({
          actorId,
          organizationId: 'customer',
          environmentId: 'development',
        });
      }
    }
  } finally {
    await pool.end();
  }
});
