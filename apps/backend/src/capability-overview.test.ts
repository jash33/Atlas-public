import {
  createCompiledWorkflowVersion,
  createTransformationCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { ingestCapabilities } from './capability-ingestion.js';
import { readCapabilityOverview } from './capability-overview.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import { saveWorkflowCatalogVersion } from './workflow-catalog.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `capability_overview_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });

const repository = 'https://github.com/example/burger-town';
let createOrderVersionId: string;
let cancelOrderVersionId: string;
let cancelOrderIdentityId: string;
let takePaymentVersionId: string;
let checkKitchenVersionId: string;
let changedVersionSequence = 0;

async function createChangedCapabilityVersion(
  fromCapabilityVersionId: string,
  capabilityFragment: unknown,
) {
  changedVersionSequence += 1;
  const capabilityVersionId = changedVersionSequence.toString(16).padStart(64, 'f');
  await pool.query(
    `INSERT INTO capability_versions
       (organization_id, capability_version_id, capability_identity_id, source_document_id,
        manifest_annotation_id, capability_fragment_hash, capability_fragment)
     SELECT organization_id, $2, capability_identity_id, source_document_id,
       manifest_annotation_id, $2, $3
     FROM capability_versions
     WHERE organization_id = 'org_atlas' AND capability_version_id = $1`,
    [fromCapabilityVersionId, capabilityVersionId, JSON.stringify(capabilityFragment)],
  );
  return capabilityVersionId;
}

async function recordDiscoveryChange(input: {
  fromCapabilityVersionId: string;
  toCapabilityVersionId?: string | null;
  classification?: 'compatible' | 'breaking';
  changeKind?: 'version-change' | 'removal';
  fieldChanges?: unknown[];
  affectedWorkflows: Array<{ workflowVersionId: string; stepId: string }>;
  trigger?: 'repository-push' | 'run-drift';
}) {
  const discovery = await pool.query<{ id: string }>(
    `INSERT INTO capability_discoveries
       (organization_id, service_id, environment_id, trigger)
     VALUES ('org_atlas', 'kitchen', 'production', $1)
     RETURNING id`,
    [input.trigger ?? 'repository-push'],
  );
  await pool.query(
    `INSERT INTO capability_discovery_changes
       (discovery_id, organization_id, from_capability_version_id,
        to_capability_version_id, classification, change_kind, field_changes,
        affected_workflows)
     VALUES ($1, 'org_atlas', $2, $3, $4, $5, $6, $7)`,
    [
      discovery.rows[0]!.id,
      input.fromCapabilityVersionId,
      input.toCapabilityVersionId ?? null,
      input.classification ?? 'breaking',
      input.changeKind ?? 'version-change',
      JSON.stringify(input.fieldChanges ?? []),
      JSON.stringify(input.affectedWorkflows),
    ],
  );
  return discovery.rows[0]!.id;
}

async function ingestService(
  organizationId: string,
  environmentId: string,
  serviceId: string,
  operations: readonly string[],
) {
  return ingestCapabilities(
    pool,
    {
      organizationId,
      serviceId,
      source: {
        format: 'openapi',
        document: {
          openapi: '3.1.0',
          info: { title: serviceId, version: '1.0.0' },
          paths: Object.fromEntries(
            operations.map((operationId) => [
              `/${operationId}`,
              {
                post: {
                  operationId,
                  requestBody: {
                    content: {
                      'application/json': { schema: { type: 'object', properties: {} } },
                    },
                  },
                  responses: {
                    '200': {
                      description: 'Success',
                      content: {
                        'application/json': {
                          schema: {
                            type: 'object',
                            properties: { id: { type: 'string' } },
                            required: ['id'],
                          },
                        },
                      },
                    },
                  },
                },
              },
            ]),
          ),
        },
        repository,
        commit: `${serviceId}-commit`,
        path: `${serviceId}.openapi.json`,
      },
      manifest: {
        source: {
          repository,
          commit: `${serviceId}-commit`,
          path: `${serviceId}.atlas.json`,
        },
        annotations: operations.map((operationId) => ({
          capability: { operationId },
          owner: `${serviceId}-team`,
          secretAlias: null,
          businessSemantics: {},
          idempotencyField: null,
          compensatedBy: null,
          irreversibleAfter: false,
        })),
      },
    },
    environmentId,
  );
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 215 });
  await pool.query('TRUNCATE organizations RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO organizations (id) VALUES ('org_atlas'), ('org_other');
     INSERT INTO environments (organization_id, id, name, kind) VALUES
       ('org_atlas', 'production', 'Production', 'production'),
       ('org_atlas', 'development', 'Development', 'development'),
       ('org_other', 'production', 'Production', 'production')`,
  );

  const kitchen = await ingestService('org_atlas', 'production', 'kitchen', [
    'createOrder',
    'cancelOrder',
    'checkKitchen',
  ]);
  const payments = await ingestService('org_atlas', 'production', 'payments', ['takePayment']);
  await ingestService('org_atlas', 'development', 'development-only', ['testOrder']);
  await ingestService('org_other', 'production', 'foreign', ['foreignOrder']);

  const createOrder = kitchen.capabilities.find(
    (capability) => capability.identity.operationId === 'createOrder',
  )!;
  const cancelOrder = kitchen.capabilities.find(
    (capability) => capability.identity.operationId === 'cancelOrder',
  )!;
  const checkKitchen = kitchen.capabilities.find(
    (capability) => capability.identity.operationId === 'checkKitchen',
  )!;
  const takePayment = payments.capabilities[0]!;
  createOrderVersionId = createOrder.capabilityVersionId;
  cancelOrderVersionId = cancelOrder.capabilityVersionId;
  takePaymentVersionId = takePayment.capabilityVersionId;
  checkKitchenVersionId = checkKitchen.capabilityVersionId;
  cancelOrderIdentityId = (
    await pool.query<{ id: string }>(
      `SELECT capability_identity_id::text AS id FROM capability_versions
       WHERE organization_id = 'org_atlas' AND capability_version_id = $1`,
      [cancelOrderVersionId],
    )
  ).rows[0]!.id;
  const workflow = await createCompiledWorkflowVersion('checkout-v1', 'org_atlas', {
    irVersion: 1,
    inputSchema: { required: {} },
    steps: [
      {
        id: 'create-order',
        kind: 'capabilityCall',
        capabilityVersionId: createOrder.capabilityVersionId,
        arguments: {},
        result: 'order',
      },
      {
        id: 'take-payment',
        kind: 'capabilityCall',
        capabilityVersionId: takePayment.capabilityVersionId,
        arguments: {
          orderId: { source: 'stepOutput', stepId: 'create-order', path: ['id'] },
        },
      },
      {
        id: 'cancel-order',
        kind: 'compensation',
        capabilityVersionId: cancelOrder.capabilityVersionId,
        compensatesStepId: 'create-order',
        arguments: {},
      },
      { id: 'done', kind: 'terminal', state: 'completed' },
    ],
  });
  await saveWorkflowCatalogVersion(pool, {
    organizationId: 'org_atlas',
    environmentId: 'production',
    workflowId: 'checkout',
    name: 'Checkout',
    status: 'active',
    draft: workflow,
  });

  const draft = await createCompiledWorkflowVersion('draft-v1', 'org_atlas', {
    irVersion: 1,
    inputSchema: { required: {} },
    steps: [
      {
        id: 'draft-call',
        kind: 'capabilityCall',
        capabilityVersionId: takePayment.capabilityVersionId,
        arguments: {},
      },
      { id: 'done', kind: 'terminal', state: 'completed' },
    ],
  });
  await saveWorkflowCatalogVersion(pool, {
    organizationId: 'org_atlas',
    environmentId: 'production',
    workflowId: 'draft-workflow',
    name: 'Draft workflow',
    status: 'draft',
    draft,
  });

  const preparedPayment = await createCompiledWorkflowVersion('prepared-payment-v1', 'org_atlas', {
    irVersion: 1,
    inputSchema: { required: { extraLettuce: { type: 'boolean' } } },
    steps: [
      {
        id: 'take-prepared-payment',
        kind: 'capabilityCall',
        capabilityVersionId: takePayment.capabilityVersionId,
        arguments: { extraLettuce: { source: 'input', path: ['extraLettuce'] } },
      },
      { id: 'done', kind: 'terminal', state: 'completed' },
    ],
  });
  await saveWorkflowCatalogVersion(pool, {
    organizationId: 'org_atlas',
    environmentId: 'production',
    workflowId: 'prepared-payment',
    name: 'Prepared payment',
    status: 'active',
    draft: preparedPayment,
  });

  const opaquePayment = await createCompiledWorkflowVersion('opaque-payment-v1', 'org_atlas', {
    irVersion: 1,
    inputSchema: { required: { order: { type: 'object', required: {} } } },
    steps: [
      {
        id: 'take-opaque-payment',
        kind: 'capabilityCall',
        capabilityVersionId: takePayment.capabilityVersionId,
        arguments: { order: { source: 'input', path: ['order'] } },
      },
      { id: 'done', kind: 'terminal', state: 'completed' },
    ],
  });
  await saveWorkflowCatalogVersion(pool, {
    organizationId: 'org_atlas',
    environmentId: 'production',
    workflowId: 'opaque-payment',
    name: 'Opaque payment',
    status: 'active',
    draft: opaquePayment,
  });
});

afterAll(async () => {
  await pool.end();
});

describe('capability overview', () => {
  it('shows every capability in one environment and only relationships backed by approved work', async () => {
    const first = await readCapabilityOverview(pool, 'org_atlas', 'production');
    const second = await readCapabilityOverview(pool, 'org_atlas', 'production');

    expect(first.status).toBe('ready');
    expect(first.nodes.map((node) => `${node.serviceId}.${node.operationId}`)).toEqual([
      'kitchen.cancelOrder',
      'kitchen.checkKitchen',
      'kitchen.createOrder',
      'payments.takePayment',
    ]);
    expect(first.services).toEqual([
      { serviceId: 'kitchen', capabilityIdentityIds: expect.any(Array) },
      { serviceId: 'payments', capabilityIdentityIds: expect.any(Array) },
    ]);
    expect(first.relationships.map((relationship) => relationship.kind)).toEqual([
      'compensation',
      'data-flow',
      'execution-order',
    ]);
    expect(
      first.relationships.every((relationship) => relationship.evidence.workflowId === 'checkout'),
    ).toBe(true);
    expect(
      first.relationships.every(
        (relationship) => relationship.evidence.workflowVersionId === 'checkout-v1',
      ),
    ).toBe(true);
    expect(
      first.relationships.every(
        (relationship) => relationship.evidence.workflowLifecycle === 'active',
      ),
    ).toBe(true);
    expect(
      first.relationships.every(
        (relationship) => relationship.evidence.sourceCapabilityVersionId.length === 64,
      ),
    ).toBe(true);
    expect(
      first.relationships.some(
        (relationship) => relationship.evidence.workflowId === 'draft-workflow',
      ),
    ).toBe(false);
    const checkKitchen = first.nodes.find((node) => node.operationId === 'checkKitchen')!;
    expect(checkKitchen.workflowLifecycles).toEqual([]);
    expect(
      first.nodes.find((node) => node.operationId === 'takePayment')?.workflowLifecycles,
    ).toEqual(['active']);
    expect(
      first.relationships.some(
        (relationship) =>
          relationship.sourceCapabilityIdentityId === checkKitchen.capabilityIdentityId ||
          relationship.targetCapabilityIdentityId === checkKitchen.capabilityIdentityId,
      ),
    ).toBe(false);
    expect(first.snapshotId).toBe(second.snapshotId);
    expect(first).toEqual(second);

    const development = await readCapabilityOverview(pool, 'org_atlas', 'development');
    expect(development.nodes.map((node) => node.serviceId)).toEqual(['development-only']);
    expect(development.relationships).toEqual([]);
    expect(development.snapshotId).not.toBe(first.snapshotId);

    const foreign = await readCapabilityOverview(pool, 'org_other', 'production');
    expect(foreign.nodes.map((node) => node.serviceId)).toEqual(['foreign']);
  });

  it('marks a capability used by a single-step workflow even though it has no relationship edge', async () => {
    const singleStep = await createCompiledWorkflowVersion('kitchen-check-v1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: {} },
      steps: [
        {
          id: 'check-kitchen',
          kind: 'capabilityCall',
          capabilityVersionId: checkKitchenVersionId,
          arguments: {},
        },
        { id: 'done', kind: 'terminal', state: 'completed' },
      ],
    });
    await saveWorkflowCatalogVersion(pool, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowId: 'kitchen-check',
      name: 'Kitchen check',
      status: 'active',
      draft: singleStep,
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production');
      const checkKitchen = overview.nodes.find((node) => node.operationId === 'checkKitchen')!;
      expect(checkKitchen.workflowLifecycles).toEqual(['active']);
      expect(
        overview.relationships.some(
          (relationship) =>
            relationship.sourceCapabilityIdentityId === checkKitchen.capabilityIdentityId ||
            relationship.targetCapabilityIdentityId === checkKitchen.capabilityIdentityId,
        ),
      ).toBe(false);
    } finally {
      await pool.query(
        `DELETE FROM workflow_identities
         WHERE organization_id = 'org_atlas' AND workflow_id = 'kitchen-check'`,
      );
    }
  });

  it('returns an honest empty result', async () => {
    const overview = await readCapabilityOverview(pool, 'org_atlas', 'empty-environment');

    expect(overview).toMatchObject({
      status: 'empty',
      nodes: [],
      relationships: [],
      services: [],
      notices: ['Atlas has not ingested any capabilities for this environment.'],
    });
  });

  it('does not mistake unavailable change history for a healthy empty map', async () => {
    const overview = await readCapabilityOverview(pool, 'org_atlas', 'empty-environment', {
      type: 'change',
      id: '999999999',
    });

    expect(overview).toMatchObject({
      status: 'partial',
      impact: { analysis: 'unavailable', affectedStepCount: 0 },
      notices: expect.arrayContaining([
        'Atlas could not find the selected contract change in this environment.',
      ]),
    });
  });

  it('reports when an approved workflow cannot be read without hiding known capabilities', async () => {
    await pool.query(
      `INSERT INTO workflow_identities (organization_id, workflow_id, name)
       VALUES ('org_atlas', 'unreadable', 'Unreadable workflow');
       INSERT INTO workflow_versions
         (organization_id, workflow_version_id, workflow_id, compiled_workflow)
       VALUES ('org_atlas', 'unreadable-v1', 'unreadable', '{"unexpected":true}'::jsonb);
       INSERT INTO workflow_environment_versions
         (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active)
       VALUES ('org_atlas', 'production', 'unreadable-v1', 'active', true)`,
    );
    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production');

      expect(overview.status).toBe('partial');
      expect(overview.nodes.length).toBeGreaterThan(0);
      expect(overview.notices).toEqual(['1 approved workflow could not be read.']);
    } finally {
      await pool.query(
        `DELETE FROM workflow_identities
         WHERE organization_id = 'org_atlas' AND workflow_id = 'unreadable'`,
      );
    }
  });

  it.each(['action-required', 'blocked', 'testing', 'draft', 'awaiting-approval'])(
    'keeps connections for a workflow that remains active with status %s',
    async (status) => {
      await pool.query(
        `UPDATE workflow_environment_versions
       SET lifecycle_status = $1
       WHERE organization_id = 'org_atlas' AND environment_id = 'production'
         AND workflow_version_id = 'checkout-v1'`,
        [status],
      );
      try {
        const overview = await readCapabilityOverview(pool, 'org_atlas', 'production');
        expect(overview.relationships).toHaveLength(3);
        expect(
          overview.relationships.every(
            (relationship) => relationship.evidence.workflowLifecycle === status,
          ),
        ).toBe(true);
      } finally {
        await pool.query(
          `UPDATE workflow_environment_versions
         SET lifecycle_status = 'active'
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
           AND workflow_version_id = 'checkout-v1'`,
        );
      }
    },
  );

  it('shows an operation removal and only the later calls in each affected workflow', async () => {
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: createOrderVersionId,
      changeKind: 'removal',
      affectedWorkflows: [{ workflowVersionId: 'checkout-v1', stepId: 'create-order' }],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });

      expect(overview.impact).toMatchObject({
        type: 'change',
        id: discoveryId,
        affectedWorkflowCount: 1,
        affectedStepCount: 2,
        sources: [
          expect.objectContaining({
            capabilityVersionId: createOrderVersionId,
            serviceId: 'kitchen',
            operationId: 'createOrder',
          }),
        ],
      });
      expect(
        overview.nodes
          .filter((node) => node.impact?.affected)
          .map((node) => `${node.serviceId}.${node.operationId}`),
      ).toEqual(['kitchen.createOrder', 'payments.takePayment']);
      expect(
        overview.nodes
          .find((node) => node.operationId === 'takePayment')
          ?.impact?.usages.map((usage) => `${usage.workflowVersionId}:${usage.stepId}`),
      ).toEqual(['checkout-v1:take-payment']);
      expect(
        overview.nodes.find((node) => node.operationId === 'cancelOrder')?.impact?.affected,
      ).not.toBe(true);
      expect(
        overview.nodes.find((node) => node.operationId === 'takePayment')?.impact?.usages[0],
      ).toMatchObject({
        capabilityVersionId: takePaymentVersionId,
        reason: expect.stringContaining('create-order'),
        evidence: {
          discoveryId,
          fromCapabilityVersionId: createOrderVersionId,
          sourceStepId: 'create-order',
        },
      });
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it('marks a call missing a new required request field without affecting a prepared use', async () => {
    const changedPaymentVersionId = await createChangedCapabilityVersion(takePaymentVersionId, {
      operation: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { extraLettuce: { type: 'boolean' } },
                required: ['extraLettuce'],
              },
            },
          },
        },
      },
    });
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: takePaymentVersionId,
      toCapabilityVersionId: changedPaymentVersionId,
      fieldChanges: [
        {
          kind: 'added-required',
          path: '/operation/requestBody/content/application~1json/schema/properties/extraLettuce',
          classification: 'breaking',
        },
      ],
      affectedWorkflows: [
        { workflowVersionId: 'checkout-v1', stepId: 'take-payment' },
        { workflowVersionId: 'prepared-payment-v1', stepId: 'take-prepared-payment' },
      ],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });
      const payment = overview.nodes.find((node) => node.operationId === 'takePayment');

      expect(overview.impact?.incompleteAnalysisCount).toBe(0);
      expect(payment?.impact).toMatchObject({
        affected: true,
        isSource: true,
        affectedWorkflowCount: 1,
        usages: [
          {
            workflowId: 'checkout',
            workflowName: 'Checkout',
            workflowVersionId: 'checkout-v1',
            workflowLifecycle: 'active',
            stepId: 'take-payment',
            capabilityVersionId: takePaymentVersionId,
            reason: 'This call does not provide the newly required extraLettuce field.',
            evidence: {
              discoveryId,
              fromCapabilityVersionId: takePaymentVersionId,
              fieldPath:
                '/operation/requestBody/content/application~1json/schema/properties/extraLettuce',
            },
          },
        ],
      });
      expect(payment?.impact?.usages).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workflowVersionId: 'prepared-payment-v1' }),
        ]),
      );
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it('marks only calls that use a removed response field', async () => {
    const changeKind = 'removed' as const;
    const changedOrderVersionId = await createChangedCapabilityVersion(createOrderVersionId, {
      operation: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {},
                },
              },
            },
          },
        },
      },
    });
    const fieldPath = '/operation/responses/200/content/application~1json/schema/properties/id';
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: createOrderVersionId,
      toCapabilityVersionId: changedOrderVersionId,
      fieldChanges: [{ kind: changeKind, path: fieldPath, classification: 'breaking' }],
      affectedWorkflows: [{ workflowVersionId: 'checkout-v1', stepId: 'create-order' }],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });

      expect(
        overview.nodes
          .filter((node) => node.impact?.affected)
          .map((node) => `${node.serviceId}.${node.operationId}`),
      ).toEqual(['payments.takePayment']);
      expect(
        overview.nodes.find((node) => node.operationId === 'createOrder')?.impact,
      ).toMatchObject({ affected: false, isSource: true });
      expect(
        overview.nodes.find((node) => node.operationId === 'takePayment')?.impact?.usages,
      ).toEqual([
        expect.objectContaining({
          workflowVersionId: 'checkout-v1',
          stepId: 'take-payment',
          reason: expect.stringContaining('uses id from create-order'),
          evidence: expect.objectContaining({ fieldPath, sourceStepId: 'create-order' }),
        }),
      ]);
      expect(
        overview.nodes.find((node) => node.operationId === 'takePayment')?.impact?.usages[0]
          ?.reason,
      ).toContain('no longer available');
      expect(
        overview.nodes.find((node) => node.operationId === 'cancelOrder')?.impact?.affected,
      ).not.toBe(true);
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it('leaves a retyped response outside red when the receiving type is unknown', async () => {
    const changedOrderVersionId = await createChangedCapabilityVersion(createOrderVersionId, {
      operation: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'number' } },
                },
              },
            },
          },
        },
      },
    });
    const fieldPath = '/operation/responses/200/content/application~1json/schema/properties/id';
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: createOrderVersionId,
      toCapabilityVersionId: changedOrderVersionId,
      fieldChanges: [{ kind: 'retyped', path: fieldPath, classification: 'breaking' }],
      affectedWorkflows: [{ workflowVersionId: 'checkout-v1', stepId: 'create-order' }],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });

      expect(overview.nodes.some((node) => node.impact?.affected)).toBe(false);
      expect(overview).toMatchObject({
        status: 'partial',
        impact: { affectedStepCount: 0, incompleteAnalysisCount: 1 },
        notices: [expect.stringContaining('Unresolved evidence is not shown as broken')],
      });
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it('marks a retyped response when the receiving step requires the old type', async () => {
    const typedWorkflow = await createTransformationCompiledWorkflowVersion(
      'typed-checkout-v1',
      'org_atlas',
      {
        irVersion: 2,
        inputSchema: { required: {} },
        steps: [
          {
            id: 'create-order',
            kind: 'capabilityCall',
            capabilityVersionId: createOrderVersionId,
            arguments: {},
            inputSchema: { required: {} },
            result: 'order',
          },
          {
            id: 'take-payment',
            kind: 'capabilityCall',
            capabilityVersionId: takePaymentVersionId,
            arguments: {
              orderId: { source: 'stepOutput', stepId: 'create-order', path: ['id'] },
            },
            inputSchema: { required: { orderId: { type: 'string' } } },
          },
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      },
    );
    await saveWorkflowCatalogVersion(pool, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowId: 'typed-checkout',
      name: 'Typed checkout',
      status: 'active',
      draft: typedWorkflow,
    });
    const changedOrderVersionId = await createChangedCapabilityVersion(createOrderVersionId, {
      operation: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { id: { type: 'number' } },
                },
              },
            },
          },
        },
      },
    });
    const fieldPath = '/operation/responses/200/content/application~1json/schema/properties/id';
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: createOrderVersionId,
      toCapabilityVersionId: changedOrderVersionId,
      fieldChanges: [{ kind: 'retyped', path: fieldPath, classification: 'breaking' }],
      affectedWorkflows: [{ workflowVersionId: 'typed-checkout-v1', stepId: 'create-order' }],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });
      const payment = overview.nodes.find((node) => node.operationId === 'takePayment');

      expect(overview.impact).toMatchObject({
        affectedWorkflowCount: 1,
        affectedStepCount: 1,
        incompleteAnalysisCount: 0,
      });
      expect(payment?.impact?.usages).toEqual([
        expect.objectContaining({
          workflowVersionId: 'typed-checkout-v1',
          stepId: 'take-payment',
          reason: expect.stringContaining('changed type'),
          evidence: expect.objectContaining({ fieldPath }),
        }),
      ]);
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
      await pool.query(
        `DELETE FROM workflow_identities
         WHERE organization_id = 'org_atlas' AND workflow_id = 'typed-checkout'`,
      );
    }
  });

  it.each([
    {
      kind: 'idempotency-changed',
      previousValue: 'idempotencyKey',
      nextValue: null,
      reason: 'doing the same write twice',
    },
    {
      kind: 'irreversibility-changed',
      previousValue: false,
      nextValue: true,
      reason: 'safely undone or repeated',
    },
    {
      kind: 'compensation-changed',
      previousValue: 'cancel-payment',
      nextValue: null,
      reason: 'recovery call',
    },
  ] as const)(
    'marks the steps that rely on a $kind safety promise without spreading through conditional paths',
    async ({ kind, previousValue, nextValue, reason }) => {
      const safetyWorkflow = await createCompiledWorkflowVersion('safe-recovery-v1', 'org_atlas', {
        irVersion: 1,
        inputSchema: { required: { orderId: { type: 'string' } } },
        steps: [
          {
            id: 'check-kitchen',
            kind: 'capabilityCall',
            capabilityVersionId: checkKitchenVersionId,
            arguments: {},
          },
          {
            id: 'take-payment',
            kind: 'capabilityCall',
            capabilityVersionId: takePaymentVersionId,
            arguments: {
              orderId: { source: 'input', path: ['orderId'] },
              idempotencyKey: { source: 'input', path: ['orderId'] },
            },
            retryPolicy: {
              initialInterval: '1 second',
              backoffCoefficient: 2,
              maximumInterval: '10 seconds',
              maximumAttempts: 3,
              nonRetryableErrorTypes: ['ContractRejected'],
            },
            idempotency: { businessKey: { source: 'input', path: ['orderId'] } },
            errorRouting: {
              rules: [
                {
                  errorTypes: ['ContractRejected'],
                  action: {
                    kind: 'revalidateFrom',
                    targetStepId: 'check-kitchen',
                    maxRevalidations: 1,
                    onExhausted: {
                      kind: 'compensateThenLand',
                      outcome: 'repair_required',
                      reasonCode: 'payment-contract-rejected',
                    },
                  },
                },
              ],
              defaultAction: {
                kind: 'preserveAndLand',
                outcome: 'repair_required',
                reasonCode: 'payment-failed',
              },
            },
          },
          {
            id: 'cancel-kitchen-order',
            kind: 'compensation',
            capabilityVersionId: cancelOrderVersionId,
            compensatesStepId: 'take-payment',
            arguments: {},
          },
          {
            id: 'create-receipt',
            kind: 'capabilityCall',
            capabilityVersionId: createOrderVersionId,
            arguments: {},
          },
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      });
      await saveWorkflowCatalogVersion(pool, {
        organizationId: 'org_atlas',
        environmentId: 'production',
        workflowId: 'safe-recovery',
        name: 'Safe recovery',
        status: 'active',
        draft: safetyWorkflow,
      });
      const changedPaymentVersionId = await createChangedCapabilityVersion(takePaymentVersionId, {
        operation: { responses: { '200': { description: 'Success' } } },
      });
      const discoveryId = await recordDiscoveryChange({
        fromCapabilityVersionId: takePaymentVersionId,
        toCapabilityVersionId: changedPaymentVersionId,
        fieldChanges: [
          {
            kind,
            classification: 'breaking',
            previousValue: kind === 'compensation-changed' ? cancelOrderIdentityId : previousValue,
            nextValue,
          },
        ],
        affectedWorkflows: [{ workflowVersionId: 'safe-recovery-v1', stepId: 'take-payment' }],
      });
      await pool.query(
        `INSERT INTO workflow_quarantines
         (organization_id, environment_id, workflow_version_id,
          from_capability_version_id, to_capability_version_id)
       VALUES ('org_atlas', 'production', 'safe-recovery-v1', $1, $2)`,
        [takePaymentVersionId, changedPaymentVersionId],
      );

      try {
        const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
          type: 'change',
          id: discoveryId,
        });
        const affectedUsages = overview.nodes.flatMap((node) => node.impact?.usages ?? []);

        expect(affectedUsages.map((usage) => usage.stepId).sort()).toEqual([
          'create-receipt',
          'take-payment',
        ]);
        expect(affectedUsages).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ stepId: 'check-kitchen' }),
            expect.objectContaining({ stepId: 'cancel-kitchen-order' }),
          ]),
        );
        expect(affectedUsages.find((usage) => usage.stepId === 'take-payment')?.reason).toContain(
          reason,
        );
        const affectedRelationships = overview.relationships
          .filter((relationship) => relationship.impact?.affected)
          .map((relationship) => ({
            kind: relationship.kind,
            workflowVersionId: relationship.evidence.workflowVersionId,
            sourceStepId: relationship.evidence.sourceStepId,
            targetStepId: relationship.evidence.targetStepId,
          }));
        expect(affectedRelationships).toContainEqual(
          expect.objectContaining({
            workflowVersionId: 'safe-recovery-v1',
            sourceStepId: 'take-payment',
            targetStepId: 'create-receipt',
          }),
        );
        expect(
          affectedRelationships.some((relationship) => relationship.kind === 'compensation'),
        ).toBe(kind === 'compensation-changed');
        await pool.query(
          `UPDATE workflow_quarantines SET lifted_at = current_timestamp
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
           AND workflow_version_id = 'safe-recovery-v1'`,
        );
        const afterUnblock = await readCapabilityOverview(pool, 'org_atlas', 'production', {
          type: 'change',
          id: discoveryId,
        });
        expect(
          afterUnblock.nodes
            .flatMap((node) => node.impact?.usages ?? [])
            .map((usage) => usage.stepId),
        ).toEqual(expect.arrayContaining(['take-payment', 'create-receipt']));
      } finally {
        await pool.query(
          `DELETE FROM workflow_quarantines
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
           AND workflow_version_id = 'safe-recovery-v1'`,
        );
        await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
        await pool.query(
          `DELETE FROM workflow_identities
         WHERE organization_id = 'org_atlas' AND workflow_id = 'safe-recovery'`,
        );
      }
    },
  );

  it.each([
    {
      kind: 'idempotency-changed',
      previousValue: 'idempotencyKey',
      nextValue: null,
    },
    {
      kind: 'irreversibility-changed',
      previousValue: false,
      nextValue: true,
    },
    {
      kind: 'compensation-changed',
      previousValue: 'matching-compensator',
      nextValue: null,
    },
  ] as const)(
    'leaves a $kind promise outside red when this workflow does not rely on it',
    async ({ kind, previousValue, nextValue }) => {
      const preserveWorkflow = await createCompiledWorkflowVersion(
        'preserve-recovery-v1',
        'org_atlas',
        {
          irVersion: 1,
          inputSchema: { required: { orderId: { type: 'string' } } },
          steps: [
            {
              id: 'take-payment',
              kind: 'capabilityCall',
              capabilityVersionId: takePaymentVersionId,
              arguments: {
                orderId: { source: 'input', path: ['orderId'] },
                idempotencyKey: { source: 'input', path: ['orderId'] },
              },
              idempotency: { businessKey: { source: 'input', path: ['orderId'] } },
            },
            {
              id: 'cancel-payment',
              kind: 'compensation',
              capabilityVersionId: cancelOrderVersionId,
              compensatesStepId: 'take-payment',
              arguments: {},
            },
            {
              id: 'create-receipt',
              kind: 'capabilityCall',
              capabilityVersionId: createOrderVersionId,
              arguments: {},
              errorRouting: {
                rules: [],
                defaultAction: {
                  kind: 'preserveAndLand',
                  outcome: 'repair_required',
                  reasonCode: 'preserve-payment',
                },
              },
            },
            { id: 'done', kind: 'terminal', state: 'completed' },
          ],
        },
      );
      await saveWorkflowCatalogVersion(pool, {
        organizationId: 'org_atlas',
        environmentId: 'production',
        workflowId: 'preserve-recovery',
        name: 'Preserve recovery',
        status: 'active',
        draft: preserveWorkflow,
      });
      const changedPaymentVersionId = await createChangedCapabilityVersion(takePaymentVersionId, {
        operation: { responses: { '200': { description: 'Success' } } },
      });
      const discoveryId = await recordDiscoveryChange({
        fromCapabilityVersionId: takePaymentVersionId,
        toCapabilityVersionId: changedPaymentVersionId,
        fieldChanges: [
          {
            kind,
            classification: 'breaking',
            previousValue: kind === 'compensation-changed' ? cancelOrderIdentityId : previousValue,
            nextValue,
          },
        ],
        affectedWorkflows: [{ workflowVersionId: 'preserve-recovery-v1', stepId: 'take-payment' }],
      });

      try {
        const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
          type: 'change',
          id: discoveryId,
        });

        expect(overview.impact).toMatchObject({
          affectedWorkflowCount: 0,
          affectedStepCount: 0,
          incompleteAnalysisCount: 0,
        });
        expect(overview.nodes.some((node) => node.impact?.affected)).toBe(false);
      } finally {
        await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
        await pool.query(
          `DELETE FROM workflow_identities
           WHERE organization_id = 'org_atlas' AND workflow_id = 'preserve-recovery'`,
        );
      }
    },
  );

  it.each([
    {
      kind: 'irreversibility-changed',
      previousValue: false,
      nextValue: true,
    },
    {
      kind: 'compensation-changed',
      previousValue: 'matching-compensator',
      nextValue: null,
    },
  ] as const)(
    'leaves a $kind promise outside red when compensation is disabled before it can run',
    async ({ kind, previousValue, nextValue }) => {
      const disabledCompensationWorkflow = await createCompiledWorkflowVersion(
        'disabled-compensation-v1',
        'org_atlas',
        {
          irVersion: 1,
          inputSchema: { required: { orderId: { type: 'string' } } },
          steps: [
            {
              id: 'take-payment',
              kind: 'capabilityCall',
              capabilityVersionId: takePaymentVersionId,
              arguments: { orderId: { source: 'input', path: ['orderId'] } },
            },
            {
              id: 'cancel-payment',
              kind: 'compensation',
              capabilityVersionId: cancelOrderVersionId,
              compensatesStepId: 'take-payment',
              arguments: {},
            },
            {
              id: 'serve-order',
              kind: 'capabilityCall',
              capabilityVersionId: createOrderVersionId,
              arguments: {},
              irreversibleAfter: true,
              errorRouting: {
                rules: [],
                defaultAction: {
                  kind: 'preserveAndLand',
                  outcome: 'repair_required',
                  reasonCode: 'order-was-not-served',
                },
              },
            },
            {
              id: 'send-receipt',
              kind: 'capabilityCall',
              capabilityVersionId: createOrderVersionId,
              arguments: {},
              errorRouting: {
                rules: [],
                defaultAction: {
                  kind: 'compensateThenLand',
                  outcome: 'repair_required',
                  reasonCode: 'payment-needs-repair',
                },
              },
            },
            { id: 'done', kind: 'terminal', state: 'completed' },
          ],
        },
      );
      await saveWorkflowCatalogVersion(pool, {
        organizationId: 'org_atlas',
        environmentId: 'production',
        workflowId: 'disabled-compensation',
        name: 'Disabled compensation',
        status: 'active',
        draft: disabledCompensationWorkflow,
      });
      const changedPaymentVersionId = await createChangedCapabilityVersion(takePaymentVersionId, {
        operation: { responses: { '200': { description: 'Success' } } },
      });
      const discoveryId = await recordDiscoveryChange({
        fromCapabilityVersionId: takePaymentVersionId,
        toCapabilityVersionId: changedPaymentVersionId,
        fieldChanges: [
          {
            kind,
            classification: 'breaking',
            previousValue: kind === 'compensation-changed' ? cancelOrderIdentityId : previousValue,
            nextValue,
          },
        ],
        affectedWorkflows: [
          { workflowVersionId: 'disabled-compensation-v1', stepId: 'take-payment' },
        ],
      });

      try {
        const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
          type: 'change',
          id: discoveryId,
        });

        expect(overview.impact).toMatchObject({
          affectedWorkflowCount: 0,
          affectedStepCount: 0,
          incompleteAnalysisCount: 0,
        });
        expect(overview.nodes.some((node) => node.impact?.affected)).toBe(false);
      } finally {
        await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
        await pool.query(
          `DELETE FROM workflow_identities
           WHERE organization_id = 'org_atlas' AND workflow_id = 'disabled-compensation'`,
        );
      }
    },
  );

  it('adds blocked-start and failed-run evidence without changing the red set', async () => {
    const changedOrderVersionId = await createChangedCapabilityVersion(createOrderVersionId, {
      operation: {
        responses: {
          '200': {
            content: {
              'application/json': {
                schema: { type: 'object', properties: {} },
              },
            },
          },
        },
      },
    });
    const fieldPath = '/operation/responses/200/content/application~1json/schema/properties/id';
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: createOrderVersionId,
      toCapabilityVersionId: changedOrderVersionId,
      fieldChanges: [{ kind: 'removed', path: fieldPath, classification: 'breaking' }],
      affectedWorkflows: [{ workflowVersionId: 'checkout-v1', stepId: 'create-order' }],
      trigger: 'run-drift',
    });
    const quarantine = await pool.query<{ id: string }>(
      `INSERT INTO workflow_quarantines
         (organization_id, environment_id, workflow_version_id,
          from_capability_version_id, to_capability_version_id)
       VALUES ('org_atlas', 'production', 'checkout-v1', $1, $2)
       RETURNING id::text`,
      [createOrderVersionId, changedOrderVersionId],
    );
    await pool.query(
      `INSERT INTO workflow_runs
         (organization_id, environment_id, run_id, workflow_version_id, intake_key, state,
          failure_bucket, failure_type, failed_step_id, started_at, updated_at)
       VALUES
         ('org_atlas', 'production', 'run-contract-failed', 'checkout-v1',
          'contract-failed', 'repair_required', 'permanent-validation', 'MissingOrderId',
          'take-payment', current_timestamp, current_timestamp),
         ('org_atlas', 'production', 'run-before-change', 'checkout-v1',
          'before-change', 'repair_required', 'permanent-validation', 'OldFailure',
          'take-payment', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z')`,
    );
    await pool.query(
      `INSERT INTO workflow_run_step_attempts
         (organization_id, environment_id, run_id, step_id, capability_version_id,
          attempt, duration_ms, status, redacted_input, failure_type, recorded_at)
       VALUES
         ('org_atlas', 'production', 'run-contract-failed', 'take-payment', $1,
          1, 20, 'failed', '{}'::jsonb, 'MissingOrderId', current_timestamp),
         ('org_atlas', 'production', 'run-before-change', 'take-payment', $1,
          1, 20, 'failed', '{}'::jsonb, 'OldFailure', '2020-01-01T00:00:00Z')`,
      [takePaymentVersionId],
    );
    await pool.query(
      `INSERT INTO capability_rediscovery_requests
         (organization_id, environment_id, capability_version_id, step_id, discovery_id)
       VALUES ('org_atlas', 'production', $1, 'take-payment', $2)`,
      [takePaymentVersionId, discoveryId],
    );

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });
      const payment = overview.nodes.find((node) => node.operationId === 'takePayment');

      expect(overview.impact).toMatchObject({ affectedStepCount: 1 });
      expect(payment?.impact?.usages).toEqual([
        expect.objectContaining({
          stepId: 'take-payment',
          reason: expect.stringContaining('uses id from create-order'),
          currentState: {
            isActive: true,
            quarantine: 'active',
            blockedWorkflowStart: {
              id: quarantine.rows[0]!.id,
              toCapabilityVersionId: changedOrderVersionId,
              blockedAt: expect.any(String),
            },
            latestFailedRun: {
              runId: 'run-contract-failed',
              failureType: 'MissingOrderId',
              failedAt: expect.any(String),
            },
          },
          evidence: expect.not.objectContaining({
            blockedWorkflowStart: expect.anything(),
            failedRun: expect.anything(),
          }),
        }),
      ]);
      expect(payment?.impact?.usages[0]?.reason).not.toContain('OldFailure');
    } finally {
      await pool.query('DELETE FROM capability_rediscovery_requests WHERE discovery_id = $1', [
        discoveryId,
      ]);
      await pool.query(
        `DELETE FROM workflow_runs
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
           AND run_id IN ('run-contract-failed', 'run-before-change')`,
      );
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it('preserves the recorded impact while showing that the workflow was replaced', async () => {
    const changedOrderVersionId = await createChangedCapabilityVersion(createOrderVersionId, {
      operation: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { locationId: { type: 'string' } },
                required: ['locationId'],
              },
            },
          },
        },
      },
    });
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: createOrderVersionId,
      toCapabilityVersionId: changedOrderVersionId,
      fieldChanges: [
        {
          kind: 'added-required',
          path: '/operation/requestBody/content/application~1json/schema/properties/locationId',
          classification: 'breaking',
        },
      ],
      affectedWorkflows: [{ workflowVersionId: 'checkout-v1', stepId: 'create-order' }],
    });
    try {
      const before = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });
      const recordedBefore = before.nodes.flatMap((node) =>
        (node.impact?.usages ?? []).map(
          ({ currentState: _currentState, workflowLifecycle: _workflowLifecycle, ...usage }) =>
            usage,
        ),
      );

      await pool.query(
        `UPDATE workflow_environment_versions
         SET lifecycle_status = 'approved-inactive', is_active = false
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
           AND workflow_version_id = 'checkout-v1'`,
      );
      const inactive = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });
      const recordedWhileInactive = inactive.nodes.flatMap((node) =>
        (node.impact?.usages ?? []).map(
          ({ currentState: _currentState, workflowLifecycle: _workflowLifecycle, ...usage }) =>
            usage,
        ),
      );
      expect(recordedWhileInactive).toEqual(recordedBefore);
      expect(inactive.impact).toMatchObject({
        affectedWorkflowCount: 1,
        affectedStepCount: 2,
        currentlyExposedWorkflowCount: 0,
        currentlyExposedStepCount: 0,
      });
      expect(
        inactive.nodes
          .flatMap((node) => node.impact?.usages ?? [])
          .find((usage) => usage.workflowVersionId === 'checkout-v1'),
      ).toMatchObject({
        workflowLifecycle: 'approved-inactive',
        currentState: { isActive: false, quarantine: 'not-recorded' },
      });

      const quarantine = await pool.query<{ id: string }>(
        `INSERT INTO workflow_quarantines
           (organization_id, environment_id, workflow_version_id,
            from_capability_version_id, to_capability_version_id)
         VALUES ('org_atlas', 'production', 'checkout-v1', $1, $2)
         RETURNING id::text`,
        [createOrderVersionId, changedOrderVersionId],
      );

      const replacement = await createCompiledWorkflowVersion('checkout-v2', 'org_atlas', {
        irVersion: 1,
        inputSchema: { required: {} },
        steps: [
          {
            id: 'create-order',
            kind: 'capabilityCall',
            capabilityVersionId: createOrderVersionId,
            arguments: {},
          },
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      });
      await saveWorkflowCatalogVersion(pool, {
        organizationId: 'org_atlas',
        environmentId: 'production',
        workflowId: 'checkout',
        name: 'Checkout',
        status: 'active',
        draft: replacement,
      });
      const candidate = await pool.query<{ id: string }>(
        `INSERT INTO workflow_migration_candidates
           (organization_id, environment_id, source_workflow_version_id, workflow_version_id,
            from_capability_version_id, to_capability_version_id, author, draft, validation)
         VALUES ('org_atlas', 'production', 'checkout-v1', 'checkout-v2', $1, $2,
                 'compiler', '{}'::jsonb, '{}'::jsonb)
         RETURNING id::text`,
        [createOrderVersionId, changedOrderVersionId],
      );
      await pool.query(
        `INSERT INTO workflow_activations
           (organization_id, environment_id, migration_candidate_id,
            previous_workflow_version_id, current_workflow_version_id,
            previous_capability_version_id, current_capability_version_id, activated_by)
         VALUES ('org_atlas', 'production', $1, 'checkout-v1', 'checkout-v2', $2, $3, 'test')`,
        [candidate.rows[0]!.id, createOrderVersionId, changedOrderVersionId],
      );
      await pool.query(
        `UPDATE workflow_quarantines SET lifted_at = current_timestamp WHERE id = $1`,
        [quarantine.rows[0]!.id],
      );

      const after = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });
      const recordedAfter = after.nodes.flatMap((node) =>
        (node.impact?.usages ?? []).map(
          ({ currentState: _currentState, workflowLifecycle: _workflowLifecycle, ...usage }) =>
            usage,
        ),
      );
      const historicalUsage = after.nodes
        .flatMap((node) => node.impact?.usages ?? [])
        .find((usage) => usage.workflowVersionId === 'checkout-v1');

      expect(before.impact).toMatchObject({
        analysis: 'complete',
        affectedWorkflowCount: 1,
        affectedStepCount: 2,
        currentlyExposedWorkflowCount: 1,
        currentlyExposedStepCount: 2,
        recordedAt: expect.any(String),
      });
      expect(after.impact).toMatchObject({
        analysis: 'complete',
        affectedWorkflowCount: 1,
        affectedStepCount: 2,
        currentlyExposedWorkflowCount: 0,
        currentlyExposedStepCount: 0,
      });
      expect(recordedAfter).toEqual(recordedBefore);
      expect(historicalUsage).toMatchObject({
        workflowLifecycle: 'historical',
        currentState: {
          isActive: false,
          quarantine: 'cleared',
          quarantineClearedAt: expect.any(String),
          replacementWorkflowVersionId: 'checkout-v2',
          replacementActivatedAt: expect.any(String),
        },
      });
    } finally {
      await pool.query(
        `DELETE FROM workflow_activations WHERE organization_id = 'org_atlas'
           AND previous_workflow_version_id = 'checkout-v1'`,
      );
      await pool.query(
        `DELETE FROM workflow_migration_candidates WHERE organization_id = 'org_atlas'
           AND source_workflow_version_id = 'checkout-v1'`,
      );
      await pool.query(
        `DELETE FROM workflow_versions WHERE organization_id = 'org_atlas'
           AND workflow_version_id = 'checkout-v2'`,
      );
      await pool.query(
        `UPDATE workflow_environment_versions
         SET lifecycle_status = 'active', is_active = true
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'
           AND workflow_version_id = 'checkout-v1'`,
      );
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it('uses the complete ordered workflow path for later broken calls', async () => {
    const longWorkflow = await createCompiledWorkflowVersion('long-checkout-v1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: {} },
      steps: [
        {
          id: 'create-order',
          kind: 'capabilityCall',
          capabilityVersionId: createOrderVersionId,
          arguments: {},
        },
        {
          id: 'take-payment',
          kind: 'capabilityCall',
          capabilityVersionId: takePaymentVersionId,
          arguments: {},
        },
        {
          id: 'check-kitchen',
          kind: 'capabilityCall',
          capabilityVersionId: checkKitchenVersionId,
          arguments: {},
        },
        { id: 'done', kind: 'terminal', state: 'completed' },
      ],
    });
    await saveWorkflowCatalogVersion(pool, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowId: 'long-checkout',
      name: 'Long checkout',
      status: 'active',
      draft: longWorkflow,
    });
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: createOrderVersionId,
      changeKind: 'removal',
      affectedWorkflows: [{ workflowVersionId: 'long-checkout-v1', stepId: 'create-order' }],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });
      const usage = overview.nodes
        .find((node) => node.operationId === 'checkKitchen')
        ?.impact?.usages.find((candidate) => candidate.workflowVersionId === 'long-checkout-v1');

      expect(usage?.evidence.path).toEqual([
        {
          kind: 'execution-order',
          fromStepId: 'create-order',
          toStepId: 'take-payment',
          fromCapabilityVersionId: createOrderVersionId,
          toCapabilityVersionId: takePaymentVersionId,
        },
        {
          kind: 'execution-order',
          fromStepId: 'take-payment',
          toStepId: 'check-kitchen',
          fromCapabilityVersionId: takePaymentVersionId,
          toCapabilityVersionId: checkKitchenVersionId,
        },
      ]);
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
      await pool.query(
        `DELETE FROM workflow_identities
         WHERE organization_id = 'org_atlas' AND workflow_id = 'long-checkout'`,
      );
    }
  });

  it('matches a nested request field exactly and leaves an opaque mapping unresolved', async () => {
    const changedPaymentVersionId = await createChangedCapabilityVersion(takePaymentVersionId, {
      operation: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  order: {
                    type: 'object',
                    properties: { extraLettuce: { type: 'boolean' } },
                    required: ['extraLettuce'],
                  },
                },
              },
            },
          },
        },
      },
    });
    const fieldPath =
      '/operation/requestBody/content/application~1json/schema/properties/order/properties/extraLettuce';
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: takePaymentVersionId,
      toCapabilityVersionId: changedPaymentVersionId,
      fieldChanges: [{ kind: 'added-required', path: fieldPath, classification: 'breaking' }],
      affectedWorkflows: [
        { workflowVersionId: 'checkout-v1', stepId: 'take-payment' },
        { workflowVersionId: 'opaque-payment-v1', stepId: 'take-opaque-payment' },
      ],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });
      const usages = overview.nodes.find((node) => node.operationId === 'takePayment')?.impact
        ?.usages;

      expect(usages).toEqual([
        expect.objectContaining({
          workflowVersionId: 'checkout-v1',
          reason: 'This call does not provide the newly required order.extraLettuce field.',
          evidence: expect.objectContaining({ fieldPath }),
        }),
      ]);
      expect(overview).toMatchObject({
        status: 'partial',
        impact: { affectedWorkflowCount: 1, incompleteAnalysisCount: 1 },
        notices: [expect.stringContaining('Unresolved evidence is not shown as broken')],
      });
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it('returns a partial focused map when the selected change is unavailable', async () => {
    const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
      type: 'change',
      id: '999999999',
    });

    expect(overview).toMatchObject({
      status: 'partial',
      impact: {
        type: 'change',
        id: '999999999',
        affectedWorkflowCount: 0,
        affectedStepCount: 0,
        incompleteAnalysisCount: 1,
        sources: [],
      },
      notices: ['Atlas could not find the selected contract change in this environment.'],
    });
  });

  it('does not present a compatible addition or replacement hint as breakage', async () => {
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: takePaymentVersionId,
      toCapabilityVersionId: takePaymentVersionId,
      classification: 'compatible',
      fieldChanges: [
        {
          kind: 'added-optional',
          path: '/operation/requestBody/content/application~1json/schema/properties/note',
          classification: 'compatible',
        },
      ],
      affectedWorkflows: [{ workflowVersionId: 'checkout-v1', stepId: 'take-payment' }],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });

      expect(overview.impact).toMatchObject({
        type: 'change',
        id: discoveryId,
        affectedWorkflowCount: 0,
        affectedStepCount: 0,
        incompleteAnalysisCount: 0,
      });
      expect(overview.nodes.some((node) => node.impact?.affected)).toBe(false);
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it('reports an unknown breaking change without turning any item red', async () => {
    const changedPaymentVersionId = await createChangedCapabilityVersion(takePaymentVersionId, {
      operation: { responses: { '200': { description: 'Changed' } } },
    });
    const discoveryId = await recordDiscoveryChange({
      fromCapabilityVersionId: takePaymentVersionId,
      toCapabilityVersionId: changedPaymentVersionId,
      fieldChanges: [{ kind: 'future-change', classification: 'breaking' }],
      affectedWorkflows: [{ workflowVersionId: 'checkout-v1', stepId: 'take-payment' }],
    });

    try {
      const overview = await readCapabilityOverview(pool, 'org_atlas', 'production', {
        type: 'change',
        id: discoveryId,
      });

      expect(overview.nodes.some((node) => node.impact?.affected)).toBe(false);
      expect(overview).toMatchObject({
        status: 'partial',
        impact: { affectedStepCount: 0, incompleteAnalysisCount: 1 },
        notices: [expect.stringContaining('Unresolved evidence is not shown as broken')],
      });
    } finally {
      await pool.query('DELETE FROM capability_discoveries WHERE id = $1', [discoveryId]);
    }
  });

  it.each(['author-token', 'operator-token', 'admin-token'])(
    'lets a signed-in member read the map with %s',
    async (token) => {
      const app = createApp(pool, undefined, undefined, undefined, undefined, {
        async authorize(request) {
          return request.authorizationHeader === `Bearer ${token}` &&
            request.organizationId === 'org_atlas' &&
            request.action === 'view-organization'
            ? {
                actorId: token,
                role: token.replace('-token', '') as 'author' | 'operator' | 'admin',
              }
            : null;
        },
      });
      const response = await app.request(
        '/v1/capability-overview?organizationId=org_atlas&environmentId=production',
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: 'ready' });
    },
  );

  it('does not reveal another organization or accept a missing sign-in', async () => {
    const app = createApp(pool, undefined, undefined, undefined, undefined, {
      async authorize(request) {
        return request.authorizationHeader === 'Bearer author-token' &&
          request.organizationId === 'org_atlas'
          ? { actorId: 'author', role: 'author' }
          : null;
      },
    });

    expect(
      (
        await app.request(
          '/v1/capability-overview?organizationId=org_other&environmentId=production',
          { headers: { authorization: 'Bearer author-token' } },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          '/v1/capability-overview?organizationId=org_atlas&environmentId=production',
        )
      ).status,
    ).toBe(403);
  });
});
