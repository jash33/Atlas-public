import { randomUUID } from 'node:crypto';
import { compileTemporalWorkflowArtifact } from '@atlas/workflow-artifact';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import type { PlannerModel } from './workflow-planning.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `potential_coverage_http_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
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

function discoveryRequest(
  organizationId: string,
  document: typeof paymentDocument,
  commit: string,
) {
  return {
    organizationId,
    serviceId: 'payments',
    source: {
      format: 'openapi' as const,
      document,
      repository: 'https://github.com/acme/payment-api',
      commit,
      path: 'openapi.json',
    },
    manifest: {
      source: {
        repository: 'https://github.com/acme/payment-api',
        commit,
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
        ...(JSON.stringify(document).includes('getPaymentRecord')
          ? [
              {
                capability: { operationId: 'getPaymentRecord' },
                owner: 'payments-team',
                secretAlias: 'payment-api-token',
                businessSemantics: { readsAuthoritativePaymentRecord: true },
                idempotencyField: null,
                compensatedBy: null,
                irreversibleAfter: false,
              },
            ]
          : []),
      ],
    },
  };
}

function breakingDocument() {
  const document = structuredClone(paymentDocument);
  Reflect.set(document.components.schemas.Payment, 'required', ['paymentId', 'merchantId']);
  Object.assign(document.components.schemas.Payment.properties, {
    merchantId: { type: 'string' },
  });
  Object.assign(document.paths, {
    '/payments/{paymentId}/record': {
      get: {
        operationId: 'getPaymentRecord',
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
            description: 'Payment record',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
            },
          },
        },
      },
    },
  });
  return document;
}

function unusedPlanning(): Pick<
  PlannerModel,
  'extractIntent' | 'draftWorkflow' | 'repairWorkflow'
> {
  return {
    async extractIntent() {
      throw new Error('planning is outside this test seam');
    },
    async draftWorkflow() {
      throw new Error('planning is outside this test seam');
    },
    async repairWorkflow() {
      throw new Error('planning is outside this test seam');
    },
  };
}

function appWithPlanner(planner: PlannerModel) {
  return createApp(pool, undefined, planner, undefined, undefined, undefined, {
    allowLegacySourceRoutes: true,
  });
}

const baselineApp = createApp(pool, undefined, undefined, undefined, undefined, undefined, {
  allowLegacySourceRoutes: true,
});

async function discover(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/v1/capability-discoveries/repository-push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 1473 });
});

afterAll(async () => {
  await pool.end();
});

describe('potential coverage discovery payloads', () => {
  it('attaches a verified in-source hint on rediscovery and GET, and omits invented or unavailable hints', async () => {
    const organizationId = `org_potential_${testRunId}`;
    expect(
      (await discover(baselineApp, discoveryRequest(organizationId, paymentDocument, 'v1'))).status,
    ).toBe(201);

    const suggesting = appWithPlanner({
      ...unusedPlanning(),
      async suggestPotentialCoverage(input) {
        const fromCapabilityVersionId = input.unmappedContracts[0]?.fromCapabilityVersionId;
        return {
          kind: 'suggestion',
          suggestions: fromCapabilityVersionId
            ? [
                {
                  fromCapabilityVersionId,
                  operationId: 'getPaymentRecord',
                  fieldPath: '/paymentId',
                },
              ]
            : [],
        };
      },
    });
    const hinted = await discover(
      suggesting,
      discoveryRequest(organizationId, breakingDocument(), 'v2-hinted'),
    );
    expect(hinted.status).toBe(201);
    const hintedBody = (await hinted.json()) as {
      discoveryId: string;
      changes: Array<{ classification: string; potentialCoverage?: { operationId: string } }>;
    };
    expect(hintedBody.changes[0]?.classification).toBe('breaking');
    expect(hintedBody.changes[0]?.potentialCoverage).toEqual({
      operationId: 'getPaymentRecord',
      fieldPath: '/paymentId',
    });

    const stored = await baselineApp.request(
      `/v1/capability-discoveries/${hintedBody.discoveryId}?organizationId=${organizationId}`,
    );
    expect(stored.status).toBe(200);
    await expect(stored.json()).resolves.toMatchObject({
      changes: [
        {
          classification: 'breaking',
          potentialCoverage: { operationId: 'getPaymentRecord', fieldPath: '/paymentId' },
        },
      ],
    });

    const inventingOrg = `org_potential_invent_${testRunId}`;
    expect(
      (await discover(baselineApp, discoveryRequest(inventingOrg, paymentDocument, 'v1'))).status,
    ).toBe(201);
    const invented = await discover(
      appWithPlanner({
        ...unusedPlanning(),
        async suggestPotentialCoverage(input) {
          const fromCapabilityVersionId = input.unmappedContracts[0]?.fromCapabilityVersionId;
          return {
            kind: 'suggestion',
            suggestions: fromCapabilityVersionId
              ? [
                  {
                    fromCapabilityVersionId,
                    operationId: 'inventedOperation',
                    fieldPath: '/inventedField',
                  },
                ]
              : [],
          };
        },
      }),
      discoveryRequest(inventingOrg, breakingDocument(), 'v2-invented'),
    );
    const inventedBody = (await invented.json()) as {
      changes: Array<{ potentialCoverage?: unknown }>;
    };
    expect(inventedBody.changes[0]?.potentialCoverage).toBeUndefined();

    const unavailableOrg = `org_potential_none_${testRunId}`;
    expect(
      (await discover(baselineApp, discoveryRequest(unavailableOrg, paymentDocument, 'v1'))).status,
    ).toBe(201);
    const unavailable = await discover(
      baselineApp,
      discoveryRequest(unavailableOrg, breakingDocument(), 'v2-none'),
    );
    const unavailableBody = (await unavailable.json()) as {
      changes: Array<{ potentialCoverage?: unknown }>;
    };
    expect(unavailableBody.changes[0]?.potentialCoverage).toBeUndefined();
  });

  it('still quarantines breaking rediscovery when the model suggests potential coverage', async () => {
    const organizationId = `org_potential_quarantine_${testRunId}`;
    const first = (await (
      await discover(baselineApp, discoveryRequest(organizationId, paymentDocument, 'v1'))
    ).json()) as { capabilities: Array<{ capabilityVersionId: string }> };
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

    const response = await discover(
      appWithPlanner({
        ...unusedPlanning(),
        async suggestPotentialCoverage(input) {
          const fromCapabilityVersionId = input.unmappedContracts[0]?.fromCapabilityVersionId;
          return {
            kind: 'suggestion',
            suggestions: fromCapabilityVersionId
              ? [
                  {
                    fromCapabilityVersionId,
                    operationId: 'getPaymentRecord',
                    fieldPath: '/paymentId',
                  },
                ]
              : [],
          };
        },
      }),
      discoveryRequest(organizationId, breakingDocument(), 'v2-quarantine'),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      changes: Array<{ potentialCoverage?: { operationId: string } }>;
    };
    expect(body.changes[0]?.potentialCoverage?.operationId).toBe('getPaymentRecord');

    const quarantines = await pool.query(
      `SELECT workflow_version_id FROM workflow_quarantines
       WHERE organization_id = $1 AND lifted_at IS NULL`,
      [organizationId],
    );
    expect(quarantines.rows).toEqual([{ workflow_version_id: workflow.workflowVersionId }]);
  });
});
