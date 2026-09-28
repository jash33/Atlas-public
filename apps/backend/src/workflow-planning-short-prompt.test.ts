import {
  createTransformationCompiledWorkflowVersion as compileWorkflowVersion,
  versionedCompiledWorkflowVersionSchema,
} from '@atlas/workflow-ir';
import { createNonProductionLocalEd25519Signer } from '@atlas/workflow-artifact';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import type { PlannerModel } from './workflow-planning.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_planning_short_prompt_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });

const planningAuthorizer = {
  async authorize() {
    return 'author' as const;
  },
};

const shortPrompt =
  'When someone orders pickup, open a pickup order, start a ticket, add the burger, and send it to the kitchen.';

const intentFrame = {
  version: 1 as const,
  summary: 'Open a pickup order, start a ticket, add an item, and send it to the kitchen.',
  requestedEffects: ['mutateRecord' as const],
  mentionedSystems: ['pos'],
  requiredInputs: ['location_id', 'server_id', 'item_id', 'quantity'],
  constraints: [] as string[],
  ambiguities: [] as Array<{
    slot: string;
    question: string;
    suggestedAnswers: [string, string, string];
  }>,
  supported: true,
  unsupportedReason: null,
};

function writeDocument(
  operationId: string,
  path: string,
  input: {
    summary: string;
    pathParams?: string[];
    requiredBody?: Record<string, Record<string, unknown>>;
    optionalBody?: Record<string, Record<string, unknown>>;
    responseRequired?: Record<string, Record<string, unknown>>;
    status?: string;
  },
) {
  const parameters = (input.pathParams ?? []).map((name) => ({
    name,
    in: 'path' as const,
    required: true,
    schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
  }));
  const bodyProperties = { ...input.requiredBody, ...input.optionalBody };
  return {
    openapi: '3.1.0',
    info: { title: `${operationId} API`, version: '1.0.0' },
    servers: [{ url: 'https://pos.internal' }],
    paths: {
      [path]: {
        post: {
          operationId,
          summary: input.summary,
          ...(parameters.length > 0 ? { parameters } : {}),
          ...(Object.keys(bodyProperties).length > 0
            ? {
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: Object.keys(input.requiredBody ?? {}),
                        properties: bodyProperties,
                      },
                    },
                  },
                },
              }
            : {}),
          responses: {
            [input.status ?? '201']: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: Object.keys(input.responseRequired ?? { id: {} }),
                    properties: input.responseRequired ?? {
                      id: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

const stringField = { type: 'string', 'x-atlas-data-classification': 'internal' };

let createFulfillmentId = '';
let createCheckId = '';
let addItemId = '';
let sendOrderId = '';
let createPaymentId = '';

async function ingestService(
  app: ReturnType<typeof createApp>,
  serviceId: string,
  operationId: string,
  document: unknown,
) {
  const ingestion = await app.request('/v1/capability-ingestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: 'org_atlas',
      serviceId,
      source: {
        format: 'openapi',
        document,
        repository: `https://github.com/acme/${serviceId}-api`,
        commit: 'short-prompt-fixture',
        path: 'openapi.json',
      },
      manifest: {
        source: {
          repository: `https://github.com/acme/${serviceId}-api`,
          commit: 'short-prompt-fixture',
          path: 'atlas-manifest.json',
        },
        annotations: [
          {
            capability: { operationId },
            owner: 'pos-team',
            secretAlias: 'pos-api-token',
            businessSemantics: { recordsOrder: true },
            idempotencyField: 'idempotency_key',
            compensatedBy: null,
            irreversibleAfter: true,
          },
        ],
      },
    }),
  });
  if (ingestion.status !== 201) throw new Error(`Could not ingest ${operationId}`);
  return ((await ingestion.json()) as { capabilities: Array<{ capabilityVersionId: string }> })
    .capabilities[0]!.capabilityVersionId;
}

async function approveCapability(capabilityVersionId: string) {
  const stored = await pool.query<{ annotation_id: string }>(
    `SELECT manifest_annotation_id AS annotation_id
     FROM capability_versions
     WHERE organization_id = 'org_atlas' AND capability_version_id = $1`,
    [capabilityVersionId],
  );
  await pool.query(
    `INSERT INTO manifest_annotation_approvals
      (organization_id, manifest_annotation_id, approved_by)
     VALUES ('org_atlas', $1, 'admin@example.com')
     ON CONFLICT DO NOTHING`,
    [stored.rows[0]!.annotation_id],
  );
  await pool.query(
    `INSERT INTO capability_approvals
      (organization_id, capability_version_id, approved_by)
     VALUES ('org_atlas', $1, 'admin@example.com')
     ON CONFLICT DO NOTHING`,
    [capabilityVersionId],
  );
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 92 });
  await pool.query(`
    TRUNCATE organizations, source_documents, capability_identities,
      manifest_annotations, capability_versions, compatibility_diffs,
      capability_approvals, workflow_versions, workflow_capability_dependencies
    RESTART IDENTITY CASCADE
  `);
  const app = createApp(pool, undefined, undefined, undefined, undefined, undefined, {
    allowLegacySourceRoutes: true,
  });
  createFulfillmentId = await ingestService(
    app,
    'fulfillment',
    'createFulfillment',
    writeDocument('createFulfillment', '/fulfillments', {
      summary: 'Open a pickup or delivery order',
      requiredBody: {
        type: {
          type: 'string',
          enum: ['pickup', 'delivery'],
          'x-atlas-data-classification': 'internal',
        },
        location_id: stringField,
      },
      optionalBody: { idempotency_key: stringField },
      responseRequired: { id: { type: 'string' }, type: { type: 'string' } },
    }),
  );
  createCheckId = await ingestService(
    app,
    'checks',
    'createCheck',
    writeDocument('createCheck', '/checks', {
      summary: 'Start a kitchen ticket',
      requiredBody: {
        fulfillment_id: stringField,
        server_id: stringField,
      },
      optionalBody: { idempotency_key: stringField },
    }),
  );
  addItemId = await ingestService(
    app,
    'items',
    'addItem',
    writeDocument('addItem', '/checks/{check_id}/items', {
      summary: 'Add an item to the ticket',
      pathParams: ['check_id'],
      requiredBody: {
        item_id: stringField,
        quantity: { type: 'integer', 'x-atlas-data-classification': 'internal' },
      },
      optionalBody: { idempotency_key: stringField },
    }),
  );
  sendOrderId = await ingestService(
    app,
    'orders',
    'sendOrder',
    writeDocument('sendOrder', '/checks/{check_id}/send', {
      summary: 'Send the ticket to the kitchen',
      pathParams: ['check_id'],
      status: '200',
      optionalBody: { idempotency_key: stringField },
      responseRequired: {
        ticket: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    }),
  );
  createPaymentId = await ingestService(
    app,
    'payments',
    'createPayment',
    writeDocument('createPayment', '/payments', {
      summary: 'Take payment for a check',
      requiredBody: {
        check_id: stringField,
        amount: { type: 'integer', 'x-atlas-data-classification': 'internal' },
        idempotency_key: stringField,
      },
    }),
  );
  for (const capabilityVersionId of [
    createFulfillmentId,
    createCheckId,
    addItemId,
    sendOrderId,
    createPaymentId,
  ]) {
    await approveCapability(capabilityVersionId);
  }
  await pool.query(`
    INSERT INTO capability_host_policies
      (organization_id, capability_identity_id, environment_id, hostname, approved_by)
    SELECT organization_id, id, 'production', 'pos.internal', 'admin@example.com'
    FROM capability_identities WHERE organization_id = 'org_atlas';
    INSERT INTO organization_environment_policies
      (organization_id, environment_id, policy_version, approved_by)
    VALUES ('org_atlas', 'production', 'mvp-validation-v1', 'admin@example.com');
  `);
});

afterAll(async () => {
  await pool.end();
});

describe('short operational planning requests', () => {
  it('adds duplicate protection when an existing pickup draft is validated without other edits', async () => {
    const source = await compileWorkflowVersion('pickup-without-keys@1', 'org_atlas', {
      irVersion: 2,
      inputSchema: {
        required: {
          location_id: { type: 'string' },
          server_id: { type: 'string' },
          item_id: { type: 'string' },
          quantity: { type: 'integer' },
        },
      },
      steps: [
        {
          id: 'open-order',
          kind: 'capabilityCall',
          capabilityVersionId: createFulfillmentId,
          inputSchema: { required: {} },
          arguments: {
            type: { source: 'literal', value: 'pickup' },
            location_id: { source: 'input', path: ['location_id'] },
          },
          responseSchema: { required: { id: { type: 'string' }, type: { type: 'string' } } },
        },
        {
          id: 'start-ticket',
          kind: 'capabilityCall',
          capabilityVersionId: createCheckId,
          inputSchema: { required: {} },
          arguments: {
            fulfillment_id: { source: 'stepOutput', stepId: 'open-order', path: ['id'] },
            server_id: { source: 'input', path: ['server_id'] },
          },
          responseSchema: { required: { id: { type: 'string' } } },
        },
        {
          id: 'add-item',
          kind: 'capabilityCall',
          capabilityVersionId: addItemId,
          inputSchema: { required: {} },
          arguments: {
            check_id: { source: 'stepOutput', stepId: 'start-ticket', path: ['id'] },
            item_id: { source: 'input', path: ['item_id'] },
            quantity: { source: 'input', path: ['quantity'] },
          },
        },
        {
          id: 'send-order',
          kind: 'capabilityCall',
          capabilityVersionId: sendOrderId,
          inputSchema: { required: {} },
          arguments: { check_id: { source: 'stepOutput', stepId: 'start-ticket', path: ['id'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });
    const original = structuredClone(source);
    const projection = await readPlannerCapabilityProjection(pool, 'org_atlas', 'production');
    const app = createApp(pool);
    const response = await app.request('/v1/workflow-edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        projectionFingerprint: projection.fingerprint,
        sourceWorkflowVersionId: source.workflowVersionId,
        executable: source.executable,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
      body.draft.executable.steps
        .slice(0, 4)
        .map((step: { idempotency?: unknown }) => step.idempotency),
    ).toEqual(
      Array.from({ length: 4 }, () => ({
        businessKey: { source: 'input', path: ['atlasWorkflowRunId'] },
      })),
    );
    expect(body.draft.workflowVersionId).not.toBe(source.workflowVersionId);
    expect(body.draft.irHash).not.toBe(source.irHash);
    expect(source).toEqual(original);
    expect(source.executable.steps.some((step) => 'idempotency' in step)).toBe(false);
  });

  it('preserves an explicit business key when mapping a required provider idempotency field', async () => {
    const businessKey = { source: 'input' as const, path: ['payment_event_id'] };
    const model: PlannerModel = {
      async extractIntent() {
        return {
          ...intentFrame,
          summary: 'Take payment for a check.',
          requiredInputs: ['check_id', 'amount', 'payment_event_id'],
        };
      },
      async draftWorkflow(input) {
        return {
          kind: 'workflowDraft',
          intentFingerprint: input.intentFingerprint,
          projectionFingerprint: input.projection.fingerprint,
          draft: await compileWorkflowVersion('payment-model-id', 'org_atlas', {
            irVersion: 2,
            inputSchema: {
              required: {
                check_id: { type: 'string' },
                amount: { type: 'integer' },
                payment_event_id: { type: 'string' },
              },
            },
            steps: [
              {
                id: 'take-payment',
                kind: 'capabilityCall',
                capabilityVersionId: createPaymentId,
                inputSchema: { required: {} },
                arguments: {
                  check_id: { source: 'input', path: ['check_id'] },
                  amount: { source: 'input', path: ['amount'] },
                },
                idempotency: { businessKey },
              },
              { id: 'complete', kind: 'terminal', state: 'completed' },
            ],
          }),
        };
      },
      async repairWorkflow() {
        throw new Error('An explicit business key should not need repair');
      },
    };
    const app = createApp(pool, { allowedHosts: [] }, model, planningAuthorizer);
    const response = await app.request('/v1/workflow-drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        request: 'Take payment for a check. Accept payment_event_id as a runtime input.',
        workflowVersionId: 'payment-key@1',
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe('validated');
    expect(body.draft.executable.steps[0].idempotency).toEqual({ businessKey });
  });

  it.each([
    { invalidReference: false, stale: false, explicitBusinessKey: false },
    { invalidReference: true, stale: false, explicitBusinessKey: false },
    { invalidReference: false, stale: true, explicitBusinessKey: false },
    { invalidReference: false, stale: false, explicitBusinessKey: true },
  ])(
    'turns a sparse pickup draft into a valid graph (invalid reference=$invalidReference, stale=$stale, explicit business key=$explicitBusinessKey)',
    async ({ invalidReference, stale, explicitBusinessKey }) => {
      const before = await readPlannerCapabilityProjection(pool, 'org_atlas', 'production');
      await pool.query(
        `UPDATE environment_capability_observations
        SET freshness_status = $1, status_reason = $2, status_changed_at = current_timestamp
        WHERE organization_id = 'org_atlas' AND environment_id = 'production'`,
        [stale ? 'stale' : 'fresh', stale ? 'discovery-failed' : 'successful-discovery'],
      );
      const projection = await readPlannerCapabilityProjection(pool, 'org_atlas', 'production');
      expect(projection.fingerprint).toBe(before.fingerprint);
      let extractionInput: Parameters<PlannerModel['extractIntent']>[0] | undefined;
      const model: PlannerModel = {
        async extractIntent(input) {
          extractionInput = input;
          return intentFrame;
        },
        async draftWorkflow(input) {
          return {
            kind: 'workflowDraft',
            intentFingerprint: input.intentFingerprint,
            projectionFingerprint: input.projection.fingerprint,
            draft: await compileWorkflowVersion('model-owned-id', 'wrong-org', {
              irVersion: 2,
              inputSchema: {
                required: {
                  item_id: { type: 'string' },
                  ...(explicitBusinessKey ? { order_event_id: { type: 'string' as const } } : {}),
                },
              },
              steps: [
                {
                  id: 'open-order',
                  kind: 'capabilityCall',
                  capabilityVersionId: createFulfillmentId,
                  inputSchema: { required: {} },
                  arguments: invalidReference
                    ? {
                        location_id: {
                          source: 'stepOutput',
                          stepId: 'send-kitchen',
                          path: ['location_id'],
                        },
                      }
                    : {},
                  irreversibleAfter: true,
                  ...(explicitBusinessKey
                    ? {
                        idempotency: {
                          businessKey: { source: 'input' as const, path: ['order_event_id'] },
                        },
                      }
                    : {}),
                },
                {
                  id: 'start-ticket',
                  kind: 'capabilityCall',
                  capabilityVersionId: createCheckId,
                  inputSchema: { required: {} },
                  arguments: explicitBusinessKey
                    ? { idempotency_key: { source: 'input', path: ['order_event_id'] } }
                    : {},
                  irreversibleAfter: true,
                },
                {
                  id: 'add-burger',
                  kind: 'capabilityCall',
                  capabilityVersionId: addItemId,
                  inputSchema: { required: {} },
                  arguments: explicitBusinessKey
                    ? {
                        idempotency_key: {
                          kind: 'call',
                          function: 'concat',
                          arguments: [
                            { source: 'literal', value: 'item-' },
                            { source: 'input', path: ['order_event_id'] },
                          ],
                        },
                      }
                    : {},
                  irreversibleAfter: true,
                },
                {
                  id: 'send-kitchen',
                  kind: 'capabilityCall',
                  capabilityVersionId: sendOrderId,
                  inputSchema: { required: {} },
                  arguments: {},
                  irreversibleAfter: true,
                },
                { id: 'complete', kind: 'terminal', state: 'completed' },
              ],
            }),
          };
        },
        async repairWorkflow() {
          throw new Error('A short pickup request should not need repair');
        },
      };

      const planningApp = createApp(pool, { allowedHosts: [] }, model, planningAuthorizer);
      const response = await planningApp.request('/v1/workflow-drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          request: shortPrompt,
          workflowVersionId: 'pos-pickup@1',
        }),
      });

      const body = (await response.json()) as {
        status: string;
        reason?: string;
        draft?: {
          executable: {
            inputSchema: { required: Record<string, unknown> };
            steps: Array<{
              id: string;
              kind: string;
              capabilityVersionId?: string;
              arguments?: Record<string, unknown>;
              idempotency?: unknown;
              retryPolicy?: unknown;
            }>;
          };
        };
      };
      if (response.status !== 200) {
        throw new Error(`draft failed ${response.status}: ${JSON.stringify(body)}`);
      }
      expect(response.status).toBe(200);
      expect(body.status).toBe('validated');
      expect(extractionInput?.capabilityIndex.capabilities[0]?.observation).toMatchObject({
        freshness: stale ? 'stale' : 'fresh',
        reason: stale ? 'discovery-failed' : 'successful-discovery',
      });
      expect(extractionInput?.capabilityIndex.capabilities.map(({ summary }) => summary)).toEqual(
        expect.arrayContaining([
          'Open a pickup or delivery order',
          'Start a kitchen ticket',
          'Add an item to the ticket',
          'Send the ticket to the kitchen',
        ]),
      );
      const steps = body.draft?.executable.steps ?? [];
      expect(steps.map((step) => step.kind)).toEqual([
        'capabilityCall',
        'capabilityCall',
        'capabilityCall',
        'capabilityCall',
        'terminal',
      ]);
      expect(steps.map((step) => step.capabilityVersionId).filter(Boolean)).toEqual([
        createFulfillmentId,
        createCheckId,
        addItemId,
        sendOrderId,
      ]);
      expect(steps.slice(0, 4).map((step) => step.retryPolicy)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
      ]);
      expect(steps.slice(0, 4).map((step) => step.idempotency)).toEqual(
        Array.from({ length: 4 }, (_, index) => ({
          businessKey: {
            source: 'input',
            path: [explicitBusinessKey && index < 2 ? 'order_event_id' : 'atlasWorkflowRunId'],
          },
        })),
      );
      expect(steps[0]?.arguments).toMatchObject({
        type: { source: 'literal', value: 'pickup' },
        location_id: { source: 'input', path: ['location_id'] },
      });
      expect(steps[1]?.arguments).toMatchObject({
        fulfillment_id: { source: 'stepOutput', stepId: 'open-order', path: ['id'] },
        server_id: { source: 'input', path: ['server_id'] },
      });
      expect(steps[2]?.arguments).toMatchObject({
        check_id: { source: 'stepOutput', stepId: 'start-ticket', path: ['id'] },
        item_id: { source: 'input', path: ['item_id'] },
        quantity: { source: 'input', path: ['quantity'] },
      });
      expect(steps[3]?.arguments).toMatchObject({
        check_id: { source: 'stepOutput', stepId: 'start-ticket', path: ['id'] },
      });
      expect(Object.keys(body.draft?.executable.inputSchema.required ?? {}).sort()).toEqual([
        'item_id',
        'location_id',
        ...(explicitBusinessKey ? ['order_event_id'] : []),
        'quantity',
        'server_id',
      ]);
      const editorPath = `/v1/workflow-editor-drafts/pickup-${invalidReference}-${stale}-${explicitBusinessKey}`;
      const references = await planningApp.request(
        '/v1/planner-capability-references?organizationId=org_atlas&environmentId=production',
      );
      expect(await references.json()).toMatchObject({
        status: 'ok',
        references: expect.arrayContaining([
          expect.objectContaining({
            capabilityVersionId: createFulfillmentId,
            observation: expect.objectContaining({
              freshness: stale ? 'stale' : 'fresh',
              reason: stale ? 'discovery-failed' : 'successful-discovery',
            }),
          }),
        ]),
      });
      const draft = versionedCompiledWorkflowVersionSchema.parse(body.draft);
      const scope = { organizationId: 'org_atlas', environmentId: 'production' };
      const saved = await planningApp.request(editorPath, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          name: 'Pickup from last known definitions',
          expectedRevision: null,
          document: {
            executable: {
              ...draft.executable,
              irVersion: 3,
              startStepId: 'open-order',
              steps: draft.executable.steps.map((step, index) =>
                step.kind === 'terminal'
                  ? step
                  : {
                      ...step,
                      next: draft.executable.steps[index + 1]!.id,
                    },
              ),
            },
            layout: {},
            labels: {},
            notes: [],
            trigger: { type: 'manual' },
          },
        }),
      });
      expect(saved.status).toBe(200);
      const version = await planningApp.request(`${editorPath}/versions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...scope,
          expectedRevision: 1,
          projectionFingerprint: before.fingerprint,
        }),
      });
      expect(version.status).toBe(201);
      const created = await version.json();
      expect(created.draft.executable.irVersion).toBe(3);
      expect(created.review.approval).toMatchObject({
        enabled: false,
      });
      expect(
        created.review.approval.diagnostics.some(
          (diagnostic: { code: string }) => diagnostic.code === 'CAPABILITY_OBSERVATION_STALE',
        ),
      ).toBe(stale);
      expect(created.review.approval.diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'compileError' })]),
      );
      const keys = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
      const approvalApp = createApp(pool, undefined, undefined, undefined, {
        approvalAuthorizer: {
          async authorize() {
            return { actorId: 'admin', role: 'admin' };
          },
        },
        workerAuthorizer: {
          async authorize() {
            return false;
          },
        },
        executionGrantIssuer: {
          async issueForRun() {
            throw new Error('Drafting must not issue an execution grant');
          },
        },
        bundleSigner: createNonProductionLocalEd25519Signer('stale-draft-test', keys.privateKey),
      });
      const approve = (extra: Record<string, unknown> = {}) =>
        approvalApp.request('/v1/workflow-approvals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...scope,
            draft: created.draft,
            projectionFingerprint: before.fingerprint,
            ...extra,
          }),
        });
      const denied = await approve();
      expect(denied.status).toBe(422);
      const approvalResult = await denied.json();
      expect(approvalResult.error).toBe(
        stale ? 'workflow-not-approvable' : 'workflow-sandbox-tests-unavailable',
      );
      expect(
        (approvalResult.diagnostics ?? []).some(
          (diagnostic: { code: string }) => diagnostic.code === 'CAPABILITY_OBSERVATION_STALE',
        ),
      ).toBe(stale);
      expect((await approve({ purpose: 'draft' })).status).toBe(400);
      expect((await pool.query('SELECT 1 FROM workflow_approvals')).rowCount).toBe(0);
    },
  );
});
