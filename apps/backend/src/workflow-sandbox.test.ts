import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import {
  workflowSandboxRuntimeVersion,
  workflowSandboxTargetEvidence,
  workflowSandboxWorkerVersion,
  type WorkflowSandboxProgressWire,
} from '@atlas/demo-estate';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

import { createApp } from './app.js';
import { createExecutionGrantIssuer } from './execution-grant-issuer.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import { generateExecutionGrantKeyPair } from '@atlas/execution-grant';
import {
  generateWorkflowSandboxTests,
  readWorkflowSandboxReadinessForArtifact,
  requirePassingWorkflowSandboxTests,
  runWorkflowSandboxTests,
  sandboxSetupStaleDiagnostics,
  WorkflowSandboxTestsUnavailable,
  type WorkflowSandboxExecutor,
  type WorkflowSandboxSetupBinding,
} from './workflow-sandbox.js';
import { deterministicTestExecutionMethods } from './workflow-sandbox-test-support.js';
import { installConnectedSandboxTargets } from './capability-sandbox-targets.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `workflow_sandbox_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });

const executorCalls: Parameters<WorkflowSandboxExecutor['execute']>[0][] = [];
let failingTestId: string | undefined;
let omitOutcomes = false;
let executorUnavailable = false;
let executorRuntimeVersion = workflowSandboxRuntimeVersion;
let beforeExecutorResults:
  | ((input: Parameters<WorkflowSandboxExecutor['execute']>[0]) => Promise<void>)
  | undefined;
const executor: WorkflowSandboxExecutor = {
  async execute(input) {
    if (executorUnavailable) {
      throw new WorkflowSandboxTestsUnavailable('unavailable');
    }
    executorCalls.push(input);
    await beforeExecutorResults?.(input);
    return (omitOutcomes ? input.tests.slice(1) : input.tests).map((test) => {
      const relevantBindings = input.targetBindings.filter(
        ({ capabilityVersionId }) =>
          test.kind === 'happy-path' || test.capabilityVersionId === capabilityVersionId,
      );
      return {
        testId: test.testId,
        status: test.testId === failingTestId ? ('failed' as const) : ('passed' as const),
        workerVersion: workflowSandboxWorkerVersion,
        runtimeVersion: executorRuntimeVersion,
        executionMethods:
          relevantBindings.length > 0 && test.kind !== 'compatibility'
            ? (['remote-sandbox'] as const)
            : deterministicTestExecutionMethods(test.kind),
        ...(relevantBindings.length === 0 || test.kind === 'compatibility'
          ? {}
          : {
              temporalWorkflowId: `atlas:sandbox:${input.workflowVersionId}:test`,
              temporalRunId: 'temporal-run-test',
              targetEvidence: relevantBindings.map(workflowSandboxTargetEvidence),
            }),
        ...(test.testId === failingTestId
          ? { detail: 'Provider rejected the generated mapping.' }
          : {}),
      };
    });
  },
};

const completedSetup: WorkflowSandboxSetupBinding = {
  workflowVersionId: 'payment-workflow@1',
  irHash: 'a'.repeat(64),
  capabilityVersions: [
    {
      capabilityVersionId: 'payments.get@v1',
      sourceDocumentHash: 'b'.repeat(64),
      secretAlias: 'PAYMENTS_SANDBOX_TOKEN',
    },
  ],
  suiteFingerprint: 'c'.repeat(64),
  targets: [
    {
      capabilityVersionId: 'payments.get@v1',
      targetKey: 'staging',
      targetRevision: 1,
      hostname: 'payments.example.test',
      healthPath: '/health',
      controlPaths: {
        resources: '/__control/resources',
        faults: '/__control/faults',
        observations: '/__control/observations',
      },
      secretAlias: 'PAYMENTS_SANDBOX_TOKEN',
      testDataProfileKey: 'settled-payment',
      testDataVersion: 1,
    },
  ],
  workerVersion: 'worker-v1',
  runtimeVersion: 'runtime-v1',
  executionMethods: ['remote-sandbox'],
  environmentId: 'production',
  testedAt: '2026-08-24T12:00:00.000Z',
};

describe('sandbox setup binding staleness', () => {
  it.each([
    ['artifact', { ...completedSetup, irHash: 'd'.repeat(64) }, 'workflow artifact'],
    [
      'contract',
      {
        ...completedSetup,
        capabilityVersions: [
          { ...completedSetup.capabilityVersions[0]!, sourceDocumentHash: 'd'.repeat(64) },
        ],
      },
      'capability version or source document',
    ],
    [
      'target',
      {
        ...completedSetup,
        targets: [{ ...completedSetup.targets[0]!, targetRevision: 2 }],
      },
      'provider target configuration',
    ],
    [
      'test-data',
      {
        ...completedSetup,
        targets: [{ ...completedSetup.targets[0]!, testDataVersion: 2 }],
      },
      'test-data profile',
    ],
    ['runtime', { ...completedSetup, runtimeVersion: 'runtime-v2' }, 'worker or runtime version'],
  ] as const)(
    'reports an independently changed %s binding and directs the reviewer to rerun',
    (part, current, changedPart) => {
      expect(sandboxSetupStaleDiagnostics(completedSetup, current)).toEqual([
        {
          part,
          message: expect.stringMatching(
            new RegExp(`${changedPart} changed.*Rerun the generated tests`, 'i'),
          ),
        },
      ]);
    },
  );

  it('does not rewrite or invalidate an unchanged historical binding', () => {
    const snapshot = structuredClone(completedSetup);
    expect(sandboxSetupStaleDiagnostics(completedSetup, structuredClone(completedSetup))).toEqual(
      [],
    );
    expect(completedSetup).toEqual(snapshot);
  });
});

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 64 });
  await pool.query(`
    TRUNCATE organizations RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas');
  `);
  await registerCapability('payments.get@v1', 'payments', 'getPayment', false, false);
  await registerCapability('stripe.create@v1', 'stripe', 'PostPaymentIntents', true, true);
  await pool.query(
    `INSERT INTO environments (organization_id, id, name, kind)
     VALUES ('org_atlas', 'production', 'Sandbox', 'production')`,
  );
  await pool.query(
    `INSERT INTO capability_host_policies
      (organization_id, capability_identity_id, environment_id, hostname, allow_redirects, approved_by)
     SELECT 'org_atlas', capability_identity_id, 'production',
            'billing-staging.example.test', false, 'admin@example.com'
     FROM capability_versions
     WHERE organization_id = 'org_atlas' AND capability_version_id = 'payments.get@v1'`,
  );
  const keyPair = await generateExecutionGrantKeyPair();
  app = createApp(
    pool,
    { allowedHosts: [] },
    undefined,
    {
      async authorize({ authorizationHeader, body }) {
        if (
          authorizationHeader !== 'Bearer author-token' ||
          !body ||
          typeof body !== 'object' ||
          !('organizationId' in body) ||
          body.organizationId !== 'org_atlas'
        ) {
          return null;
        }
        return 'author';
      },
    },
    {
      approvalAuthorizer: {
        async authorize({ authorizationHeader, organizationId }) {
          return authorizationHeader === 'Bearer admin-token' && organizationId === 'org_atlas'
            ? { actorId: 'admin@example.com', role: 'admin' as const }
            : null;
        },
      },
      workerAuthorizer: {
        async authorize() {
          return false;
        },
      },
      executionGrantIssuer: createExecutionGrantIssuer(keyPair.privateKey),
    },
    undefined,
    { workflowSandboxExecutor: executor },
  );
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await pool.end();
});

describe('workflow sandbox test API', () => {
  it('does not invent optional request fields in generated compatibility samples', async () => {
    const draft = await createCompiledWorkflowVersion('optional-sample@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: {} },
      steps: [
        {
          id: 'create',
          kind: 'capabilityCall',
          capabilityVersionId: 'fulfillment@1',
          arguments: {},
        },
        { id: 'done', kind: 'terminal', state: 'completed' },
      ],
    });
    const tests = generateWorkflowSandboxTests(draft, [
      {
        capabilityVersionId: 'fulfillment@1',
        serviceId: 'burger-town',
        operationId: 'createFulfillment',
        documentHash: 'a'.repeat(64),
        provider: 'burger-town',
        mode: 'local',
        method: 'post',
        path: '/fulfillments',
        requestSchema: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['pickup'] },
            pickup_at: { type: 'string', format: 'date-time' },
          },
        },
        responseSchema: null,
      },
    ]);
    expect(tests.find(({ kind }) => kind === 'compatibility')?.requestSample).toEqual({
      type: 'pickup',
    });
  });

  it.each([
    {
      environmentId: 'production',
      sharedOrigin: false,
      metadataMatches: true,
      expectedStatus: 201,
    },
    {
      environmentId: 'development',
      sharedOrigin: true,
      metadataMatches: true,
      expectedStatus: 201,
    },
    { environmentId: 'production', sharedOrigin: true, metadataMatches: true, expectedStatus: 400 },
    {
      environmentId: 'development',
      sharedOrigin: true,
      metadataMatches: false,
      expectedStatus: 400,
    },
  ])(
    'checks a connected sandbox with %j',
    async ({ environmentId, sharedOrigin, metadataMatches, expectedStatus }) => {
      const metadata = {
        healthPath: '/health',
        controlPaths: {
          resources: '/v1/__control/resources',
          faults: '/v1/__control/faults',
          observations: '/v1/__control/observations',
        },
        inputs: { paymentId: 'pay_sandbox' },
        targetState: { mode: 'replace', resources: [] },
        setupAssumptions: [{ path: ['setup', 'ready'], equals: true }],
      };
      await pool.query(
        `INSERT INTO environments (organization_id, id, name, kind)
       VALUES ('org_atlas', 'development', 'Development', 'development') ON CONFLICT DO NOTHING`,
      );
      await pool.query(
        `INSERT INTO capability_host_policies
        (organization_id, capability_identity_id, environment_id, hostname, allow_redirects, approved_by)
       SELECT 'org_atlas', capability_identity_id, 'development',
              'billing-staging.example.test', false, 'admin@example.com'
       FROM capability_versions WHERE capability_version_id = 'payments.get@v1'
       ON CONFLICT DO NOTHING`,
      );
      await pool.query(
        `UPDATE source_documents SET document = document || jsonb_build_object('x-atlas-sandbox', $1::jsonb)
       WHERE organization_id = 'org_atlas' AND service_id = 'payments'`,
        [JSON.stringify(metadataMatches ? metadata : { ...metadata, healthPath: '/different' })],
      );
      if (sharedOrigin) {
        await pool.query(
          `INSERT INTO capability_execution_bindings
          (organization_id, environment_id, capability_identity_id, base_url, configured_by)
         SELECT organization_id, $1, capability_identity_id,
                'https://billing-staging.example.test:43123/v1', 'admin@example.com'
         FROM capability_versions WHERE capability_version_id = 'payments.get@v1'`,
          [environmentId],
        );
      }
      await installConnectedSandboxTargets(pool, {
        organizationId: 'org_atlas',
        environmentId,
        applicationUrl: 'https://billing-staging.example.test:43123',
        capabilityVersionIds: ['payments.get@v1'],
        actorId: 'admin',
        metadata,
      });
      try {
        const draft = await createCompiledWorkflowVersion('connected-sandbox@1', 'org_atlas', {
          irVersion: 1,
          inputSchema: { required: { paymentId: { type: 'string' } } },
          steps: [
            {
              id: 'get-payment',
              kind: 'capabilityCall',
              capabilityVersionId: 'payments.get@v1',
              arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
            },
            { id: 'done', kind: 'terminal', state: 'completed' },
          ],
        });
        const response = await app.request('/v1/workflow-sandbox-tests', {
          method: 'POST',
          headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId: 'org_atlas', environmentId, draft }),
        });
        expect(response.status).toBe(expectedStatus);
        await expect(response.json()).resolves.toMatchObject(
          expectedStatus === 201
            ? {
                status: 'passed',
                targetBindings: [
                  {
                    capabilityVersionId: 'payments.get@v1',
                    targetKey: 'connected-source',
                    targetRevision: 1,
                  },
                ],
              }
            : { error: 'invalid-workflow-sandbox-target' },
        );
        expect(executorCalls.map(({ targetBindings }) => targetBindings[0]?.baseUrl)).toEqual(
          expectedStatus === 201 ? ['https://billing-staging.example.test:43123'] : [],
        );
      } finally {
        await pool.query(
          `DELETE FROM capability_execution_bindings WHERE organization_id = 'org_atlas' AND environment_id = $1`,
          [environmentId],
        );
        await pool.query(
          `UPDATE source_documents SET document = document - 'x-atlas-sandbox' WHERE organization_id = 'org_atlas' AND service_id = 'payments'`,
        );
        await pool.query(
          "DELETE FROM capability_sandbox_target_revisions WHERE target_key = 'connected-source'",
        );
        await pool.query(
          "DELETE FROM capability_test_data_profile_versions WHERE profile_key = 'connected-source'",
        );
        executorCalls.length = 0;
      }
    },
  );

  it('generates a default-route fault distinct from every declared error type', async () => {
    const draft = await createCompiledWorkflowVersion('routing-collision@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'first',
          kind: 'capabilityCall',
          capabilityVersionId: 'payments.get@v1',
          arguments: {},
        },
        {
          id: 'second',
          kind: 'capabilityCall',
          capabilityVersionId: 'stripe.create@v1',
          arguments: {},
          errorRouting: {
            rules: [
              {
                errorTypes: ['SandboxUnmatchedFailure'],
                action: {
                  kind: 'land',
                  outcome: 'repair_required',
                  reasonCode: 'declared-route',
                },
              },
            ],
            defaultAction: {
              kind: 'preserveAndLand',
              outcome: 'manual_review',
              reasonCode: 'default-route',
            },
          },
        },
        { id: 'done', kind: 'terminal', state: 'completed' },
      ],
    });
    const generated = generateWorkflowSandboxTests(draft, []);
    const errorTypes = generated
      .filter(({ kind }) => kind === 'partial-failure')
      .map(({ failureErrorType }) => failureErrorType);
    expect(errorTypes).toEqual(['SandboxUnmatchedFailure', 'SandboxUnmatchedFailure_']);
  });

  it('routes AsyncAPI invoice.paid checks to the local events HTTP path', async () => {
    await registerEventsCapability();
    const draft = await createCompiledWorkflowVersion('publish-invoice-paid@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: {
        required: {
          paymentId: { type: 'string' },
          invoiceId: { type: 'string' },
          atlasWorkflowRunId: { type: 'string' },
        },
      },
      steps: [
        {
          id: 'publish_invoice_paid',
          kind: 'capabilityCall',
          capabilityVersionId: 'events.invoice-paid@v1',
          arguments: {
            eventId: { source: 'input', path: ['atlasWorkflowRunId'] },
            eventType: { source: 'literal', value: 'invoice.paid' },
            invoiceId: { source: 'input', path: ['invoiceId'] },
            paymentId: { source: 'input', path: ['paymentId'] },
            atlasWorkflowRunId: { source: 'input', path: ['atlasWorkflowRunId'] },
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    executorCalls.length = 0;
    const response = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
      }),
    });
    expect(response.status).toBe(201);
    expect(executorCalls[0]?.providerContracts).toEqual([
      expect.objectContaining({
        capabilityVersionId: 'events.invoice-paid@v1',
        operationId: 'publishInvoicePaid',
        method: 'post',
        path: '/events/invoice.paid',
      }),
    ]);
  });

  it('lets an author who can Draft run checks, and rejects an operator', async () => {
    const draft = await workflow('author-draft-checks@1');
    const authorResponse = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
      }),
    });
    const operatorResponse = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
      }),
    });

    expect(authorResponse.status).toBe(201);
    expect(((await authorResponse.json()) as { status: string }).status).toBe('passed');
    expect(operatorResponse.status).toBe(403);
    await expect(operatorResponse.json()).resolves.toEqual({ error: 'author-role-required' });
  });

  it('starts and reads an asynchronous check request without running it twice', async () => {
    executorCalls.length = 0;
    const draft = await workflow('async-check-request@1');
    const requestId = crypto.randomUUID();
    const url = `/v1/workflow-sandbox-test-requests/${requestId}?organizationId=org_atlas&environmentId=production`;
    const start = await app.request(url, {
      method: 'PUT',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
      }),
    });
    expect(start.status).toBe(201);
    await expect(start.json()).resolves.toMatchObject({ requestId, status: 'running' });

    let state: { status?: string; result?: { workflowVersionId?: string } } = {};
    for (let attempt = 0; attempt < 50 && state.status !== 'passed'; attempt += 1) {
      const response = await app.request(url, {
        headers: { authorization: 'Bearer admin-token' },
      });
      expect(response.status).toBe(200);
      state = await response.json();
      if (state.status === 'running') await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(state).toMatchObject({
      status: 'passed',
      result: { workflowVersionId: draft.workflowVersionId },
    });
    expect(executorCalls).toHaveLength(1);
  });

  it('polls live check progress before the executor finishes and only then stores results', async () => {
    const entered = Promise.withResolvers<Parameters<WorkflowSandboxExecutor['execute']>[0]>();
    const finish = Promise.withResolvers<void>();
    beforeExecutorResults = async (input) => {
      entered.resolve(input);
      await finish.promise;
    };
    try {
      const draft = await workflow('async-progress@1');
      const url = `/v1/workflow-sandbox-test-requests/${crypto.randomUUID()}?organizationId=org_atlas&environmentId=production`;
      const start = await app.request(url, {
        method: 'PUT',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_atlas', environmentId: 'production', draft }),
      });
      expect(start.status).toBe(201);
      expect(await start.json()).toMatchObject({
        status: 'running',
        progress: { phase: 'preparing', completed: 0, total: 0 },
      });
      const input = await entered.promise;
      const read = async () =>
        (await app.request(url, { headers: { authorization: 'Bearer admin-token' } })).json();
      expect(await read()).toMatchObject({
        status: 'running',
        progress: { phase: 'running', completed: 0, total: input.tests.length },
      });
      for (const completed of [1, 2]) {
        const current = input.tests[completed]!;
        const progress: WorkflowSandboxProgressWire = {
          phase: 'running',
          completed,
          total: input.tests.length,
          currentTest: { kind: current.kind, stepId: current.stepId },
        };
        input.onProgress?.(progress);
        const state = await read();
        expect(state).toMatchObject({ status: 'running', progress });
        expect(state.result).toBeUndefined();
      }
      expect(
        (
          await pool.query(
            'SELECT 1 FROM workflow_sandbox_test_runs WHERE workflow_version_id = $1',
            [draft.workflowVersionId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (await app.request(url, { headers: { authorization: 'Bearer author-token' } })).status,
      ).toBe(404);
      finish.resolve();
      await vi.waitFor(async () =>
        expect(await read()).toMatchObject({
          status: 'passed',
          progress: {
            phase: 'finalizing',
            completed: input.tests.length,
            total: input.tests.length,
          },
          result: { workflowVersionId: draft.workflowVersionId },
        }),
      );
    } finally {
      finish.resolve();
      beforeExecutorResults = undefined;
    }
  });

  it('does not report finalizing or store checks when runner outcomes are incomplete', async () => {
    const progress: WorkflowSandboxProgressWire[] = [];
    const draft = await workflow('incomplete-progress@1');
    await expect(
      runWorkflowSandboxTests(
        pool,
        {
          async execute(input) {
            input.onProgress?.({
              phase: 'running',
              completed: input.tests.length,
              total: input.tests.length,
            });
            input.onProgress?.({
              phase: 'finalizing',
              completed: input.tests.length,
              total: input.tests.length,
            });
            return [];
          },
        },
        { organizationId: 'org_atlas', environmentId: 'production', draft },
        'admin@example.com',
        undefined,
        (update) => progress.push(update),
      ),
    ).rejects.toThrow('incomplete or unexpected results');
    expect(progress[0]).toEqual({ phase: 'preparing', completed: 0, total: 0 });
    expect(progress[1]).toMatchObject({
      phase: 'preparing',
      completed: 0,
      total: expect.any(Number),
    });
    expect(progress.some(({ phase }) => phase === 'finalizing')).toBe(false);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM workflow_sandbox_test_runs WHERE workflow_version_id = $1',
          [draft.workflowVersionId],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('generates relevant cases, executes them, and binds passing evidence to the exact artifact', async () => {
    executorCalls.length = 0;
    const draft = await workflow('checkout@1');
    await expect(
      requirePassingWorkflowSandboxTests(
        pool,
        { organizationId: 'org_atlas', environmentId: 'production' },
        draft,
      ),
    ).rejects.toMatchObject({ readinessStatus: 'missing' });
    const response = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      workflowVersionId: string;
      irHash: string;
      status: string;
      tests: Array<{ kind: string; status: string; executionMethods: string[] }>;
      providerContracts: Array<{ capabilityVersionId: string; documentHash: string }>;
    };
    expect(body).toMatchObject({
      workflowVersionId: draft.workflowVersionId,
      irHash: draft.irHash,
      status: 'passed',
    });
    expect(new Set(body.tests.map(({ kind }) => kind))).toEqual(
      new Set([
        'happy-path',
        'contract-mapping',
        'authentication',
        'retry',
        'rate-limit',
        'timeout',
        'duplicate-event',
        'partial-failure',
        'compatibility',
      ]),
    );
    expect(body.tests.every(({ status }) => status === 'passed')).toBe(true);
    expect(body.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'happy-path',
          executionMethods: ['local-test-service'],
        }),
        expect.objectContaining({
          kind: 'contract-mapping',
          capabilityVersionId: 'stripe.create@v1',
          executionMethods: ['local-test-service'],
        }),
        expect.objectContaining({
          kind: 'compatibility',
          capabilityVersionId: 'stripe.create@v1',
          executionMethods: ['static-validation'],
        }),
      ]),
    );
    expect(body.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'contract-mapping',
          capabilityVersionId: 'stripe.create@v1',
          requestSample: { amount: 100, currency: 'USD' },
          expectedResponseSchema: expect.objectContaining({ required: ['id'] }),
        }),
      ]),
    );
    expect(body.providerContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityVersionId: 'payments.get@v1',
          documentHash: '1'.repeat(64),
        }),
        expect.objectContaining({
          capabilityVersionId: 'stripe.create@v1',
          documentHash: '2'.repeat(64),
        }),
      ]),
    );
    expect(executorCalls).toHaveLength(1);
    expect(executorCalls[0]).toMatchObject({
      workflowVersionId: draft.workflowVersionId,
      irHash: draft.irHash,
    });

    const readiness = await app.request(
      `/v1/workflow-sandbox-tests/readiness?organizationId=org_atlas&environmentId=production&workflowVersionId=${draft.workflowVersionId}&irHash=${draft.irHash}`,
    );
    await expect(readiness.json()).resolves.toMatchObject({
      ready: true,
      status: 'passed',
      tests: expect.arrayContaining([
        expect.objectContaining({
          kind: 'contract-mapping',
          capabilityVersionId: 'stripe.create@v1',
          executionMethods: ['local-test-service'],
        }),
      ]),
    });

    await pool.query(
      `UPDATE source_documents SET document_hash = $1
       WHERE organization_id = 'org_atlas' AND service_id = 'payments'`,
      ['9'.repeat(64)],
    );
    const contractStale = await readWorkflowSandboxReadinessForArtifact(
      pool,
      { organizationId: 'org_atlas', environmentId: 'production' },
      draft,
    );
    expect(contractStale).toMatchObject({
      ready: false,
      status: 'stale',
      staleDiagnostics: expect.arrayContaining([expect.objectContaining({ part: 'contract' })]),
    });
    await expect(
      requirePassingWorkflowSandboxTests(
        pool,
        { organizationId: 'org_atlas', environmentId: 'production' },
        draft,
      ),
    ).rejects.toMatchObject({ readinessStatus: 'stale' });
    await pool.query(
      `UPDATE source_documents SET document_hash = $1
       WHERE organization_id = 'org_atlas' AND service_id = 'payments'`,
      ['1'.repeat(64)],
    );

    await pool.query(
      `UPDATE workflow_sandbox_test_runs SET suite_fingerprint = $1
       WHERE organization_id = 'org_atlas' AND workflow_version_id = $2`,
      ['0'.repeat(64), draft.workflowVersionId],
    );
    await expect(
      requirePassingWorkflowSandboxTests(
        pool,
        { organizationId: 'org_atlas', environmentId: 'production' },
        draft,
      ),
    ).rejects.toMatchObject({ readinessStatus: 'stale' });

    const edited = await createCompiledWorkflowVersion('checkout@1', 'org_atlas', {
      ...draft.executable,
      steps: [...draft.executable.steps].reverse(),
    });
    const stale = await app.request(
      `/v1/workflow-sandbox-tests/readiness?organizationId=org_atlas&environmentId=production&workflowVersionId=${edited.workflowVersionId}&irHash=${edited.irHash}`,
    );
    await expect(stale.json()).resolves.toMatchObject({ ready: false, status: 'stale' });
  });

  it('keeps approval blocked when any required provider case fails', async () => {
    const draft = await workflow('checkout-failure@1');
    failingTestId = 'contract-mapping:get-payment:payments.get@v1';
    const response = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
      }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ status: 'failed' });
    await expect(
      requirePassingWorkflowSandboxTests(
        pool,
        { organizationId: 'org_atlas', environmentId: 'production' },
        draft,
      ),
    ).rejects.toMatchObject({ readinessStatus: 'failed' });
    failingTestId = undefined;
  });

  it('blocks approval when a passing result came from an outdated runtime', async () => {
    const draft = await workflow('checkout-old-runtime@1');
    executorRuntimeVersion = 'temporal-adapter-v0';
    try {
      const response = await app.request('/v1/workflow-sandbox-tests', {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          draft,
        }),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ status: 'passed' });

      const runtimeStale = await readWorkflowSandboxReadinessForArtifact(
        pool,
        { organizationId: 'org_atlas', environmentId: 'production' },
        draft,
      );
      expect(runtimeStale).toMatchObject({
        ready: false,
        status: 'stale',
        staleDiagnostics: expect.arrayContaining([expect.objectContaining({ part: 'runtime' })]),
      });
      await expect(
        requirePassingWorkflowSandboxTests(
          pool,
          { organizationId: 'org_atlas', environmentId: 'production' },
          draft,
        ),
      ).rejects.toMatchObject({ readinessStatus: 'stale' });
    } finally {
      executorRuntimeVersion = workflowSandboxRuntimeVersion;
    }
  });

  it('configures immutable internal sandbox target and test-data revisions and binds them to remote evidence', async () => {
    const targetResponse = await app.request('/v1/capability-sandbox-targets', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        capabilityVersionId: 'payments.get@v1',
        targetKey: 'billing-staging',
        baseUrl: 'https://billing-staging.example.test',
        healthPath: '/ready',
        secretAlias: null,
      }),
    });
    expect(targetResponse.status).toBe(201);
    await expect(targetResponse.json()).resolves.toMatchObject({
      capabilityVersionId: 'payments.get@v1',
      targetKey: 'billing-staging',
      revision: 1,
      hostname: 'billing-staging.example.test',
    });

    const profileResponse = await app.request('/v1/capability-test-data-profiles', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        capabilityVersionId: 'payments.get@v1',
        profileKey: 'paid-invoice',
        inputs: { paymentId: 'pay_sandbox' },
        targetState: {
          mode: 'replace',
          resources: [
            {
              service: 'payments',
              collection: 'payments',
              id: 'pay_sandbox',
              document: { paymentId: 'pay_sandbox', status: 'succeeded' },
            },
          ],
        },
        setupAssumptions: [
          { path: ['payments', 0, 'paymentId'], equals: 'pay_sandbox' },
          { path: ['payments', 0, 'status'], equals: 'succeeded' },
        ],
      }),
    });
    expect(profileResponse.status).toBe(201);
    await expect(profileResponse.json()).resolves.toMatchObject({
      capabilityVersionId: 'payments.get@v1',
      profileKey: 'paid-invoice',
      version: 1,
    });

    const draft = await createCompiledWorkflowVersion('internal-remote@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'payments.get@v1',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        {
          id: 'create-intent',
          kind: 'capabilityCall',
          capabilityVersionId: 'stripe.create@v1',
          arguments: {
            amount: { source: 'stepOutput', stepId: 'get-payment', path: ['amount'] },
            currency: { source: 'literal', value: 'USD' },
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    const runResponse = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
        targetSelections: [
          {
            capabilityVersionId: 'payments.get@v1',
            targetKey: 'billing-staging',
            targetRevision: 1,
            testDataProfileKey: 'paid-invoice',
            testDataVersion: 1,
          },
        ],
      }),
    });
    expect(runResponse.status).toBe(201);
    const runBody = (await runResponse.json()) as {
      status: string;
      targetBindings: unknown[];
      tests: Array<Record<string, unknown>>;
    };
    expect(runBody).toMatchObject({
      status: 'passed',
      targetBindings: [
        {
          capabilityVersionId: 'payments.get@v1',
          targetKey: 'billing-staging',
          targetRevision: 1,
          testDataProfileKey: 'paid-invoice',
          testDataVersion: 1,
        },
      ],
    });
    expect(runBody.tests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'happy-path',
          executionMethods: ['remote-sandbox'],
          targetEvidence: [
            expect.objectContaining({
              capabilityVersionId: 'payments.get@v1',
              targetRevision: 1,
              testDataVersion: 1,
            }),
          ],
        }),
        expect.objectContaining({
          kind: 'contract-mapping',
          capabilityVersionId: 'stripe.create@v1',
          executionMethods: ['local-test-service'],
        }),
      ]),
    );
    expect(
      runBody.tests.find(
        ({ kind, capabilityVersionId }) =>
          kind === 'contract-mapping' && capabilityVersionId === 'stripe.create@v1',
      ),
    ).not.toHaveProperty('targetEvidence');

    const identity = await pool.query<{ capability_version_id: string }>(
      `SELECT trim(capability_version_id) AS capability_version_id FROM capability_versions
       WHERE organization_id = 'org_atlas' AND capability_version_id = 'payments.get@v1'`,
    );
    expect(identity.rows).toEqual([{ capability_version_id: 'payments.get@v1' }]);

    const revisedTargetResponse = await app.request('/v1/capability-sandbox-targets', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        capabilityVersionId: 'payments.get@v1',
        targetKey: 'billing-staging',
        baseUrl: 'https://billing-staging.example.test',
        healthPath: '/health',
        secretAlias: null,
      }),
    });
    expect(revisedTargetResponse.status).toBe(201);
    const targetStale = await readWorkflowSandboxReadinessForArtifact(
      pool,
      { organizationId: 'org_atlas', environmentId: 'production' },
      draft,
    );
    expect(targetStale).toMatchObject({
      ready: false,
      status: 'stale',
      staleDiagnostics: expect.arrayContaining([expect.objectContaining({ part: 'target' })]),
    });
    await expect(
      requirePassingWorkflowSandboxTests(
        pool,
        { organizationId: 'org_atlas', environmentId: 'production' },
        draft,
      ),
    ).rejects.toMatchObject({ readinessStatus: 'stale' });

    const rerunResponse = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
        targetSelections: [
          {
            capabilityVersionId: 'payments.get@v1',
            targetKey: 'billing-staging',
            targetRevision: 2,
            testDataProfileKey: 'paid-invoice',
            testDataVersion: 1,
          },
        ],
      }),
    });
    expect(rerunResponse.status).toBe(201);

    const revisedProfileResponse = await app.request('/v1/capability-test-data-profiles', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        capabilityVersionId: 'payments.get@v1',
        profileKey: 'paid-invoice',
        inputs: { paymentId: 'pay_sandbox' },
        targetState: {
          mode: 'replace',
          resources: [
            {
              service: 'payments',
              collection: 'payments',
              id: 'pay_sandbox',
              document: { paymentId: 'pay_sandbox', status: 'succeeded' },
            },
          ],
        },
        setupAssumptions: [
          { path: ['payments', 0, 'paymentId'], equals: 'pay_sandbox' },
          { path: ['payments', 0, 'status'], equals: 'succeeded' },
        ],
      }),
    });
    expect(revisedProfileResponse.status).toBe(201);
    const testDataStale = await readWorkflowSandboxReadinessForArtifact(
      pool,
      { organizationId: 'org_atlas', environmentId: 'production' },
      draft,
    );
    expect(testDataStale).toMatchObject({
      ready: false,
      status: 'stale',
      staleDiagnostics: expect.arrayContaining([expect.objectContaining({ part: 'test-data' })]),
    });
    await expect(
      requirePassingWorkflowSandboxTests(
        pool,
        { organizationId: 'org_atlas', environmentId: 'production' },
        draft,
      ),
    ).rejects.toMatchObject({ readinessStatus: 'stale' });

    const missingTargetResponse = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft,
        targetSelections: [
          {
            capabilityVersionId: 'payments.get@v1',
            targetKey: 'billing-staging',
            targetRevision: 99,
            testDataProfileKey: 'paid-invoice',
            testDataVersion: 1,
          },
        ],
      }),
    });
    expect(missingTargetResponse.status).toBe(400);
    await expect(missingTargetResponse.json()).resolves.toEqual({
      error: 'invalid-workflow-sandbox-target',
      message: 'Sandbox target or test-data profile is missing or no longer valid',
    });
  });

  it('refuses to use the environment runtime service as a sandbox target', async () => {
    await pool.query(
      `INSERT INTO capability_execution_bindings
        (organization_id, environment_id, capability_identity_id, base_url, configured_by)
       SELECT organization_id, 'production', capability_identity_id,
              'https://billing-production.example.test/v1', 'admin@example.com'
       FROM capability_versions
       WHERE organization_id = 'org_atlas' AND capability_version_id = 'payments.get@v1'
       ON CONFLICT (organization_id, environment_id, capability_identity_id) DO UPDATE
         SET base_url = EXCLUDED.base_url`,
    );
    try {
      const response = await app.request('/v1/capability-sandbox-targets', {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          capabilityVersionId: 'payments.get@v1',
          targetKey: 'unsafe-production-target',
          baseUrl: 'https://billing-production.example.test/test-controls',
          healthPath: '/ready',
          secretAlias: null,
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'invalid-capability-sandbox-target',
        message: 'Sandbox targets cannot use the environment runtime service',
      });
    } finally {
      await pool.query(
        `DELETE FROM capability_execution_bindings
         WHERE organization_id = 'org_atlas' AND environment_id = 'production'`,
      );
    }
  });

  it('does not turn remote configuration into evidence of remote execution', async () => {
    await pool.query(
      `UPDATE source_documents
       SET document = document || '{"x-atlas-connection":{"mode":"official-test"}}'::jsonb
       WHERE organization_id = 'org_atlas' AND service_id = 'stripe'`,
    );
    try {
      const draft = await workflow('checkout-mixed-methods@1');
      const response = await app.request('/v1/workflow-sandbox-tests', {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          draft,
        }),
      });
      const body = (await response.json()) as {
        tests: Array<{
          kind: string;
          capabilityVersionId: string | null;
          executionMethods: string[];
        }>;
      };

      expect(response.status).toBe(201);
      expect(body.tests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'happy-path',
            executionMethods: ['local-test-service'],
          }),
          expect.objectContaining({
            kind: 'contract-mapping',
            capabilityVersionId: 'payments.get@v1',
            executionMethods: ['local-test-service'],
          }),
          expect.objectContaining({
            kind: 'contract-mapping',
            capabilityVersionId: 'stripe.create@v1',
            executionMethods: ['local-test-service'],
          }),
        ]),
      );
    } finally {
      await pool.query(
        `UPDATE source_documents
         SET document = document - 'x-atlas-connection'
         WHERE organization_id = 'org_atlas' AND service_id = 'stripe'`,
      );
    }
  });

  it('rejects incomplete runner evidence instead of inventing an execution method', async () => {
    omitOutcomes = true;
    try {
      const draft = await workflow('checkout-incomplete-runner@1');
      const response = await app.request('/v1/workflow-sandbox-tests', {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          draft,
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: 'invalid-workflow-sandbox-test' });
    } finally {
      omitOutcomes = false;
    }
  });

  it('reports an unavailable check runner instead of an internal error', async () => {
    executorUnavailable = true;
    try {
      const draft = await workflow('checkout-offline-runner@1');
      const response = await app.request('/v1/workflow-sandbox-tests', {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          draft,
        }),
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: 'workflow-sandbox-tests-unavailable',
        status: 'unavailable',
      });
    } finally {
      executorUnavailable = false;
    }
  });
});

async function workflow(workflowVersionId: string) {
  return createCompiledWorkflowVersion(workflowVersionId, 'org_atlas', {
    irVersion: 1,
    inputSchema: { required: { paymentId: { type: 'string' } } },
    steps: [
      {
        id: 'get-payment',
        kind: 'capabilityCall',
        capabilityVersionId: 'payments.get@v1',
        arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        responseSchema: { required: { amount: { type: 'number' } } },
      },
      {
        id: 'create-intent',
        kind: 'capabilityCall',
        capabilityVersionId: 'stripe.create@v1',
        arguments: { amount: { source: 'stepOutput', stepId: 'get-payment', path: ['amount'] } },
        retryPolicy: {
          initialInterval: '1 second',
          backoffCoefficient: 2,
          maximumInterval: '10 seconds',
          maximumAttempts: 3,
          nonRetryableErrorTypes: ['InvalidRequest'],
        },
        idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
      },
      { id: 'completed', kind: 'terminal', state: 'completed' },
    ],
  });
}

async function registerCapability(
  capabilityVersionId: string,
  serviceId: string,
  operationId: string,
  secret: boolean,
  thirdParty: boolean,
) {
  const source = await pool.query<{ id: string }>(
    `INSERT INTO source_documents
      (organization_id, service_id, format, document, document_hash,
       repository, commit_sha, path)
     VALUES ('org_atlas', $1, 'openapi', $2, $3, 'fixture', $4, $5)
     RETURNING id`,
    [
      serviceId,
      { openapi: '3.1.0' },
      thirdParty ? '2'.repeat(64) : '1'.repeat(64),
      `${serviceId}-v1`,
      `${serviceId}.json`,
    ],
  );
  const identity = await pool.query<{ id: string }>(
    `INSERT INTO capability_identities (organization_id, kind, service_id, operation_id)
     VALUES ('org_atlas', 'openapi', $1, $2) RETURNING id`,
    [serviceId, operationId],
  );
  const annotation = await pool.query<{ id: string }>(
    `INSERT INTO manifest_annotations
      (organization_id, capability_identity_id, annotation_hash, owner, secret_alias,
       business_semantics, idempotency_field, irreversible_after, source_document_id)
     VALUES ('org_atlas', $1, $2, 'fixture', $3, $4, $5, false, $6) RETURNING id`,
    [
      identity.rows[0]!.id,
      (thirdParty ? '4' : '3').repeat(64),
      secret ? 'PROVIDER_TOKEN' : null,
      {
        provider: thirdParty ? 'Stripe' : 'Atlas internal',
        sourceType: thirdParty ? 'third-party' : 'internal',
        defaultConnectionMode: thirdParty ? 'contract-faithful-rehearsal' : 'local',
      },
      secret ? 'Idempotency-Key' : null,
      source.rows[0]!.id,
    ],
  );
  await pool.query(
    `INSERT INTO capability_versions
      (organization_id, capability_version_id, capability_identity_id, source_document_id,
       manifest_annotation_id, capability_fragment_hash, capability_fragment)
     VALUES ('org_atlas', $1, $2, $3, $4, $5, $6)`,
    [
      capabilityVersionId,
      identity.rows[0]!.id,
      source.rows[0]!.id,
      annotation.rows[0]!.id,
      '5'.repeat(64),
      thirdParty
        ? {
            method: 'post',
            path: '/v1/payment_intents',
            operation: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['amount', 'currency'],
                      properties: {
                        amount: { type: 'integer', minimum: 1 },
                        currency: { type: 'string' },
                      },
                    },
                  },
                },
              },
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id'],
                        properties: { id: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          }
        : {
            method: 'get',
            path: '/payments/{paymentId}',
            pathParameters: [{ name: 'paymentId', schema: { type: 'string' } }],
            operation: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['amount'],
                        properties: { amount: { type: 'number' } },
                      },
                    },
                  },
                },
              },
            },
          },
    ],
  );
  await pool.query(
    `INSERT INTO capability_version_provenance
      (organization_id, capability_version_id, source_document_id)
     VALUES ('org_atlas', $1, $2)`,
    [capabilityVersionId, source.rows[0]!.id],
  );
}

async function registerEventsCapability() {
  const source = await pool.query<{ id: string }>(
    `INSERT INTO source_documents
      (organization_id, service_id, format, document, document_hash,
       repository, commit_sha, path)
     VALUES ('org_atlas', 'events', 'asyncapi', $1, $2, 'fixture', 'events-v1', 'events.asyncapi.json')
     RETURNING id`,
    [{ asyncapi: '3.0.0' }, 'e'.repeat(64)],
  );
  const identity = await pool.query<{ id: string }>(
    `INSERT INTO capability_identities
      (organization_id, kind, service_id, operation_id, channel_address, message_key)
     VALUES ('org_atlas', 'asyncapi', 'events', 'publishInvoicePaid', 'invoice.paid', 'invoicePaid')
     RETURNING id`,
  );
  const annotation = await pool.query<{ id: string }>(
    `INSERT INTO manifest_annotations
      (organization_id, capability_identity_id, annotation_hash, owner, secret_alias,
       business_semantics, idempotency_field, irreversible_after, source_document_id)
     VALUES ('org_atlas', $1, $2, 'fixture', null, $3, 'idempotencyKey', true, $4) RETURNING id`,
    [
      identity.rows[0]!.id,
      'f'.repeat(64),
      { provider: 'Atlas internal', sourceType: 'internal', defaultConnectionMode: 'local' },
      source.rows[0]!.id,
    ],
  );
  await pool.query(
    `INSERT INTO capability_versions
      (organization_id, capability_version_id, capability_identity_id, source_document_id,
       manifest_annotation_id, capability_fragment_hash, capability_fragment)
     VALUES ('org_atlas', 'events.invoice-paid@v1', $1, $2, $3, $4, $5)`,
    [
      identity.rows[0]!.id,
      source.rows[0]!.id,
      annotation.rows[0]!.id,
      '7'.repeat(64),
      {
        operation: { action: 'send' },
        channel: { address: 'invoice.paid' },
        message: {
          payload: {
            type: 'object',
            required: ['eventId', 'eventType', 'invoiceId', 'paymentId', 'atlasWorkflowRunId'],
            properties: {
              eventId: { type: 'string' },
              eventType: { type: 'string', const: 'invoice.paid' },
              invoiceId: { type: 'string' },
              paymentId: { type: 'string' },
              atlasWorkflowRunId: { type: 'string' },
            },
          },
        },
      },
    ],
  );
  await pool.query(
    `INSERT INTO capability_version_provenance
      (organization_id, capability_version_id, source_document_id)
     VALUES ('org_atlas', 'events.invoice-paid@v1', $1)`,
    [source.rows[0]!.id],
  );
}
