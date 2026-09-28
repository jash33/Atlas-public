import { randomUUID } from 'node:crypto';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { connectBurgerTown, type BurgerTownConnectionPlan } from './burger-town-connection.js';
import { readCapabilityArchitecture } from './capability-architecture.js';
import { createPostgresBurgerTownMonitoringStore } from './burger-town-monitor-store.js';
import { createApp } from './app.js';
import { readCapabilityOverview } from './capability-overview.js';
import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { recordWorkflowLifecycle } from './workflow-catalog.js';
import { createPostgresRuntimeMismatchNotifier, markNotificationRead } from './notifications.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `burger_town_connection_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const runId = randomUUID();

const operationIds = Array.from({ length: 15 }, (_, index) =>
  index === 8 ? 'createPayment' : `burgerTownOperation${index + 1}`,
);

const openApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Burger Town', version: '1.0.0' },
  paths: Object.fromEntries(
    operationIds.map((operationId, index) => [
      `/demo/${index + 1}`,
      {
        post: {
          operationId,
          requestBody: {
            content: { 'application/json': { schema: { type: 'object', properties: {} } } },
          },
          responses: { '200': { description: 'Success' } },
        },
      },
    ]),
  ),
};

const plan: BurgerTownConnectionPlan = {
  serviceId: 'burger-town',
  operations: operationIds.map((operationId, index) => ({
    operationId,
    owner: index === 8 ? 'payments' : 'burger-town',
    method: 'POST',
    path: `/demo/${index + 1}`,
    requestBody: { demoRequest: index + 1 },
    expectedSuccess: { status: 200 },
    recognizedError: {
      status: 400,
      code: 'required_field_missing',
      codePath: ['code'],
      fieldPathPath: ['fieldPath'],
      ...(operationId === 'createPayment' ? { fieldPath: 'extraLettuce' } : {}),
    },
  })),
};

function connectionOptions(connectionPlan: BurgerTownConnectionPlan = plan) {
  return {
    actorId: 'demo-user',
    allowedApplicationUrls: ['https://burger-town.test/'],
    allowedOpenApiUrls: ['https://burger-town.test/openapi.json'],
    plan: connectionPlan,
  };
}

function sourcePolicy(
  applicationReachable = true,
  openApiState: 'valid' | 'unreachable' | 'invalid' = 'valid',
  document: Record<string, unknown> = openApiDocument,
  arazzoYaml: string | null = null,
) {
  return {
    allowedHosts: ['burger-town.test'],
    lookup: async () => [{ address: '203.0.113.10', family: 4 }],
    fetch: async (url: URL) => {
      if (url.pathname === '/openapi.json') {
        if (openApiState === 'unreachable') return new Response(null, { status: 503 });
        if (openApiState === 'invalid') {
          return new Response('{', { headers: { 'content-type': 'application/json' } });
        }
        return Response.json(document);
      }
      if (url.pathname === '/arazzo.yaml') {
        if (arazzoYaml === null) return new Response(null, { status: 404 });
        return new Response(arazzoYaml, { headers: { 'content-type': 'application/yaml' } });
      }
      return new Response(null, { status: applicationReachable ? 204 : 503 });
    },
  };
}

async function prepareOrganization(organizationId: string) {
  await pool.query('INSERT INTO organizations (id) VALUES ($1)', [organizationId]);
  await pool.query(
    `INSERT INTO environments (organization_id, id, name, kind)
     VALUES ($1, 'development', 'Development', 'development')`,
    [organizationId],
  );
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 222 });
});

afterAll(async () => {
  await pool.end();
});

describe('Burger Town source connection', () => {
  it('connects Burger Town alongside an existing source without changing that source', async () => {
    const organizationId = `org_burger_town_secondary_${runId}`;
    await prepareOrganization(organizationId);
    const input = {
      organizationId,
      environmentId: 'development',
      applicationUrl: 'https://burger-town.test/',
      openApiUrl: 'https://burger-town.test/openapi.json',
    };
    const existing = await connectBurgerTown(
      pool,
      sourcePolicy(),
      input,
      connectionOptions({ ...plan, serviceId: 'existing-source' }),
    );
    await connectBurgerTown(pool, sourcePolicy(), input, connectionOptions());
    const app = createApp(pool, { allowedHosts: [] }, undefined, undefined, undefined, undefined, {
      allowLegacySourceRoutes: true,
      burgerTownPlan: plan,
      burgerTownAllowedOpenApiUrls: [input.openApiUrl],
      burgerTownSourcePolicy: sourcePolicy(),
    });
    const refreshed = await app.request('/v1/capability-source-rediscoveries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        environmentId: 'development',
        serviceId: 'burger-town',
      }),
    });
    expect(refreshed.status).toBe(201);
    const versions = await pool.query<{ capability_version_id: string }>(
      `SELECT o.capability_version_id FROM environment_capability_observations o
       JOIN capability_identities i ON i.id = o.capability_identity_id
       WHERE o.organization_id = $1 AND i.service_id = 'existing-source'`,
      [organizationId],
    );
    expect(versions.rows.map((row) => row.capability_version_id.trim()).sort()).toEqual(
      existing.capabilities.map((capability) => capability.capabilityVersionId).sort(),
    );
  });
  it('reconfirms changed prepared annotations even when OpenAPI bytes and the clock are unchanged', async () => {
    const organizationId = `org_burger_town_reconfirm_${runId}`;
    await prepareOrganization(organizationId);
    const input = {
      organizationId,
      environmentId: 'development',
      applicationUrl: 'https://burger-town.test/',
      openApiUrl: 'https://burger-town.test/openapi.json',
    };
    const now = () => new Date('2026-09-04T15:00:00Z');
    const initial = await connectBurgerTown(pool, sourcePolicy(), input, {
      ...connectionOptions(),
      now,
    });
    const updated = structuredClone(plan);
    updated.operations[0]!.owner = 'updated-provider-owner';
    const reconnected = await connectBurgerTown(pool, sourcePolicy(), input, {
      ...connectionOptions(updated),
      now,
    });
    expect(reconnected.capabilities[0]!.capabilityVersionId).not.toBe(
      initial.capabilities[0]!.capabilityVersionId,
    );
    const repeated = await connectBurgerTown(pool, sourcePolicy(), input, {
      ...connectionOptions(updated),
      now,
    });
    expect(repeated.capabilities.map((capability) => capability.capabilityVersionId)).toEqual(
      reconnected.capabilities.map((capability) => capability.capabilityVersionId),
    );
  });

  it('exposes provider-declared idempotent writes to planning while keeping unannotated writes excluded', async () => {
    const organizationId = `org_burger_town_safety_${runId}`;
    await prepareOrganization(organizationId);
    const supported = ['createFulfillment', 'createCheck', 'addItem', 'sendOrder'];
    const document = {
      openapi: '3.1.0',
      info: { title: 'Burger Town', version: '1.0.0' },
      paths: Object.fromEntries(
        [...supported, 'unpreparedMutation'].map((operationId) => [
          `/v1/${operationId}`,
          {
            post: {
              operationId,
              ...(supported.includes(operationId)
                ? {
                    'x-atlas-safety': {
                      idempotencyField: 'idempotency_key',
                      compensatedBy: null,
                      irreversibleAfter: true,
                    },
                  }
                : {}),
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { idempotency_key: { type: 'string' } },
                    },
                  },
                },
              },
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        ]),
      ),
    };
    await connectBurgerTown(
      pool,
      sourcePolicy(true, 'valid', document),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions({ serviceId: 'burger-town', operations: [] }),
    );
    const projection = await readPlannerCapabilityProjection(pool, organizationId, 'development');
    expect(
      projection.capabilities.map((capability) => capability.identity.operationId).sort(),
    ).toEqual(supported.sort());
    expect(
      projection.capabilities.every(
        (capability) => capability.annotation.idempotencyField === 'idempotency_key',
      ),
    ).toBe(true);
  });

  it('prepares all capabilities and monitoring targets without creating workflows', async () => {
    const organizationId = `org_burger_town_success_${runId}`;
    await prepareOrganization(organizationId);

    const result = await connectBurgerTown(
      pool,
      sourcePolicy(),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions(),
    );

    expect(result.capabilities).toHaveLength(15);
    expect(result).toMatchObject({
      monitoringState: 'stopped',
      pollingDefinitionCount: 15,
      arazzoWorkflowCount: 0,
    });
    await connectBurgerTown(
      pool,
      sourcePolicy(),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions(),
    );

    const stored = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM capability_versions WHERE organization_id = $1) AS capabilities,
        (SELECT count(*)::int FROM workflow_versions WHERE organization_id = $1) AS workflows,
        (SELECT count(*)::int FROM workflow_capability_dependencies
          WHERE organization_id = $1) AS pins,
        (SELECT count(*)::int FROM capability_approvals WHERE organization_id = $1) AS approvals,
        (SELECT count(*)::int FROM capability_host_policies WHERE organization_id = $1) AS hosts,
        (SELECT count(*)::int FROM capability_polling_definitions
          WHERE organization_id = $1) AS polling,
        (SELECT count(*)::int FROM source_documents WHERE organization_id = $1) AS sources,
        (SELECT state FROM capability_monitoring_state
          WHERE organization_id = $1 AND environment_id = 'development') AS monitoring`,
      [organizationId],
    );
    expect(stored.rows[0]).toEqual({
      capabilities: 15,
      workflows: 0,
      pins: 0,
      approvals: 15,
      hosts: 15,
      polling: 15,
      sources: 2,
      monitoring: 'stopped',
    });
    const monitoringStore = createPostgresBurgerTownMonitoringStore(pool, plan);
    const pollingTargets = await monitoringStore.loadReadyTargets({
      organizationId,
      environmentId: 'development',
    });
    expect(pollingTargets).toHaveLength(15);
    expect(pollingTargets[0]).toMatchObject({
      definitionKey: `burger-town:${operationIds[0]}`,
      url: 'https://burger-town.test/demo/1',
      expectedStatus: 200,
    });
    await monitoringStore.saveSuccessfulResponse(
      { organizationId, environmentId: 'development' },
      pollingTargets[0]!,
      new Date('2026-09-04T15:00:00.000Z'),
    );
    await expect(
      pool.query(
        `SELECT last_succeeded_at FROM capability_polling_baselines
         WHERE organization_id = $1 AND environment_id = 'development'`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: [{ last_succeeded_at: new Date('2026-09-04T15:00:00.000Z') }],
    });
  });

  it('stores provider Arazzo recipes as a separate architecture graph', async () => {
    const organizationId = `org_burger_town_arazzo_${runId}`;
    await prepareOrganization(organizationId);
    const arazzoYaml = `arazzo: "1.0.1"
info:
  title: Burgertown workflows
workflows:
  - workflowId: payThenCharge
    summary: Pay then charge
    steps:
      - stepId: reset
        operationId: resetSandbox
      - stepId: pay
        operationId: createPayment
        outputs:
          paymentId: $response.body#/id
      - stepId: next
        operationId: burgerTownOperation1
        requestBody:
          payload:
            payment_id: $steps.pay.outputs.paymentId
`;
    const result = await connectBurgerTown(
      pool,
      sourcePolicy(true, 'valid', openApiDocument, arazzoYaml),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions(),
    );
    expect(result.arazzoWorkflowCount).toBe(1);

    const architecture = await readCapabilityArchitecture(pool, organizationId, 'development');
    expect(architecture.status).toBe('ready');
    expect(architecture.title).toBe('Burgertown workflows');
    expect(architecture.workflows).toEqual([
      { workflowId: 'payThenCharge', summary: 'Pay then charge' },
    ]);
    expect(architecture.relationships).toEqual([
      expect.objectContaining({
        kind: 'execution-order',
        sourceOperationId: 'createPayment',
        targetOperationId: 'burgerTownOperation1',
      }),
      expect.objectContaining({
        kind: 'data-flow',
        sourceOperationId: 'createPayment',
        targetOperationId: 'burgerTownOperation1',
        destinationField: 'payment_id',
      }),
    ]);
    expect(architecture.nodes.map((node) => node.operationId).sort()).toEqual([
      'burgerTownOperation1',
      'createPayment',
    ]);
    expect(
      architecture.nodes.every((node) => node.capabilityIdentityId && node.capabilityVersionId),
    ).toBe(true);
  });

  it('prepares every operation in the connected OpenAPI document', async () => {
    const organizationId = `org_burger_town_dynamic_${runId}`;
    await prepareOrganization(organizationId);
    const currentOperationIds = Array.from(
      { length: 87 },
      (_, index) => `currentBurgerTownOperation${index + 1}`,
    );
    const currentDocument = {
      openapi: '3.1.0',
      info: { title: 'Current Burger Town', version: '1.1.0' },
      paths: Object.fromEntries(
        currentOperationIds.map((operationId, index) => [
          `/v1/current/${index + 1}`,
          {
            get: {
              operationId,
              tags: [`api-${index % 4}`],
              responses: { '200': { description: 'Success' } },
            },
          },
        ]),
      ),
    };

    const result = await connectBurgerTown(
      pool,
      sourcePolicy(true, 'valid', currentDocument),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions(),
    );

    expect(result.capabilities).toHaveLength(87);
    expect(result).toMatchObject({
      pollingDefinitionCount: 87,
      monitoringState: 'stopped',
    });
    const targets = await createPostgresBurgerTownMonitoringStore(pool).loadReadyTargets({
      organizationId,
      environmentId: 'development',
    });
    expect(targets).toHaveLength(87);
    expect(targets[0]).toMatchObject({ acceptAnyStatus: false });
  });

  it('ingests mutations and lookups without polling guessed requests or reset controls', async () => {
    const organizationId = `org_burger_town_fixtures_${runId}`;
    await prepareOrganization(organizationId);
    const fixture = {
      method: 'POST',
      path: '/probe/addItem',
      requestBody: { item_id: 'itm_townie', quantity: 1 },
      expectedSuccess: { status: 200 },
      recognizedError: {
        status: 400,
        code: 'required_field_missing',
        codePath: ['code'],
        fieldPathPath: ['fieldPath'],
      },
    };
    const document = {
      openapi: '3.1.0',
      info: { title: 'Burger Town', version: '1.0.0' },
      paths: {
        '/health': { get: { operationId: 'health', responses: { '200': { description: 'OK' } } } },
        '/v1/sandbox': {
          post: { operationId: 'resetSandbox', responses: { '200': { description: 'Reset' } } },
        },
        '/v1/checks/{check_id}': {
          get: {
            operationId: 'getCheck',
            parameters: [
              { name: 'check_id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': { description: 'OK' } },
          },
        },
        '/v1/checks/{check_id}/items': {
          post: {
            operationId: 'addItem',
            parameters: [
              { name: 'check_id', in: 'path', required: true, schema: { type: 'string' } },
            ],
            'x-atlas-polling': fixture,
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const result = await connectBurgerTown(
      pool,
      sourcePolicy(true, 'valid', document),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions({ serviceId: 'burger-town', operations: [] }),
    );
    expect(result.capabilities).toHaveLength(4);
    expect(result.pollingDefinitionCount).toBe(2);
    const scope = { organizationId, environmentId: 'development' };
    const store = createPostgresBurgerTownMonitoringStore(pool);
    expect(await store.loadReadyTargets(scope)).toEqual([
      expect.objectContaining({
        definitionKey: 'burger-town:addItem',
        url: 'https://burger-town.test/probe/addItem',
        requestBody: fixture.requestBody,
      }),
      expect.objectContaining({ definitionKey: 'burger-town:health' }),
    ]);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM capability_execution_bindings WHERE organization_id = $1',
          [organizationId],
        )
      ).rows,
    ).toEqual([{ count: 4 }]);
    // Removing a fixture retires its latest probe without erasing its prior evidence.
    const reconnected = structuredClone(document);
    Reflect.deleteProperty(
      reconnected.paths['/v1/checks/{check_id}/items'].post,
      'x-atlas-polling',
    );
    await connectBurgerTown(
      pool,
      sourcePolicy(true, 'valid', reconnected),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions({ serviceId: 'burger-town', operations: [] }),
    );
    expect(await store.loadReadyTargets(scope)).toEqual([
      expect.objectContaining({ definitionKey: 'burger-town:health' }),
    ]);
  });

  it('links a real probe failure to separately saved workflows and their downstream calls', async () => {
    const organizationId = `org_burger_town_organic_${runId}`;
    await prepareOrganization(organizationId);
    const operationNames = ['createCheck', 'addItem', 'sendOrder'];
    const document = {
      openapi: '3.1.0',
      info: { title: 'Burger Town', version: '1.0.0' },
      paths: Object.fromEntries(
        operationNames.map((operationId) => [
          `/demo/${operationId}`,
          {
            post: { operationId, responses: { '200': { description: 'OK' } } },
          },
        ]),
      ),
    };
    const connected = await connectBurgerTown(
      pool,
      sourcePolicy(true, 'valid', document),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions({
        serviceId: 'burger-town',
        operations: operationNames.map((operationId) => ({
          ...plan.operations[0]!,
          operationId,
          path: `/demo/${operationId}`,
        })),
      }),
    );
    const versionByOperation = new Map(
      connected.capabilities.map((capability) => [
        capability.identity.operationId,
        capability.capabilityVersionId,
      ]),
    );
    const app = createApp(pool, { allowedHosts: [] }, undefined, {
      async authorize() {
        return 'author';
      },
    });
    // Save independently through the same Catalog endpoint used by Create Workflow.
    for (const suppliesNewField of [false, true]) {
      const draft = await createCompiledWorkflowVersion(
        `order-${suppliesNewField}`,
        organizationId,
        {
          irVersion: 1,
          inputSchema: { required: { check_id: { type: 'string' } } },
          steps: [
            {
              id: 'create-check',
              kind: 'capabilityCall',
              capabilityVersionId: versionByOperation.get('createCheck')!,
              arguments: {},
            },
            {
              id: 'add-item',
              kind: 'capabilityCall',
              capabilityVersionId: versionByOperation.get('addItem')!,
              arguments: {
                body: {
                  source: 'literal',
                  value: {
                    item_id: 'itm_fries',
                    quantity: 1,
                    ...(suppliesNewField ? { kitchen_note: 'No salt' } : {}),
                  },
                },
              },
            },
            // It consumes intake, not add-item output: ordering alone establishes downstream impact.
            {
              id: 'send-order',
              kind: 'capabilityCall',
              capabilityVersionId: versionByOperation.get('sendOrder')!,
              arguments: { check_id: { source: 'input', path: ['check_id'] } },
            },
            { id: 'done', kind: 'terminal', state: 'completed' },
          ],
        },
      );
      const saved = await app.request('/v1/workflow-catalog/versions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          environmentId: 'development',
          workflowId: `order-${suppliesNewField}`,
          name: suppliesNewField ? 'Prepared order' : 'Place order',
          status: 'draft',
          draft,
        }),
      });
      expect(saved.status).toBe(201);
      // Approval/activation is exercised by its own suite; establish that boundary for map analysis.
      await recordWorkflowLifecycle(pool, {
        organizationId,
        environmentId: 'development',
        workflowVersionId: draft.workflowVersionId,
        status: 'active',
        isActive: true,
      });
      // A failed check changes the status without deactivating the workflow.
      await recordWorkflowLifecycle(pool, {
        organizationId,
        environmentId: 'development',
        workflowVersionId: draft.workflowVersionId,
        status: 'blocked',
      });
    }
    const scope = { organizationId, environmentId: 'development' };
    const store = createPostgresBurgerTownMonitoringStore(pool);
    const target = (await store.loadReadyTargets(scope)).find(
      (probe) => probe.definitionKey === 'burger-town:addItem',
    )!;
    await store.saveSuccessfulResponse(scope, target, new Date('2026-09-04T15:00:00Z'));
    const mismatch = {
      status: 400,
      reason: 'required-field-missing' as const,
      fieldPath: 'kitchen_note',
    };
    const id = (await store.saveRuntimeMismatch(
      scope,
      target,
      mismatch,
      new Date('2026-09-04T15:00:01Z'),
    ))!;
    await createPostgresRuntimeMismatchNotifier(pool).notify(scope, target, mismatch, id);
    const overview = await readCapabilityOverview(pool, organizationId, 'development', {
      type: 'runtime-mismatch',
      id,
    });
    expect(overview.impact).toMatchObject({
      affectedWorkflowCount: 1,
      affectedEndpointCount: 2,
      affectedStepCount: 2,
      analysis: 'complete',
    });
    expect(
      overview.nodes
        .filter((node) => node.impact?.affected)
        .map((node) => node.operationId)
        .sort(),
    ).toEqual(['addItem', 'sendOrder']);
    const notice = (
      await pool.query(
        'SELECT navigation_target, details FROM notifications WHERE organization_id = $1 AND kind = $2',
        [organizationId, 'runtime-contract-mismatch'],
      )
    ).rows[0];
    expect(notice).toMatchObject({
      navigation_target: `#/capabilities?view=map&environmentId=development&focusType=runtime-mismatch&focusId=${id}`,
      details: expect.objectContaining({
        operation: 'addItem',
        affectedWorkflowCount: 1,
        affectedEndpointCount: 2,
      }),
    });
  });

  it('turns repeated Payments failures into safe evidence and one updating notification', async () => {
    const organizationId = `org_burger_town_mismatch_${runId}`;
    await prepareOrganization(organizationId);
    await connectBurgerTown(
      pool,
      sourcePolicy(),
      {
        organizationId,
        environmentId: 'development',
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
      },
      connectionOptions(),
    );
    const store = createPostgresBurgerTownMonitoringStore(pool, plan);
    const notifier = createPostgresRuntimeMismatchNotifier(pool);
    const scope = { organizationId, environmentId: 'development' };
    const payment = (await store.loadReadyTargets(scope)).find((target) =>
      target.definitionKey.endsWith(':createPayment'),
    )!;
    const saveMismatch = async (observedAt: Date) => {
      const mismatch = {
        status: 400,
        reason: 'required-field-missing' as const,
        fieldPath: 'extraLettuce',
      };
      const mismatchId = await store.saveRuntimeMismatch(scope, payment, mismatch, observedAt);
      if (mismatchId) await notifier.notify(scope, payment, mismatch, mismatchId);
      return mismatchId;
    };
    await saveMismatch(new Date('2026-09-04T14:59:59.000Z'));
    expect(
      await pool.query(
        `SELECT count(*)::int AS count FROM runtime_contract_mismatch_observations
         WHERE organization_id = $1`,
        [organizationId],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });
    await store.saveSuccessfulResponse(scope, payment, new Date('2026-09-04T15:00:00.000Z'));
    await store.savePollingFailure(
      scope,
      payment,
      { reason: 'unrecognized-response', status: 401 },
      new Date('2026-09-04T15:00:00.500Z'),
    );
    expect(
      await pool.query(
        `SELECT reason, status_code, occurrence_count FROM capability_polling_failures
         WHERE organization_id = $1`,
        [organizationId],
      ),
    ).toMatchObject({
      rows: [{ reason: 'unrecognized-response', status_code: 401, occurrence_count: 1 }],
    });
    expect(
      await pool.query(
        `SELECT count(*)::int AS count FROM notifications
         WHERE organization_id = $1 AND kind = 'runtime-contract-mismatch'`,
        [organizationId],
      ),
    ).toMatchObject({ rows: [{ count: 0 }] });

    await saveMismatch(new Date('2026-09-04T15:00:01.000Z'));

    const condition = await pool.query<{
      id: string;
      occurrence_count: number;
      first_seen_at: Date;
      last_seen_at: Date;
    }>(
      `SELECT id, occurrence_count, first_seen_at, last_seen_at
       FROM runtime_contract_mismatches
       WHERE organization_id = $1 AND environment_id = 'development'`,
      [organizationId],
    );
    expect(condition.rows[0]).toMatchObject({ occurrence_count: 1 });
    const mismatchId = condition.rows[0]!.id;
    await expect(
      pool.query(
        `INSERT INTO runtime_contract_mismatches
          (id, organization_id, environment_id, condition_key, capability_identity_id,
           capability_version_id, definition_key, polling_definition_revision,
           operation_id, reason, field_path, status_code, first_seen_at, last_seen_at,
           latest_observation_id)
         SELECT 'duplicate-active-incident', organization_id, environment_id,
                'duplicate-active-condition', capability_identity_id, capability_version_id,
                definition_key, polling_definition_revision, operation_id, reason, field_path,
                status_code, first_seen_at, last_seen_at, latest_observation_id
         FROM runtime_contract_mismatches
         WHERE id = $1`,
        [mismatchId],
      ),
    ).rejects.toThrow('runtime_contract_mismatches_one_active_identity');
    const overview = await readCapabilityOverview(pool, organizationId, 'development', {
      type: 'runtime-mismatch',
      id: mismatchId,
    });
    expect(overview.impact).toMatchObject({
      type: 'runtime-mismatch',
      id: mismatchId,
      affectedEndpointCount: 0,
      affectedWorkflowCount: 0,
      affectedStepCount: 0,
      occurrenceCount: 1,
    });
    expect(
      overview.nodes
        .filter((node) => node.impact?.affected)
        .map((node) => node.operationId)
        .sort(),
    ).toEqual([]);

    const firstNotice = await pool.query<{
      id: string;
      kind: string;
      condition_key: string;
      severity: string;
      title: string;
      message: string;
      navigation_target: string;
      occurrence_count: number;
      affected_workflows: unknown[];
      details: Record<string, unknown>;
      read_at: Date | null;
      resolved_at: Date | null;
    }>(
      `SELECT * FROM notifications
       WHERE organization_id = $1 AND kind = 'runtime-contract-mismatch'`,
      [organizationId],
    );
    expect(firstNotice.rows).toHaveLength(1);
    expect(firstNotice.rows[0]).toMatchObject({
      kind: 'runtime-contract-mismatch',
      severity: 'critical',
      title: 'createPayment request is broken',
      message:
        'createPayment now requires extraLettuce. No Atlas workflows currently use this capability.',
      occurrence_count: 1,
      read_at: null,
      resolved_at: null,
      details: expect.objectContaining({
        runtimeMismatchId: mismatchId,
        capabilityVersionId: payment.capabilityVersionId,
        pollingDefinitionRevision: 1,
        operation: 'createPayment',
        reason: 'required-field-missing',
        fieldPath: 'extraLettuce',
        status: 400,
        affectedEndpointCount: 0,
        affectedWorkflowCount: 0,
      }),
    });
    expect(firstNotice.rows[0]!.navigation_target).toBe(
      `#/capabilities?view=map&environmentId=development&focusType=runtime-mismatch&focusId=${mismatchId}`,
    );
    expect(firstNotice.rows[0]!.affected_workflows).toEqual([]);

    await markNotificationRead(pool, firstNotice.rows[0]!.id, organizationId);
    await saveMismatch(new Date('2026-09-04T15:00:02.000Z'));

    const repeated = await pool.query<{
      mismatch_count: number;
      occurrence_count: number;
      first_seen_at: Date;
      last_seen_at: Date;
      notice_count: number;
      notice_occurrence_count: number;
      read_at: Date | null;
      resolved_at: Date | null;
    }>(
      `SELECT
         (SELECT count(*)::int FROM runtime_contract_mismatch_observations
           WHERE organization_id = $1) AS mismatch_count,
         mismatch.occurrence_count,
         mismatch.first_seen_at,
         mismatch.last_seen_at,
         (SELECT count(*)::int FROM notifications
           WHERE organization_id = $1 AND kind = 'runtime-contract-mismatch') AS notice_count,
         notice.occurrence_count AS notice_occurrence_count,
         notice.read_at,
         notice.resolved_at
       FROM runtime_contract_mismatches mismatch
       JOIN notifications notice ON notice.condition_key = mismatch.condition_key
         AND notice.organization_id = mismatch.organization_id
         AND notice.environment_id = mismatch.environment_id
       WHERE mismatch.organization_id = $1`,
      [organizationId],
    );
    expect(repeated.rows[0]).toMatchObject({
      mismatch_count: 2,
      occurrence_count: 2,
      notice_count: 1,
      notice_occurrence_count: 2,
      read_at: expect.any(Date),
      resolved_at: null,
    });
    expect(repeated.rows[0]!.first_seen_at.toISOString()).toBe('2026-09-04T15:00:01.000Z');
    expect(repeated.rows[0]!.last_seen_at.toISOString()).toBe('2026-09-04T15:00:02.000Z');
    await expect(
      pool.query(
        `UPDATE runtime_contract_mismatch_observations SET field_path = 'changed'
         WHERE organization_id = $1`,
        [organizationId],
      ),
    ).rejects.toThrow('runtime contract mismatch observations are immutable');

    const recoveredAt = new Date('2026-09-04T15:00:03.000Z');
    const recovered = await store.saveSuccessfulResponse(scope, payment, recoveredAt);
    await notifier.recover(scope, recovered, recoveredAt);
    const recoveredState = await pool.query<{
      state: string;
      recovered_at: Date;
      occurrence_count: number;
      observation_count: number;
      resolved_at: Date;
      resolution_reason: string;
      details: Record<string, unknown>;
    }>(
      `SELECT mismatch.state, mismatch.recovered_at, mismatch.occurrence_count,
              (SELECT count(*)::int FROM runtime_contract_mismatch_observations
               WHERE organization_id = $1) AS observation_count,
              notice.resolved_at, notice.resolution_reason, notice.details
       FROM runtime_contract_mismatches mismatch
       JOIN notifications notice ON notice.condition_key = mismatch.condition_key
         AND notice.organization_id = mismatch.organization_id
         AND notice.environment_id = mismatch.environment_id
       WHERE mismatch.organization_id = $1`,
      [organizationId],
    );
    expect(recoveredState.rows[0]).toMatchObject({
      state: 'recovered',
      occurrence_count: 2,
      observation_count: 2,
      resolution_reason: 'Burger Town accepted the prepared request again.',
      details: expect.objectContaining({
        runtimeMismatchId: mismatchId,
        fieldPath: 'extraLettuce',
        affectedEndpointCount: 0,
        affectedWorkflowCount: 0,
      }),
    });
    expect(recoveredState.rows[0]!.recovered_at.toISOString()).toBe(recoveredAt.toISOString());
    expect(recoveredState.rows[0]!.resolved_at.toISOString()).toBe(recoveredAt.toISOString());

    const recoveredOverview = await readCapabilityOverview(pool, organizationId, 'development', {
      type: 'runtime-mismatch',
      id: mismatchId,
    });
    expect(recoveredOverview.impact).toMatchObject({
      type: 'runtime-mismatch',
      state: 'recovered',
      recoveredAt: recoveredAt.toISOString(),
      affectedEndpointCount: 0,
      affectedWorkflowCount: 0,
      affectedStepCount: 0,
      occurrenceCount: 2,
    });
    expect(recoveredOverview.nodes.some((node) => node.impact?.affected)).toBe(false);
    expect(recoveredOverview.nodes.flatMap((node) => node.impact?.usages ?? [])).toHaveLength(0);
    expect(
      recoveredOverview.relationships.some((relationship) => relationship.impact?.affected),
    ).toBe(false);

    const nextMismatchId = await saveMismatch(new Date('2026-09-04T15:00:04.000Z'));
    expect(nextMismatchId).not.toBe(mismatchId);
    const returnedFailures = await pool.query<{
      id: string;
      state: string;
      recovered_at: Date | null;
      occurrence_count: number;
      resolved_at: Date | null;
      notice_occurrence_count: number;
      read_at: Date | null;
    }>(
      `SELECT mismatch.id, mismatch.state, mismatch.recovered_at, mismatch.occurrence_count,
              notice.resolved_at, notice.occurrence_count AS notice_occurrence_count,
              notice.read_at
       FROM runtime_contract_mismatches mismatch
       JOIN notifications notice ON notice.condition_key = mismatch.condition_key
         AND notice.organization_id = mismatch.organization_id
         AND notice.environment_id = mismatch.environment_id
       WHERE mismatch.organization_id = $1
       ORDER BY mismatch.first_seen_at`,
      [organizationId],
    );
    expect(returnedFailures.rows).toHaveLength(2);
    expect(returnedFailures.rows[0]).toMatchObject({
      id: mismatchId,
      state: 'recovered',
      recovered_at: recoveredAt,
      occurrence_count: 2,
      resolved_at: recoveredAt,
      notice_occurrence_count: 2,
      read_at: expect.any(Date),
    });
    expect(returnedFailures.rows[1]).toMatchObject({
      id: nextMismatchId,
      state: 'active',
      recovered_at: null,
      occurrence_count: 1,
      resolved_at: null,
      notice_occurrence_count: 1,
      read_at: null,
    });
    const stillRecovered = await readCapabilityOverview(pool, organizationId, 'development', {
      type: 'runtime-mismatch',
      id: mismatchId,
    });
    expect(stillRecovered.impact).toMatchObject({
      type: 'runtime-mismatch',
      state: 'recovered',
      recoveredAt: recoveredAt.toISOString(),
      occurrenceCount: 2,
    });
  });

  it('ignores stale configured operations that are absent from the contract', async () => {
    const organizationId = `org_burger_town_missing_${runId}`;
    await prepareOrganization(organizationId);
    const missingPlan = {
      ...plan,
      operations: [
        { ...plan.operations[0]!, operationId: 'missingOperation' },
        ...plan.operations.slice(1),
      ],
    };

    await expect(
      connectBurgerTown(
        pool,
        sourcePolicy(),
        {
          organizationId,
          environmentId: 'development',
          applicationUrl: 'https://burger-town.test/',
          openApiUrl: 'https://burger-town.test/openapi.json',
        },
        connectionOptions(missingPlan),
      ),
    ).resolves.toMatchObject({ pollingDefinitionCount: 14 });
    await expect(
      pool.query(
        'SELECT count(*)::int AS count FROM capability_versions WHERE organization_id = $1',
        [organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 15 }] });
  });

  it('fails before discovery when the application is unavailable', async () => {
    const organizationId = `org_burger_town_unavailable_${runId}`;
    await prepareOrganization(organizationId);

    await expect(
      connectBurgerTown(
        pool,
        sourcePolicy(false),
        {
          organizationId,
          environmentId: 'development',
          applicationUrl: 'https://burger-town.test/',
          openApiUrl: 'https://burger-town.test/openapi.json',
        },
        connectionOptions(),
      ),
    ).rejects.toThrow('application address');
  });

  it('rejects a different path or port on an otherwise allowed host', async () => {
    const organizationId = `org_burger_town_unapproved_address_${runId}`;
    await prepareOrganization(organizationId);

    await expect(
      connectBurgerTown(
        pool,
        sourcePolicy(),
        {
          organizationId,
          environmentId: 'development',
          applicationUrl: 'https://burger-town.test:8443/',
          openApiUrl: 'https://burger-town.test/openapi.json',
        },
        connectionOptions(),
      ),
    ).rejects.toThrow('not one of the configured Burger Town addresses');
  });

  it.each([
    ['unreachable', 'returned HTTP 503'],
    ['invalid', 'did not return valid JSON'],
  ] as const)('stores nothing when the OpenAPI address is %s', async (openApiState, message) => {
    const organizationId = `org_burger_town_openapi_${openApiState}_${runId}`;
    await prepareOrganization(organizationId);

    await expect(
      connectBurgerTown(
        pool,
        sourcePolicy(true, openApiState),
        {
          organizationId,
          environmentId: 'development',
          applicationUrl: 'https://burger-town.test/',
          openApiUrl: 'https://burger-town.test/openapi.json',
        },
        connectionOptions(),
      ),
    ).rejects.toThrow(message);
    await expect(
      pool.query(
        'SELECT count(*)::int AS count FROM capability_versions WHERE organization_id = $1',
        [organizationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('adds a new polling definition revision only when its request changes', async () => {
    const organizationId = `org_burger_town_polling_revision_${runId}`;
    await prepareOrganization(organizationId);
    const input = {
      organizationId,
      environmentId: 'development',
      applicationUrl: 'https://burger-town.test/',
      openApiUrl: 'https://burger-town.test/openapi.json',
    };
    await connectBurgerTown(pool, sourcePolicy(), input, connectionOptions());
    const changedPlan = {
      ...plan,
      operations: [
        { ...plan.operations[0]!, expectedSuccess: { status: 201 } },
        ...plan.operations.slice(1),
      ],
    };
    await connectBurgerTown(pool, sourcePolicy(), input, connectionOptions(changedPlan));

    await expect(
      pool.query(
        `SELECT definition_key, max(revision)::int AS revision
         FROM capability_polling_definitions
         WHERE organization_id = $1
         GROUP BY definition_key
         ORDER BY definition_key`,
        [organizationId],
      ),
    ).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { definition_key: `burger-town:${operationIds[0]}`, revision: 2 },
        { definition_key: `burger-town:${operationIds[1]}`, revision: 1 },
      ]),
    });
  });

  it('lets every signed-in demo role connect without changing an existing monitoring state', async () => {
    const organizationId = `org_burger_town_roles_${runId}`;
    await prepareOrganization(organizationId);
    const app = createApp(
      pool,
      sourcePolicy(),
      undefined,
      undefined,
      undefined,
      {
        async authorize(request) {
          if (request.action !== 'view-organization') return null;
          const role = request.authorizationHeader?.replace('Bearer ', '');
          return role === 'author' || role === 'operator' || role === 'admin'
            ? { actorId: `${role}-user`, role }
            : null;
        },
      },
      {
        burgerTownAllowedApplicationUrls: ['https://burger-town.test/'],
        burgerTownAllowedOpenApiUrls: ['https://burger-town.test/openapi.json'],
        burgerTownPlan: plan,
        burgerTownSourcePolicy: sourcePolicy(),
      },
    );

    for (const role of ['author', 'operator', 'admin'] as const) {
      const defaultsResponse = await app.request(
        `/v1/burger-town-source-connections?organizationId=${organizationId}&environmentId=development`,
        { headers: { authorization: `Bearer ${role}` } },
      );
      expect(defaultsResponse.status).toBe(200);
      await expect(defaultsResponse.json()).resolves.toEqual({
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
        arazzoUrl: 'https://burger-town.test/arazzo.yaml',
      });

      const response = await app.request('/v1/burger-town-source-connections', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${role}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          organizationId,
          environmentId: 'development',
          applicationUrl: 'https://burger-town.test/',
          openApiUrl: 'https://burger-town.test/openapi.json',
        }),
      });
      expect(response.status).toBe(201);
      if (role === 'author') {
        await pool.query(
          `UPDATE capability_monitoring_state SET state = 'active'
           WHERE organization_id = $1 AND environment_id = 'development'`,
          [organizationId],
        );
      }
    }

    const prepared = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM workflow_versions WHERE organization_id = $1) AS workflows,
        (SELECT count(*)::int FROM capability_polling_definitions
          WHERE organization_id = $1) AS polling,
        (SELECT state FROM capability_monitoring_state
          WHERE organization_id = $1 AND environment_id = 'development') AS monitoring`,
      [organizationId],
    );
    expect(prepared.rows[0]).toEqual({
      workflows: 0,
      polling: 15,
      monitoring: 'active',
    });
  });
});
