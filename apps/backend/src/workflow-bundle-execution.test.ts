import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';

import {
  generateExecutionGrantKeyPair,
  issueExecutionGrant,
  type ExecutionGrant,
} from '@atlas/execution-grant';
import { createMockServicesApp } from '@atlas/mock-services';
import {
  createEncryptedDataConverter,
  createTemporalWorker,
  INTERPRETER_WORKFLOW,
} from '@atlas/temporal-adapter';
import { createTemporalTestEnvironment } from '@atlas/temporal-adapter/testing';
import {
  compileAtlasBundle,
  compileTemporalWorkflowArtifact,
  createNonProductionLocalEd25519Signer,
} from '@atlas/workflow-artifact';
import {
  createTransformationCompiledWorkflowVersion,
  type VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';

import { createApp } from './app.js';
import { createExecutionGrantIssuer } from './execution-grant-issuer.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import type { WorkflowSandboxExecutor } from './workflow-sandbox.js';
import { createPassingLocalWorkflowSandboxExecutor } from './workflow-sandbox-test-support.js';
import type { PlannerModel } from './workflow-planning.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_bundle_execution_test_v2';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
let fixture: Awaited<ReturnType<typeof createFixture>>;
let app: ReturnType<typeof createApp>;
let mappingPaymentCapabilityVersionId = '';
let mappingBillingCapabilityVersionId = '';
let executionGrantPublicKey = '';
let bundleTrustKey: Awaited<ReturnType<typeof createTrustKey>>;
const mockProvider = createMockServicesApp();

const sandboxExecutor: WorkflowSandboxExecutor = createPassingLocalWorkflowSandboxExecutor();

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 83 });
  await pool.query('TRUNCATE organizations RESTART IDENTITY CASCADE');
  const executionKeys = await generateExecutionGrantKeyPair();
  executionGrantPublicKey = executionKeys.publicKey;
  const bundleKeys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  bundleTrustKey = await createTrustKey(bundleKeys.publicKey);
  app = createApp(
    pool,
    { allowedHosts: [] },
    mappingPlanner,
    {
      async authorize() {
        return 'author' as const;
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
        async authorize({ authorizationHeader, organizationId, environmentId }) {
          return (
            authorizationHeader === 'Bearer worker-token' &&
            organizationId === 'org_atlas' &&
            (environmentId === 'development' || environmentId === 'production')
          );
        },
      },
      executionGrantIssuer: createExecutionGrantIssuer(executionKeys.privateKey),
      bundleSigner: createNonProductionLocalEd25519Signer(
        bundleTrustKey.keyId,
        bundleKeys.privateKey,
      ),
    },
    {
      async authorize({ authorizationHeader, organizationId }) {
        return authorizationHeader === 'Bearer viewer-token' && organizationId === 'org_atlas'
          ? { actorId: 'viewer@example.com', role: 'author' as const }
          : null;
      },
    },
    { allowLegacySourceRoutes: true, workflowSandboxExecutor: sandboxExecutor },
  );
  await seedMappingCapabilities();
  fixture = await createFixture();
  await pool.query(
    `TRUNCATE atlas_bundle_verification_events, atlas_workflow_bundles RESTART IDENTITY`,
  );
  await pool.query(
    `INSERT INTO atlas_workflow_bundles
       (artifact_id, organization_id, environment_id, bundle_bytes,
        activation_artifact_id, approval_binding)
     VALUES ($1, 'org_atlas', 'development', $2, $1, $3)`,
    [
      fixture.bundle.artifactId,
      Buffer.from(fixture.bytes),
      {
        artifactId: fixture.bundle.artifactId,
        organizationId: 'org_atlas',
        environmentId: 'development',
        workflowVersionId: fixture.bundle.manifest.workflowVersionId,
        irHash: fixture.bundle.manifest.irHash,
        policyVersion: 'policy/v1',
        projectionFingerprint: 'c'.repeat(64),
        sandboxSuiteFingerprint: 'd'.repeat(64),
        status: 'active',
      },
    ],
  );
});

afterAll(async () => pool.end());

describe('one-box bundle verification boundary', () => {
  it('verifies the backend-served bundle and policy before crossing the Temporal boundary', async () => {
    const workerGateModule = '../../worker/src/backend-bundle-run-gate.js';
    const { createBackendAtlasBundleRunGate } = await import(workerGateModule);
    const gate = await createBackendAtlasBundleRunGate({
      backendUrl: 'http://backend',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'development',
      grantPublicKey: fixture.grantPublicKey,
      trustConfigJson: JSON.stringify({ keys: [fixture.trustKey] }),
      fetch: ((input, init) =>
        app.fetch(input instanceof Request ? input : new Request(input, init))) as typeof fetch,
    });
    const startTemporal = vi.fn<() => Promise<string>>().mockResolvedValue('started');

    await expect(
      gate.startVerifiedTemporalRun(
        { artifactId: fixture.bundle.artifactId, runId: 'run_1', grant: fixture.grant },
        async () => await startTemporal(),
      ),
    ).resolves.toBe('started');
    expect(startTemporal).toHaveBeenCalledOnce();
    await expect(
      pool.query(`SELECT outcome, reason FROM atlas_bundle_verification_events`),
    ).resolves.toMatchObject({
      rows: [{ outcome: 'accepted', reason: null }],
    });
  });

  it('plans, signs, verifies, and executes the incompatible mapping with visible tamper rejection', async () => {
    const planningRequest = {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowVersionId: 'mapping-vertical@1',
      request:
        'Read a Payment API result and settle it through Billing despite their incompatible contracts.',
    };
    const clarificationResponse = await app.request('/v1/workflow-drafts', {
      method: 'POST',
      headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
      body: JSON.stringify(planningRequest),
    });
    const clarification = (await clarificationResponse.json()) as {
      status: string;
      candidateMappings: Array<{ candidateId: string; destinationPath: string[] }>;
      requiredQuestions: Array<{ destinationPath: string[] }>;
      mapping: Record<string, unknown> & { selections?: Record<string, string> };
    };
    expect(clarificationResponse.status).toBe(200);
    expect(clarification).toMatchObject({ status: 'clarification_required' });
    expect(clarification.requiredQuestions.map(({ destinationPath }) => destinationPath)).toEqual(
      expect.arrayContaining([
        ['payment', 'amount'],
        ['payment', 'currency'],
      ]),
    );
    let planning = await app.request('/v1/workflow-drafts', {
      method: 'POST',
      headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        ...planningRequest,
        mapping: {
          ...clarification.mapping,
          selections: Object.fromEntries(
            clarification.candidateMappings.map(({ destinationPath, candidateId }) => [
              destinationPath.join('.'),
              candidateId,
            ]),
          ),
        },
      }),
    });
    type PlanningResult = {
      status: string;
      draft: VersionedCompiledWorkflowVersion;
      validation: { decision: { projectionFingerprint: string } };
      candidateMappings: Array<{ candidateId: string; destinationPath: string[] }>;
      mapping: Record<string, unknown> & { selections?: Record<string, string> };
    };
    let planned = (await planning.json()) as PlanningResult;
    // Each answer can reveal another required mapping in the same request.
    for (let round = 0; planned.status === 'clarification_required' && round < 2; round += 1) {
      planning = await app.request('/v1/workflow-drafts', {
        method: 'POST',
        headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          ...planningRequest,
          mapping: {
            ...planned.mapping,
            selections: {
              ...planned.mapping.selections,
              ...Object.fromEntries(
                planned.candidateMappings.map(({ destinationPath, candidateId }) => [
                  destinationPath.join('.'),
                  candidateId,
                ]),
              ),
            },
          },
        }),
      });
      planned = (await planning.json()) as PlanningResult;
    }
    expect(planning.status, JSON.stringify(planned)).toBe(200);
    expect(planned).toMatchObject({
      status: 'validated',
      draft: {
        executable: {
          irVersion: 2,
          steps: [
            { capabilityVersionId: mappingPaymentCapabilityVersionId },
            {
              capabilityVersionId: mappingBillingCapabilityVersionId,
              arguments: {
                invoiceId: { path: ['invoice_id'] },
                payment: {
                  fields: {
                    amount: { function: 'divide' },
                    currency: { function: 'uppercase' },
                  },
                },
                notification: { fields: { address: { path: ['customer', 'notification_email'] } } },
              },
            },
            { kind: 'terminal', state: 'completed' },
          ],
        },
      },
    });

    const sandbox = await app.request('/v1/workflow-sandbox-tests', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        draft: planned.draft,
      }),
    });
    expect(sandbox.status).toBe(201);
    await expect(sandbox.json()).resolves.toMatchObject({ status: 'passed' });

    const approval = await app.request('/v1/workflow-approvals', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        projectionFingerprint: planned.validation.decision.projectionFingerprint,
        draft: planned.draft,
      }),
    });
    expect(approval.status).toBe(201);
    const approved = (await approval.json()) as {
      source: string;
      bundle: { artifactId: string; signature: { keyId: string } };
    };
    expect(approved.bundle.signature.keyId).toBe(bundleTrustKey.keyId);

    const compilation = await app.request('/v1/workflow-compilations', {
      method: 'POST',
      headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        workflowVersionId: planned.draft.workflowVersionId,
        source: approved.source,
      }),
    });
    await expect(compilation.json()).resolves.toMatchObject({
      success: true,
      workflow: { irHash: planned.draft.irHash },
    });

    const grantResponse = await requestExecutionGrant('mapping-run-1', approved.bundle.artifactId);
    expect(grantResponse.status).toBe(201);
    const { grant } = (await grantResponse.json()) as { grant: ExecutionGrant };
    expect(grant.approvedHostnames).toEqual(['mock-services']);
    const workerGateModule = '../../worker/src/backend-bundle-run-gate.js';
    const { createBackendAtlasBundleRunGate } = await import(workerGateModule);
    const gate = await createBackendAtlasBundleRunGate({
      backendUrl: 'http://backend',
      workerToken: 'worker-token',
      organizationId: 'org_atlas',
      environmentId: 'production',
      grantPublicKey: executionGrantPublicKey,
      trustConfigJson: JSON.stringify({ keys: [bundleTrustKey] }),
      fetch: ((input, init) =>
        app.fetch(input instanceof Request ? input : new Request(input, init))) as typeof fetch,
    });
    const genericActivitiesModule = '../../worker/src/generic-capability-activities.js';
    const { createGenericCapabilityActivityResolver } = await import(genericActivitiesModule);
    const resolveGenericCapability = createGenericCapabilityActivityResolver({
      backendUrl: 'http://backend',
      organizationId: 'org_atlas',
      environmentId: 'production',
      providerBaseUrl: 'http://mock-services',
      fetch: ((input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return request.url.startsWith('http://backend')
          ? app.fetch(request)
          : mockProvider.fetch(request);
      }) as typeof fetch,
    });

    const dataConverter = createEncryptedDataConverter(Buffer.alloc(32, 80).toString('base64'));
    const environment = await createTemporalTestEnvironment({ dataConverter });
    const taskQueue = 'issue-84-mapping-vertical';
    const worker = await createTemporalWorker({
      connection: environment.nativeConnection,
      taskQueue,
      dataConverter,
      activities: {
        async invokeStep(invocation) {
          const activity = await resolveGenericCapability(invocation.capabilityVersionId);
          if (!activity) throw new Error('Production demo capability binding is unavailable');
          return activity.invokeStep(invocation);
        },
      },
    });
    try {
      await gate.startVerifiedTemporalRun(
        { artifactId: approved.bundle.artifactId, runId: 'mapping-run-1', grant },
        async (verifiedWorkflow: VersionedCompiledWorkflowVersion) =>
          worker.runUntil(
            environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
              workflowId: 'mapping-run-1',
              taskQueue,
              args: [
                {
                  workflow: verifiedWorkflow,
                  input: { paymentId: 'pay_123' },
                  approvedHostnames: grant.approvedHostnames,
                },
              ],
            }),
          ),
      );
    } finally {
      await environment.teardown();
    }

    const observations = (await (await mockProvider.request('/__control/observations')).json()) as {
      mappingDemoBillingRequests: Array<{ request: unknown; providerDurationMs: number }>;
    };
    expect(observations.mappingDemoBillingRequests).toEqual([
      {
        request: {
          invoiceId: 'inv_456',
          payment: { amount: 12.5, currency: 'USD' },
          notification: { address: 'ops@example.test' },
        },
        providerDurationMs: expect.any(Number),
      },
    ]);
    expect(observations.mappingDemoBillingRequests[0]!.providerDurationMs).toBeGreaterThanOrEqual(
      18,
    );
    await expect(readVisibleVerification(approved.bundle.artifactId)).resolves.toMatchObject({
      event: { outcome: 'accepted' },
    });

    const stored = await pool.query<{ bundle_bytes: Buffer }>(
      `SELECT bundle_bytes FROM atlas_workflow_bundles WHERE artifact_id = $1`,
      [approved.bundle.artifactId],
    );
    const edited = Buffer.from(stored.rows[0]!.bundle_bytes);
    edited[edited.length - 2] = edited[edited.length - 2]! ^ 1;
    await pool.query(`UPDATE atlas_workflow_bundles SET bundle_bytes = $2 WHERE artifact_id = $1`, [
      approved.bundle.artifactId,
      edited,
    ]);
    const tamperGrantResponse = await requestExecutionGrant(
      'mapping-run-2',
      approved.bundle.artifactId,
    );
    const tamperGrant = ((await tamperGrantResponse.json()) as { grant: typeof grant }).grant;
    await expect(
      gate.startVerifiedTemporalRun(
        { artifactId: approved.bundle.artifactId, runId: 'mapping-run-2', grant: tamperGrant },
        async () => {
          throw new Error('Tampered bytes crossed the Temporal boundary');
        },
      ),
    ).rejects.toThrow('Bundle verification rejected');
    await expect(readVisibleVerification(approved.bundle.artifactId)).resolves.toMatchObject({
      event: { outcome: 'rejected', reason: 'policy-or-integrity-check-failed' },
    });
    const afterTamper = (await (await mockProvider.request('/__control/observations')).json()) as {
      mappingDemoBillingRequests: unknown[];
    };
    expect(afterTamper.mappingDemoBillingRequests).toHaveLength(1);
  }, 60_000);
});

const mappingPlanner: PlannerModel = {
  async extractIntent() {
    return {
      version: 1,
      summary: 'Settle a Payment API result through Billing',
      requestedEffects: ['readRecord', 'mutateRecord'],
      mentionedSystems: ['payments', 'billing'],
      requiredInputs: ['paymentId'],
      constraints: ['Preserve the exact incompatible contracts'],
      ambiguities: [],
      supported: true,
      unsupportedReason: null,
    };
  },
  async draftWorkflow({ intentFingerprint, projection }) {
    return {
      kind: 'workflowDraft',
      intentFingerprint,
      projectionFingerprint: projection.fingerprint,
      draft: await mappingWorkflow(),
    };
  },
  async repairWorkflow({ intentFingerprint, projection }) {
    return {
      kind: 'workflowDraft',
      intentFingerprint,
      projectionFingerprint: projection.fingerprint,
      draft: await mappingWorkflow(),
    };
  },
};

async function mappingWorkflow() {
  return createTransformationCompiledWorkflowVersion('model-owned-id', 'wrong-org', {
    irVersion: 2,
    inputSchema: { required: { paymentId: { type: 'string' } } },
    steps: [
      {
        id: 'get-payment',
        kind: 'capabilityCall',
        capabilityVersionId: mappingPaymentCapabilityVersionId,
        inputSchema: { required: { paymentId: { type: 'string' } } },
        arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        responseSchema: {
          required: {
            invoice_id: { type: 'string' },
            amount_cents: { type: 'number' },
            currency: { type: 'string' },
            customer: {
              type: 'object',
              required: { notification_email: { type: 'string' } },
            },
          },
        },
      },
      {
        id: 'settle-billing',
        kind: 'capabilityCall',
        capabilityVersionId: mappingBillingCapabilityVersionId,
        inputSchema: {
          required: {
            invoiceId: { type: 'string' },
            payment: {
              type: 'object',
              required: { amount: { type: 'number' }, currency: { type: 'string' } },
            },
            notification: {
              type: 'object',
              required: { address: { type: 'string' } },
            },
          },
        },
        arguments: {
          invoiceId: { source: 'stepOutput', stepId: 'get-payment', path: ['invoice_id'] },
          payment: {
            kind: 'object',
            fields: {
              amount: {
                kind: 'call',
                function: 'divide',
                arguments: [
                  { source: 'stepOutput', stepId: 'get-payment', path: ['amount_cents'] },
                  { source: 'literal', value: 100 },
                ],
              },
              currency: {
                kind: 'call',
                function: 'uppercase',
                arguments: [{ source: 'stepOutput', stepId: 'get-payment', path: ['currency'] }],
              },
            },
          },
          notification: {
            kind: 'object',
            fields: {
              address: {
                source: 'stepOutput',
                stepId: 'get-payment',
                path: ['customer', 'notification_email'],
              },
            },
          },
        },
        idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
        irreversibleAfter: true,
        responseSchema: { required: { accepted: { type: 'boolean' } } },
      },
      { id: 'complete', kind: 'terminal', state: 'completed' },
    ],
  });
}

async function seedMappingCapabilities() {
  await pool.query(`
    INSERT INTO organizations (id) VALUES ('org_atlas') ON CONFLICT DO NOTHING;
    INSERT INTO environments (organization_id, id, name, kind)
    VALUES ('org_atlas', 'production', 'Production', 'production')
    ON CONFLICT DO NOTHING;
  `);
  const documents = {
    payment: await (await mockProvider.request('/specs/payment.openapi.json')).json(),
    billing: await (await mockProvider.request('/specs/billing.openapi.json')).json(),
  };
  const operationIds = {
    payment: ['getPayment', 'getMappingDemoPayment'],
    billing: [
      'getInvoice',
      'beginInvoiceSettlement',
      'cancelInvoiceSettlement',
      'markInvoicePaid',
      'settleMappingDemoInvoice',
    ],
  } as const;
  const capabilities: Array<{ capabilityVersionId: string; identity: { operationId: string } }> =
    [];
  for (const sourceKey of ['payment', 'billing'] as const) {
    const serviceId = sourceKey === 'payment' ? 'payments' : 'billing';
    const response = await app.request('/v1/capability-ingestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        serviceId,
        source: {
          format: 'openapi',
          document: documents[sourceKey],
          repository: `https://github.com/atlas-demo/${serviceId}`,
          commit: 'issue-84-contract-v4',
          path: 'openapi.json',
        },
        manifest: {
          source: {
            repository: `https://github.com/atlas-demo/${serviceId}`,
            commit: 'issue-84-contract-v4',
            path: 'atlas-manifest.json',
          },
          annotations: operationIds[sourceKey].map((operationId) => ({
            capability: { operationId },
            owner: `${serviceId}-team`,
            secretAlias: `${serviceId}-api-token`,
            businessSemantics: { contractMappingDemo: true },
            idempotencyField:
              serviceId === 'billing' && operationId !== 'getInvoice' ? 'idempotencyKey' : null,
            compensatedBy: null,
            irreversibleAfter: serviceId === 'billing' && operationId !== 'getInvoice',
          })),
        },
      }),
    });
    if (response.status !== 201) {
      throw new Error(`Could not ingest ${serviceId}: ${await response.text()}`);
    }
    capabilities.push(
      ...(
        (await response.json()) as {
          capabilities: Array<{
            capabilityVersionId: string;
            identity: { operationId: string };
          }>;
        }
      ).capabilities,
    );
  }
  mappingPaymentCapabilityVersionId = capabilities.find(
    ({ identity }) => identity.operationId === 'getMappingDemoPayment',
  )!.capabilityVersionId;
  mappingBillingCapabilityVersionId = capabilities.find(
    ({ identity }) => identity.operationId === 'settleMappingDemoInvoice',
  )!.capabilityVersionId;
  await pool.query(`
    INSERT INTO manifest_annotation_approvals
      (organization_id, manifest_annotation_id, approved_by)
    SELECT organization_id, id, 'admin@example.com' FROM manifest_annotations
    WHERE organization_id = 'org_atlas' ON CONFLICT DO NOTHING;
    INSERT INTO capability_approvals
      (organization_id, capability_version_id, approved_by)
    SELECT organization_id, capability_version_id, 'admin@example.com' FROM capability_versions
    WHERE organization_id = 'org_atlas' ON CONFLICT DO NOTHING;
    INSERT INTO capability_host_policies
      (organization_id, capability_identity_id, environment_id, hostname, approved_by)
    SELECT organization_id, id, 'production', 'mock-services', 'admin@example.com'
    FROM capability_identities WHERE organization_id = 'org_atlas' ON CONFLICT DO NOTHING;
    INSERT INTO organization_environment_policies
      (organization_id, environment_id, policy_version, approved_by)
    VALUES ('org_atlas', 'production', 'mvp-validation-v1', 'admin@example.com')
    ON CONFLICT (organization_id, environment_id) DO NOTHING;
  `);
}

async function createTrustKey(publicKey: CryptoKey) {
  return {
    keyId: 'issue-84-bundle-key',
    algorithm: 'Ed25519' as const,
    publicKey: Buffer.from(await crypto.subtle.exportKey('spki', publicKey)).toString('base64url'),
    organizationIds: ['org_atlas'],
    environmentIds: ['production'],
    notBefore: '2026-08-19T00:00:00Z',
    notAfter: '2030-08-19T00:00:00Z',
    status: 'active' as const,
  };
}

function requestExecutionGrant(runId: string, artifactId: string) {
  return app.request('/v1/execution-grants', {
    method: 'POST',
    headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: 'org_atlas',
      environmentId: 'production',
      runId,
      artifactId,
      intakeKey: 'a'.repeat(64),
    }),
  });
}

async function readVisibleVerification(artifactId: string) {
  const response = await app.request(
    `/v1/bundle-verification-events/${artifactId}?organizationId=org_atlas&environmentId=production`,
    { headers: { authorization: 'Bearer viewer-token' } },
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function createFixture() {
  const workflow = await createTransformationCompiledWorkflowVersion('payment@1', 'org_atlas', {
    irVersion: 2,
    steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
  });
  const compiledPlan = await compileTemporalWorkflowArtifact(workflow, {
    sandboxSuiteFingerprint: 'd'.repeat(64),
    secretReferencesByCapabilityVersion: {},
  });
  const signingKeys = (await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const result = await compileAtlasBundle(
    {
      environmentId: 'development',
      compiledPlan,
      provenance: {
        sourceFormatVersion: 'atlas-source/v1',
        sourceSha256: 'b'.repeat(64),
        compiler: { name: 'atlas-workflow-compiler', version: '1.0.0' },
        compiledAt: '2026-08-19T12:00:00Z',
      },
      approval: {
        policyVersion: 'policy/v1',
        projectionFingerprint: 'c'.repeat(64),
        sandboxSuiteFingerprint: 'd'.repeat(64),
        approvedBy: 'admin@example.com',
        approvedAt: '2026-08-19T12:01:00Z',
      },
      signedAt: '2026-08-19T12:02:00Z',
    },
    createNonProductionLocalEd25519Signer('bundle-key', signingKeys.privateKey),
  );
  const grantKeys = await generateExecutionGrantKeyPair();
  return {
    ...result,
    grantPublicKey: grantKeys.publicKey,
    grant: await issueExecutionGrant(grantKeys.privateKey, {
      organizationId: 'org_atlas',
      environmentId: 'development',
      runId: 'run_1',
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      approvedCapabilityVersionIds: [],
      approvedHostnames: [],
    }),
    trustKey: {
      keyId: 'bundle-key',
      algorithm: 'Ed25519',
      publicKey: Buffer.from(await crypto.subtle.exportKey('spki', signingKeys.publicKey)).toString(
        'base64url',
      ),
      organizationIds: ['org_atlas'],
      environmentIds: ['development'],
      notBefore: '2026-08-19T00:00:00Z',
      notAfter: '2030-08-19T00:00:00Z',
      status: 'active',
    },
  };
}
