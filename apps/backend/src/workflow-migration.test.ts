import {
  createTransformationCompiledWorkflowVersion,
  type TransformationCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { readWorkflowCapabilityLossProtection } from './capability-loss-protection.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';
import { runWorkflowSandboxTests } from './workflow-sandbox.js';
import { createPassingLocalWorkflowSandboxExecutor } from './workflow-sandbox-test-support.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_migration_v2_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const organizationId = 'org_migration';
const oldCapabilityVersionId = 'a'.repeat(64);
const renamedCapabilityVersionId = 'b'.repeat(64);
const breakingCapabilityVersionId = 'c'.repeat(64);
const removedOutputCapabilityVersionId = 'd'.repeat(64);
let plannerCalls = 0;
let plannerDraft: TransformationCompiledWorkflowVersion | undefined;

const planner = {
  async extractIntent() {
    throw new Error('Intent extraction is not used for migration');
  },
  async draftWorkflow() {
    throw new Error('Workflow drafting is not used for migration');
  },
  async repairWorkflow() {
    throw new Error('Workflow repair is not used for migration');
  },
  async migrateWorkflow() {
    plannerCalls += 1;
    if (!plannerDraft) throw new Error('Planner draft was not configured');
    return plannerDraft;
  },
};

const planningAuthorizer = {
  async authorize({ authorizationHeader }: { authorizationHeader: string | undefined }) {
    return authorizationHeader === 'Bearer author-token' ? ('author' as const) : null;
  },
};

const approvalAuthorizer = {
  async authorize({ authorizationHeader }: { authorizationHeader: string | undefined }) {
    return authorizationHeader === 'Bearer admin-token'
      ? { actorId: 'admin@example.com', role: 'admin' as const }
      : null;
  },
};

const app = createApp(pool, { allowedHosts: [] }, planner, planningAuthorizer, {
  approvalAuthorizer,
  workerAuthorizer: {
    async authorize() {
      return false;
    },
  },
  executionGrantIssuer: {
    async issueForRun() {
      throw new Error('not used');
    },
  },
  bundleSigner: {
    keyId: 'migration-test-key',
    algorithm: 'Ed25519',
    async sign() {
      return new Uint8Array(64);
    },
  },
});

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 65 });
  await seedMigrationGraph();
});

afterAll(async () => {
  await pool.end();
});

describe('workflow migration candidate API', () => {
  it('compiles an unambiguous rename without involving the planner', async () => {
    plannerCalls = 0;
    const projectionFingerprint = await currentProjectionFingerprint();
    const reusedVersion = await generateCandidate({
      toCapabilityVersionId: renamedCapabilityVersionId,
      workflowVersionId: 'payment-flow@1',
      projectionFingerprint,
    });
    expect(reusedVersion.status).toBe(409);
    await expect(reusedVersion.json()).resolves.toMatchObject({
      error: 'workflow-migration-version-id-must-be-new',
    });
    const source = await sourceWorkflow();
    await pool.query(
      `INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
       VALUES ($1, 'payment-flow@occupied', $2, $3)`,
      [organizationId, source.irHash, source],
    );
    const occupiedVersion = await generateCandidate({
      toCapabilityVersionId: renamedCapabilityVersionId,
      workflowVersionId: 'payment-flow@occupied',
      projectionFingerprint,
    });
    expect(occupiedVersion.status).toBe(409);
    await expect(occupiedVersion.json()).resolves.toMatchObject({
      error: 'workflow-migration-version-id-must-be-new',
    });

    const response = await generateCandidate({
      toCapabilityVersionId: renamedCapabilityVersionId,
      workflowVersionId: 'payment-flow@rename',
      projectionFingerprint,
    });

    expect(response.status).toBe(201);
    const candidate = (await response.json()) as {
      candidateId: string;
      author: string;
      draft: TransformationCompiledWorkflowVersion;
      validation: { decision: { approvable: boolean; recomputedIrHash: string } };
    };
    expect(candidate).toMatchObject({
      candidateId: expect.any(String),
      author: 'compiler',
      draft: {
        workflowVersionId: 'payment-flow@rename',
        executable: {
          steps: [
            {
              id: 'settle-invoice',
              capabilityVersionId: renamedCapabilityVersionId,
              arguments: { invoiceIdentifier: { source: 'literal', value: 'invoice-fixed' } },
            },
            {
              id: 'unaffected-step',
              capabilityVersionId: renamedCapabilityVersionId,
              arguments: { invoiceId: { source: 'literal', value: 'invoice-fixed' } },
            },
            { id: 'complete', kind: 'terminal' },
          ],
        },
      },
      validation: { decision: { approvable: true } },
    });
    expect(candidate.draft.irHash).not.toBe((await sourceWorkflow()).irHash);
    expect(candidate.draft.irHash).toBe(candidate.validation.decision.recomputedIrHash);
    expect(plannerCalls).toBe(0);

    const recorded = await app.request(
      `/v1/workflow-migration-candidates/${candidate.candidateId}?organizationId=${organizationId}`,
    );
    expect(recorded.status).toBe(200);
    await expect(recorded.json()).resolves.toMatchObject({
      candidateId: candidate.candidateId,
      author: 'compiler',
      draft: candidate.draft,
    });
    const audit = await app.request(
      `/v1/audit-entries?organizationId=${organizationId}&environmentId=production`,
    );
    const auditBody = (await audit.json()) as {
      entries: Array<{ eventType: string; subjectId: string; details: Record<string, unknown> }>;
    };
    expect(auditBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'generation',
          subjectId: candidate.candidateId,
          details: expect.objectContaining({ author: 'compiler' }),
        }),
        expect.objectContaining({
          eventType: 'validation',
          subjectId: candidate.candidateId,
          details: { result: candidate.validation },
        }),
      ]),
    );

    await pool.query(
      `UPDATE compatibility_diffs
       SET diff = $1
       WHERE organization_id = $2 AND from_capability_version_id = $3
         AND to_capability_version_id = $4`,
      [
        {
          fieldChanges: [
            {
              kind: 'renamed',
              fromPath:
                '/operation/responses/200/content/application~1json/schema/properties/invoiceId',
              path: '/operation/responses/200/content/application~1json/schema/properties/invoiceIdentifier',
              classification: 'conditional',
            },
          ],
        },
        organizationId,
        oldCapabilityVersionId,
        renamedCapabilityVersionId,
      ],
    );
    plannerDraft = candidate.draft;
    const responseRename = await generateCandidate({
      toCapabilityVersionId: renamedCapabilityVersionId,
      workflowVersionId: 'payment-flow@response-rename',
      projectionFingerprint,
    });
    expect(responseRename.status).toBe(201);
    await expect(responseRename.json()).resolves.toMatchObject({ author: 'planner' });
    expect(plannerCalls).toBe(1);
    const plannerAudit = await app.request(
      `/v1/audit-entries?organizationId=${organizationId}&environmentId=production`,
    );
    const plannerAuditBody = (await plannerAudit.json()) as {
      entries: Array<{ eventType: string; details: Record<string, unknown> }>;
    };
    expect(plannerAuditBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'generation',
          details: expect.objectContaining({
            author: 'planner',
            workflowVersionId: 'payment-flow@response-rename',
          }),
        }),
      ]),
    );
  });

  it('compiles a breaking pin refresh when a removed response field is unused', async () => {
    plannerCalls = 0;
    const originalSource = await sourceWorkflow();
    const isolatedSource = await createTransformationCompiledWorkflowVersion(
      'payment-flow@1',
      organizationId,
      {
        ...originalSource.executable,
        steps: originalSource.executable.steps.map((step) =>
          step.kind !== 'terminal' && step.id === 'unaffected-step'
            ? { ...step, capabilityVersionId: removedOutputCapabilityVersionId }
            : step,
        ),
      },
    );
    await pool.query(
      `UPDATE workflow_versions SET ir_hash = $1, compiled_workflow = $2
       WHERE organization_id = $3 AND workflow_version_id = 'payment-flow@1'`,
      [isolatedSource.irHash, isolatedSource, organizationId],
    );
    await setCapabilityHead(removedOutputCapabilityVersionId);
    const wholeOutputSource = await createTransformationCompiledWorkflowVersion(
      'payment-flow@1',
      organizationId,
      {
        ...isolatedSource.executable,
        steps: isolatedSource.executable.steps.map((step) =>
          step.kind !== 'terminal' && step.id === 'unaffected-step'
            ? {
                ...step,
                arguments: {
                  invoiceId: { source: 'stepOutput', stepId: 'settle-invoice', path: [] },
                },
              }
            : step,
        ),
      },
    );
    await pool.query(
      `UPDATE workflow_versions SET ir_hash = $1, compiled_workflow = $2
       WHERE organization_id = $3 AND workflow_version_id = 'payment-flow@1'`,
      [wholeOutputSource.irHash, wholeOutputSource, organizationId],
    );
    plannerCalls = 0;
    plannerDraft = await createTransformationCompiledWorkflowVersion(
      'planner-whole-output',
      organizationId,
      {
        ...wholeOutputSource.executable,
        steps: wholeOutputSource.executable.steps.map((step) =>
          step.kind !== 'terminal' && step.capabilityVersionId === oldCapabilityVersionId
            ? { ...step, capabilityVersionId: removedOutputCapabilityVersionId }
            : step,
        ),
      },
    );
    const wholeOutputResponse = await generateCandidate({
      toCapabilityVersionId: removedOutputCapabilityVersionId,
      workflowVersionId: 'payment-flow@whole-output-removal',
      projectionFingerprint: await currentProjectionFingerprint(),
    });
    expect(wholeOutputResponse.status).toBe(201);
    await expect(wholeOutputResponse.json()).resolves.toMatchObject({ author: 'planner' });
    expect(plannerCalls).toBe(1);

    await pool.query(
      `UPDATE workflow_versions SET ir_hash = $1, compiled_workflow = $2
       WHERE organization_id = $3 AND workflow_version_id = 'payment-flow@1'`,
      [isolatedSource.irHash, isolatedSource, organizationId],
    );
    plannerCalls = 0;
    const response = await generateCandidate({
      toCapabilityVersionId: removedOutputCapabilityVersionId,
      workflowVersionId: 'payment-flow@unused-output-removal',
      projectionFingerprint: await currentProjectionFingerprint(),
    });

    expect(response.status).toBe(201);
    const candidate = (await response.json()) as {
      author: string;
      draft: TransformationCompiledWorkflowVersion;
      validation: { diagnostics: unknown[]; decision: { approvable: boolean } };
    };
    expect(candidate.validation.diagnostics).toEqual([]);
    expect(candidate).toMatchObject({
      author: 'compiler',
      draft: {
        workflowVersionId: 'payment-flow@unused-output-removal',
        executable: {
          steps: [
            {
              id: 'settle-invoice',
              capabilityVersionId: removedOutputCapabilityVersionId,
            },
            {
              id: 'unaffected-step',
              capabilityVersionId: removedOutputCapabilityVersionId,
            },
            { id: 'complete', kind: 'terminal' },
          ],
        },
      },
      validation: { decision: { approvable: true } },
    });
    expect(plannerCalls).toBe(0);
    await setCapabilityHead(renamedCapabilityVersionId);
    await pool.query(
      `UPDATE workflow_versions SET ir_hash = $1, compiled_workflow = $2
       WHERE organization_id = $3 AND workflow_version_id = 'payment-flow@1'`,
      [originalSource.irHash, originalSource, organizationId],
    );
  });

  it('uses the planner when a non-field change has no proven deterministic remap', async () => {
    await pool.query(
      `UPDATE compatibility_diffs
       SET classification = 'breaking', diff = $1
       WHERE organization_id = $2 AND from_capability_version_id = $3
         AND to_capability_version_id = $4`,
      [
        { changes: ['/operation/responses/200'], fieldChanges: [] },
        organizationId,
        oldCapabilityVersionId,
        renamedCapabilityVersionId,
      ],
    );
    plannerCalls = 0;
    const source = await sourceWorkflow();
    plannerDraft = await createTransformationCompiledWorkflowVersion(
      'model-non-field-change',
      organizationId,
      {
        ...source.executable,
        steps: source.executable.steps.map((step) =>
          step.kind === 'terminal'
            ? step
            : { ...step, capabilityVersionId: renamedCapabilityVersionId },
        ),
      },
    );

    const response = await generateCandidate({
      toCapabilityVersionId: renamedCapabilityVersionId,
      workflowVersionId: 'payment-flow@non-field-change',
      projectionFingerprint: await currentProjectionFingerprint(),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ author: 'planner' });
    expect(plannerCalls).toBe(1);
  });

  it('blocks a planner guess, accepts a reviewer source path, and uses ordinary approval', async () => {
    await setCapabilityHead(breakingCapabilityVersionId);
    const existingSource = await sourceWorkflow();
    const activationSource = await createTransformationCompiledWorkflowVersion(
      'payment-flow@1',
      organizationId,
      {
        ...existingSource.executable,
        steps: existingSource.executable.steps.filter((step) => step.id !== 'unaffected-step'),
      },
    );
    await pool.query(
      `UPDATE workflow_versions SET ir_hash = $1, compiled_workflow = $2
       WHERE organization_id = $3 AND workflow_version_id = 'payment-flow@1'`,
      [activationSource.irHash, activationSource, organizationId],
    );
    await pool.query(
      `UPDATE workflow_approvals SET ir_hash = $1
       WHERE organization_id = $2 AND workflow_version_id = 'payment-flow@1'`,
      [activationSource.irHash, organizationId],
    );
    plannerCalls = 0;
    plannerDraft = await createTransformationCompiledWorkflowVersion(
      'model-proposal',
      organizationId,
      {
        irVersion: 2,
        inputSchema: { required: { invoiceId: { type: 'string' }, currency: { type: 'string' } } },
        steps: [
          {
            id: 'settle-invoice',
            kind: 'capabilityCall',
            inputSchema: { required: {} },
            capabilityVersionId: breakingCapabilityVersionId,
            arguments: {
              invoiceIdentifier: { source: 'literal', value: 'invoice-fixed' },
              currency: {
                kind: 'call',
                function: 'uppercase',
                arguments: [{ source: 'literal', value: 'usd' }],
              },
              region: { source: 'literal', value: 'us-central' },
            },
          },
          {
            id: 'unaffected-step',
            kind: 'capabilityCall',
            inputSchema: { required: {} },
            capabilityVersionId: renamedCapabilityVersionId,
            arguments: {
              invoiceIdentifier: { source: 'literal', value: 'invoice-fixed' },
            },
          },
          { id: 'complete', kind: 'terminal', state: 'completed' },
        ],
      },
    );
    const projectionFingerprint = await currentProjectionFingerprint();
    const generated = await generateCandidate({
      toCapabilityVersionId: breakingCapabilityVersionId,
      workflowVersionId: 'payment-flow@breaking',
      projectionFingerprint,
    });

    expect(generated.status).toBe(201);
    const candidate = (await generated.json()) as {
      candidateId: string;
      author: string;
      draft: TransformationCompiledWorkflowVersion;
      validation: {
        diagnostics: Array<{ code: string }>;
        decision: { approvable: boolean };
      };
      validationContext: { plannerAuthoredLiteralPaths: string[] };
    };
    expect(candidate).toMatchObject({
      author: 'planner',
      draft: { workflowVersionId: 'payment-flow@breaking' },
      validation: {
        decision: { approvable: false },
      },
    });
    expect(candidate.validationContext.plannerAuthoredLiteralPaths).toEqual([
      'executable.steps[settle-invoice].arguments.currency',
      'executable.steps[unaffected-step].arguments.invoiceIdentifier',
    ]);
    expect(plannerCalls).toBe(1);

    const review = await app.request('/v1/workflow-reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        environmentId: 'production',
        projectionFingerprint,
        draft: candidate.draft,
        migrationCandidateId: candidate.candidateId,
        migration: {
          fromCapabilityVersionId: oldCapabilityVersionId,
          toCapabilityVersionId: breakingCapabilityVersionId,
        },
      }),
    });
    expect(review.status).toBe(200);
    await expect(review.json()).resolves.toMatchObject({
      approval: {
        enabled: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'literal-not-derived' }),
        ]),
      },
    });

    const ordinaryValidation = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint,
        draft: candidate.draft,
        ...candidate.validationContext,
      }),
    });
    expect(ordinaryValidation.status).toBe(422);
    await expect(ordinaryValidation.json()).resolves.toEqual(candidate.validation);

    const ordinaryLiteral = await app.request('/v1/workflow-validations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        environmentId: 'production',
        proposedApproverRole: 'admin',
        projectionFingerprint,
        draft: candidate.draft,
      }),
    });
    expect(ordinaryLiteral.status).toBe(422);
    expect(
      ((await ordinaryLiteral.json()) as { diagnostics: Array<{ code: string }> }).diagnostics,
    ).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'literal-not-derived' })]),
    );

    plannerDraft = await createTransformationCompiledWorkflowVersion(
      'model-omits-currency',
      organizationId,
      {
        ...candidate.draft.executable,
        steps: candidate.draft.executable.steps
          .filter((step) => step.id !== 'unaffected-step')
          .map((step) =>
            step.kind === 'terminal'
              ? step
              : {
                  ...step,
                  arguments: {
                    invoiceIdentifier: { source: 'literal', value: 'invoice-fixed' },
                    region: { source: 'literal', value: 'us-central' },
                  },
                },
          ),
      },
    );
    const omitted = await generateCandidate({
      toCapabilityVersionId: breakingCapabilityVersionId,
      workflowVersionId: 'payment-flow@reviewed',
      projectionFingerprint,
    });
    expect(omitted.status).toBe(201);
    const omittedCandidate = (await omitted.json()) as {
      candidateId: string;
      draft: TransformationCompiledWorkflowVersion;
    };

    const literalCorrection = await app.request(
      `/v1/workflow-migration-candidates/${omittedCandidate.candidateId}`,
      {
        method: 'PATCH',
        headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          environmentId: 'production',
          projectionFingerprint,
          mappings: [
            {
              stepId: 'settle-invoice',
              argument: 'currency',
              source: { source: 'literal', value: 'USD' },
            },
          ],
        }),
      },
    );
    expect(literalCorrection.status).toBe(409);
    await expect(literalCorrection.json()).resolves.toMatchObject({
      error: 'workflow-migration-correction-rejected',
      message: 'Migration corrections must use a trusted workflow source path',
    });

    const corrected = await app.request(
      `/v1/workflow-migration-candidates/${omittedCandidate.candidateId}`,
      {
        method: 'PATCH',
        headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          environmentId: 'production',
          projectionFingerprint,
          mappings: [
            {
              stepId: 'settle-invoice',
              argument: 'currency',
              source: { source: 'input', path: ['currency'] },
            },
          ],
        }),
      },
    );

    expect(corrected.status).toBe(200);
    const revised = (await corrected.json()) as {
      author: string;
      draft: TransformationCompiledWorkflowVersion;
      validation: { diagnostics: unknown[]; decision: { approvable: boolean } };
    };
    expect(revised).toMatchObject({
      author: 'planner',
      draft: {
        workflowVersionId: 'payment-flow@reviewed',
        executable: {
          steps: [
            {
              id: 'settle-invoice',
              arguments: { currency: { source: 'input', path: ['currency'] } },
            },
            { id: 'complete' },
          ],
        },
      },
      validation: { diagnostics: [], decision: { approvable: true } },
    });
    expect(revised.draft.irHash).not.toBe(omittedCandidate.draft.irHash);

    await runWorkflowSandboxTests(
      pool,
      createPassingLocalWorkflowSandboxExecutor(),
      {
        organizationId,
        environmentId: 'production',
        draft: revised.draft,
      },
      'sandbox-runner',
    );

    const approval = await app.request('/v1/workflow-approvals', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId,
        environmentId: 'production',
        projectionFingerprint,
        draft: revised.draft,
        migrationCandidateId: omittedCandidate.candidateId,
      }),
    });
    expect(approval.status).toBe(201);
    await expect(approval.json()).resolves.toMatchObject({
      workflowVersionId: 'payment-flow@reviewed',
      irHash: revised.draft.irHash,
    });
    const catalog = await app.request(
      `/v1/workflow-catalog?organizationId=${organizationId}&environmentId=production`,
    );
    await expect(catalog.json()).resolves.toMatchObject({
      workflows: [
        {
          activeVersion: { workflowVersionId: 'payment-flow@1' },
          latestVersion: {
            workflowVersionId: 'payment-flow@reviewed',
            status: 'approved-inactive',
          },
        },
      ],
    });
    const versions = await pool.query<{
      workflow_version_id: string;
      ir_hash: string;
      compiled_workflow: TransformationCompiledWorkflowVersion;
    }>(
      `SELECT workflow_version_id, ir_hash, compiled_workflow FROM workflow_versions
       WHERE organization_id = $1 AND workflow_version_id = ANY($2::text[])
       ORDER BY workflow_version_id`,
      [organizationId, ['payment-flow@1', 'payment-flow@reviewed']],
    );
    expect(versions.rows).toHaveLength(2);
    expect(
      versions.rows.find(({ workflow_version_id }) => workflow_version_id === 'payment-flow@1'),
    ).toMatchObject({ ir_hash: (await sourceWorkflow()).irHash });
    expect(
      versions.rows.find(
        ({ workflow_version_id }) => workflow_version_id === 'payment-flow@reviewed',
      ),
    ).toMatchObject({ ir_hash: revised.draft.irHash, compiled_workflow: revised.draft });

    await pool.query(
      `INSERT INTO environment_workers
        (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version)
       VALUES ($1, 'production', 'migration-worker', 2, 2)`,
      [organizationId],
    );
    await pool.query(
      `UPDATE environment_capability_observations
       SET capability_version_id = $2, availability_status = 'removed', freshness_status = 'fresh',
           status_reason = 'operation-absent-from-successful-discovery'
       WHERE organization_id = $1 AND environment_id = 'production'`,
      [organizationId, oldCapabilityVersionId],
    );
    await expect(
      readWorkflowCapabilityLossProtection(pool, {
        organizationId,
        environmentId: 'production',
        workflowVersionId: 'payment-flow@1',
      }),
    ).resolves.toMatchObject({ allowed: false });
    const activation = await app.request(
      `/v1/workflow-migration-candidates/${omittedCandidate.candidateId}/activation`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId, environmentId: 'production' }),
      },
    );
    expect(activation.status).toBe(200);
    await expect(
      readWorkflowCapabilityLossProtection(pool, {
        organizationId,
        environmentId: 'production',
        workflowVersionId: revised.draft.workflowVersionId,
      }),
    ).resolves.toMatchObject({ allowed: true, blockers: [] });
  });
});

async function seedMigrationGraph() {
  await pool.query('TRUNCATE organizations, workflow_versions RESTART IDENTITY CASCADE');
  await pool.query(`INSERT INTO organizations (id) VALUES ($1)`, [organizationId]);
  await pool.query(
    `INSERT INTO environments (organization_id, id, name, kind)
     VALUES ($1, 'production', 'Production', 'production')`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO organization_environment_policies
       (organization_id, environment_id, policy_version, approved_by)
     VALUES ($1, 'production', 'mvp-validation-v1', 'admin@example.com')`,
    [organizationId],
  );
  await pool.query(
    `INSERT INTO source_documents
       (organization_id, service_id, format, document, document_hash, repository, commit_sha, path)
     VALUES
       ($1, 'billing', 'openapi', '{}', $2, 'atlas/mock-services', 'old', 'billing.json'),
       ($1, 'billing', 'openapi', '{}', $3, 'atlas/mock-services', 'rename', 'billing.json'),
       ($1, 'billing', 'openapi', '{}', $4, 'atlas/mock-services', 'breaking', 'billing.json'),
       ($1, 'billing', 'openapi', '{}', $5, 'atlas/mock-services', 'removed-output', 'billing.json')`,
    [organizationId, '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO capability_identities
       (organization_id, kind, service_id, operation_id)
     VALUES ($1, 'openapi', 'billing', 'settleInvoice')`,
    [organizationId],
  );
  const identity = await pool.query<{ id: string }>(
    `SELECT id FROM capability_identities WHERE organization_id = $1`,
    [organizationId],
  );
  const documents = await pool.query<{ id: string; commit_sha: string }>(
    `SELECT id, commit_sha FROM source_documents WHERE organization_id = $1`,
    [organizationId],
  );
  const documentByCommit = new Map(documents.rows.map((row) => [row.commit_sha, row.id]));
  const annotation = await pool.query<{ id: string }>(
    `INSERT INTO manifest_annotations
       (organization_id, capability_identity_id, annotation_hash, owner, business_semantics,
        irreversible_after, source_document_id, field_renames)
     VALUES ($1, $2, $3, 'billing-team', '{"readsInvoice":true}', false, $4, '[]') RETURNING id`,
    [organizationId, identity.rows[0]!.id, '4'.repeat(64), documentByCommit.get('old')],
  );
  const fragments = [
    [
      oldCapabilityVersionId,
      'old',
      requestFragment(['invoiceId'], { invoiceId: 'string', region: 'string' }),
    ],
    [
      renamedCapabilityVersionId,
      'rename',
      requestFragment([], {
        invoiceId: 'string',
        invoiceIdentifier: 'string',
        region: 'string',
      }),
    ],
    [
      breakingCapabilityVersionId,
      'breaking',
      requestFragment(['invoiceIdentifier', 'currency'], {
        invoiceIdentifier: 'string',
        currency: 'string',
        region: 'string',
      }),
    ],
    [
      removedOutputCapabilityVersionId,
      'removed-output',
      requestFragment(['invoiceId'], { invoiceId: 'string', region: 'string' }, []),
    ],
  ] as const;
  for (const [versionId, commit, fragment] of fragments) {
    await pool.query(
      `INSERT INTO capability_versions
         (organization_id, capability_version_id, capability_identity_id, source_document_id,
          manifest_annotation_id, capability_fragment_hash, capability_fragment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        organizationId,
        versionId,
        identity.rows[0]!.id,
        documentByCommit.get(commit),
        annotation.rows[0]!.id,
        versionId,
        fragment,
      ],
    );
    await pool.query(
      `INSERT INTO capability_version_provenance
         (organization_id, capability_version_id, source_document_id)
       VALUES ($1, $2, $3)`,
      [organizationId, versionId, documentByCommit.get(commit)],
    );
  }
  await pool.query(
    `INSERT INTO manifest_annotation_approvals
       (organization_id, manifest_annotation_id, approved_by) VALUES ($1, $2, 'admin@example.com')`,
    [organizationId, annotation.rows[0]!.id],
  );
  await pool.query(
    `INSERT INTO capability_approvals
       (organization_id, capability_version_id, approved_by)
     VALUES ($1, $2, 'admin@example.com'), ($1, $3, 'admin@example.com')`,
    [organizationId, renamedCapabilityVersionId, breakingCapabilityVersionId],
  );
  await pool.query(
    `INSERT INTO capability_approvals
       (organization_id, capability_version_id, approved_by)
     VALUES ($1, $2, 'admin@example.com')`,
    [organizationId, removedOutputCapabilityVersionId],
  );
  await pool.query(
    `INSERT INTO capability_identity_heads
       (organization_id, capability_identity_id, capability_version_id) VALUES ($1, $2, $3)`,
    [organizationId, identity.rows[0]!.id, renamedCapabilityVersionId],
  );
  await pool.query(
    `INSERT INTO environment_capability_observations
      (organization_id, environment_id, capability_identity_id, capability_version_id)
     VALUES ($1, 'production', $2, $3)`,
    [organizationId, identity.rows[0]!.id, renamedCapabilityVersionId],
  );
  await pool.query(
    `INSERT INTO capability_host_policies
       (organization_id, capability_identity_id, environment_id, hostname, approved_by)
     VALUES ($1, $2, 'production', 'billing.example.com', 'admin@example.com')`,
    [organizationId, identity.rows[0]!.id],
  );
  const workflow = await createTransformationCompiledWorkflowVersion(
    'payment-flow@1',
    organizationId,
    {
      irVersion: 2,
      inputSchema: { required: { invoiceId: { type: 'string' }, currency: { type: 'string' } } },
      steps: [
        {
          id: 'settle-invoice',
          kind: 'capabilityCall',
          inputSchema: { required: {} },
          capabilityVersionId: oldCapabilityVersionId,
          arguments: {
            invoiceId: { source: 'literal', value: 'invoice-fixed' },
            region: { source: 'literal', value: 'us-central' },
          },
        },
        {
          id: 'unaffected-step',
          kind: 'capabilityCall',
          inputSchema: { required: {} },
          capabilityVersionId: renamedCapabilityVersionId,
          arguments: { invoiceId: { source: 'literal', value: 'invoice-fixed' } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    },
  );
  await pool.query(
    `INSERT INTO workflow_versions
       (organization_id, workflow_version_id, ir_hash, compiled_workflow)
     VALUES ($1, $2, $3, $4)`,
    [organizationId, workflow.workflowVersionId, workflow.irHash, workflow],
  );
  await pool.query(
    `INSERT INTO workflow_approvals
       (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
        projection_fingerprint, approved_by, lifecycle_status)
     VALUES ($1, 'production', $2, $3, 'mvp-validation-v1', $4,
       'admin@example.com', 'current')`,
    [organizationId, workflow.workflowVersionId, workflow.irHash, '0'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO workflow_environment_versions
       (organization_id, environment_id, workflow_version_id, lifecycle_status, is_active)
     VALUES ($1, 'production', $2, 'active', true)`,
    [organizationId, workflow.workflowVersionId],
  );
  await pool.query(
    `INSERT INTO workflow_capability_dependencies
       (organization_id, workflow_version_id, step_id, capability_version_id)
     VALUES ($1, $2, 'settle-invoice', $3)`,
    [organizationId, workflow.workflowVersionId, oldCapabilityVersionId],
  );
  await pool.query(
    `INSERT INTO compatibility_diffs
       (organization_id, capability_identity_id, from_capability_version_id,
        to_capability_version_id, classification, diff)
     VALUES
       ($1, $2, $3, $4, 'conditional', $5),
       ($1, $2, $3, $6, 'breaking', $7),
       ($1, $2, $3, $8, 'breaking', $9)`,
    [
      organizationId,
      identity.rows[0]!.id,
      oldCapabilityVersionId,
      renamedCapabilityVersionId,
      {
        fieldChanges: [
          {
            kind: 'renamed',
            fromPath:
              '/operation/requestBody/content/application~1json/schema/properties/invoiceId',
            path: '/operation/requestBody/content/application~1json/schema/properties/invoiceIdentifier',
            classification: 'conditional',
          },
        ],
      },
      breakingCapabilityVersionId,
      {
        fieldChanges: [
          {
            kind: 'renamed',
            fromPath:
              '/operation/requestBody/content/application~1json/schema/properties/invoiceId',
            path: '/operation/requestBody/content/application~1json/schema/properties/invoiceIdentifier',
            classification: 'conditional',
          },
          {
            kind: 'added-required',
            path: '/operation/requestBody/content/application~1json/schema/properties/currency',
            classification: 'breaking',
          },
        ],
      },
      removedOutputCapabilityVersionId,
      {
        fieldChanges: [
          {
            kind: 'removed',
            path: '/references/#~1components~1schemas~1Invoice/properties/customerId',
            classification: 'breaking',
          },
        ],
      },
    ],
  );
}

async function setCapabilityHead(capabilityVersionId: string) {
  await pool.query(
    `UPDATE capability_identity_heads SET capability_version_id = $1
     WHERE organization_id = $2`,
    [capabilityVersionId, organizationId],
  );
  await pool.query(
    `UPDATE environment_capability_observations
     SET capability_version_id = $1, availability_status = 'available', freshness_status = 'fresh',
         status_reason = 'successful-discovery'
     WHERE organization_id = $2 AND environment_id = 'production'`,
    [capabilityVersionId, organizationId],
  );
}

function requestFragment(
  required: string[],
  properties: Record<string, string>,
  responseFields: string[] = ['customerId'],
) {
  return {
    method: 'get',
    operation: {
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required,
              properties: Object.fromEntries(
                Object.entries(properties).map(([name, type]) => [name, { type }]),
              ),
            },
          },
        },
      },
      responses: {
        200: {
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Invoice' },
            },
          },
        },
      },
    },
    references: {
      '#/components/schemas/Invoice': {
        type: 'object',
        required: responseFields,
        properties: Object.fromEntries(responseFields.map((field) => [field, { type: 'string' }])),
      },
    },
  };
}

async function currentProjectionFingerprint() {
  const response = await app.request(
    `/v1/planner-capabilities?organizationId=${organizationId}&environmentId=production`,
  );
  return ((await response.json()) as { fingerprint: string }).fingerprint;
}

async function sourceWorkflow() {
  const result = await pool.query<{ compiled_workflow: TransformationCompiledWorkflowVersion }>(
    `SELECT compiled_workflow FROM workflow_versions
     WHERE organization_id = $1 AND workflow_version_id = 'payment-flow@1'`,
    [organizationId],
  );
  return result.rows[0]!.compiled_workflow;
}

function generateCandidate(input: {
  toCapabilityVersionId: string;
  workflowVersionId: string;
  projectionFingerprint: string;
}) {
  return app.request('/v1/workflow-migration-candidates', {
    method: 'POST',
    headers: { authorization: 'Bearer author-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      environmentId: 'production',
      sourceWorkflowVersionId: 'payment-flow@1',
      workflowVersionId: input.workflowVersionId,
      fromCapabilityVersionId: oldCapabilityVersionId,
      toCapabilityVersionId: input.toCapabilityVersionId,
      projectionFingerprint: input.projectionFingerprint,
    }),
  });
}
