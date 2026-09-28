import { draftWorkflow } from './workflow-planning.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  createCompiledWorkflowVersion as compileWorkflowVersion,
  createTransformationCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { PlannerUnavailableError } from './openai-planner-model.js';
import { createPlanningTokenAuthorizer } from './planning-authorization.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import type { PlannerModel } from './workflow-planning.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_validation_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const app = createApp(pool, undefined, undefined, undefined, undefined, undefined, {
  allowLegacySourceRoutes: true,
});
const hostileFixtures = JSON.parse(
  readFileSync(new URL('./fixtures/hostile-validation-fixtures.json', import.meta.url), 'utf8'),
) as Array<{ id: string; expectedKind: string; expectedCode: string }>;

function hostileFixture(id: string) {
  const fixture = hostileFixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Missing hostile validation fixture '${id}'`);
  return fixture;
}

const defaultWorkflowInputSchema = {
  required: {
    id: { type: 'string' as const },
    paymentId: { type: 'string' as const },
  },
};

async function createCompiledWorkflowVersion(
  workflowVersionId: string,
  organizationId: string,
  executable: Parameters<typeof compileWorkflowVersion>[2],
) {
  return compileWorkflowVersion(workflowVersionId, organizationId, {
    inputSchema: defaultWorkflowInputSchema,
    ...executable,
  });
}

async function createTransformationWorkflowVersion(
  workflowVersionId: string,
  organizationId: string,
  executable: Parameters<typeof createTransformationCompiledWorkflowVersion>[2],
) {
  return createTransformationCompiledWorkflowVersion(workflowVersionId, organizationId, {
    inputSchema: defaultWorkflowInputSchema,
    ...executable,
  });
}
let getPaymentCapabilityVersionId = '';
let lookupPaymentRiskCapabilityVersionId = '';
let beginSettlementCapabilityVersionId = '';
let cancelSettlementCapabilityVersionId = '';
let markPaidCapabilityVersionId = '';

const capabilityDocument = {
  openapi: '3.1.0',
  info: { title: 'Atlas validation estate', version: '1.0.0' },
  paths: {
    '/payments/{paymentId}': {
      get: {
        operationId: 'getPayment',
        parameters: [
          {
            name: 'paymentId',
            in: 'path',
            required: true,
            schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
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
    '/settlements': {
      post: {
        operationId: 'beginSettlement',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['invoiceId', 'idempotencyKey'],
                properties: {
                  invoiceId: { type: 'string' },
                  idempotencyKey: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Settlement',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Settlement' } },
            },
          },
        },
      },
    },
    '/settlements/{settlementId}/cancel': {
      post: {
        operationId: 'cancelSettlement',
        parameters: [
          { name: 'settlementId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'idempotencyKey', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: { '204': { description: 'Cancelled' } },
      },
    },
    '/invoices/{invoiceId}/paid': {
      post: {
        operationId: 'markPaid',
        parameters: [
          { name: 'invoiceId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'idempotencyKey', in: 'header', required: true, schema: { type: 'string' } },
        ],
        responses: { '204': { description: 'Paid' } },
      },
    },
  },
  components: {
    schemas: {
      Payment: {
        type: 'object',
        required: ['paymentId', 'invoiceId'],
        properties: {
          paymentId: { type: 'string' },
          invoiceId: { type: 'string', 'x-atlas-data-classification': 'confidential' },
        },
      },
      Settlement: {
        type: 'object',
        required: ['settlementId'],
        properties: { settlementId: { type: 'string' } },
      },
    },
  },
};

const partnerRiskDocument = {
  openapi: '3.1.0',
  info: { title: 'Partner risk API', version: '1.0.0' },
  servers: [{ url: 'https://api.partner.test' }],
  paths: {
    '/payment-risk/{paymentId}': {
      get: {
        operationId: 'lookupPaymentRisk',
        parameters: [
          {
            name: 'paymentId',
            in: 'path',
            required: true,
            schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
          },
        ],
        responses: {
          '200': {
            description: 'Payment risk',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['risk'],
                  properties: { risk: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
};

beforeAll(async () => {
  if (hostileFixtures.length !== 18) throw new Error('Expected all 18 hostile fixtures');
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 29 });
  await pool.query(`
    TRUNCATE organizations, source_documents, capability_identities,
      manifest_annotations, capability_versions, compatibility_diffs,
      capability_approvals, workflow_versions, workflow_capability_dependencies
    RESTART IDENTITY CASCADE
  `);
  const ingestion = await app.request('/v1/capability-ingestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: 'org_atlas',
      serviceId: 'payments',
      source: {
        format: 'openapi',
        document: capabilityDocument,
        repository: 'https://github.com/acme/payment-api',
        commit: 'validation-fixture',
        path: 'openapi.json',
      },
      manifest: {
        source: {
          repository: 'https://github.com/acme/payment-api',
          commit: 'validation-fixture',
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
          {
            capability: { operationId: 'beginSettlement' },
            owner: 'billing-team',
            secretAlias: 'billing-api-token',
            businessSemantics: { beginsSettlement: true },
            idempotencyField: 'idempotencyKey',
            compensatedBy: { operationId: 'cancelSettlement' },
            irreversibleAfter: false,
          },
          {
            capability: { operationId: 'cancelSettlement' },
            owner: 'billing-team',
            secretAlias: 'billing-api-token',
            businessSemantics: { cancelsSettlement: true },
            idempotencyField: 'idempotencyKey',
            compensatedBy: null,
            irreversibleAfter: true,
          },
          {
            capability: { operationId: 'markPaid' },
            owner: 'billing-team',
            secretAlias: 'billing-api-token',
            businessSemantics: { marksInvoicePaid: true },
            idempotencyField: 'idempotencyKey',
            compensatedBy: null,
            irreversibleAfter: true,
          },
        ],
      },
    }),
  });
  if (ingestion.status !== 201) throw new Error('Could not ingest validation capabilities');
  const capabilities = (
    (await ingestion.json()) as {
      capabilities: Array<{
        capabilityVersionId: string;
        identity: { operationId: string };
      }>;
    }
  ).capabilities;
  getPaymentCapabilityVersionId = capabilities.find(
    ({ identity }) => identity.operationId === 'getPayment',
  )!.capabilityVersionId;
  beginSettlementCapabilityVersionId = capabilities.find(
    ({ identity }) => identity.operationId === 'beginSettlement',
  )!.capabilityVersionId;
  cancelSettlementCapabilityVersionId = capabilities.find(
    ({ identity }) => identity.operationId === 'cancelSettlement',
  )!.capabilityVersionId;
  markPaidCapabilityVersionId = capabilities.find(
    ({ identity }) => identity.operationId === 'markPaid',
  )!.capabilityVersionId;
  const partnerIngestion = await app.request('/v1/capability-ingestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: 'org_atlas',
      serviceId: 'partner-risk',
      source: {
        format: 'openapi',
        document: partnerRiskDocument,
        repository: 'https://github.com/partner/risk-api',
        commit: 'partner-validation-fixture',
        path: 'openapi.json',
      },
      manifest: {
        source: {
          repository: 'https://github.com/partner/risk-api',
          commit: 'partner-validation-fixture',
          path: 'atlas-manifest.json',
        },
        annotations: [
          {
            capability: { operationId: 'lookupPaymentRisk' },
            owner: 'partner-risk-team',
            secretAlias: 'partner-risk-token',
            businessSemantics: { readsPartnerPaymentRisk: true },
            idempotencyField: null,
            compensatedBy: null,
            irreversibleAfter: false,
          },
        ],
      },
    }),
  });
  if (partnerIngestion.status !== 201) throw new Error('Could not ingest partner capability');
  lookupPaymentRiskCapabilityVersionId = (
    (await partnerIngestion.json()) as {
      capabilities: Array<{ capabilityVersionId: string }>;
    }
  ).capabilities[0]!.capabilityVersionId;
  await pool.query(`
    INSERT INTO environment_capability_observations
      (organization_id, environment_id, capability_identity_id, capability_version_id)
    SELECT organization_id, 'development', capability_identity_id, capability_version_id
    FROM environment_capability_observations
    WHERE organization_id = 'org_atlas' AND environment_id = 'production'
    ON CONFLICT DO NOTHING;
    INSERT INTO environment_capability_version_observations
      (organization_id, environment_id, capability_version_id)
    SELECT organization_id, 'development', capability_version_id
    FROM environment_capability_version_observations
    WHERE organization_id = 'org_atlas' AND environment_id = 'production'
    ON CONFLICT DO NOTHING;
    INSERT INTO manifest_annotation_approvals
      (organization_id, manifest_annotation_id, approved_by)
    SELECT organization_id, id, 'admin@example.com' FROM manifest_annotations
    WHERE organization_id = 'org_atlas';
    INSERT INTO capability_approvals
      (organization_id, capability_version_id, approved_by)
    SELECT organization_id, capability_version_id, 'admin@example.com' FROM capability_versions
    WHERE organization_id = 'org_atlas';
    INSERT INTO capability_host_policies
      (organization_id, capability_identity_id, environment_id, hostname, approved_by)
    SELECT organization_id, id, 'production',
      CASE WHEN service_id = 'partner-risk' THEN 'api.partner.test' ELSE 'payments.internal' END,
      'admin@example.com'
    FROM capability_identities WHERE organization_id = 'org_atlas';
    INSERT INTO organization_environment_policies
      (organization_id, environment_id, policy_version, approved_by)
    VALUES ('org_atlas', 'production', 'mvp-validation-v1', 'admin@example.com');
  `);
});

afterAll(async () => {
  await pool.end();
});

describe('workflow validation API', () => {
  it('retains all 18 hostile validation fixtures', () => {
    const portedRoot = resolve('apps/backend/src/fixtures/009-validation-policy');
    expect(
      readdirSync(join(portedRoot, 'hostile'), { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      ),
    ).toHaveLength(18);
  });

  it('rejects an invented capability through the backend HTTP seam', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('payment-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'f'.repeat(64),
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('01-capability-not-found').expectedCode,
          path: 'executable.steps[get-payment].capabilityVersionId',
        }),
      ]),
      decision: { approvable: false },
    });
  });

  it('rejects a stale or tampered planner projection fingerprint', async () => {
    const draft = await createCompiledWorkflowVersion('empty-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'complete', kind: 'terminal', state: 'completed' }],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: '0'.repeat(64),
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('18-projection-fingerprint-mismatch').expectedCode,
          path: 'projectionFingerprint',
        }),
      ]),
      decision: { approvable: false },
    });
  });

  it('rejects a capability version owned by another organization', async () => {
    const foreignIngestion = await app.request('/v1/capability-ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_foreign',
        serviceId: 'foreign',
        source: {
          format: 'openapi',
          document: {
            openapi: '3.1.0',
            info: { title: 'Foreign API', version: '1.0.0' },
            paths: {
              '/foreign/{id}': {
                get: {
                  operationId: 'getForeignRecord',
                  parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                  ],
                  responses: {
                    '200': {
                      description: 'Foreign record',
                      content: {
                        'application/json': { schema: { type: 'object', properties: {} } },
                      },
                    },
                  },
                },
              },
            },
          },
          repository: 'https://github.com/acme/foreign-api',
          commit: 'foreign-validation-fixture',
          path: 'openapi.json',
        },
        manifest: {
          source: {
            repository: 'https://github.com/acme/foreign-api',
            commit: 'foreign-validation-fixture',
            path: 'atlas-manifest.json',
          },
          annotations: [
            {
              capability: { operationId: 'getForeignRecord' },
              owner: 'foreign-team',
              secretAlias: null,
              businessSemantics: { readsForeignRecord: true },
              idempotencyField: null,
              compensatedBy: null,
              irreversibleAfter: false,
            },
          ],
        },
      }),
    });
    expect(foreignIngestion.status).toBe(201);
    const foreignCapabilityVersionId = (
      (await foreignIngestion.json()) as { capabilities: Array<{ capabilityVersionId: string }> }
    ).capabilities[0]!.capabilityVersionId;
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('foreign-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'foreign-call',
          kind: 'capabilityCall',
          capabilityVersionId: foreignCapabilityVersionId,
          arguments: { id: { source: 'input', path: ['id'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('03-capability-org-mismatch').expectedCode,
          path: 'executable.steps[foreign-call].capabilityVersionId',
        }),
      ]),
    });
  });

  it('re-resolves referenced capabilities and rejects revoked approval', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('payment-flow@2', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });
    await pool.query(
      `UPDATE capability_approvals SET revoked_at = current_timestamp
       WHERE organization_id = $1 AND capability_version_id = $2`,
      ['org_atlas', getPaymentCapabilityVersionId],
    );

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('02-capability-not-enabled').expectedCode,
          path: 'executable.steps[get-payment].capabilityVersionId',
        }),
      ]),
    });
    await pool.query(
      `UPDATE capability_approvals SET revoked_at = NULL
       WHERE organization_id = $1 AND capability_version_id = $2`,
      ['org_atlas', getPaymentCapabilityVersionId],
    );
  });

  it('discards a draft hash and binds the decision to the recomputed IR hash', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('empty-flow@2', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'complete', kind: 'terminal', state: 'completed' }],
    });
    const recomputedIrHash = draft.irHash;
    draft.irHash = 'f'.repeat(64);
    draft.executionRequirements.irHash = 'f'.repeat(64);

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'compileError',
          code: hostileFixture('17-tampered-backend-hash').expectedCode,
          path: 'irHash',
        }),
      ]),
      decision: { approvable: false, recomputedIrHash },
    });
  });

  it('rejects document-internal structural violations before policy evaluation', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('duplicate-step-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        { id: 'duplicate', kind: 'terminal', state: 'validation_failed' },
        { id: 'duplicate', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'compileError',
          code: 'TICKET_007_STRUCTURAL_INVALID',
          path: 'executable.steps[duplicate].id',
        }),
      ]),
    });
  });

  it('rejects a draft that leaves a required capability input unmapped', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('missing-mapping-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: {},
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('04-unmapped-required-field').expectedCode,
          path: 'executable.steps[get-payment].arguments.paymentId',
        }),
      ]),
    });
  });

  it('rejects a mapping whose source type is not assignable to the capability schema', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('type-mismatch-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'literal', value: 42 } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('05-schema-type-mismatch').expectedCode,
          path: 'executable.steps[get-payment].arguments.paymentId',
        }),
      ]),
    });
  });

  it('type-checks IR v2 transformations against fingerprint-bound capability versions', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createTransformationWorkflowVersion(
      'transformation-type-mismatch-flow@1',
      'org_atlas',
      {
        irVersion: 2,
        steps: [
          {
            id: 'get-payment',
            kind: 'capabilityCall',
            capabilityVersionId: getPaymentCapabilityVersionId,
            inputSchema: { required: { paymentId: { type: 'string' } } },
            arguments: {
              paymentId: {
                kind: 'call',
                function: 'multiply',
                arguments: [
                  { source: 'literal', value: 6 },
                  { source: 'literal', value: 7 },
                ],
              },
            },
          },
          { id: 'complete', kind: 'terminal', state: 'completed' },
        ],
      },
    );

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'TRANSFORM_TYPE_MISMATCH',
          path: 'executable.steps[get-payment].arguments.paymentId',
          message: expect.stringContaining("Source type 'number'"),
        }),
      ]),
      decision: {
        approvable: false,
        projectionFingerprint: projection.fingerprint,
        recomputedIrHash: draft.irHash,
      },
    });
  });

  it('rejects a non-admin proposed approver', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('rbac-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'complete', kind: 'terminal', state: 'completed' }],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'author',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('07-rbac-denied').expectedCode,
          path: 'proposedApproverRole',
        }),
      ]),
    });
  });

  it('rejects an organization/environment mismatch', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('environment-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'complete', kind: 'terminal', state: 'completed' }],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'env_dev_sandbox',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('08-org-environment-mismatch').expectedCode,
          path: 'environmentId',
        }),
      ]),
    });
  });

  it('rejects a literal secret-shaped value in a workflow mapping', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('secret-leak-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: {
            paymentId: { source: 'literal', value: 'sk_live_51_secret_material' },
          },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('06-secret-value-leak').expectedCode,
          path: 'executable.steps[get-payment].arguments.paymentId',
        }),
      ]),
    });
  });

  it('rejects a capability without an effective execution-host allowlist entry', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('host-policy-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });
    await pool.query(
      `UPDATE capability_host_policies SET revoked_at = current_timestamp
       WHERE organization_id = $1`,
      ['org_atlas'],
    );

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('10-execution-host-not-allowlisted').expectedCode,
          path: 'executable.steps[get-payment]',
        }),
      ]),
    });
    await pool.query(
      `UPDATE capability_host_policies SET revoked_at = NULL WHERE organization_id = $1`,
      ['org_atlas'],
    );
  });

  it('rejects private and cloud-metadata execution hosts even when allowlisted', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('private-host-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });
    await pool.query(
      `UPDATE capability_host_policies SET hostname = '169.254.169.254'
       WHERE organization_id = $1`,
      ['org_atlas'],
    );

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('11-execution-host-metadata-denied').expectedCode,
          path: 'executable.steps[get-payment]',
        }),
      ]),
    });
    await pool.query(
      `UPDATE capability_host_policies SET hostname = 'payments.internal'
       WHERE organization_id = $1`,
      ['org_atlas'],
    );
  });

  it('rejects retryable side effects without a declared idempotency key', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('retry-safety-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'begin-settlement',
          kind: 'capabilityCall',
          capabilityVersionId: beginSettlementCapabilityVersionId,
          arguments: {
            invoiceId: { source: 'input', path: ['invoiceId'] },
            idempotencyKey: { source: 'input', path: ['paymentId'] },
          },
          retryPolicy: {
            initialInterval: '1s',
            backoffCoefficient: 2,
            maximumInterval: '10s',
            maximumAttempts: 3,
            nonRetryableErrorTypes: [],
          },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('12-retry-idempotency-missing').expectedCode,
          path: 'executable.steps[begin-settlement]',
        }),
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'RETRY_ON_NON_IDEMPOTENT_SIDE_EFFECT',
          path: 'executable.steps[begin-settlement]',
        }),
      ]),
    });
  });

  it('cross-checks compensation wiring against the trusted capability graph', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('compensation-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'begin-settlement',
          kind: 'capabilityCall',
          capabilityVersionId: beginSettlementCapabilityVersionId,
          arguments: {
            invoiceId: { source: 'input', path: ['invoiceId'] },
            idempotencyKey: { source: 'input', path: ['paymentId'] },
          },
          idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
        },
        {
          id: 'wrong-compensation',
          kind: 'compensation',
          compensatesStepId: 'begin-settlement',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('13-compensation-incomplete').expectedCode,
          path: 'executable.steps[begin-settlement]',
        }),
      ]),
    });
  });

  it('rejects a draft that lies about an irreversible boundary', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('irreversible-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'begin-settlement',
          kind: 'capabilityCall',
          capabilityVersionId: beginSettlementCapabilityVersionId,
          arguments: {
            invoiceId: { source: 'input', path: ['invoiceId'] },
            idempotencyKey: { source: 'input', path: ['paymentId'] },
          },
          idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
          irreversibleAfter: true,
        },
        {
          id: 'cancel-settlement',
          kind: 'compensation',
          compensatesStepId: 'begin-settlement',
          capabilityVersionId: cancelSettlementCapabilityVersionId,
          arguments: {
            settlementId: {
              source: 'stepOutput',
              stepId: 'begin-settlement',
              path: ['settlementId'],
            },
            idempotencyKey: { source: 'input', path: ['paymentId'] },
          },
          idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('14-irreversible-boundary-violation').expectedCode,
          path: 'executable.steps[begin-settlement].irreversibleAfter',
        }),
      ]),
    });
  });

  it('rejects an invalid revalidation cycle', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const cyclicStep = {
      id: 'get-payment',
      kind: 'capabilityCall' as const,
      capabilityVersionId: getPaymentCapabilityVersionId,
      arguments: { paymentId: { source: 'input' as const, path: ['paymentId'] } },
      errorRouting: {
        rules: [],
        defaultAction: {
          kind: 'revalidateFrom' as const,
          targetStepId: 'get-payment',
          maxRevalidations: 1,
          onExhausted: {
            kind: 'land' as const,
            outcome: 'validation_failed' as const,
            reasonCode: 'revalidation-exhausted',
          },
        },
      },
    };
    const draft = await createCompiledWorkflowVersion('cycle-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [cyclicStep, { id: 'complete', kind: 'terminal', state: 'completed' }],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'compileError',
          code: hostileFixture('16-invalid-cycle').expectedCode,
          path: 'executable.steps[get-payment].errorRouting',
        }),
      ]),
    });
  });

  it('rejects a revalidation slice that crosses an irreversible boundary', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const probeStep = {
      id: 'hostile-probe',
      kind: 'capabilityCall' as const,
      capabilityVersionId: getPaymentCapabilityVersionId,
      arguments: { paymentId: { source: 'input' as const, path: ['paymentId'] } },
      errorRouting: {
        rules: [],
        defaultAction: {
          kind: 'revalidateFrom' as const,
          targetStepId: 'get-payment',
          maxRevalidations: 1,
          onExhausted: {
            kind: 'land' as const,
            outcome: 'repair_required' as const,
            reasonCode: 'revalidation-exhausted',
          },
        },
      },
    };
    const draft = await createCompiledWorkflowVersion('revalidation-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        {
          id: 'mark-paid',
          kind: 'capabilityCall',
          capabilityVersionId: markPaidCapabilityVersionId,
          arguments: {
            invoiceId: { source: 'input', path: ['invoiceId'] },
            idempotencyKey: { source: 'input', path: ['paymentId'] },
          },
          idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
          irreversibleAfter: true,
        },
        probeStep,
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('15-revalidation-slice-unsafe').expectedCode,
          path: 'executable.steps[hostile-probe].errorRouting',
        }),
      ]),
    });
  });

  it('rejects a data-classification downgrade in a mapping', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('classification-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        {
          id: 'hostile-downgrade',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: {
            paymentId: {
              source: 'stepOutput',
              stepId: 'get-payment',
              path: ['invoiceId'],
            },
          },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: hostileFixture('09-data-classification-downgrade').expectedCode,
          path: 'executable.steps[hostile-downgrade].arguments.paymentId',
        }),
      ]),
    });
  });

  it('blocks approval on every warning in the MVP', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('warning-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          retryPolicy: {
            initialInterval: '1s',
            backoffCoefficient: 2,
            maximumInterval: '10s',
            maximumAttempts: 6,
            nonRetryableErrorTypes: [],
          },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'warning',
          code: 'WARN_HIGH_RETRY_ATTEMPT_COUNT',
          path: 'executable.steps[get-payment].retryPolicy.maximumAttempts',
        }),
      ]),
      decision: { approvable: false },
    });
  });

  it('discards backend-owned draft fields and returns a deterministic bound decision', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('valid-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });
    Object.assign(draft, {
      approvalState: 'approved',
      approvedBy: 'attacker@example.com',
      approvedAt: '2099-01-01T00:00:00.000Z',
      executionGrant: { forged: true },
      modelInvocation: { trusted: true },
    });
    const body = JSON.stringify({
      organizationId: 'org_atlas',
      environmentId: 'production',
      proposedApproverRole: 'admin',
      projectionFingerprint: projection.fingerprint,
      draft,
    });

    const first = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const second = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const firstReport = await first.json();
    const secondReport = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondReport).toEqual(firstReport);
    expect(firstReport).toMatchObject({
      diagnostics: [],
      decision: {
        approvable: true,
        recomputedIrHash: draft.irHash,
        policyVersion: 'mvp-validation-v1',
        projectionFingerprint: projection.fingerprint,
      },
    });
  });

  it('rejects execution-host policies that permit redirects', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('redirect-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });
    await pool.query(
      `UPDATE capability_host_policies SET allow_redirects = true WHERE organization_id = $1`,
      ['org_atlas'],
    );

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'EXECUTION_HOST_REDIRECTS_NOT_PERMITTED',
          path: 'executable.steps[get-payment]',
        }),
      ]),
    });
    await pool.query(
      `UPDATE capability_host_policies SET allow_redirects = false WHERE organization_id = $1`,
      ['org_atlas'],
    );
  });

  it('scopes execution-host allowlists to the requested environment', async () => {
    await pool.query(
      `INSERT INTO organization_environment_policies
        (organization_id, environment_id, policy_version, approved_by)
       VALUES ($1, $2, $3, $4)`,
      ['org_atlas', 'development', 'mvp-validation-v1', 'admin@example.com'],
    );
    const projection = (await (
      await app.request(
        '/v1/planner-capabilities?organizationId=org_atlas&environmentId=development',
      )
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('environment-host-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'development',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'EXECUTION_HOST_NOT_ALLOWLISTED',
          path: 'executable.steps[get-payment]',
        }),
      ]),
    });
  });

  it('rejects workflow-input paths absent from the compiled input schema', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('input-path-flow@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['invented'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'SOURCE_PATH_NOT_FOUND',
          path: 'executable.steps[get-payment].arguments.paymentId',
        }),
      ]),
    });
  });

  it("enforces data-classification flow from the workflow's declared inputs", async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('input-classification-flow@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string', classification: 'confidential' } } },
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'DATA_CLASSIFICATION_DOWNGRADE',
          path: 'executable.steps[get-payment].arguments.paymentId',
        }),
      ]),
    });
  });

  it('does not block the development demo on data-classification downgrades', async () => {
    await pool.query(
      `INSERT INTO organization_environment_policies
         (organization_id, environment_id, policy_version, approved_by)
       VALUES ($1, 'development', 'mvp-demo-permissive-v1', 'admin@example.com')
       ON CONFLICT (organization_id, environment_id) DO UPDATE
       SET policy_version = EXCLUDED.policy_version,
           revoked_at = NULL`,
      ['org_atlas'],
    );
    await pool.query(
      `INSERT INTO capability_host_policies
         (organization_id, capability_identity_id, environment_id, hostname, approved_by)
       SELECT version.organization_id, version.capability_identity_id, 'development',
              'payments.internal', 'admin@example.com'
       FROM capability_versions version
       WHERE version.organization_id = $1 AND version.capability_version_id = $2`,
      ['org_atlas', getPaymentCapabilityVersionId],
    );
    const projection = (await (
      await app.request(
        '/v1/planner-capabilities?organizationId=org_atlas&environmentId=development',
      )
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('development-demo-flow@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string', classification: 'confidential' } } },
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    try {
      const response = await app.request('/v1/workflow-validations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          proposedApproverRole: 'admin',
          projectionFingerprint: projection.fingerprint,
          draft,
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        diagnostics: expect.not.arrayContaining([
          expect.objectContaining({ code: 'DATA_CLASSIFICATION_DOWNGRADE' }),
        ]),
        decision: { approvable: true },
      });
    } finally {
      await pool.query(
        `DELETE FROM capability_host_policies
         WHERE organization_id = $1 AND capability_identity_id = (
           SELECT capability_identity_id FROM capability_versions
           WHERE organization_id = $1 AND capability_version_id = $2
         ) AND environment_id = 'development'`,
        ['org_atlas', getPaymentCapabilityVersionId],
      );
      await pool.query(
        `UPDATE organization_environment_policies
         SET policy_version = 'mvp-validation-v1'
         WHERE organization_id = $1 AND environment_id = 'development'`,
        ['org_atlas'],
      );
    }
  });

  it('rejects compensation edges absent from the trusted capability graph', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('invented-compensation-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: getPaymentCapabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        {
          id: 'invented-compensation',
          kind: 'compensation',
          compensatesStepId: 'get-payment',
          capabilityVersionId: cancelSettlementCapabilityVersionId,
          arguments: {
            settlementId: { source: 'literal', value: 'settlement-1' },
            idempotencyKey: { source: 'literal', value: 'cancel-1' },
          },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'COMPENSATION_INCOMPLETE',
          path: 'executable.steps[get-payment]',
        }),
      ]),
    });
  });

  it('rejects an extra compensation edge even when the trusted edge is also present', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion(
      'duplicate-compensation-flow@1',
      'org_atlas',
      {
        irVersion: 1,
        steps: [
          {
            id: 'begin-settlement',
            kind: 'capabilityCall',
            capabilityVersionId: beginSettlementCapabilityVersionId,
            arguments: {
              invoiceId: { source: 'input', path: ['id'] },
              idempotencyKey: { source: 'literal', value: 'settle-1' },
            },
          },
          {
            id: 'trusted-compensation',
            kind: 'compensation',
            compensatesStepId: 'begin-settlement',
            capabilityVersionId: cancelSettlementCapabilityVersionId,
            arguments: {
              settlementId: { source: 'literal', value: 'settlement-1' },
              idempotencyKey: { source: 'literal', value: 'cancel-1' },
            },
          },
          {
            id: 'invented-compensation',
            kind: 'compensation',
            compensatesStepId: 'begin-settlement',
            capabilityVersionId: markPaidCapabilityVersionId,
            arguments: {
              invoiceId: { source: 'input', path: ['id'] },
              idempotencyKey: { source: 'literal', value: 'mark-1' },
            },
          },
          { id: 'complete', kind: 'terminal', state: 'completed' },
        ],
      },
    );

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'COMPENSATION_INCOMPLETE',
          path: 'executable.steps[begin-settlement]',
        }),
      ]),
    });
  });

  it('rejects an invented compensation chain targeting a compensation step', async () => {
    const projection = (await (
      await app.request('/v1/planner-capabilities?organizationId=org_atlas')
    ).json()) as { fingerprint: string };
    const draft = await createCompiledWorkflowVersion('compensation-chain-flow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'begin-settlement',
          kind: 'capabilityCall',
          capabilityVersionId: beginSettlementCapabilityVersionId,
          arguments: {
            invoiceId: { source: 'input', path: ['id'] },
            idempotencyKey: { source: 'literal', value: 'settle-1' },
          },
        },
        {
          id: 'trusted-compensation',
          kind: 'compensation',
          compensatesStepId: 'begin-settlement',
          capabilityVersionId: cancelSettlementCapabilityVersionId,
          arguments: {
            settlementId: { source: 'literal', value: 'settlement-1' },
            idempotencyKey: { source: 'literal', value: 'cancel-1' },
          },
        },
        {
          id: 'invented-chain',
          kind: 'compensation',
          compensatesStepId: 'trusted-compensation',
          capabilityVersionId: markPaidCapabilityVersionId,
          arguments: {
            invoiceId: { source: 'input', path: ['id'] },
            idempotencyKey: { source: 'literal', value: 'mark-1' },
          },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint: projection.fingerprint,
        draft,
      }),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          kind: 'policyDenial',
          code: 'COMPENSATION_INCOMPLETE',
          path: 'executable.steps[trusted-compensation]',
        }),
      ]),
    });
  });
});

describe('workflow drafting API', () => {
  const planningAuthorizer = {
    async authorize() {
      return 'author' as const;
    },
  };
  const intentFrame = {
    version: 1 as const,
    summary: 'Read the authoritative payment',
    requestedEffects: ['readRecord' as const],
    mentionedSystems: ['payments'],
    requiredInputs: ['paymentId'],
    constraints: [],
    ambiguities: [],
    supported: true,
    unsupportedReason: null,
  };

  async function validPlanningDraft(capabilityVersionId = getPaymentCapabilityVersionId) {
    return createCompiledWorkflowVersion('model-owned-id', 'wrong-org', {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId,
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });
  }

  function planningRequest(
    request = 'When a payment succeeds, read its payment record.',
    extras: Record<string, unknown> = {},
  ) {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        request,
        workflowVersionId: 'payment-read@1',
        ...extras,
      }),
    };
  }

  it('rejects an unauthenticated or cross-organization request before intent extraction', async () => {
    let extractionCount = 0;
    const model: PlannerModel = {
      async extractIntent() {
        extractionCount += 1;
        return intentFrame;
      },
      async draftWorkflow() {
        throw new Error('Unauthorized requests must not reach planning');
      },
      async repairWorkflow() {
        throw new Error('Unauthorized requests must not reach repair');
      },
    };
    const authorizedApp = createApp(
      pool,
      { allowedHosts: [] },
      model,
      createPlanningTokenAuthorizer({ token: 'test-author-token', organizationId: 'org_atlas' }),
    );

    const missingToken = await authorizedApp.request('/v1/workflow-drafts', planningRequest());
    const wrongOrganization = await authorizedApp.request('/v1/workflow-drafts', {
      ...planningRequest(),
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-author-token',
      },
      body: JSON.stringify({
        organizationId: 'another_org',
        environmentId: 'production',
        request: 'Read a payment.',
        workflowVersionId: 'payment-read@1',
      }),
    });

    expect(missingToken.status).toBe(403);
    expect(wrongOrganization.status).toBe(403);
    expect(extractionCount).toBe(0);
  });

  it('returns JSON when the planning model is unavailable', async () => {
    const model: PlannerModel = {
      async extractIntent() {
        throw new PlannerUnavailableError(503);
      },
      async draftWorkflow() {
        throw new Error('Unavailable models must not reach planning');
      },
      async repairWorkflow() {
        throw new Error('Unavailable models must not reach repair');
      },
    };
    const planningApp = createApp(pool, { allowedHosts: [] }, model, planningAuthorizer);

    const response = await planningApp.request('/v1/workflow-drafts', planningRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'planner-unavailable' });
  });

  it('names exhausted OpenAI credits on the planner-unavailable response', async () => {
    const model: PlannerModel = {
      async extractIntent() {
        throw new PlannerUnavailableError(
          429,
          'insufficient_quota: credit_balance_exhausted: You have no credits remaining.',
          'credit_balance_exhausted',
        );
      },
      async draftWorkflow() {
        throw new Error('Unavailable models must not reach planning');
      },
      async repairWorkflow() {
        throw new Error('Unavailable models must not reach repair');
      },
    };
    const planningApp = createApp(pool, { allowedHosts: [] }, model, planningAuthorizer);

    const response = await planningApp.request('/v1/workflow-drafts', planningRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'planner-unavailable',
      reason: 'credit_balance_exhausted',
    });
  });

  it('turns authorized plain English into a fingerprint-bound validated draft', async () => {
    let planningInput: Parameters<PlannerModel['draftWorkflow']>[0] | undefined;
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow(input) {
        planningInput = input;
        const draft = await validPlanningDraft();
        return {
          kind: 'workflowDraft',
          intentFingerprint: input.intentFingerprint,
          projectionFingerprint: input.projection.fingerprint,
          draft: {
            ...draft,
            status: 'approved',
            compilerVersion: 'model-owned',
            provenance: { invented: true },
            approvalState: 'approved',
            executionGrant: { forged: true },
          },
        };
      },
      async repairWorkflow() {
        throw new Error('A valid draft should not need repair');
      },
    };
    const planningApp = createApp(pool, { allowedHosts: [] }, model, planningAuthorizer);

    const response = await planningApp.request('/v1/workflow-drafts', planningRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'validated',
      intentFrame: { summary: 'Read the authoritative payment' },
      draft: {
        workflowVersionId: 'payment-read@1',
        executionRequirements: { organizationId: 'org_atlas' },
      },
      validation: { decision: { approvable: true } },
    });
    expect(body.draft).not.toHaveProperty('status');
    expect(body.draft).not.toHaveProperty('compilerVersion');
    expect(body.draft).not.toHaveProperty('provenance');
    expect(body.draft).not.toHaveProperty('approvalState');
    expect(body.draft).not.toHaveProperty('executionGrant');
    expect(planningInput).toMatchObject({
      intent: intentFrame,
      projection: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
  });

  it('repairs an otherwise valid draft when the planner adds a closed-schema field', async () => {
    let repairValidation: Parameters<PlannerModel['repairWorkflow']>[0]['validation'] | undefined;
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft(),
          unexpectedPlannerField: true,
        };
      },
      async repairWorkflow({ intentFingerprint, projection, validation }) {
        repairValidation = validation;
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft(),
        };
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'validated' });
    expect(repairValidation?.diagnostics).toEqual([
      expect.objectContaining({
        code: 'SCHEMA_PARSE_FAILED',
        path: '(root)',
      }),
    ]);
  });

  it('classifies a non-repairable planner response as a contract failure, not ambiguity', async () => {
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow() {
        return { kind: 'unexpectedPlannerResponse' };
      },
      async repairWorkflow() {
        throw new Error('A response without a fingerprint-bound draft cannot be repaired safely');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      status: 'manual_review',
      reason: 'planner-contract-invalid',
      detail: 'The planning model returned an invalid closed-schema response',
    });
  });

  it('recomputes invalid model placeholders for backend-owned draft envelope fields', async () => {
    let repairCount = 0;
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        const draft = await validPlanningDraft();
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: {
            ...draft,
            workflowVersionId: 'model-placeholder',
            irHash: 'model-placeholder',
            executionRequirements: {
              organizationId: 'model-placeholder',
              workflowVersionId: 'model-placeholder',
              irHash: 'model-placeholder',
              requiredCapabilityVersionIds: ['model-placeholder'],
            },
          },
        };
      },
      async repairWorkflow() {
        repairCount += 1;
        throw new Error('Backend-owned placeholders must not trigger repair');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'validated',
      draft: {
        workflowVersionId: 'payment-read@1',
        irHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        executionRequirements: {
          organizationId: 'org_atlas',
          workflowVersionId: 'payment-read@1',
          irHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
    });
    expect(repairCount).toBe(0);
  });

  it('normalizes equivalent planner IR and output placement before repair', async () => {
    let repairCount = 0;
    const request = 'When a payment succeeds, read its payment record.';
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        const draft = await validPlanningDraft();
        const steps = draft.executable.steps.map((step) =>
          step.kind === 'terminal'
            ? step
            : {
                ...step,
                responseSchema: {
                  required: {
                    amount: {
                      required: {
                        value: { type: 'integer' },
                        currency: { type: 'string' },
                      },
                    },
                  },
                },
              },
        );
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: {
            ...draft,
            executable: { ...draft.executable, irVersion: 2, steps },
            clarifiedRequest: request,
            annotations: [],
          },
        };
      },
      async repairWorkflow() {
        repairCount += 1;
        throw new Error('Equivalent planner representations must not trigger repair');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(request),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      draft: { executable: { irVersion: number; steps: Array<Record<string, unknown>> } };
    };
    expect(body).toMatchObject({
      status: 'validated',
      clarifiedRequest: request,
      annotations: [],
      draft: { executable: { irVersion: 2 } },
    });
    expect(body.draft.executable.steps[0]).toMatchObject({
      responseSchema: {
        required: {
          paymentId: { type: 'string' },
          invoiceId: { type: 'string', classification: 'confidential' },
        },
      },
    });
    expect(body.draft.executable.steps[0]).not.toMatchObject({
      responseSchema: { required: { amount: expect.anything() } },
    });
    expect(repairCount).toBe(0);
  });

  it('repairs malformed annotation shapes without weakening semantic verification', async () => {
    const request = 'When a payment succeeds, read its payment record.';
    const seenPaths: string[] = [];
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          clarifiedRequest: request,
          annotations: [
            {
              start: 0,
              end: 4,
              text: 'When',
              kind: 'capability',
              capabilityVersionId: getPaymentCapabilityVersionId,
              direction: 'input',
              path: ['paymentId'],
            },
          ],
          draft: await validPlanningDraft(),
        };
      },
      async repairWorkflow({ intentFingerprint, projection, validation }) {
        seenPaths.push(...validation.diagnostics.map(({ path }) => path));
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          clarifiedRequest: request,
          annotations: [],
          draft: await validPlanningDraft(),
        };
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(request),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'validated', annotations: [] });
    expect(seenPaths).toEqual(
      expect.arrayContaining([expect.stringMatching(/^annotations\.0\.(direction|path)$/)]),
    );
  });

  it('keeps a valid draft when the model returns overlapping annotation ranges', async () => {
    const request = 'When a payment succeeds, read its payment record.';
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        const start = request.indexOf('payment');
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          clarifiedRequest: request,
          annotations: [
            {
              start,
              end: start + 'payment'.length,
              text: 'payment',
              kind: 'capability',
              capabilityVersionId: getPaymentCapabilityVersionId,
            },
            {
              start,
              end: start + 'payment'.length,
              text: 'payment',
              kind: 'capability',
              capabilityVersionId: getPaymentCapabilityVersionId,
            },
          ],
          draft: await validPlanningDraft(),
        };
      },
      async repairWorkflow() {
        throw new Error('Overlapping annotations must not fail a valid draft');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(request),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'validated' });
  });

  it('gives repair attempts the nested leaf path from a versioned draft union', async () => {
    const seenPaths: string[] = [];
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        const draft = await validPlanningDraft();
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: { ...draft, executable: { ...draft.executable, irVersion: 3 } },
        };
      },
      async repairWorkflow({ intentFingerprint, projection, validation }) {
        seenPaths.push(...validation.diagnostics.map(({ path }) => path));
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft(),
        };
      },
    };

    const stages: string[] = [];
    const response = await draftWorkflow(pool, model, JSON.parse(planningRequest().body), {
      onProgress: async (stage) => {
        stages.push(stage);
      },
    });
    expect(response.httpStatus).toBe(200);
    expect(stages).toEqual(['understanding', 'building', 'validating', 'repairing', 'validating']);
    expect(seenPaths).toContain('draft.executable.irVersion');
  });

  it('binds deterministic mapping selections into the real planner context', async () => {
    const planningInputs: Array<Parameters<PlannerModel['draftWorkflow']>[0]> = [];
    const repairInputs: Array<Parameters<PlannerModel['repairWorkflow']>[0]> = [];
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow(input) {
        planningInputs.push(input);
        const draft = await validPlanningDraft();
        return {
          kind: 'workflowDraft',
          intentFingerprint: input.intentFingerprint,
          projectionFingerprint: input.projection.fingerprint,
          draft: input.mappingResolutions
            ? {
                ...draft,
                executable: {
                  ...draft.executable,
                  steps: draft.executable.steps.map((step) =>
                    step.kind === 'terminal'
                      ? step
                      : {
                          ...step,
                          arguments: { paymentId: { source: 'literal', value: 'invented' } },
                        },
                  ),
                },
              }
            : draft,
        };
      },
      async repairWorkflow(input) {
        repairInputs.push(input);
        return {
          kind: 'workflowDraft',
          intentFingerprint: input.intentFingerprint,
          projectionFingerprint: input.projection.fingerprint,
          draft: await validPlanningDraft(),
        };
      },
    };
    const planningApp = createApp(pool, { allowedHosts: [] }, model, planningAuthorizer);
    expect((await planningApp.request('/v1/workflow-drafts', planningRequest())).status).toBe(200);
    const binding = planningInputs[0]!;

    const mappingRequest = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        request: 'When a payment succeeds, read its payment record.',
        workflowVersionId: 'payment-read@1',
        mapping: {
          intentFingerprint: binding.intentFingerprint,
          projectionFingerprint: binding.projection.fingerprint,
          sourceSteps: [
            { stepId: 'first-read', capabilityVersionId: getPaymentCapabilityVersionId },
            { stepId: 'second-read', capabilityVersionId: getPaymentCapabilityVersionId },
          ],
          destinationCapabilityVersionId: getPaymentCapabilityVersionId,
          destinationStepId: 'get-payment',
          // The draft's own inputs, echoed back the way the console does.
          workflowInputSchema: { required: { paymentId: { type: 'string' } } },
        },
      }),
    };
    const clarificationResponse = await planningApp.request('/v1/workflow-drafts', mappingRequest);
    const clarification = (await clarificationResponse.json()) as {
      status: string;
      candidateMappings: Array<{ candidateId: string }>;
      requiredQuestions: Array<{ question: string }>;
      questionAnnotations: Array<{ text: string; kind: string; path?: string }>;
    };
    expect(clarificationResponse.status).toBe(200);
    expect(clarification).toMatchObject({
      status: 'clarification_required',
      question:
        'What should Atlas use for the getPayment request field paymentId in the Payments API?',
      requiredQuestions: [
        {
          question:
            'What should Atlas use for the getPayment request field paymentId in the Payments API?',
        },
      ],
      questionAnnotations: [
        expect.objectContaining({ text: 'getPayment', kind: 'capability' }),
        expect.objectContaining({ text: 'paymentId', kind: 'requestField', path: '/paymentId' }),
        expect.objectContaining({ text: 'Payments', kind: 'capability' }),
      ],
    });
    expect(planningInputs).toHaveLength(1);

    const mappingBody = JSON.parse(mappingRequest.body) as {
      mapping: { selections?: Record<string, string> };
    };
    mappingBody.mapping.selections = {
      paymentId: clarification.candidateMappings[0]!.candidateId,
    };
    const response = await planningApp.request('/v1/workflow-drafts', {
      ...mappingRequest,
      body: JSON.stringify(mappingBody),
    });

    expect(response.status).toBe(200);
    expect(repairInputs).toHaveLength(0);
    expect(planningInputs[1]?.mappingResolutions?.[0]?.plan.diagnostics).toEqual([]);
    expect(planningInputs[1]?.mappingResolutions?.[0]?.plan).toMatchObject({
      status: 'ready',
      resolvedMappings: [
        expect.objectContaining({
          destinationPath: ['paymentId'],
          expression: { source: 'input', path: ['paymentId'] },
        }),
      ],
    });
  });

  it("gives a draft that declares no inputs the first step's required request fields", async () => {
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow(input) {
        return {
          kind: 'workflowDraft',
          intentFingerprint: input.intentFingerprint,
          projectionFingerprint: input.projection.fingerprint,
          // No inputSchema at all: the raw compiler, not the test wrapper that adds one.
          draft: await compileWorkflowVersion('model-owned-id', 'wrong-org', {
            irVersion: 1,
            steps: [
              {
                id: 'get-payment',
                kind: 'capabilityCall',
                capabilityVersionId: getPaymentCapabilityVersionId,
                arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
              },
              { id: 'complete', kind: 'terminal', state: 'completed' },
            ],
          }),
        };
      },
      async repairWorkflow() {
        throw new Error('A derived input schema must validate without repair');
      },
    };
    const planningApp = createApp(pool, { allowedHosts: [] }, model, planningAuthorizer);

    const response = await planningApp.request('/v1/workflow-drafts', planningRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      draft: { executable: { inputSchema?: unknown } };
    };
    expect(body.status).toBe('validated');
    expect(body.draft.executable.inputSchema).toEqual({
      required: { paymentId: { type: 'string', classification: 'internal' } },
    });
  });

  it('keeps the inputs a draft declares and leaves the injected run id out of them', async () => {
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow(input) {
        const draft = await validPlanningDraft();
        return {
          kind: 'workflowDraft',
          intentFingerprint: input.intentFingerprint,
          projectionFingerprint: input.projection.fingerprint,
          draft: {
            ...draft,
            executable: {
              ...draft.executable,
              inputSchema: {
                required: {
                  paymentId: { type: 'string', classification: 'internal' },
                  atlasWorkflowRunId: { type: 'string' },
                },
              },
            },
          },
        };
      },
      async repairWorkflow() {
        throw new Error('A declared input schema must validate without repair');
      },
    };
    const planningApp = createApp(pool, { allowedHosts: [] }, model, planningAuthorizer);

    const response = await planningApp.request('/v1/workflow-drafts', planningRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      draft: { executable: { inputSchema?: unknown } };
    };
    expect(body.status).toBe('validated');
    expect(body.draft.executable.inputSchema).toEqual({
      required: { paymentId: { type: 'string', classification: 'internal' } },
    });
  });

  it('normalizes redundant JSON Schema object types from planner object schemas', async () => {
    let repairCount = 0;
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        const draft = await validPlanningDraft();
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: {
            ...draft,
            executable: {
              ...draft.executable,
              inputSchema: {
                type: 'object',
                ...draft.executable.inputSchema,
                required: {
                  ...draft.executable.inputSchema?.required,
                  metadata: {
                    type: 'object',
                    required: { requestId: { type: 'string' } },
                  },
                },
              },
              steps: draft.executable.steps.map((step) =>
                step.kind === 'terminal'
                  ? step
                  : {
                      ...step,
                      responseSchema: {
                        type: 'object',
                        required: {
                          paymentId: { type: 'string' },
                          invoiceId: { type: 'string' },
                        },
                      },
                    },
              ),
            },
          },
        };
      },
      async repairWorkflow() {
        repairCount += 1;
        throw new Error('A redundant object type should be normalized before repair');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      draft: {
        executable: {
          inputSchema: Record<string, unknown>;
          steps: Array<{ responseSchema?: Record<string, unknown> }>;
        };
      };
    };
    expect(body.status).toBe('validated');
    expect(body.draft.executable.inputSchema).not.toHaveProperty('type');
    expect(body.draft.executable.inputSchema).toMatchObject({
      required: {
        metadata: {
          type: 'object',
          required: { requestId: { type: 'string' } },
        },
      },
    });
    expect(body.draft.executable.steps[0]?.responseSchema).not.toHaveProperty('type');
    expect(repairCount).toBe(0);
  });

  it('rebinds a uniquely truncated capability pin to the exact projected version', async () => {
    const truncatedCapabilityVersionId = getPaymentCapabilityVersionId.slice(0, -1);
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft(truncatedCapabilityVersionId),
        };
      },
      async repairWorkflow() {
        throw new Error('A uniquely truncated projection pin should be rebound before validation');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      draft: { executable: { steps: Array<{ capabilityVersionId?: string }> } };
    };
    expect(body.status).toBe('validated');
    expect(body.draft.executable.steps[0]?.capabilityVersionId).toBe(getPaymentCapabilityVersionId);
  });

  it('drafts a typed workflow across approved internal and third-party capabilities', async () => {
    let planningInput: Parameters<PlannerModel['draftWorkflow']>[0] | undefined;
    const model: PlannerModel = {
      async extractIntent({ developerRequest }) {
        return {
          ...intentFrame,
          summary: developerRequest.includes('Clarification answers:')
            ? 'Read the payment and use the selected source to check partner risk'
            : 'Read the payment and check its risk with the approved partner',
          mentionedSystems: ['payments', 'partner-risk'],
          ambiguities:
            developerRequest.includes('Clarification answers:') &&
            !developerRequest.includes('Use the payment currency')
              ? [
                  {
                    slot: 'currencyUse',
                    question: 'Should the risk check use the payment currency?',
                    suggestedAnswers: [
                      'Use the payment currency',
                      'Ignore currency',
                      'Use a fixed currency',
                    ],
                  },
                ]
              : [],
        };
      },
      async draftWorkflow(input) {
        planningInput = input;
        const { intent, intentFingerprint, projection } = input;
        const ambiguity = intent.ambiguities[0];
        if (ambiguity) {
          return {
            kind: 'clarification',
            intentFingerprint,
            projectionFingerprint: projection.fingerprint,
            question: ambiguity.question,
            suggestedAnswers: ambiguity.suggestedAnswers,
          };
        }
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await createCompiledWorkflowVersion('model-owned-id', 'wrong-org', {
            irVersion: 1,
            steps: [
              {
                id: 'get-payment',
                kind: 'capabilityCall',
                capabilityVersionId: getPaymentCapabilityVersionId,
                arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
                result: 'payment',
              },
              {
                id: 'check-partner-risk',
                kind: 'capabilityCall',
                capabilityVersionId: lookupPaymentRiskCapabilityVersionId,
                arguments: {
                  paymentId: {
                    source: 'stepOutput',
                    stepId: 'get-payment',
                    path: ['paymentId'],
                  },
                },
              },
              {
                id: 'check-partner-risk-again',
                kind: 'capabilityCall',
                capabilityVersionId: lookupPaymentRiskCapabilityVersionId,
                arguments: {
                  paymentId: {
                    source: 'stepOutput',
                    stepId: 'get-payment',
                    path: ['paymentId'],
                  },
                },
              },
              { id: 'complete', kind: 'terminal', state: 'completed' },
            ],
          }),
        };
      },
      async repairWorkflow() {
        throw new Error('A valid cross-system draft should not need repair');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest('Read the payment, then check its risk with our approved partner.'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'validated' });
    expect(
      planningInput?.projection.capabilities.map(({ capabilityVersionId }) => capabilityVersionId),
    ).toEqual(
      expect.arrayContaining([getPaymentCapabilityVersionId, lookupPaymentRiskCapabilityVersionId]),
    );
    expect(Object.keys(planningInput ?? {}).sort()).toEqual([
      'intent',
      'intentFingerprint',
      'projection',
    ]);
    expect(JSON.stringify(planningInput)).not.toMatch(
      /partner-risk-token|apiKey|secret|token|password|credential|authorization|executionGrant|network|endpoint/i,
    );
  });

  it('repairs a draft that uses a capability outside the projection without asking the user', async () => {
    let repairCount = 0;
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft('invented-capability-version'),
        };
      },
      async repairWorkflow({ intentFingerprint, projection, validation }) {
        repairCount += 1;
        expect(validation.diagnostics).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND_IN_PROJECTION' }),
          ]),
        );
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft(getPaymentCapabilityVersionId),
        };
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'validated' });
    expect(repairCount).toBe(1);
  });

  it('repairs an invented development capability pin without offering an environment switch', async () => {
    await pool.query(
      `INSERT INTO capability_host_policies
         (organization_id, capability_identity_id, environment_id, hostname, approved_by)
       SELECT version.organization_id, version.capability_identity_id, 'development',
              'payments.internal', 'admin@example.com'
       FROM capability_versions version
       WHERE version.organization_id = $1 AND version.capability_version_id = $2
       ON CONFLICT (organization_id, capability_identity_id, environment_id, hostname) DO UPDATE
       SET revoked_at = NULL`,
      ['org_atlas', getPaymentCapabilityVersionId],
    );
    let repairCount = 0;
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft('invented-capability-version'),
        };
      },
      async repairWorkflow({ intentFingerprint, projection }) {
        repairCount += 1;
        expect(
          projection.capabilities.map(({ capabilityVersionId }) => capabilityVersionId),
        ).toContain(getPaymentCapabilityVersionId);
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft(getPaymentCapabilityVersionId),
        };
      },
    };
    try {
      const response = await createApp(
        pool,
        { allowedHosts: [] },
        model,
        planningAuthorizer,
      ).request(
        '/v1/workflow-drafts',
        planningRequest('Read the payment record.', { environmentId: 'development' }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'validated' });
      expect(repairCount).toBe(1);
    } finally {
      await pool.query(
        `DELETE FROM capability_host_policies
         WHERE organization_id = $1 AND capability_identity_id = (
           SELECT capability_identity_id FROM capability_versions
           WHERE organization_id = $1 AND capability_version_id = $2
         ) AND environment_id = 'development'`,
        ['org_atlas', getPaymentCapabilityVersionId],
      );
    }
  });

  it('rejects the recorded fingerprint-mismatch proposal before repair', async () => {
    let repairCount = 0;
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: '0'.repeat(64),
          draft: await validPlanningDraft(),
        };
      },
      async repairWorkflow() {
        repairCount += 1;
        throw new Error('A binding mismatch must stop generation');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      status: 'manual_review',
      reason: 'capability-drift',
    });
    expect(repairCount).toBe(0);
  });

  it('overrides model mapping mistakes with deterministic mappings', async () => {
    async function proposal(attempt: number) {
      const draft = await validPlanningDraft();
      return {
        ...draft,
        executable: {
          ...draft.executable,
          steps: draft.executable.steps.map((step) => {
            if (step.kind === 'terminal') return step;
            if (attempt === 0) {
              return {
                ...step,
                arguments: { paymentId: { source: 'literal' as const, value: 42 } },
              };
            }
            if (attempt === 1) return { ...step, arguments: {} };
            return step;
          }),
        },
      };
    }
    const seenDiagnostics: string[][] = [];
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await proposal(0),
        };
      },
      async repairWorkflow({ attempt, intentFingerprint, projection, validation }) {
        seenDiagnostics.push(validation.diagnostics.map(({ code }) => code));
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await proposal(attempt),
        };
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'validated' });
    expect(seenDiagnostics).toHaveLength(0);
  });

  it('persists requested mapping origin on the validated planning draft', async () => {
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await validPlanningDraft(),
        };
      },
      async repairWorkflow() {
        throw new Error('A valid draft should not need repair');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );
    const body = (await response.json()) as {
      status: string;
      draft: {
        mappingOrigins?: Array<{
          stepId: string;
          destinationPath: string[];
          origin: string;
        }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe('validated');
    expect(body.draft.mappingOrigins).toEqual([
      {
        stepId: 'get-payment',
        destinationPath: ['paymentId'],
        origin: 'requested',
      },
    ]);
  });

  it('overrides an invalid model source path without spending repair attempts', async () => {
    const repairBindings: Array<{
      attempt: number;
      intentFingerprint: string;
      projectionFingerprint: string;
    }> = [];
    const invalidDraft = async () => {
      const draft = await validPlanningDraft();
      return {
        ...draft,
        executable: {
          ...draft.executable,
          steps: draft.executable.steps.map((step) =>
            step.kind === 'terminal'
              ? step
              : {
                  ...step,
                  arguments: {
                    paymentId: { source: 'input' as const, path: ['missingPaymentId'] },
                  },
                },
          ),
        },
      };
    };
    const model: PlannerModel = {
      async extractIntent() {
        return intentFrame;
      },
      async draftWorkflow({ intentFingerprint, projection }) {
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await invalidDraft(),
        };
      },
      async repairWorkflow({ attempt, intentFingerprint, projection }) {
        repairBindings.push({
          attempt,
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
        });
        return {
          kind: 'workflowDraft',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          draft: await invalidDraft(),
        };
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'validated' });
    expect(repairBindings).toHaveLength(0);
  });

  it('returns a specific question when the planner cannot produce a grounded valid draft', async () => {
    let planningAttempts = 0;
    const model: PlannerModel = {
      async extractIntent() {
        return {
          ...intentFrame,
          ambiguities: [
            {
              slot: 'paymentState',
              question: 'Which payment state should start the workflow?',
              suggestedAnswers: ['Succeeded', 'Authorized', 'Captured'],
            },
          ],
        };
      },
      async draftWorkflow({ intent, intentFingerprint, projection }) {
        planningAttempts += 1;
        const ambiguity = intent.ambiguities[0]!;
        return {
          kind: 'clarification',
          intentFingerprint,
          projectionFingerprint: projection.fingerprint,
          question: ambiguity.question,
          suggestedAnswers: ambiguity.suggestedAnswers,
        };
      },
      async repairWorkflow() {
        throw new Error('Incomplete intent must not be repaired');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest('Settle a payment somehow.'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'clarification_required',
      question: 'Which payment state should start the workflow?',
    });
    expect(planningAttempts).toBe(2);
  });

  it('fails closed with the extracted reason for an unsupported request', async () => {
    const model: PlannerModel = {
      async extractIntent() {
        return {
          ...intentFrame,
          supported: false,
          unsupportedReason: 'No authorized capability can delete a bank account',
        };
      },
      async draftWorkflow() {
        throw new Error('Unsupported intent must not be drafted');
      },
      async repairWorkflow() {
        throw new Error('Unsupported intent must not be repaired');
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest('Delete the customer bank account.'),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      status: 'unsupported',
      reason: 'No authorized capability can delete a bank account',
    });
  });

  it('repairs from sandbox contract failures instead of drafting a new workflow', async () => {
    const previousDraft = await validPlanningDraft();
    let drafted = 0;
    let extractedRevisionContext: unknown;
    let repairInput: Parameters<PlannerModel['repairWorkflow']>[0] | undefined;
    const model: PlannerModel = {
      async extractIntent(input) {
        extractedRevisionContext = input.revisionContext;
        return intentFrame;
      },
      async draftWorkflow() {
        drafted += 1;
        throw new Error('Sandbox contract repair must not draft from scratch');
      },
      async repairWorkflow(input) {
        repairInput = input;
        return {
          kind: 'workflowDraft',
          intentFingerprint: input.intentFingerprint,
          projectionFingerprint: input.projection.fingerprint,
          draft: previousDraft,
        };
      },
    };

    const response = await createApp(pool, { allowedHosts: [] }, model, planningAuthorizer).request(
      '/v1/workflow-drafts',
      planningRequest('When a payment succeeds, read its payment record.', {
        revisionContext: {
          previousRequest: 'When a payment succeeds, read its payment record.',
          draft: previousDraft,
        },
        sandboxRepair: {
          tests: [
            {
              status: 'failed',
              kind: 'contract-mapping',
              stepId: 'get-payment',
              capabilityVersionId: getPaymentCapabilityVersionId,
              detail:
                'The real Temporal execution produced an incompatible provider request or response.',
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(drafted).toBe(0);
    expect(extractedRevisionContext).toBeUndefined();
    expect(repairInput?.previousDraft).toMatchObject({
      executable: {
        steps: expect.arrayContaining([expect.objectContaining({ id: 'get-payment' })]),
      },
    });
    expect(repairInput?.validation.diagnostics).toEqual([
      expect.objectContaining({
        kind: 'compileError',
        code: 'PROVIDER_CONTRACT_MISMATCH',
        path: 'steps.get-payment',
        message: expect.stringMatching(/required provider field/i),
      }),
    ]);
    expect(JSON.stringify(repairInput?.validation.diagnostics)).not.toContain('irHash');
    expect(JSON.stringify(repairInput?.validation.diagnostics)).not.toContain('fingerprint');
  });
});
