import { createTransformationCompiledWorkflowVersion } from '@atlas/workflow-ir';
import {
  compileAtlasBundle,
  createNonProductionLocalEd25519Signer,
} from '@atlas/workflow-artifact';
import { Pool } from 'pg';

import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { loadBackendConfig } from './config.js';
import { createHttpWorkflowSandboxExecutor } from './http-workflow-sandbox-executor.js';
import { compileApprovedTemporalWorkflowArtifact } from './workflow-artifact.js';
import { demoteActiveWorkflowVersions, recordWorkflowLifecycle } from './workflow-catalog.js';
import { runWorkflowSandboxTests } from './workflow-sandbox.js';
import { validateWorkflowDraft } from './workflow-validation.js';

const organizationId = 'org_atlas';
const environmentId = 'production';
const workflowId = 'invoice-drift-demo';
const workflowName = 'Invoice drift demo workflow';
const workflowVersionId = 'invoice-drift-demo@1';

const config = loadBackendConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
try {
  const capabilities = await pool.query<{
    capability_version_id: string;
    operation_id: string;
  }>(
    `SELECT head.capability_version_id, identity.operation_id
     FROM capability_identity_heads head
     JOIN capability_identities identity ON identity.id = head.capability_identity_id
     WHERE head.organization_id = $1
       AND ((identity.service_id = 'payments' AND identity.operation_id = 'getPayment')
         OR (identity.service_id = 'billing' AND identity.operation_id = 'getInvoice'))`,
    [organizationId],
  );
  const capabilityVersionIds = new Map(
    capabilities.rows.map(({ capability_version_id, operation_id }) => [
      operation_id,
      capability_version_id.trim(),
    ]),
  );
  const paymentCapabilityVersionId = capabilityVersionIds.get('getPayment');
  const billingCapabilityVersionId = capabilityVersionIds.get('getInvoice');
  if (!paymentCapabilityVersionId)
    throw new Error('The baseline Payment getPayment capability is missing');
  if (!billingCapabilityVersionId)
    throw new Error('The baseline Billing getInvoice capability is missing');

  const workflow = await createTransformationCompiledWorkflowVersion(
    workflowVersionId,
    organizationId,
    {
      irVersion: 2,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: paymentCapabilityVersionId,
          inputSchema: { required: { paymentId: { type: 'string' } } },
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          result: 'payment',
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
        {
          id: 'get-invoice',
          kind: 'capabilityCall',
          capabilityVersionId: billingCapabilityVersionId,
          inputSchema: { required: { invoiceId: { type: 'string' } } },
          arguments: {
            invoiceId: { source: 'stepOutput', stepId: 'get-payment', path: ['invoiceId'] },
          },
          responseSchema: {
            required: {
              invoiceId: { type: 'string' },
              version: { type: 'number' },
              status: { type: 'string' },
              outstandingBalance: {
                type: 'object',
                required: { value: { type: 'number' }, currency: { type: 'string' } },
              },
            },
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    },
  );
  const projection = await readPlannerCapabilityProjection(pool, organizationId, environmentId);
  const validation = await validateWorkflowDraft(pool, {
    organizationId,
    environmentId,
    proposedApproverRole: 'admin',
    projectionFingerprint: projection.fingerprint,
    plannerAuthoredLiteralPaths: [],
    draft: workflow,
  });
  if (!validation.decision.approvable) {
    throw new Error(
      `The drift demo workflow is not approvable: ${JSON.stringify(validation.diagnostics)}`,
    );
  }

  await pool.query('BEGIN');
  await pool.query(
    `INSERT INTO workflow_identities (organization_id, workflow_id, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (organization_id, workflow_id) DO UPDATE
     SET name = EXCLUDED.name, updated_at = current_timestamp`,
    [organizationId, workflowId, workflowName],
  );
  const storedVersion = await pool.query(
    `INSERT INTO workflow_versions
       (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, workflow_version_id) DO UPDATE
       SET workflow_id = EXCLUDED.workflow_id
       WHERE workflow_versions.ir_hash = EXCLUDED.ir_hash
         AND workflow_versions.compiled_workflow = EXCLUDED.compiled_workflow
         AND (workflow_versions.workflow_id = EXCLUDED.workflow_id
           OR workflow_versions.workflow_id LIKE 'unassigned-%')
     RETURNING workflow_version_id`,
    [organizationId, workflow.workflowVersionId, workflowId, workflow.irHash, workflow],
  );
  if (!storedVersion.rows[0]) {
    throw new Error(`${workflow.workflowVersionId} is already bound to another immutable workflow`);
  }
  await pool.query(
    `INSERT INTO workflow_capability_dependencies
       (organization_id, workflow_version_id, step_id, capability_version_id)
     VALUES ($1, $2, 'get-payment', $3), ($1, $2, 'get-invoice', $4)
     ON CONFLICT (organization_id, workflow_version_id, step_id) DO UPDATE
       SET capability_version_id = EXCLUDED.capability_version_id`,
    [
      organizationId,
      workflow.workflowVersionId,
      paymentCapabilityVersionId,
      billingCapabilityVersionId,
    ],
  );
  await pool.query(
    `INSERT INTO workflow_approvals
       (organization_id, environment_id, workflow_version_id, workflow_id, ir_hash,
        policy_version, projection_fingerprint, approved_by, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'mvp-validation-v1', $6, 'atlas-admin', 'approved')
     ON CONFLICT (organization_id, environment_id, workflow_version_id) DO UPDATE
     SET workflow_id = EXCLUDED.workflow_id, ir_hash = EXCLUDED.ir_hash,
       projection_fingerprint = EXCLUDED.projection_fingerprint`,
    [
      organizationId,
      environmentId,
      workflow.workflowVersionId,
      workflowId,
      workflow.irHash,
      projection.fingerprint,
    ],
  );
  await pool.query('COMMIT');

  const sandbox = await runWorkflowSandboxTests(
    pool,
    createHttpWorkflowSandboxExecutor(config.workflowSandboxRunnerUrls),
    { organizationId, environmentId, draft: workflow },
    'atlas-drift-demo',
  );
  if (sandbox.status !== 'passed') throw new Error('Drift demo sandbox tests failed');
  const artifact = await compileApprovedTemporalWorkflowArtifact(
    pool,
    { organizationId, environmentId },
    workflow,
  );
  if (!config.bundleSigningKeyId || !config.bundleSigningPrivateKey) {
    throw new Error('Drift demo bundle signing is not configured');
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
      environmentId,
      compiledPlan: artifact,
      provenance: {
        sourceFormatVersion: 'atlas-source/v1',
        sourceSha256: workflow.irHash,
        compiler: { name: 'atlas-workflow-compiler', version: 'drift-demo' },
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
    `UPDATE workflow_approvals
     SET lifecycle_status = 'superseded'
     WHERE organization_id = $1 AND environment_id = $2 AND workflow_id = $3
       AND lifecycle_status = 'current' AND workflow_version_id <> $4`,
    [organizationId, environmentId, workflowId, workflow.workflowVersionId],
  );
  await pool.query(
    `UPDATE workflow_approvals
     SET artifact_id = $4, artifact_manifest = $5, lifecycle_status = 'current'
     WHERE organization_id = $1 AND environment_id = $2 AND workflow_version_id = $3`,
    [
      organizationId,
      environmentId,
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
      organizationId,
      environmentId,
      Buffer.from(signedBundle.bytes),
      {
        artifactId: signedBundle.bundle.artifactId,
        organizationId,
        environmentId,
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
    organizationId,
    environmentId,
    replacingWorkflowVersionId: workflow.workflowVersionId,
  });
  await recordWorkflowLifecycle(pool, {
    organizationId,
    environmentId,
    workflowVersionId: workflow.workflowVersionId,
    status: 'active',
    isActive: true,
  });
  await pool.query('COMMIT');
} catch (error) {
  await pool.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  await pool.end();
}
