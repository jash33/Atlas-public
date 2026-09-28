import { randomUUID } from 'node:crypto';
import { compileTemporalWorkflowArtifact } from '@atlas/workflow-artifact';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { startCapabilityRediscoveryTriggers } from './capability-rediscovery.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `capability_drift_notifications_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const app = createApp(pool, undefined, undefined, undefined, undefined, undefined, {
  allowLegacySourceRoutes: true,
});
const workerApp = createApp(pool, { allowedHosts: [] }, undefined, undefined, {
  approvalAuthorizer: {
    async authorize() {
      return null;
    },
  },
  workerAuthorizer: {
    async authorize({ authorizationHeader, organizationId, environmentId }) {
      return (
        authorizationHeader === 'Bearer worker-token' &&
        organizationId.startsWith('org_') &&
        environmentId === 'production'
      );
    },
  },
  executionGrantIssuer: {
    async issueForRun() {
      throw new Error('Execution grants are outside this test seam');
    },
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
        parameters: [
          {
            name: 'paymentId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
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

function discoveryRequest(trigger: 'repository-push' | 'daily-poll' | 'run-drift') {
  return {
    trigger,
    organizationId: `org_${trigger.replaceAll('-', '_')}_${testRunId}`,
    serviceId: 'payments',
    source: {
      format: 'openapi',
      document: paymentDocument,
      repository: 'https://github.com/acme/payment-api',
      commit: `${trigger}-v1`,
      path: 'openapi.json',
    },
    manifest: {
      source: {
        repository: 'https://github.com/acme/payment-api',
        commit: `${trigger}-v1`,
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
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('trigger' in body)) {
    throw new Error('Discovery test request requires a trigger');
  }
  const { trigger, ...request } = body;
  return app.request(`/v1/capability-discoveries/${String(trigger)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
}

async function unresolvedEnvironmentDifferences(database: Pool, organizationId: string) {
  const result = await database.query<{ unresolved: number }>(
    `SELECT count(*)::int AS unresolved FROM notifications
     WHERE organization_id = $1 AND kind = 'environment-difference'
       AND resolved_at IS NULL`,
    [organizationId],
  );
  return result.rows[0]!.unresolved;
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 1472 });
});

afterAll(async () => {
  await pool.end();
});

describe('capability drift API', () => {
  it('notifies for genuine environment drift but not a capability missing from one environment', async () => {
    const organizationId = `org_environment_comparison_${testRunId}`;
    await pool.query(`INSERT INTO organizations (id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      organizationId,
    ]);
    await pool.query(
      `INSERT INTO environments (organization_id, id, name, kind) VALUES
         ($1, 'development', 'Development', 'development'),
         ($1, 'production', 'Production', 'production')`,
      [organizationId],
    );
    const baseline = discoveryRequest('repository-push');
    const productionRequest = {
      ...baseline,
      organizationId,
      environmentId: 'production',
    };
    const developmentBaselineRequest = {
      ...baseline,
      organizationId,
      environmentId: 'development',
    };
    await discover(productionRequest);
    const missingNotice = await pool.query<{ id: string }>(
      `SELECT id FROM notifications WHERE organization_id = $1
       AND kind = 'environment-difference' AND resolved_at IS NULL
       AND details->>'comparisonState' = 'missing-in-development'`,
      [organizationId],
    );
    expect(missingNotice.rows).toHaveLength(0);
    await discover(developmentBaselineRequest);

    const readComparisonState = async () => {
      const body = (await (
        await app.request(
          `/v1/capabilities?organizationId=${organizationId}&environmentId=development`,
        )
      ).json()) as {
        capabilities: Array<{
          identity: { operationId: string };
          comparison: { state: string };
        }>;
      };
      return body.capabilities.find(({ identity }) => identity.operationId === 'getPayment')!
        .comparison.state;
    };
    expect(await readComparisonState()).toBe('matching');
    await expect(unresolvedEnvironmentDifferences(pool, organizationId)).resolves.toBe(0);

    const changedDocument = {
      ...paymentDocument,
      components: {
        schemas: {
          Payment: {
            ...paymentDocument.components.schemas.Payment,
            properties: {
              ...paymentDocument.components.schemas.Payment.properties,
              status: { type: 'string' },
            },
          },
        },
      },
    };
    const developmentChangeRequest = {
      ...developmentBaselineRequest,
      source: {
        ...developmentBaselineRequest.source,
        commit: 'development-v2',
        document: changedDocument,
      },
      manifest: {
        ...developmentBaselineRequest.manifest,
        source: { ...developmentBaselineRequest.manifest.source, commit: 'development-v2' },
      },
    };
    const changed = (await (await discover(developmentChangeRequest)).json()) as {
      discoveryId: string;
      changes: unknown[];
    };
    expect(changed.changes).toHaveLength(1);
    await pool.query(
      `INSERT INTO capability_versions
         (organization_id, capability_version_id, capability_identity_id, source_document_id,
          manifest_annotation_id, capability_fragment_hash, capability_fragment)
       SELECT organization_id, repeat('9', 64), capability_identity_id, source_document_id,
         manifest_annotation_id, repeat('8', 64), capability_fragment
       FROM capability_versions WHERE organization_id = $1 LIMIT 1`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO capability_discovery_changes
         (discovery_id, organization_id, from_capability_version_id,
          to_capability_version_id, classification, change_kind, field_changes,
          affected_workflows)
       SELECT $2, $1, repeat('9', 64), observation.capability_version_id,
         'compatible', 'version-change', '[]', '[]'
       FROM environment_capability_observations observation
       WHERE observation.organization_id = $1 AND observation.environment_id = 'development'
       LIMIT 1`,
      [organizationId, changed.discoveryId],
    );
    await expect(
      pool.query(
        `SELECT kind, details, affected_workflows, occurrence_count FROM notifications
         WHERE organization_id = $1 AND environment_id = 'development'
           AND condition_key = $2`,
        [organizationId, `discovery:${changed.discoveryId}`],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          kind: 'discovery-summary',
          details: { discoveryId: Number(changed.discoveryId), changeCount: 2 },
          affected_workflows: [],
          occurrence_count: 1,
        },
      ],
    });

    const unchanged = (await (await discover(developmentChangeRequest)).json()) as {
      changes: unknown[];
    };
    expect(unchanged.changes).toEqual([]);

    const catalog = (await (
      await app.request(
        `/v1/capabilities?organizationId=${organizationId}&environmentId=development`,
      )
    ).json()) as {
      capabilities: Array<{
        comparison: {
          state: string;
          development: { capabilityVersionId: string };
          production: { capabilityVersionId: string };
        };
      }>;
    };
    expect(catalog.capabilities[0]!.comparison).toMatchObject({
      state: 'ahead',
      development: { capabilityVersionId: expect.any(String) },
      production: { capabilityVersionId: expect.any(String) },
    });

    const identity = await pool.query<{ id: string }>(
      `SELECT id FROM capability_identities
       WHERE organization_id = $1 AND service_id = 'payments' AND operation_id = 'getPayment'`,
      [organizationId],
    );
    const identityId = identity.rows[0]!.id;
    const differenceNotice = await pool.query<{ id: string; occurrence_count: number }>(
      `SELECT id, occurrence_count FROM notifications WHERE organization_id = $1
       AND kind = 'environment-difference' AND resolved_at IS NULL`,
      [organizationId],
    );
    expect(differenceNotice.rows).toEqual([{ id: expect.any(String), occurrence_count: 1 }]);
    const updateObservation = async (environment: string, assignments: string) => {
      await pool.query(
        `UPDATE environment_capability_observations SET ${assignments}
         WHERE organization_id = $1 AND environment_id = $2 AND capability_identity_id = $3`,
        [organizationId, environment, identityId],
      );
    };
    await pool.query(
      `UPDATE environment_capability_observations production
       SET capability_version_id = development.capability_version_id
       FROM environment_capability_observations development
       WHERE production.organization_id = $1 AND production.environment_id = 'production'
         AND development.organization_id = production.organization_id
         AND development.environment_id = 'development'
         AND development.capability_identity_id = production.capability_identity_id`,
      [organizationId],
    );
    await updateObservation('development', "availability_status = 'removed'");
    expect(await readComparisonState()).toBe('removed-in-development');
    await updateObservation('production', "availability_status = 'removed'");
    await expect(unresolvedEnvironmentDifferences(pool, organizationId)).resolves.toBe(0);
    await updateObservation('development', "availability_status = 'available'");
    await updateObservation('production', "availability_status = 'available'");
    await updateObservation('development', "freshness_status = 'stale'");
    expect(await readComparisonState()).toBe('stale-in-development');
    await updateObservation('production', "freshness_status = 'stale'");
    await expect(unresolvedEnvironmentDifferences(pool, organizationId)).resolves.toBe(0);
    await updateObservation('development', "freshness_status = 'fresh'");
    await updateObservation('production', "freshness_status = 'fresh'");
    await updateObservation('development', "source_resolution_status = 'conflicting'");
    expect(await readComparisonState()).toBe('conflicting-in-development');
    await updateObservation('production', "source_resolution_status = 'conflicting'");
    await expect(unresolvedEnvironmentDifferences(pool, organizationId)).resolves.toBe(0);
    await updateObservation('development', "source_resolution_status = 'uncontested'");
    await updateObservation('production', "source_resolution_status = 'uncontested'");
    await expect(
      pool.query(
        `SELECT count(*)::int AS unresolved FROM notifications
         WHERE organization_id = $1 AND kind = 'environment-difference'
           AND resolved_at IS NULL`,
        [organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ unresolved: 0 }] });

    const productionNewerDocument = structuredClone(changedDocument);
    Object.assign(productionNewerDocument.components.schemas.Payment.properties, {
      productionSequence: { type: 'integer' },
    });
    await discover({
      ...productionRequest,
      source: {
        ...productionRequest.source,
        commit: 'production-v3',
        document: productionNewerDocument,
      },
      manifest: {
        ...productionRequest.manifest,
        source: { ...productionRequest.manifest.source, commit: 'production-v3' },
      },
    });
    await discover(developmentChangeRequest);
    expect(await readComparisonState()).toBe('different');

    const discovery = await app.request(
      `/v1/capability-discoveries/${changed.discoveryId}?organizationId=${organizationId}&environmentId=development`,
    );
    await expect(discovery.json()).resolves.toMatchObject({
      changes: [expect.any(Object), expect.any(Object)],
    });

    await pool.query(
      `UPDATE environment_capability_observations production
       SET capability_version_id = development.capability_version_id
       FROM environment_capability_observations development
       WHERE production.organization_id = $1 AND production.environment_id = 'production'
         AND development.organization_id = production.organization_id
         AND development.environment_id = 'development'
         AND development.capability_identity_id = production.capability_identity_id
         AND production.capability_identity_id = $2`,
      [organizationId, identityId],
    );
    await expect(
      pool.query(`SELECT resolved_at FROM notifications WHERE id = $1`, [
        differenceNotice.rows[0]!.id,
      ]),
    ).resolves.toMatchObject({ rows: [{ resolved_at: expect.any(Date) }] });
  });

  it('correlates an AsyncAPI operation rename and service move by channel and message', async () => {
    const organizationId = `org_event_identity_${testRunId}`;
    const eventDocument = (operationId: string, withSequence: boolean) => ({
      asyncapi: '3.0.0',
      info: { title: 'Events', version: '1.0.0' },
      channels: {
        invoices: {
          address: 'invoice.paid',
          messages: {
            invoicePaid: {
              payload: {
                type: 'object',
                properties: {
                  invoiceId: { type: 'string' },
                  ...(withSequence ? { sequence: { type: 'integer' } } : {}),
                },
              },
            },
          },
        },
      },
      operations: {
        [operationId]: {
          action: 'send',
          channel: { $ref: '#/channels/invoices' },
          messages: [{ $ref: '#/channels/invoices/messages/invoicePaid' }],
        },
      },
    });
    const request = (operationId: string, commit: string, withSequence: boolean) => ({
      trigger: 'repository-push' as const,
      organizationId,
      environmentId: 'development',
      serviceId: 'events',
      source: {
        format: 'asyncapi' as const,
        document: eventDocument(operationId, withSequence),
        repository: 'https://github.com/acme/events',
        commit,
        path: 'events.asyncapi.json',
      },
      manifest: {
        source: {
          repository: 'https://github.com/acme/events',
          commit,
          path: 'atlas-manifest.json',
        },
        annotations: [
          {
            capability: {
              operationId,
              channelAddress: 'invoice.paid',
              messageKey: 'invoicePaid',
            },
            owner: 'events-team',
            secretAlias: null,
            businessSemantics: {},
            idempotencyField: null,
            compensatedBy: null,
            irreversibleAfter: false,
          },
        ],
      },
    });
    const original = request('publishInvoicePaid', 'events-v1', false);
    await discover({ ...original, environmentId: 'production' });
    await discover(original);
    const renamed = (await (
      await discover({
        ...request('emitInvoicePaid', 'events-v2', true),
        serviceId: 'event-bus',
      })
    ).json()) as {
      changes: Array<{ changeKind: string; toCapabilityVersionId: string | null }>;
    };

    expect(renamed.changes).toEqual([
      expect.objectContaining({
        fromCapabilityVersionId: expect.any(String),
        toCapabilityVersionId: expect.any(String),
      }),
    ]);
    const identities = await pool.query<{ count: string; service_id: string }>(
      `SELECT count(*) OVER () AS count, service_id FROM capability_identities
       WHERE organization_id = $1
         AND channel_address = 'invoice.paid' AND message_key = 'invoicePaid'`,
      [organizationId],
    );
    expect(identities.rows[0]!.count).toBe('1');
    expect(identities.rows[0]!.service_id).toBe('event-bus');

    const developmentCatalog = (await (
      await app.request(
        `/v1/capabilities?organizationId=${organizationId}&environmentId=development`,
      )
    ).json()) as {
      capabilities: Array<{
        identity: { serviceId: string; operationId: string };
        comparison: {
          state: string;
          production: { identity: { serviceId: string; operationId: string } };
        };
      }>;
    };
    expect(developmentCatalog.capabilities[0]).toMatchObject({
      identity: { serviceId: 'event-bus', operationId: 'emitInvoicePaid' },
      comparison: {
        state: 'ahead',
        production: {
          identity: { serviceId: 'events', operationId: 'publishInvoicePaid' },
        },
      },
    });
    const productionCatalog = (await (
      await app.request(
        `/v1/capabilities?organizationId=${organizationId}&environmentId=production`,
      )
    ).json()) as { capabilities: Array<{ identity: { serviceId: string; operationId: string } }> };
    expect(productionCatalog.capabilities[0]!.identity).toEqual({
      kind: 'asyncapi',
      serviceId: 'events',
      operationId: 'publishInvoicePaid',
      channelAddress: 'invoice.paid',
      messageKey: 'invoicePaid',
    });
  });

  it('isolates current observations and discovery history between environments', async () => {
    const organizationId = `org_environment_isolation_${testRunId}`;
    const developmentRequest = {
      ...discoveryRequest('repository-push'),
      organizationId,
      environmentId: 'development',
      source: {
        ...discoveryRequest('repository-push').source,
        document: {
          ...paymentDocument,
          paths: {
            ...paymentDocument.paths,
            '/development-only': {
              get: {
                operationId: 'developmentOnly',
                responses: { '204': { description: 'Development-only operation' } },
              },
            },
          },
        },
      },
    };
    const productionRequest = {
      ...discoveryRequest('repository-push'),
      organizationId,
      environmentId: 'production',
      source: {
        ...discoveryRequest('repository-push').source,
        commit: 'production-v2',
        document: {
          ...paymentDocument,
          info: { ...paymentDocument.info, version: '2.0.0' },
          paths: {
            '/payments-v2/{paymentId}': paymentDocument.paths['/payments/{paymentId}'],
            '/production-only': {
              get: {
                operationId: 'productionOnly',
                responses: { '204': { description: 'Production-only operation' } },
              },
            },
          },
        },
      },
      manifest: {
        ...discoveryRequest('repository-push').manifest,
        source: {
          ...discoveryRequest('repository-push').manifest.source,
          commit: 'production-v2',
        },
      },
    };

    const production = (await (await discover(productionRequest)).json()) as {
      discoveryId: string;
      capabilities: Array<{ capabilityVersionId: string }>;
    };
    const development = (await (await discover(developmentRequest)).json()) as {
      discoveryId: string;
      capabilities: Array<{
        capabilityVersionId: string;
        identity: { operationId: string };
      }>;
    };
    const developmentVersionId = development.capabilities.find(
      ({ identity }) => identity.operationId === 'getPayment',
    )!.capabilityVersionId;
    const productionVersionId = production.capabilities[0]!.capabilityVersionId;
    expect(productionVersionId).not.toBe(developmentVersionId);

    const developmentCatalog = (await (
      await app.request(
        `/v1/capabilities?organizationId=${organizationId}&environmentId=development`,
      )
    ).json()) as {
      capabilities: Array<{
        capabilityVersionId: string;
        identity: { operationId: string };
        comparison: { state: string };
      }>;
    };
    const productionCatalog = (await (
      await app.request(
        `/v1/capabilities?organizationId=${organizationId}&environmentId=production`,
      )
    ).json()) as {
      capabilities: Array<{
        capabilityVersionId: string;
        identity: { operationId: string };
        comparison: { state: string };
      }>;
    };
    expect(developmentCatalog.capabilities).toHaveLength(3);
    expect(
      developmentCatalog.capabilities.find(({ identity }) => identity.operationId === 'getPayment')
        ?.comparison.state,
    ).toBe('different');
    expect(
      developmentCatalog.capabilities.find(
        ({ identity }) => identity.operationId === 'productionOnly',
      )?.comparison.state,
    ).toBe('missing-in-development');
    expect(
      developmentCatalog.capabilities.find(
        ({ identity }) => identity.operationId === 'developmentOnly',
      )?.comparison.state,
    ).toBe('missing-in-production');
    expect(productionCatalog.capabilities).toHaveLength(3);
    expect(
      productionCatalog.capabilities.find(({ identity }) => identity.operationId === 'getPayment')
        ?.comparison.state,
    ).toBe('different');
    expect(
      productionCatalog.capabilities.map(({ capabilityVersionId }) => capabilityVersionId),
    ).toContain(productionVersionId);

    const pinnedDevelopmentCapability = (await (
      await app.request(
        `/v1/capabilities?organizationId=${organizationId}&environmentId=development&capabilityVersionId=${developmentVersionId}`,
      )
    ).json()) as { capabilities: Array<{ capabilityVersionId: string }> };
    expect(pinnedDevelopmentCapability.capabilities).toEqual([
      expect.objectContaining({ capabilityVersionId: developmentVersionId }),
    ]);
    const crossEnvironmentCapability = (await (
      await app.request(
        `/v1/capabilities?organizationId=${organizationId}&environmentId=production&capabilityVersionId=${developmentVersionId}`,
      )
    ).json()) as { capabilities: unknown[] };
    expect(crossEnvironmentCapability.capabilities).toEqual([]);

    const developmentHistory = await app.request(
      `/v1/capability-discoveries?organizationId=${organizationId}&environmentId=development`,
    );
    await expect(developmentHistory.json()).resolves.toEqual({
      discoveries: [expect.objectContaining({ discoveryId: development.discoveryId })],
    });
    expect(
      await app.request(
        `/v1/capability-discoveries/${production.discoveryId}?organizationId=${organizationId}&environmentId=development`,
      ),
    ).toHaveProperty('status', 404);
    expect(
      await app.request(
        `/v1/capability-versions/${productionVersionId}?organizationId=${organizationId}&environmentId=development`,
      ),
    ).toHaveProperty('status', 404);
    expect(
      await app.request(
        `/v1/capability-versions/${productionVersionId}/selection?organizationId=${organizationId}&environmentId=development`,
      ),
    ).toHaveProperty('status', 404);

    const developmentV2 = await discover({
      ...developmentRequest,
      source: {
        ...developmentRequest.source,
        commit: 'development-v2',
        document: {
          ...developmentRequest.source.document,
          paths: {
            '/payments-next/{paymentId}': paymentDocument.paths['/payments/{paymentId}'],
            '/development-only': developmentRequest.source.document.paths['/development-only'],
          },
        },
      },
      manifest: {
        ...developmentRequest.manifest,
        source: { ...developmentRequest.manifest.source, commit: 'development-v2' },
      },
    });
    expect(developmentV2.status).toBe(201);
    const pinnedAfterRediscovery = (await (
      await app.request(
        `/v1/capabilities?organizationId=${organizationId}&environmentId=development&capabilityVersionId=${developmentVersionId}`,
      )
    ).json()) as { capabilities: Array<{ capabilityVersionId: string }> };
    expect(pinnedAfterRediscovery.capabilities).toEqual([
      expect.objectContaining({ capabilityVersionId: developmentVersionId }),
    ]);
  });

  it('records repository-push rediscovery as the primary trigger', async () => {
    const request = discoveryRequest('repository-push');
    const response = await discover(request);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      discoveryId: expect.any(String),
      trigger: 'repository-push',
      changes: [],
      capabilities: [
        {
          capabilityVersionId: expect.stringMatching(/^[a-f0-9]{64}$/),
          lifecycleStatus: 'current',
        },
      ],
    });

    const auditResponse = await app.request(
      `/v1/audit-entries?organizationId=${request.organizationId}`,
    );
    expect(auditResponse.status).toBe(200);
    await expect(auditResponse.json()).resolves.toMatchObject({
      entries: [
        {
          eventType: 'discovery',
          subjectType: 'capability-discovery',
          details: { serviceId: 'payments', trigger: 'repository-push' },
        },
      ],
    });
  });

  it('runs the daily poll backstop for registered capability sources', async () => {
    const organizationId = `org_daily_scheduler_${testRunId}`;
    expect(
      (await discover({ ...discoveryRequest('repository-push'), organizationId })).status,
    ).toBe(201);
    const stop = startCapabilityRediscoveryTriggers(
      pool,
      { allowedHosts: [] },
      {
        dailyPollMs: 10,
        requestPollMs: 60_000,
      },
    );
    try {
      await expect
        .poll(
          async () => {
            const response = await app.request(
              `/v1/capability-discoveries?organizationId=${organizationId}`,
            );
            const body = (await response.json()) as {
              discoveries: Array<{ trigger: string }>;
            };
            return body.discoveries.map(({ trigger }) => trigger);
          },
          { timeout: 10_000 },
        )
        .toContain('daily-poll');
    } finally {
      stop();
    }
  });

  it('classifies an optional field addition and returns its complete blast radius', async () => {
    const organizationId = `org_optional_drift_${testRunId}`;
    const firstRequest = {
      ...discoveryRequest('repository-push'),
      organizationId,
    };
    const firstResponse = await discover(firstRequest);
    const first = (await firstResponse.json()) as {
      capabilities: Array<{ capabilityVersionId: string }>;
    };
    const firstVersionId = first.capabilities[0]!.capabilityVersionId;
    await pool.query(
      `INSERT INTO workflow_versions (organization_id, workflow_version_id)
       VALUES ($1, $2), ($1, $3)`,
      [organizationId, 'payment-workflow-v1', 'reporting-workflow-v3'],
    );
    await pool.query(
      `INSERT INTO workflow_capability_dependencies
        (organization_id, workflow_version_id, step_id, capability_version_id)
       VALUES ($1, $2, $3, $4), ($1, $5, $6, $4)`,
      [
        organizationId,
        'payment-workflow-v1',
        'read-payment',
        firstVersionId,
        'reporting-workflow-v3',
        'load-payment',
      ],
    );
    const changedDocument = structuredClone(paymentDocument);
    Object.assign(changedDocument.components.schemas.Payment.properties, {
      receiptUrl: { type: 'string' },
    });

    const response = await discover({
      ...firstRequest,
      trigger: 'daily-poll',
      source: { ...firstRequest.source, document: changedDocument, commit: 'optional-v2' },
      manifest: {
        ...firstRequest.manifest,
        source: { ...firstRequest.manifest.source, commit: 'optional-v2' },
      },
    });

    expect(response.status).toBe(201);
    const result = (await response.json()) as {
      discoveryId: string;
      capabilities: Array<{ capabilityVersionId: string }>;
    };
    const secondVersionId = result.capabilities[0]!.capabilityVersionId;
    expect(result).toMatchObject({
      trigger: 'daily-poll',
      changes: [
        {
          fromCapabilityVersionId: firstVersionId,
          toCapabilityVersionId: secondVersionId,
          classification: 'compatible',
          fieldChanges: [
            {
              kind: 'added-optional',
              path: '/references/#~1components~1schemas~1Payment/properties/receiptUrl',
              classification: 'compatible',
            },
          ],
          affectedWorkflows: [
            { workflowVersionId: 'payment-workflow-v1', stepId: 'read-payment' },
            { workflowVersionId: 'reporting-workflow-v3', stepId: 'load-payment' },
          ],
        },
      ],
    });

    const previous = await app.request(
      `/v1/capability-versions/${firstVersionId}?organizationId=${organizationId}`,
    );
    await expect(previous.json()).resolves.toMatchObject({ lifecycleStatus: 'superseded' });
    const current = await app.request(
      `/v1/capability-versions/${secondVersionId}?organizationId=${organizationId}`,
    );
    await expect(current.json()).resolves.toMatchObject({ lifecycleStatus: 'current' });

    const recorded = await app.request(
      `/v1/capability-discoveries/${result.discoveryId}?organizationId=${organizationId}`,
    );
    expect(recorded.status).toBe(200);
    await expect(recorded.json()).resolves.toMatchObject({
      discoveryId: result.discoveryId,
      trigger: 'daily-poll',
      changes: [
        {
          fromCapabilityVersionId: firstVersionId,
          toCapabilityVersionId: secondVersionId,
          classification: 'compatible',
          affectedWorkflows: [
            { workflowVersionId: 'payment-workflow-v1', stepId: 'read-payment' },
            { workflowVersionId: 'reporting-workflow-v3', stepId: 'load-payment' },
          ],
        },
      ],
    });

    const environmentScoped = await app.request(
      `/v1/capability-discoveries/${result.discoveryId}?organizationId=${organizationId}&environmentId=production`,
    );
    await expect(environmentScoped.json()).resolves.toMatchObject({
      environmentId: 'production',
      changes: [
        {
          organizationAffectedWorkflowCount: 2,
          affectedWorkflows: [],
        },
      ],
    });

    const audit = await app.request(`/v1/audit-entries?organizationId=${organizationId}`);
    const auditBody = (await audit.json()) as {
      entries: Array<{ eventType: string; details: Record<string, unknown> }>;
    };
    expect(auditBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'classification',
          details: expect.objectContaining({
            classification: 'compatible',
            toCapabilityVersionId: secondVersionId,
          }),
        }),
        expect.objectContaining({
          eventType: 'reverse-lookup',
          details: expect.objectContaining({
            affectedWorkflows: [
              { workflowVersionId: 'payment-workflow-v1', stepId: 'read-payment' },
              { workflowVersionId: 'reporting-workflow-v3', stepId: 'load-payment' },
            ],
          }),
        }),
      ]),
    );
  });

  it('classifies a matching approved field rename as conditional', async () => {
    const organizationId = `org_approved_rename_${testRunId}`;
    const firstRequest = {
      ...discoveryRequest('repository-push'),
      organizationId,
      manifest: {
        ...discoveryRequest('repository-push').manifest,
        annotations: [
          {
            ...discoveryRequest('repository-push').manifest.annotations[0],
            fieldRenames: [
              {
                schema: '#/components/schemas/Payment',
                from: 'paymentId',
                to: 'id',
              },
            ],
          },
        ],
      },
    };
    const firstResponse = await discover(firstRequest);
    expect(firstResponse.status).toBe(201);
    await pool.query(
      `INSERT INTO manifest_annotation_approvals
        (organization_id, manifest_annotation_id, approved_by)
       SELECT $1, manifest_annotation_id, 'admin@example.com'
       FROM capability_versions
       WHERE organization_id = $1`,
      [organizationId],
    );
    const renamedDocument = structuredClone(paymentDocument);
    const paymentSchema = renamedDocument.components.schemas.Payment;
    Reflect.set(paymentSchema, 'required', ['id']);
    Reflect.set(paymentSchema, 'properties', { id: { type: 'string' } });

    const response = await discover({
      ...firstRequest,
      trigger: 'run-drift',
      source: { ...firstRequest.source, document: renamedDocument, commit: 'rename-v2' },
      manifest: {
        ...firstRequest.manifest,
        source: { ...firstRequest.manifest.source, commit: 'rename-v2' },
      },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      trigger: 'run-drift',
      changes: [
        {
          classification: 'conditional',
          fieldChanges: [
            {
              kind: 'renamed',
              fromPath: '/references/#~1components~1schemas~1Payment/properties/paymentId',
              path: '/references/#~1components~1schemas~1Payment/properties/id',
              classification: 'conditional',
            },
          ],
        },
      ],
    });
  });

  it('keeps compatible and conditional drift flowing on the old capability pin', async () => {
    for (const drift of ['compatible', 'conditional'] as const) {
      const organizationId = `org_open_${drift}_drift_${testRunId}`;
      const baseRequest = discoveryRequest('repository-push');
      const firstRequest = {
        ...baseRequest,
        organizationId,
        manifest:
          drift === 'conditional'
            ? {
                ...baseRequest.manifest,
                annotations: [
                  {
                    ...baseRequest.manifest.annotations[0],
                    fieldRenames: [
                      {
                        schema: '#/components/schemas/Payment',
                        from: 'paymentId',
                        to: 'id',
                      },
                    ],
                  },
                ],
              }
            : baseRequest.manifest,
      };
      const first = (await (await discover(firstRequest)).json()) as {
        capabilities: Array<{ capabilityVersionId: string }>;
      };
      const capabilityVersionId = first.capabilities[0]!.capabilityVersionId;
      if (drift === 'conditional') {
        await pool.query(
          `INSERT INTO manifest_annotation_approvals
             (organization_id, manifest_annotation_id, approved_by)
           SELECT $1, manifest_annotation_id, 'admin@example.com'
           FROM capability_versions WHERE organization_id = $1`,
          [organizationId],
        );
      }
      await seedCurrentIntakeWorkflow(organizationId, capabilityVersionId);
      const changedDocument = structuredClone(paymentDocument);
      if (drift === 'compatible') {
        Object.assign(changedDocument.components.schemas.Payment.properties, {
          receiptUrl: { type: 'string' },
        });
      } else {
        Reflect.set(changedDocument.components.schemas.Payment, 'required', ['id']);
        Reflect.set(changedDocument.components.schemas.Payment, 'properties', {
          id: { type: 'string' },
        });
      }
      const changed = await discover({
        ...firstRequest,
        source: {
          ...firstRequest.source,
          document: changedDocument,
          commit: `${drift}-v2`,
        },
        manifest: {
          ...firstRequest.manifest,
          source: { ...firstRequest.manifest.source, commit: `${drift}-v2` },
        },
      });
      await expect(changed.json()).resolves.toMatchObject({
        changes: [{ classification: drift }],
      });

      const intake = await requestCurrentExecutionGrant(organizationId, `run-${drift}`);
      expect(intake.status).toBe(201);
      await expect(intake.json()).resolves.toMatchObject({
        grant: {
          workflowVersionId: 'payment-workflow-v1',
          approvedCapabilityVersionIds: [capabilityVersionId],
        },
      });
    }
  });

  it('accepts an interpreter drift signal as a rediscovery request', async () => {
    const organizationId = `org_run_drift_signal_${testRunId}`;
    const discovered = (await (
      await discover({
        ...discoveryRequest('repository-push'),
        organizationId,
        environmentId: 'production',
      })
    ).json()) as { capabilities: Array<{ capabilityVersionId: string }> };

    const response = await workerApp.request('/v1/capability-rediscovery-requests', {
      method: 'POST',
      headers: {
        authorization: 'Bearer worker-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organizationId,
        environmentId: 'production',
        capabilityVersionId: discovered.capabilities[0]!.capabilityVersionId,
        stepId: 'read-payment',
      }),
    });

    expect(response.status).toBe(202);
    const recorded = (await response.json()) as {
      rediscoveryRequestId: string;
      discoveryId: string;
      trigger: string;
    };
    expect(recorded).toMatchObject({
      rediscoveryRequestId: expect.any(String),
      discoveryId: expect.any(String),
      trigger: 'run-drift',
      capabilityVersionId: discovered.capabilities[0]!.capabilityVersionId,
      stepId: 'read-payment',
    });
    await expect(
      (
        await workerApp.request(
          `/v1/capability-discoveries/${recorded.discoveryId}?organizationId=${organizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({
      trigger: 'run-drift',
      runtimeSignals: [
        {
          environmentId: 'production',
          capabilityVersionId: discovered.capabilities[0]!.capabilityVersionId,
          stepId: 'read-payment',
          affectedWorkflows: [],
        },
      ],
    });
  });

  it('classifies required additions, removals, and retypes as breaking overall', async () => {
    const organizationId = `org_breaking_drift_${testRunId}`;
    const initialDocument = structuredClone(paymentDocument);
    Reflect.set(initialDocument.components.schemas.Payment, 'properties', {
      paymentId: { type: 'string' },
      legacyCode: { type: 'string' },
    });
    const firstRequest = {
      ...discoveryRequest('repository-push'),
      organizationId,
      source: {
        ...discoveryRequest('repository-push').source,
        document: initialDocument,
        commit: 'breaking-v1',
      },
      manifest: {
        ...discoveryRequest('repository-push').manifest,
        source: {
          ...discoveryRequest('repository-push').manifest.source,
          commit: 'breaking-v1',
        },
      },
    };
    expect((await discover(firstRequest)).status).toBe(201);
    const changedDocument = structuredClone(initialDocument);
    Reflect.set(changedDocument.components.schemas.Payment, 'required', [
      'paymentId',
      'merchantId',
    ]);
    Reflect.set(changedDocument.components.schemas.Payment, 'properties', {
      paymentId: { type: 'number' },
      merchantId: { type: 'string' },
      receiptUrl: { type: 'string' },
    });

    const response = await discover({
      ...firstRequest,
      source: { ...firstRequest.source, document: changedDocument, commit: 'breaking-v2' },
      manifest: {
        ...firstRequest.manifest,
        source: { ...firstRequest.manifest.source, commit: 'breaking-v2' },
      },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      changes: Array<{
        classification: string;
        fieldChanges: Array<{ kind: string; path: string; classification: string }>;
      }>;
    };
    expect(body.changes[0]?.classification).toBe('breaking');
    expect(body.changes[0]?.fieldChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'retyped', classification: 'breaking' }),
        expect.objectContaining({ kind: 'removed', classification: 'breaking' }),
        expect.objectContaining({ kind: 'added-required', classification: 'breaking' }),
        expect.objectContaining({ kind: 'added-optional', classification: 'compatible' }),
      ]),
    );
  });

  it('quarantines new intake for a current workflow affected by breaking drift', async () => {
    const organizationId = `org_quarantined_drift_${testRunId}`;
    const firstRequest = {
      ...discoveryRequest('repository-push'),
      organizationId,
    };
    const first = (await (await discover(firstRequest)).json()) as {
      capabilities: Array<{ capabilityVersionId: string }>;
    };
    const capabilityVersionId = first.capabilities[0]!.capabilityVersionId;
    const workflow = await createCompiledWorkflowVersion('payment-workflow-v1', organizationId, {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'read-payment',
          kind: 'capabilityCall',
          capabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });
    await pool.query(
      `INSERT INTO workflow_versions
         (organization_id, workflow_version_id, ir_hash, compiled_workflow)
       VALUES ($1, $2, $3, $4)`,
      [organizationId, workflow.workflowVersionId, workflow.irHash, workflow],
    );
    await pool.query(
      `INSERT INTO workflow_capability_dependencies
         (organization_id, workflow_version_id, step_id, capability_version_id)
       VALUES ($1, $2, 'read-payment', $3)`,
      [organizationId, workflow.workflowVersionId, capabilityVersionId],
    );
    const artifact = await compileTemporalWorkflowArtifact(workflow, {
      sandboxSuiteFingerprint: 'f'.repeat(64),
      secretReferencesByCapabilityVersion: {},
    });
    await pool.query(
      `INSERT INTO workflow_approvals
         (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
          projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
       VALUES ($1, 'production', $2, $3, 'mvp-validation-v1', $4,
         'admin@example.com', 'current', $5, $6)`,
      [
        organizationId,
        workflow.workflowVersionId,
        workflow.irHash,
        '0'.repeat(64),
        artifact.artifactId,
        artifact,
      ],
    );
    const breakingDocument = structuredClone(paymentDocument);
    Reflect.set(breakingDocument.components.schemas.Payment, 'required', [
      'paymentId',
      'merchantId',
    ]);
    Object.assign(breakingDocument.components.schemas.Payment.properties, {
      merchantId: { type: 'string' },
    });
    expect(
      (
        await discover({
          ...firstRequest,
          source: { ...firstRequest.source, document: breakingDocument, commit: 'breaking-v2' },
          manifest: {
            ...firstRequest.manifest,
            source: { ...firstRequest.manifest.source, commit: 'breaking-v2' },
          },
        })
      ).status,
    ).toBe(201);
    const intakeApp = createApp(pool, { allowedHosts: [] }, undefined, undefined, {
      approvalAuthorizer: {
        async authorize() {
          return null;
        },
      },
      workerAuthorizer: {
        async authorize() {
          return true;
        },
      },
      executionGrantIssuer: {
        async issueForRun(run) {
          return {
            organizationId,
            environmentId: 'production',
            runId: run.runId,
            workflowVersionId: run.workflow.workflowVersionId,
            irHash: run.workflow.irHash,
            approvedCapabilityVersionIds:
              run.workflow.executionRequirements.requiredCapabilityVersionIds,
            approvedHostnames: [...run.approvedHostnames],
            signatureAlgorithm: 'Ed25519' as const,
            signature: 'test-signature',
          };
        },
      },
    });

    const response = await intakeApp.request('/v1/execution-grants', {
      method: 'POST',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        environmentId: 'production',
        runId: 'run-quarantined',
        intakeKey: 'a'.repeat(64),
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'workflow-quarantined' });
  });

  it('rejects provider webhooks as a rediscovery trigger', async () => {
    const response = await discover({
      ...discoveryRequest('repository-push'),
      trigger: 'provider-webhook',
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid-discovery' });
  });

  it('uses a breaking structural change as the overall worst classification', async () => {
    const organizationId = `org_mixed_drift_${testRunId}`;
    const initialDocument = structuredClone(paymentDocument);
    Object.assign(initialDocument.paths['/payments/{paymentId}'].get.responses, {
      '404': { description: 'Payment not found' },
    });
    const firstRequest = {
      ...discoveryRequest('repository-push'),
      organizationId,
      source: {
        ...discoveryRequest('repository-push').source,
        document: initialDocument,
        commit: 'mixed-v1',
      },
      manifest: {
        ...discoveryRequest('repository-push').manifest,
        source: { ...discoveryRequest('repository-push').manifest.source, commit: 'mixed-v1' },
      },
    };
    expect((await discover(firstRequest)).status).toBe(201);
    const changedDocument = structuredClone(initialDocument);
    Object.assign(changedDocument.components.schemas.Payment.properties, {
      receiptUrl: { type: 'string' },
    });
    Reflect.deleteProperty(changedDocument.paths['/payments/{paymentId}'].get.responses, '404');

    const response = await discover({
      ...firstRequest,
      source: { ...firstRequest.source, document: changedDocument, commit: 'mixed-v2' },
      manifest: {
        ...firstRequest.manifest,
        source: { ...firstRequest.manifest.source, commit: 'mixed-v2' },
      },
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      changes: [{ classification: 'breaking' }],
    });
  });

  it('moves the current head back to a retained immutable version on repository revert', async () => {
    const organizationId = `org_reverted_drift_${testRunId}`;
    const firstRequest = {
      ...discoveryRequest('repository-push'),
      organizationId,
      source: { ...discoveryRequest('repository-push').source, commit: 'revert-v1' },
      manifest: {
        ...discoveryRequest('repository-push').manifest,
        source: { ...discoveryRequest('repository-push').manifest.source, commit: 'revert-v1' },
      },
    };
    const first = (await (await discover(firstRequest)).json()) as {
      capabilities: Array<{ capabilityVersionId: string }>;
    };
    const changedDocument = structuredClone(paymentDocument);
    Object.assign(changedDocument.components.schemas.Payment.properties, {
      receiptUrl: { type: 'string' },
    });
    const second = (await (
      await discover({
        ...firstRequest,
        source: { ...firstRequest.source, document: changedDocument, commit: 'revert-v2' },
        manifest: {
          ...firstRequest.manifest,
          source: { ...firstRequest.manifest.source, commit: 'revert-v2' },
        },
      })
    ).json()) as typeof first;

    const staleRediscovery = await discover(firstRequest);
    await expect(staleRediscovery.json()).resolves.toMatchObject({
      capabilities: [
        {
          capabilityVersionId: first.capabilities[0]!.capabilityVersionId,
          lifecycleStatus: 'superseded',
        },
      ],
      changes: [],
    });

    const reverted = await discover({
      ...firstRequest,
      source: { ...firstRequest.source, commit: 'revert-v3' },
      manifest: {
        ...firstRequest.manifest,
        source: { ...firstRequest.manifest.source, commit: 'revert-v3' },
      },
    });

    expect(reverted.status).toBe(201);
    await expect(reverted.json()).resolves.toMatchObject({
      capabilities: [
        {
          capabilityVersionId: first.capabilities[0]!.capabilityVersionId,
          lifecycleStatus: 'current',
        },
      ],
      changes: [
        {
          fromCapabilityVersionId: second.capabilities[0]!.capabilityVersionId,
          toCapabilityVersionId: first.capabilities[0]!.capabilityVersionId,
        },
      ],
    });
    await expect(
      (
        await app.request(
          `/v1/capability-versions/${first.capabilities[0]!.capabilityVersionId}?organizationId=${organizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({ lifecycleStatus: 'current' });
    await expect(
      (
        await app.request(
          `/v1/capability-versions/${second.capabilities[0]!.capabilityVersionId}?organizationId=${organizationId}`,
        )
      ).json(),
    ).resolves.toMatchObject({ lifecycleStatus: 'superseded' });
  });
});

async function seedCurrentIntakeWorkflow(organizationId: string, capabilityVersionId: string) {
  const workflow = await createCompiledWorkflowVersion('payment-workflow-v1', organizationId, {
    irVersion: 1,
    inputSchema: { required: { paymentId: { type: 'string' } } },
    steps: [
      {
        id: 'read-payment',
        kind: 'capabilityCall',
        capabilityVersionId,
        arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
      },
      { id: 'complete', kind: 'terminal', state: 'completed' },
    ],
  });
  await pool.query(
    `INSERT INTO workflow_versions
       (organization_id, workflow_version_id, ir_hash, compiled_workflow)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, workflow.workflowVersionId, workflow.irHash, workflow],
  );
  await pool.query(
    `INSERT INTO workflow_capability_dependencies
       (organization_id, workflow_version_id, step_id, capability_version_id)
     VALUES ($1, $2, 'read-payment', $3)`,
    [organizationId, workflow.workflowVersionId, capabilityVersionId],
  );
  const artifact = await compileTemporalWorkflowArtifact(workflow, {
    sandboxSuiteFingerprint: 'f'.repeat(64),
    secretReferencesByCapabilityVersion: {},
  });
  await pool.query(
    `INSERT INTO workflow_approvals
       (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
        projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
     VALUES ($1, 'production', $2, $3, 'mvp-validation-v1', $4,
       'admin@example.com', 'current', $5, $6)`,
    [
      organizationId,
      workflow.workflowVersionId,
      workflow.irHash,
      '0'.repeat(64),
      artifact.artifactId,
      artifact,
    ],
  );
}

function requestCurrentExecutionGrant(organizationId: string, runId: string) {
  const intakeApp = createApp(pool, { allowedHosts: [] }, undefined, undefined, {
    approvalAuthorizer: {
      async authorize() {
        return null;
      },
    },
    workerAuthorizer: {
      async authorize() {
        return true;
      },
    },
    executionGrantIssuer: {
      async issueForRun(run) {
        return {
          organizationId,
          environmentId: 'production',
          runId: run.runId,
          workflowVersionId: run.workflow.workflowVersionId,
          irHash: run.workflow.irHash,
          approvedCapabilityVersionIds:
            run.workflow.executionRequirements.requiredCapabilityVersionIds,
          approvedHostnames: [...run.approvedHostnames],
          signatureAlgorithm: 'Ed25519' as const,
          signature: 'test-signature',
        };
      },
    },
  });
  return intakeApp.request('/v1/execution-grants', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      environmentId: 'production',
      runId,
      intakeKey: 'a'.repeat(64),
    }),
  });
}
