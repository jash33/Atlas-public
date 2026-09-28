import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `capability_source_registrations_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const app = createApp(pool, undefined, undefined, undefined, undefined, undefined, {
  allowLegacySourceRoutes: true,
});
const governedApp = createApp(pool, { allowedHosts: [] }, undefined, undefined, undefined, {
  async authorize(request) {
    return request.authorizationHeader === 'Bearer source-author-token' &&
      ['connect-capability-source', 'view-organization'].includes(request.action)
      ? { actorId: 'atlas-author', role: 'author' as const }
      : null;
  },
});
const testRunId = randomUUID();

const paymentDocument = {
  openapi: '3.1.0',
  info: { title: 'Payment API', version: '1.0.0' },
  paths: {
    '/payments/{paymentId}': {
      get: {
        operationId: 'getPayment',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': {
            description: 'Payment',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Payment: {
        type: 'object',
        required: ['paymentId'],
        properties: { paymentId: { type: 'string' } },
      },
    },
  },
};

function discoveryRequest(organizationId: string) {
  return {
    organizationId,
    serviceId: 'payments',
    source: {
      format: 'openapi',
      document: paymentDocument,
      repository: 'https://github.com/acme/payment-api',
      commit: 'registration-v1',
      path: 'openapi.json',
    },
    manifest: {
      source: {
        repository: 'https://github.com/acme/payment-api',
        commit: 'registration-v1',
        path: 'atlas-manifest.json',
      },
      annotations: [
        {
          capability: { operationId: 'getPayment' },
          owner: 'payments-team',
          secretAlias: 'payment-api-token',
          businessSemantics: { readsAuthoritativePayment: true },
          idempotencyField: null,
          compensatedBy: null,
          irreversibleAfter: false,
        },
      ],
    },
  };
}

async function discover(body: unknown) {
  return app.request('/v1/capability-discoveries/repository-push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function rediscover(body: unknown) {
  return app.request('/v1/capability-source-rediscoveries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 1475 });
});

afterAll(async () => {
  await pool.end();
});

describe('capability source registrations API', () => {
  it('registers a human-confirmed private HTTP API without repository evidence', async () => {
    const organizationId = `org_registration_manual_${testRunId}`;
    const request = discoveryRequest(organizationId);
    await pool.query('INSERT INTO organizations (id) VALUES ($1)', [organizationId]);
    await pool.query(
      `INSERT INTO environments (organization_id, id, name, kind)
       VALUES ($1, 'development', 'Development', 'development')`,
      [organizationId],
    );
    const githubDocumentBypass = await governedApp.request('/v1/capability-source-connections', {
      method: 'POST',
      headers: {
        authorization: 'Bearer source-author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...request,
        environmentId: 'development',
        source: {
          format: 'openapi',
          document: paymentDocument,
          repository: 'https://github.com/acme/payment-api',
          repositoryProvider: 'github',
          commit: '0123456789abcdef0123456789abcdef01234567',
          path: 'openapi.json',
        },
      }),
    });
    expect(githubDocumentBypass.status).toBe(400);
    await expect(githubDocumentBypass.json()).resolves.toEqual({
      error: 'source-github-document-denied',
    });
    const response = await governedApp.request('/v1/capability-source-connections', {
      method: 'POST',
      headers: {
        authorization: 'Bearer source-author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...request,
        environmentId: 'development',
        source: {
          format: 'openapi',
          document: paymentDocument,
          evidence: {
            kind: 'human-confirmed',
            label: 'Private payments API',
          },
        },
        manifest: {
          ...request.manifest,
          source: {
            kind: 'human-confirmed',
            label: 'Private payments safety notes',
          },
        },
      }),
    });

    expect(response.status).toBe(201);

    const discovery = (await response.json()) as {
      connection: {
        environmentId: string;
        evidence: Record<string, unknown>;
        manifestEvidence: Record<string, unknown>;
      };
    };
    expect(discovery.connection.environmentId).toBe('development');
    expect(discovery.connection.evidence).toEqual({
      kind: 'human-confirmed',
      label: 'Private payments API',
      confirmedBy: 'atlas-author',
      confirmedAt: expect.any(String),
    });
    expect(discovery.connection.manifestEvidence).toEqual({
      kind: 'human-confirmed',
      label: 'Private payments safety notes',
      confirmedBy: 'atlas-author',
      confirmedAt: expect.any(String),
    });

    const otherOrganization = await governedApp.request(
      `/v1/capability-source-connections?organizationId=other-${organizationId}&environmentId=development`,
      { headers: { authorization: 'Bearer source-author-token' } },
    );
    expect(otherOrganization.status).toBe(403);
  });

  it('fails closed when source connection authorization or environment policy is missing', async () => {
    const organizationId = `org_registration_policy_${testRunId}`;
    await pool.query('INSERT INTO organizations (id) VALUES ($1)', [organizationId]);
    const request = {
      ...discoveryRequest(organizationId),
      environmentId: 'missing-environment',
    };

    const legacyRoute = await governedApp.request('/v1/capability-ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(discoveryRequest(organizationId)),
    });
    expect(legacyRoute.status).toBe(403);
    await expect(legacyRoute.json()).resolves.toEqual({
      error: 'source-connection-route-required',
    });

    const unauthorized = await governedApp.request('/v1/capability-source-connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(unauthorized.status).toBe(403);

    const missingEnvironment = await governedApp.request('/v1/capability-source-connections', {
      method: 'POST',
      headers: {
        authorization: 'Bearer source-author-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    expect(missingEnvironment.status).toBe(403);
    await expect(missingEnvironment.json()).resolves.toEqual({
      error: 'source-environment-not-authorized',
    });
  });

  it('keeps source registrations isolated by environment', async () => {
    const organizationId = `org_registration_environment_${testRunId}`;
    const request = discoveryRequest(organizationId);
    expect(
      (
        await discover({
          ...request,
          environmentId: 'development',
          source: { ...request.source, commit: 'development-revision' },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await discover({
          ...request,
          environmentId: 'production',
          source: { ...request.source, commit: 'production-revision' },
        })
      ).status,
    ).toBe(201);
    await pool.query(
      `INSERT INTO environments (organization_id, id, name, kind)
       VALUES ($1, 'development', 'Development', 'development'),
              ($1, 'production', 'Production', 'production')`,
      [organizationId],
    );

    const development = await governedApp.request(
      `/v1/capability-source-connections?organizationId=${organizationId}&environmentId=development`,
      { headers: { authorization: 'Bearer source-author-token' } },
    );
    const production = await governedApp.request(
      `/v1/capability-source-connections?organizationId=${organizationId}&environmentId=production`,
      { headers: { authorization: 'Bearer source-author-token' } },
    );
    await expect(development.json()).resolves.toMatchObject({
      registrations: [{ evidence: { commit: 'development-revision' } }],
    });
    await expect(production.json()).resolves.toMatchObject({
      registrations: [{ evidence: { commit: 'production-revision' } }],
    });
  });

  it('lists registered sources with their provenance summary', async () => {
    const organizationId = `org_registration_list_${testRunId}`;
    expect((await discover(discoveryRequest(organizationId))).status).toBe(201);

    const response = await app.request(
      `/v1/capability-source-registrations?organizationId=${organizationId}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      registrations: Array<Record<string, unknown>>;
    };
    expect(body.registrations).toHaveLength(1);
    expect(body.registrations[0]).toMatchObject({
      serviceId: 'payments',
      format: 'openapi',
      evidence: {
        kind: 'repository',
        repository: 'https://github.com/acme/payment-api',
        commit: 'registration-v1',
        path: 'openapi.json',
      },
      url: null,
    });
    expect(typeof body.registrations[0]!.updatedAt).toBe('string');
  });

  it('requires organizationId when listing registrations', async () => {
    const response = await app.request('/v1/capability-source-registrations');
    expect(response.status).toBe(400);
  });

  it('reruns a registered source on demand and records a daily-poll discovery', async () => {
    const organizationId = `org_registration_rerun_${testRunId}`;
    expect((await discover(discoveryRequest(organizationId))).status).toBe(201);

    const response = await rediscover({ organizationId, serviceId: 'payments' });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { discoveryId: string; trigger: string };
    expect(body.trigger).toBe('daily-poll');

    const history = await app.request(
      `/v1/capability-discoveries?organizationId=${organizationId}`,
    );
    const { discoveries } = (await history.json()) as {
      discoveries: Array<{ discoveryId: string; trigger: string }>;
    };
    expect(discoveries.map(({ trigger }) => trigger)).toEqual(['repository-push', 'daily-poll']);
    expect(discoveries.some(({ discoveryId }) => discoveryId === body.discoveryId)).toBe(true);
  });

  it('rejects rediscovery of a source that has never been registered', async () => {
    const response = await rediscover({
      organizationId: `org_registration_missing_${testRunId}`,
      serviceId: 'payments',
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'capability-source-not-registered',
    });
  });

  it('preserves removed and stale observations within their environment', async () => {
    const organizationId = `org_observation_lifecycle_${testRunId}`;
    const initial = discoveryRequest(organizationId);
    const initialDocument = structuredClone(paymentDocument);
    Object.assign(initialDocument.paths, {
      '/payments': {
        post: {
          operationId: 'createPayment',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: { '201': { description: 'Created' } },
        },
      },
    });
    const initialFor = (environmentId: string, commit: string) => ({
      ...initial,
      environmentId,
      source: { ...initial.source, document: initialDocument, commit },
    });
    const development = await discover(initialFor('development', 'observation-dev-v1'));
    const production = await discover(initialFor('production', 'observation-prod-v1'));
    expect(development.status).toBe(201);
    expect(production.status).toBe(201);
    const removedVersionId = (
      (await development.json()) as {
        capabilities: Array<{ capabilityVersionId: string; identity: { operationId: string } }>;
      }
    ).capabilities.find(
      ({ identity }) => identity.operationId === 'createPayment',
    )!.capabilityVersionId;
    await pool.query(
      `INSERT INTO workflow_versions (organization_id, workflow_version_id)
       VALUES ($1, 'development-removal-workflow'), ($1, 'production-removal-workflow')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO workflow_capability_dependencies
         (organization_id, workflow_version_id, step_id, capability_version_id)
       VALUES ($1, 'development-removal-workflow', 'create-payment', $2),
              ($1, 'production-removal-workflow', 'create-payment', $2)`,
      [organizationId, removedVersionId],
    );
    await pool.query(
      `INSERT INTO workflow_approvals
         (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
          projection_fingerprint, approved_by, lifecycle_status)
       VALUES ($1, 'development', 'development-removal-workflow', $2, 'v1', $3, 'admin', 'current'),
              ($1, 'production', 'production-removal-workflow', $2, 'v1', $3, 'admin', 'current')`,
      [organizationId, 'a'.repeat(64), 'b'.repeat(64)],
    );

    const removal = await discover({
      ...initial,
      environmentId: 'development',
      source: { ...initial.source, commit: 'observation-dev-v2' },
    });
    expect(removal.status).toBe(201);
    await expect(removal.json()).resolves.toMatchObject({
      changes: [
        {
          fromCapabilityVersionId: removedVersionId,
          toCapabilityVersionId: null,
          changeKind: 'removal',
          classification: 'breaking',
          affectedWorkflows: [
            {
              workflowVersionId: 'development-removal-workflow',
              stepId: 'create-payment',
            },
          ],
        },
      ],
    });

    const catalog = async (environmentId: string) =>
      (
        (await (
          await app.request(
            `/v1/capabilities?organizationId=${organizationId}&environmentId=${environmentId}`,
          )
        ).json()) as {
          capabilities: Array<{
            capabilityVersionId: string;
            observation: { availability: string; freshness: string; reason: string };
          }>;
        }
      ).capabilities;
    expect(
      (await catalog('development')).find(
        (entry) => entry.capabilityVersionId === removedVersionId,
      ),
    ).toMatchObject({
      observation: {
        availability: 'removed',
        freshness: 'fresh',
        reason: 'operation-absent-from-successful-discovery',
      },
    });
    expect(
      (await catalog('production')).find((entry) => entry.capabilityVersionId === removedVersionId),
    ).toMatchObject({ observation: { availability: 'available', freshness: 'fresh' } });
    await expect(
      (
        await app.request(
          `/v1/capability-versions/${removedVersionId}/selection?organizationId=${organizationId}&environmentId=development`,
        )
      ).json(),
    ).resolves.toMatchObject({
      newCompilation: { allowed: false, denials: expect.arrayContaining(['capability-removed']) },
    });
    const removedProjection = (await (
      await app.request(
        `/v1/planner-capabilities?organizationId=${organizationId}&environmentId=development`,
      )
    ).json()) as { capabilities: Array<{ capabilityVersionId: string }> };
    expect(
      removedProjection.capabilities.some(
        ({ capabilityVersionId }) => capabilityVersionId === removedVersionId,
      ),
    ).toBe(false);

    const failedRefreshApp = createApp(
      pool,
      {
        allowedHosts: ['specs.example'],
        lookup: async () => [{ address: '203.0.113.10', family: 4 }],
        fetch: async () => {
          throw new Error('source unavailable');
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { allowLegacySourceRoutes: true },
    );
    await pool.query(
      `UPDATE capability_source_registrations
       SET discovery_input = jsonb_set(
         (discovery_input #- '{source,document}'), '{source,url}', '"https://specs.example/payment.json"'
       )
       WHERE organization_id = $1 AND environment_id = 'development' AND service_id = 'payments'`,
      [organizationId],
    );
    const failed = await failedRefreshApp.request('/v1/capability-source-rediscoveries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, environmentId: 'development', serviceId: 'payments' }),
    });
    expect(failed.status).toBe(400);
    expect(
      (await catalog('development')).every(({ observation }) => observation.freshness === 'stale'),
    ).toBe(true);
    expect(
      (await catalog('production')).every(({ observation }) => observation.freshness === 'fresh'),
    ).toBe(true);

    await pool.query(
      `INSERT INTO environments (organization_id, id, name, kind)
       VALUES ($1, 'development', 'Development', 'development')`,
      [organizationId],
    );
    const disconnected = await governedApp.request(
      `/v1/capability-source-connections/payments?organizationId=${organizationId}&environmentId=development`,
      { method: 'DELETE', headers: { authorization: 'Bearer source-author-token' } },
    );
    expect(disconnected.status).toBe(200);
    expect(
      (await catalog('development')).every(
        ({ observation }) =>
          observation.freshness === 'stale' && observation.reason === 'source-disconnected',
      ),
    ).toBe(true);

    const recovered = await discover({
      ...initialFor('development', 'observation-dev-v3'),
      source: {
        ...initial.source,
        document: initialDocument,
        commit: 'observation-dev-v3',
      },
    });
    expect(recovered.status).toBe(201);
    expect(
      (await catalog('development')).every(
        ({ observation }) =>
          observation.availability === 'available' && observation.freshness === 'fresh',
      ),
    ).toBe(true);
  });
});
