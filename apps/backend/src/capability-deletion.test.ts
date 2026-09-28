import { ingestCapabilities } from './capability-ingestion.js';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createApp } from './app.js';
import { readCapabilityCatalog } from './capability-catalog.js';
import { loadCapabilitySelectionFacts } from './capability-selection.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schema = `capability_deletion_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const app = createApp(
  pool,
  undefined,
  undefined,
  undefined,
  undefined,
  {
    async authorize(request) {
      return request.authorizationHeader === 'Bearer test-admin' &&
        request.organizationId === 'org_delete' &&
        request.action === 'manage-organization'
        ? { actorId: 'admin', role: 'admin' as const }
        : null;
    },
  },
  { allowLegacySourceRoutes: true },
);

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema, lockValue: 1479 });
  await pool.query("INSERT INTO organizations (id) VALUES ('org_delete') ON CONFLICT DO NOTHING");
});
afterAll(async () => {
  await pool.end();
});

async function ingest(serviceId: string, environmentId = 'development') {
  await ingestCapabilities(
    pool,
    {
      organizationId: 'org_delete',
      serviceId,
      source: {
        format: 'openapi',
        repository: 'https://github.com/atlas/test',
        commit: 'v1',
        path: `${serviceId}.json`,
        document: {
          openapi: '3.1.0',
          info: { title: serviceId, version: '1.0.0' },
          paths: {
            '/items': {
              get: { operationId: 'listItems', responses: { '200': { description: 'ok' } } },
            },
          },
        },
      },
      manifest: {
        source: {
          repository: 'https://github.com/atlas/test',
          commit: 'v1',
          path: `${serviceId}-manifest.json`,
        },
        annotations: [],
      },
    },
    environmentId,
  );
  const catalog = await readCapabilityCatalog(pool, 'org_delete', environmentId);
  return catalog.find((capability) => capability.identity.serviceId === serviceId);
}

function remove(
  id: string,
  environmentId = 'development',
  token = 'test-admin',
  organizationId = 'org_delete',
) {
  return app.request(
    `/v1/organizations/${organizationId}/environments/${environmentId}/capabilities/${id}`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    },
  );
}

describe('capability deletion', () => {
  it('requires an organization admin and hides deleted capabilities only in the selected environment', async () => {
    const capability = (await ingest('deletable'))!;
    await ingest('deletable', 'production');
    expect(
      (await remove(capability.capabilityIdentityId, 'development', 'test-author')).status,
    ).toBe(403);
    expect(
      (await remove(capability.capabilityIdentityId, 'development', 'test-admin', 'other-org'))
        .status,
    ).toBe(403);
    expect((await remove(capability.capabilityIdentityId)).status).toBe(200);
    expect(
      (await readCapabilityCatalog(pool, 'org_delete', 'development')).some(
        (item) => item.capabilityIdentityId === capability.capabilityIdentityId,
      ),
    ).toBe(false);
    expect(
      (await readCapabilityCatalog(pool, 'org_delete', 'production')).some(
        (item) => item.capabilityIdentityId === capability.capabilityIdentityId,
      ),
    ).toBe(true);
    expect(
      await loadCapabilitySelectionFacts(
        pool,
        'org_delete',
        capability.capabilityVersionId,
        'development',
      ),
    ).toMatchObject({ isAvailable: false });
    expect((await remove(capability.capabilityIdentityId)).status).toBe(404);
    await ingest('deletable');
    expect(
      (await readCapabilityCatalog(pool, 'org_delete', 'development')).some(
        (item) => item.capabilityIdentityId === capability.capabilityIdentityId,
      ),
    ).toBe(false);
    expect(
      (
        await pool.query(
          "SELECT details FROM audit_entries WHERE subject_type = 'capability' AND subject_id = $1",
          [capability.capabilityIdentityId],
        )
      ).rows,
    ).toEqual([{ details: { action: 'deleted' } }]);
  });

  it('rejects deleting a capability used by a saved workflow', async () => {
    const capability = (await ingest('in-use'))!;
    await pool.query(
      "INSERT INTO workflow_versions (organization_id, workflow_version_id, ir_hash, compiled_workflow) VALUES ('org_delete', 'used@1', repeat('a',64), '{}')",
    );
    await pool.query(
      "INSERT INTO workflow_capability_dependencies (organization_id, workflow_version_id, step_id, capability_version_id) VALUES ('org_delete', 'used@1', 'invoke', $1)",
      [capability.capabilityVersionId],
    );
    expect((await remove(capability.capabilityIdentityId)).status).toBe(409);
    expect(
      (await readCapabilityCatalog(pool, 'org_delete', 'development')).some(
        (item) => item.capabilityIdentityId === capability.capabilityIdentityId,
      ),
    ).toBe(true);
  });

  it('returns a clear response for invalid and missing capabilities', async () => {
    expect((await remove('not-an-id')).status).toBe(400);
    expect((await remove('9223372036854775807')).status).toBe(404);
  });
});
