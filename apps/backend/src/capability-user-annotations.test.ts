import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { readCapabilityCatalog, readPlannerCapabilityProjection } from './capability-catalog.js';
import { ingestCapabilities, readCapabilityVersion } from './capability-ingestion.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schema = `capability_user_annotations_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const organizationId = 'org_annotations';
const token = 'annotation-member';
const app = createApp(pool, undefined, undefined, undefined, undefined, {
  async authorize(request) {
    return request.authorizationHeader === `Bearer ${token}` &&
      request.organizationId === organizationId &&
      request.action === 'annotate-capability'
      ? { actorId: 'avery', role: 'author' as const }
      : null;
  },
});

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema, lockValue: 271 });
  await pool.query('INSERT INTO organizations (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    organizationId,
  ]);
});

afterAll(async () => {
  await pool.end();
});

function sourceRequest(commit: string, description: string) {
  return {
    organizationId,
    serviceId: 'orders',
    source: {
      format: 'openapi' as const,
      repository: 'https://github.com/atlas/orders',
      commit,
      path: 'openapi.json',
      document: {
        openapi: '3.1.0',
        info: { title: 'Orders', version: commit },
        paths: {
          '/orders': {
            get: {
              operationId: 'listOrders',
              description,
              responses: {
                '200': {
                  description: 'Orders',
                  content: {
                    'application/json': { schema: { type: 'array', items: { type: 'object' } } },
                  },
                },
              },
            },
          },
        },
      },
    },
    manifest: {
      source: {
        repository: 'https://github.com/atlas/orders',
        commit,
        path: 'atlas-manifest.json',
      },
      annotations: [
        {
          capability: { operationId: 'listOrders' },
          owner: 'order-operations',
          secretAlias: null,
          businessSemantics: { listsFulfillmentOrders: true },
          idempotencyField: null,
          compensatedBy: null,
          irreversibleAfter: false,
        },
      ],
    },
  };
}

function annotationsPath(capabilityIdentityId: string, annotationId?: string) {
  const path = `/v1/organizations/${organizationId}/capabilities/${capabilityIdentityId}/annotations`;
  return annotationId ? `${path}/${annotationId}` : path;
}

async function authorizeForPlanning(capabilityVersionId: string) {
  const stored = await pool.query<{ annotation_id: string; identity_id: string }>(
    `SELECT manifest_annotation_id AS annotation_id, capability_identity_id AS identity_id
     FROM capability_versions
     WHERE organization_id = $1 AND capability_version_id = $2`,
    [organizationId, capabilityVersionId],
  );
  await pool.query(
    `INSERT INTO manifest_annotation_approvals
       (organization_id, manifest_annotation_id, approved_by)
     VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
    [organizationId, stored.rows[0]!.annotation_id],
  );
  await pool.query(
    `INSERT INTO capability_approvals
       (organization_id, capability_version_id, approved_by)
     VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
    [organizationId, capabilityVersionId],
  );
  await pool.query(
    `INSERT INTO capability_host_policies
       (organization_id, capability_identity_id, hostname, approved_by)
     VALUES ($1, $2, 'orders.internal', 'admin') ON CONFLICT DO NOTHING`,
    [organizationId, stored.rows[0]!.identity_id],
  );
}

describe('capability user annotations', () => {
  it('supports member CRUD, survives monitoring updates, and reaches workflow planning', async () => {
    const first = await ingestCapabilities(pool, sourceRequest('v1', 'List current orders'));
    const firstVersionId = first.capabilities[0]!.capabilityVersionId;
    const firstCatalog = await readCapabilityCatalog(pool, organizationId);
    const capabilityIdentityId = firstCatalog[0]!.capabilityIdentityId;

    const unauthorized = await app.request(annotationsPath(capabilityIdentityId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Private orders are excluded.' }),
    });
    expect(unauthorized.status).toBe(403);

    const invalid = await app.request(annotationsPath(capabilityIdentityId), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: '   ' }),
    });
    expect(invalid.status).toBe(400);

    const createdResponse = await app.request(annotationsPath(capabilityIdentityId), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Use this only for active retail fulfillment orders.' }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as { id: string };
    expect(await readCapabilityCatalog(pool, organizationId)).toMatchObject([
      {
        capabilityIdentityId,
        capabilityVersionId: firstVersionId,
        userAnnotations: [
          {
            id: created.id,
            body: 'Use this only for active retail fulfillment orders.',
            createdBy: 'avery',
          },
        ],
      },
    ]);

    const updatedResponse = await app.request(annotationsPath(capabilityIdentityId, created.id), {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Use this only for active wholesale fulfillment orders.' }),
    });
    expect(updatedResponse.status).toBe(200);

    const second = await ingestCapabilities(
      pool,
      sourceRequest('v2', 'List current orders with their fulfillment state'),
    );
    const secondVersionId = second.capabilities[0]!.capabilityVersionId;
    expect(secondVersionId).not.toBe(firstVersionId);
    await authorizeForPlanning(secondVersionId);

    const secondCatalog = await readCapabilityCatalog(pool, organizationId);
    expect(secondCatalog[0]).toMatchObject({
      capabilityIdentityId,
      capabilityVersionId: secondVersionId,
      userAnnotations: [
        {
          id: created.id,
          body: 'Use this only for active wholesale fulfillment orders.',
          createdBy: 'avery',
          updatedBy: 'avery',
        },
      ],
    });
    await expect(
      readCapabilityVersion(pool, organizationId, secondVersionId),
    ).resolves.toMatchObject({
      capabilityIdentityId,
      userAnnotations: [
        { id: created.id, body: 'Use this only for active wholesale fulfillment orders.' },
      ],
    });
    await expect(readPlannerCapabilityProjection(pool, organizationId)).resolves.toMatchObject({
      capabilities: [
        {
          capabilityVersionId: secondVersionId,
          userAnnotations: ['Use this only for active wholesale fulfillment orders.'],
        },
      ],
    });

    const deleted = await app.request(annotationsPath(capabilityIdentityId, created.id), {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.status).toBe(200);
    expect((await readCapabilityCatalog(pool, organizationId))[0]!.userAnnotations).toEqual([]);
    expect(
      (await readPlannerCapabilityProjection(pool, organizationId)).capabilities[0],
    ).not.toHaveProperty('userAnnotations');
    expect(
      (
        await app.request(annotationsPath(capabilityIdentityId, created.id), {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(404);
  });
});
