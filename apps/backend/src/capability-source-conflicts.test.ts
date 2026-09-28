import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `capability_source_conflicts_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const app = createApp(pool, { allowedHosts: [] }, undefined, undefined, undefined, {
  async authorize(request) {
    if (request.authorizationHeader !== 'Bearer admin-token') return null;
    return {
      actorId: 'conflict-admin',
      role: request.action === 'manage-organization' ? ('admin' as const) : ('author' as const),
    };
  },
});
const runId = randomUUID();

function discoveryRequest(
  organizationId: string,
  environmentId: string,
  repository: string,
  commit: string,
  includeOptionalReference = false,
) {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Payments', version: '1' },
    paths: {
      '/payments/{paymentId}': {
        get: {
          operationId: 'getPayment',
          parameters: [
            { name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } },
            ...(includeOptionalReference
              ? [{ name: 'reference', in: 'query', required: false, schema: { type: 'string' } }]
              : []),
          ],
          responses: {
            '200': {
              description: 'Payment',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
    },
  };
  return {
    organizationId,
    environmentId,
    serviceId: 'payments',
    source: { format: 'openapi', document, repository, commit, path: 'openapi.json' },
    manifest: {
      source: { repository, commit, path: 'atlas-manifest.json' },
      annotations: [
        {
          capability: { operationId: 'getPayment' },
          owner: 'payments-team',
          secretAlias: null,
          businessSemantics: { readsPayment: true },
          idempotencyField: null,
          compensatedBy: null,
          irreversibleAfter: false,
        },
      ],
    },
  };
}

async function connect(body: unknown, token = 'admin-token') {
  return app.request('/v1/capability-source-connections', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface TestCatalogCapability {
  capabilityVersionId: string;
  capabilityIdentityId: string;
  sourceResolution: {
    status: string;
    claims: Array<{
      sourceKey: string;
      capabilityVersionId: string;
      provenance: { evidence: { repository?: string } };
    }>;
  };
}

async function readCatalog(organizationId: string, environmentId: string) {
  return (await (
    await app.request(
      `/v1/capabilities?organizationId=${organizationId}&environmentId=${environmentId}`,
    )
  ).json()) as { capabilities: TestCatalogCapability[] };
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 1471 });
});

afterAll(async () => {
  await pool.end();
});

describe('conflicting capability sources', () => {
  it('fails closed, preserves candidates, supports audited Admin authority, and isolates environments', async () => {
    const organizationId = `org_source_conflict_${runId}`;
    await pool.query('INSERT INTO organizations (id) VALUES ($1)', [organizationId]);
    await pool.query(
      `INSERT INTO environments (organization_id, id, name, kind)
       VALUES ($1, 'development', 'Development', 'development'),
              ($1, 'production', 'Production', 'production')`,
      [organizationId],
    );
    const sourceA = 'https://git.example.test/payments-primary';
    const sourceB = 'https://git.example.test/payments-mirror';

    expect(
      (await connect(discoveryRequest(organizationId, 'development', sourceA, 'a1'))).status,
    ).toBe(201);
    const equivalentMirror = discoveryRequest(organizationId, 'development', sourceB, 'b1');
    equivalentMirror.manifest.annotations[0]!.owner = 'mirror-team';
    expect((await connect(equivalentMirror)).status).toBe(201);

    const registrationsResponse = await app.request(
      `/v1/capability-source-connections?organizationId=${organizationId}&environmentId=development`,
      { headers: { authorization: 'Bearer admin-token' } },
    );
    const registrations = (await registrationsResponse.json()) as {
      registrations: Array<{ sourceKey: string; evidence: { repository: string } }>;
    };
    expect(registrations.registrations).toHaveLength(2);

    const equivalentCatalog = await readCatalog(organizationId, 'development');
    expect(equivalentCatalog.capabilities[0]!.sourceResolution).toMatchObject({
      status: 'uncontested',
      claims: [
        { capabilityVersionId: expect.any(String) },
        { capabilityVersionId: expect.any(String) },
      ],
    });
    expect(
      new Set(
        equivalentCatalog.capabilities[0]!.sourceResolution.claims.map(
          (claim: { capabilityVersionId: string }) => claim.capabilityVersionId,
        ),
      ).size,
    ).toBe(2);

    expect(
      (await connect(discoveryRequest(organizationId, 'development', sourceB, 'b2', true))).status,
    ).toBe(201);
    const conflicted = await readCatalog(organizationId, 'development');
    const capability = conflicted.capabilities[0]!;
    expect(capability.sourceResolution.status).toBe('conflicting');
    const conflictNotice = await pool.query<{
      id: string;
      kind: string;
      resolved_at: Date | null;
      occurrence_count: number;
    }>(
      `SELECT id, kind, resolved_at, occurrence_count FROM notifications
       WHERE organization_id = $1 AND environment_id = 'development'
         AND kind = 'source-conflict'`,
      [organizationId],
    );
    expect(conflictNotice.rows).toEqual([
      expect.objectContaining({ kind: 'source-conflict', resolved_at: null }),
    ]);
    expect(capability.sourceResolution.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: { evidence: expect.objectContaining({ repository: sourceA }) },
        }),
        expect.objectContaining({
          provenance: { evidence: expect.objectContaining({ repository: sourceB }) },
        }),
      ]),
    );
    expect(
      new Set(
        capability.sourceResolution.claims.map(
          (claim: { capabilityVersionId: string }) => claim.capabilityVersionId,
        ),
      ).size,
    ).toBe(2);
    const conflictedSelection = await app.request(
      `/v1/capability-versions/${capability.capabilityVersionId}/selection?organizationId=${organizationId}&environmentId=development`,
    );
    await expect(conflictedSelection.json()).resolves.toMatchObject({
      newCompilation: { denials: expect.arrayContaining(['conflicting-sources']) },
    });
    const projection = await app.request(
      `/v1/planner-capabilities?organizationId=${organizationId}&environmentId=development`,
    );
    await expect(projection.json()).resolves.toMatchObject({ capabilities: [] });

    const sourceAClaim = capability.sourceResolution.claims.find(
      (claim) => claim.provenance.evidence.repository === sourceA,
    )!;
    const authorityUrl = `/v1/organizations/${organizationId}/environments/development/capabilities/${capability.capabilityIdentityId}/source-authority`;
    expect(
      (
        await app.request(authorityUrl, {
          method: 'PUT',
          headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
          body: JSON.stringify({ sourceKey: sourceAClaim.sourceKey }),
        })
      ).status,
    ).toBe(403);
    const designated = await app.request(authorityUrl, {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ sourceKey: sourceAClaim.sourceKey }),
    });
    expect(designated.status).toBe(200);
    await expect(designated.json()).resolves.toMatchObject({
      resolution: 'authoritative',
      capabilityVersionId: sourceAClaim.capabilityVersionId,
    });
    await expect(
      pool.query(`SELECT resolved_at FROM notifications WHERE id = $1`, [
        conflictNotice.rows[0]!.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ resolved_at: expect.any(Date) }] });
    const selected = await app.request(
      `/v1/capability-versions/${sourceAClaim.capabilityVersionId}/selection?organizationId=${organizationId}&environmentId=development`,
    );
    const selectedBody = (await selected.json()) as { newCompilation: { denials: string[] } };
    expect(selectedBody.newCompilation.denials).not.toContain('conflicting-sources');

    const cleared = await app.request(authorityUrl, {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ sourceKey: null }),
    });
    await expect(cleared.json()).resolves.toMatchObject({ resolution: 'conflicting' });
    await expect(
      pool.query(
        `SELECT id, read_at, resolved_at, occurrence_count FROM notifications WHERE id = $1`,
        [conflictNotice.rows[0]!.id],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          id: conflictNotice.rows[0]!.id,
          read_at: null,
          resolved_at: null,
          occurrence_count: expect.any(Number),
        },
      ],
    });
    const audit = await app.request(
      `/v1/audit-entries?organizationId=${organizationId}&environmentId=development`,
    );
    const auditBody = (await audit.json()) as { entries: Array<Record<string, any>> };
    expect(
      auditBody.entries.filter((entry) => entry.eventType === 'capability-source-authority'),
    ).toEqual([
      expect.objectContaining({
        actorId: 'conflict-admin',
        details: expect.objectContaining({ action: 'cleared', sourceKey: null }),
      }),
      expect.objectContaining({
        actorId: 'conflict-admin',
        details: expect.objectContaining({
          action: 'designated',
          sourceKey: sourceAClaim.sourceKey,
        }),
      }),
    ]);

    const sourceBRegistration = registrations.registrations.find(
      (registration) => registration.evidence.repository === sourceB,
    )!;
    const disconnected = await app.request(
      `/v1/capability-source-connections/payments?organizationId=${organizationId}&environmentId=development&sourceKey=${sourceBRegistration.sourceKey}`,
      { method: 'DELETE', headers: { authorization: 'Bearer admin-token' } },
    );
    expect(disconnected.status).toBe(200);
    const remainingRegistrations = (await (
      await app.request(
        `/v1/capability-source-connections?organizationId=${organizationId}&environmentId=development`,
        { headers: { authorization: 'Bearer admin-token' } },
      )
    ).json()) as { registrations: Array<{ sourceKey: string }> };
    expect(remainingRegistrations.registrations).toHaveLength(1);
    const corrected = await readCatalog(organizationId, 'development');
    expect(corrected.capabilities[0]!.sourceResolution).toMatchObject({
      status: 'uncontested',
      claims: [{ sourceKey: expect.any(String) }],
    });

    expect(
      (await connect(discoveryRequest(organizationId, 'production', sourceB, 'prod-b2', true)))
        .status,
    ).toBe(201);
    const production = await readCatalog(organizationId, 'production');
    expect(production.capabilities[0]!.sourceResolution.status).toBe('uncontested');
    expect(production.capabilities[0]!.sourceResolution.claims).toHaveLength(1);
  });
});
