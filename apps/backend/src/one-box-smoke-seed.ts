import { Pool } from 'pg';

import { createTransformationCompiledWorkflowVersion } from '@atlas/workflow-ir';
import {
  compileAtlasBundle,
  createNonProductionLocalEd25519Signer,
} from '@atlas/workflow-artifact';

import { readCapabilityCatalog, readPlannerCapabilityProjection } from './capability-catalog.js';
import { loadBackendConfig } from './config.js';
import { createHttpWorkflowSandboxExecutor } from './http-workflow-sandbox-executor.js';
import { compileApprovedTemporalWorkflowArtifact } from './workflow-artifact.js';
import { demoteActiveWorkflowVersions, recordWorkflowLifecycle } from './workflow-catalog.js';
import { runWorkflowSandboxTests } from './workflow-sandbox.js';
import { validateWorkflowDraft } from './workflow-validation.js';

const workflowId = 'one-box-smoke';
const workflowName = 'One-box smoke workflow';
const scope = { organizationId: 'org_atlas', environmentId: 'production' } as const;

const config = loadBackendConfig();
const pool = new Pool({ connectionString: config.databaseUrl });

// The worker resolves capability activities from the same catalog, so the smoke workflow must
// call the demo-seeded payments/getPayment version rather than an ID only this seed knows.
async function resolveGetPaymentCapabilityVersionId() {
  const catalog = await readCapabilityCatalog(pool, scope.organizationId, scope.environmentId);
  const capability = catalog.find(
    ({ identity }) => identity.serviceId === 'payments' && identity.operationId === 'getPayment',
  );
  if (!capability) {
    throw new Error(
      'One-box smoke seed requires the demo capability seed to have registered payments/getPayment',
    );
  }
  return capability.capabilityVersionId;
}

async function compileSmokeWorkflow(getPaymentCapabilityVersionId: string) {
  return createTransformationCompiledWorkflowVersion('one-box-smoke@1', scope.organizationId, {
    irVersion: 2,
    inputSchema: { required: { paymentId: { type: 'string' } } },
    steps: [
      {
        id: 'get-payment',
        kind: 'capabilityCall',
        capabilityVersionId: getPaymentCapabilityVersionId,
        inputSchema: { required: { paymentId: { type: 'string' } } },
        arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        retryPolicy: {
          initialInterval: '10 milliseconds',
          backoffCoefficient: 2,
          maximumInterval: '100 milliseconds',
          maximumAttempts: 3,
          nonRetryableErrorTypes: ['PaymentNotFound', 'ResponseSchemaMismatch'],
          failureBuckets: {
            PaymentNotFound: 'permanent-validation',
            ResponseSchemaMismatch: 'permanent-validation',
          },
        },
        responseSchema: {
          required: {
            paymentId: { type: 'string' },
            invoiceId: { type: 'string' },
            status: { type: 'string' },
            amount: {
              type: 'object',
              required: { value: { type: 'number' }, currency: { type: 'string' } },
            },
            paidAt: { type: 'string' },
          },
        },
      },
      { id: 'completed', kind: 'terminal', state: 'completed' },
    ],
  });
}

try {
  const getPaymentCapabilityVersionId = await resolveGetPaymentCapabilityVersionId();
  const workflow = await compileSmokeWorkflow(getPaymentCapabilityVersionId);
  const projection = await readPlannerCapabilityProjection(
    pool,
    scope.organizationId,
    scope.environmentId,
  );
  const validation = await validateWorkflowDraft(pool, {
    ...scope,
    proposedApproverRole: 'admin',
    projectionFingerprint: projection.fingerprint,
    plannerAuthoredLiteralPaths: [],
    draft: workflow,
  });
  if (!validation.decision.approvable) {
    throw new Error(
      `The one-box smoke workflow is not approvable: ${JSON.stringify(validation.diagnostics)}`,
    );
  }
  await pool.query('BEGIN');
  await pool.query(
    `INSERT INTO workflow_identities (organization_id, workflow_id, name)
     VALUES ('org_atlas', $1, $2)
     ON CONFLICT (organization_id, workflow_id) DO UPDATE
     SET name = EXCLUDED.name, updated_at = current_timestamp`,
    [workflowId, workflowName],
  );
  const storedVersion = await pool.query(
    `INSERT INTO workflow_versions
      (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, workflow_version_id) DO UPDATE
       SET workflow_id = EXCLUDED.workflow_id
       WHERE workflow_versions.ir_hash = EXCLUDED.ir_hash
         AND workflow_versions.compiled_workflow = EXCLUDED.compiled_workflow
         AND workflow_versions.workflow_id = EXCLUDED.workflow_id
     RETURNING workflow_version_id`,
    ['org_atlas', workflow.workflowVersionId, workflowId, workflow.irHash, workflow],
  );
  if (!storedVersion.rows[0]) {
    throw new Error(`${workflow.workflowVersionId} is already bound to another immutable workflow`);
  }
  await pool.query(
    `INSERT INTO workflow_capability_dependencies
      (organization_id, workflow_version_id, step_id, capability_version_id)
     VALUES ($1, $2, 'get-payment', $3)
     ON CONFLICT (organization_id, workflow_version_id, step_id) DO UPDATE
       SET capability_version_id = EXCLUDED.capability_version_id`,
    [scope.organizationId, workflow.workflowVersionId, getPaymentCapabilityVersionId],
  );
  await pool.query(
    `INSERT INTO workflow_approvals
      (organization_id, environment_id, workflow_version_id, workflow_id, ir_hash, policy_version,
       projection_fingerprint, approved_by, lifecycle_status)
     VALUES ('org_atlas', 'production', $1, $2, $3, $4, $5, 'atlas-admin',
       'approved')
     ON CONFLICT (organization_id, environment_id, workflow_version_id) DO UPDATE
     SET workflow_id = EXCLUDED.workflow_id, ir_hash = EXCLUDED.ir_hash,
       policy_version = EXCLUDED.policy_version,
       projection_fingerprint = EXCLUDED.projection_fingerprint`,
    [
      workflow.workflowVersionId,
      workflowId,
      workflow.irHash,
      validation.decision.policyVersion,
      validation.decision.projectionFingerprint,
    ],
  );
  await pool.query('COMMIT');

  const sandbox = await runWorkflowSandboxTests(
    pool,
    createHttpWorkflowSandboxExecutor(config.workflowSandboxRunnerUrls),
    { ...scope, draft: workflow },
    'atlas-smoke',
  );
  if (sandbox.status !== 'passed') {
    throw new Error('One-box smoke workflow sandbox tests failed');
  }
  const artifact = await compileApprovedTemporalWorkflowArtifact(pool, scope, workflow);
  if (!config.bundleSigningKeyId || !config.bundleSigningPrivateKey) {
    throw new Error('One-box smoke bundle signing is not configured');
  }
  const signedAt = new Date().toISOString();
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    Buffer.from(config.bundleSigningPrivateKey, 'base64'),
    'Ed25519',
    false,
    ['sign'],
  );
  const signedBundle = await compileAtlasBundle(
    {
      environmentId: scope.environmentId,
      compiledPlan: artifact,
      provenance: {
        sourceFormatVersion: 'atlas-source/v1',
        sourceSha256: workflow.irHash,
        compiler: { name: 'atlas-workflow-compiler', version: 'one-box-smoke' },
        compiledAt: signedAt,
      },
      approval: {
        policyVersion: validation.decision.policyVersion,
        projectionFingerprint: validation.decision.projectionFingerprint,
        sandboxSuiteFingerprint: artifact.evidence.sandboxSuiteFingerprint,
        approvedBy: 'atlas-admin',
        approvedAt: signedAt,
      },
      signedAt,
    },
    createNonProductionLocalEd25519Signer(config.bundleSigningKeyId, signingKey),
  );
  await pool.query('BEGIN');
  await pool.query(
    `UPDATE workflow_approvals SET lifecycle_status = 'superseded'
     WHERE organization_id = $1 AND environment_id = $2 AND workflow_id = $3
       AND lifecycle_status = 'current'`,
    [scope.organizationId, scope.environmentId, workflowId],
  );
  await pool.query(
    `UPDATE workflow_approvals
     SET artifact_id = $4, artifact_manifest = $5, lifecycle_status = 'current'
     WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3`,
    [
      scope.organizationId,
      scope.environmentId,
      workflow.workflowVersionId,
      signedBundle.bundle.artifactId,
      artifact,
    ],
  );
  await pool.query(
    `INSERT INTO atlas_workflow_bundles
      (artifact_id, organization_id, environment_id, bundle_bytes,
       activation_artifact_id, approval_binding)
     VALUES ($1, $2, $3, $4, $1, $5)`,
    [
      signedBundle.bundle.artifactId,
      scope.organizationId,
      scope.environmentId,
      Buffer.from(signedBundle.bytes),
      {
        artifactId: signedBundle.bundle.artifactId,
        organizationId: scope.organizationId,
        environmentId: scope.environmentId,
        workflowVersionId: workflow.workflowVersionId,
        irHash: workflow.irHash,
        policyVersion: validation.decision.policyVersion,
        projectionFingerprint: validation.decision.projectionFingerprint,
        sandboxSuiteFingerprint: artifact.evidence.sandboxSuiteFingerprint,
        status: 'active',
      },
    ],
  );
  await demoteActiveWorkflowVersions(pool, {
    organizationId: scope.organizationId,
    environmentId: scope.environmentId,
    replacingWorkflowVersionId: workflow.workflowVersionId,
  });
  await recordWorkflowLifecycle(pool, {
    organizationId: scope.organizationId,
    environmentId: scope.environmentId,
    workflowVersionId: workflow.workflowVersionId,
    status: 'active',
    isActive: true,
  });
  await pool.query('COMMIT');
} catch (error) {
  await pool.query('ROLLBACK');
  throw error;
} finally {
  await pool.end();
}
