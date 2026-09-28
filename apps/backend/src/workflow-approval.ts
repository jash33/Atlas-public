import {
  isCapabilityStep,
  versionedCompiledWorkflowVersionSchema,
  verifyCompiledWorkflowVersionIntegrity,
  visitTransformationExpression,
} from '@atlas/workflow-ir';
import { executionGrantSchema, type ExecutionGrant } from '@atlas/execution-grant';
import { compileAtlasBundle, type AtlasBundleSigner } from '@atlas/workflow-artifact';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import type { ExecutionGrantIssuer } from './execution-grant-issuer.js';
import { discardBackendOwnedDraftFields, validateWorkflowDraft } from './workflow-validation.js';
import { compileApprovedTemporalWorkflowArtifact } from './workflow-artifact.js';
import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { demoteActiveWorkflowVersions, recordWorkflowLifecycle } from './workflow-catalog.js';
import { compileWorkflowSource, renderWorkflowSource } from './workflow-source.js';
import {
  findWorkflowMigrationCandidateForApproval,
  readWorkflowMigrationCandidate,
} from './workflow-migration.js';
import type {
  WorkflowApprovalActor,
  WorkflowApprovalAuthorizer,
  WorkflowRepairAuthorizer,
  WorkflowWorkerAuthorizer,
} from './workflow-authorization.js';
import { assertWorkflowIntakeOpen } from './workflow-quarantine.js';
import { assertWorkflowCapabilityLossOpen } from './capability-loss-protection.js';
import { recordWorkflowRunStarted } from './workflow-runs.js';

export interface WorkflowExecutionServices {
  readonly approvalAuthorizer: WorkflowApprovalAuthorizer;
  readonly workerAuthorizer: WorkflowWorkerAuthorizer;
  readonly repairAuthorizer?: WorkflowRepairAuthorizer;
  readonly executionGrantIssuer: ExecutionGrantIssuer;
  readonly bundleSigner?: AtlasBundleSigner;
}

export const workflowApprovalRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    migrationCandidateId: z.string().regex(/^\d+$/).optional(),
    draft: z.unknown(),
  })
  .strict();

export const executionGrantRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    runId: z.string().min(1),
    intakeKey: z.string().regex(/^(?:[a-z0-9.-]+:)?[a-f0-9]{64}$/),
    artifactId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    runCommandId: z.string().uuid().optional(),
    trigger: z
      .discriminatedUnion('type', [
        z.object({ type: z.literal('manual') }).strict(),
        z
          .object({ type: z.literal('webhook'), deliveryId: z.string().trim().min(1).max(255) })
          .strict(),
        z
          .object({ type: z.literal('api'), deliveryId: z.string().trim().min(1).max(255) })
          .strict(),
        z
          .object({
            type: z.literal('schedule'),
            scheduleId: z.string().uuid(),
            scheduledFor: z.iso.datetime({ offset: true }),
          })
          .strict(),
      ])
      .default({ type: 'manual' }),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.runCommandId && !request.artifactId) {
      context.addIssue({
        code: 'custom',
        path: ['artifactId'],
        message: 'A run command must carry its pinned artifact ID',
      });
    }
  });

export class WorkflowApprovalConflict extends Error {}
export class ExecutionArtifactMismatch extends Error {}

const runAdmissionBindingSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    runId: z.string().min(1),
    workflowVersionId: z.string().min(1),
    artifactId: z.string().regex(/^[a-f0-9]{64}$/),
    irHash: z.string().regex(/^[a-f0-9]{64}$/),
    capabilityVersionIds: z.array(z.string().min(1)),
    activationArtifactId: z.string().regex(/^[a-f0-9]{64}$/),
    approval: z.record(z.string(), z.unknown()),
    executionGrant: executionGrantSchema,
  })
  .strict();

export async function approveWorkflow(
  pool: Pool,
  request: z.infer<typeof workflowApprovalRequestSchema>,
  actor: WorkflowApprovalActor,
  bundleSigner: AtlasBundleSigner,
) {
  const requestedWorkflow = versionedCompiledWorkflowVersionSchema.safeParse(
    discardBackendOwnedDraftFields(request.draft),
  );
  const candidate = request.migrationCandidateId
    ? await readWorkflowMigrationCandidate(
        pool,
        request.organizationId,
        request.migrationCandidateId,
      )
    : requestedWorkflow.success
      ? await findWorkflowMigrationCandidateForApproval(
          pool,
          request.organizationId,
          request.environmentId,
          requestedWorkflow.data.workflowVersionId,
          requestedWorkflow.data.irHash,
        )
      : undefined;
  if (request.migrationCandidateId && !candidate) {
    throw new WorkflowApprovalConflict('Migration candidate was not found');
  }
  if (
    candidate &&
    (candidate.environmentId !== request.environmentId ||
      !requestedWorkflow.success ||
      candidate.draft.workflowVersionId !== requestedWorkflow.data.workflowVersionId ||
      candidate.draft.irHash !== requestedWorkflow.data.irHash)
  ) {
    throw new WorkflowApprovalConflict('Approval draft does not match the migration candidate');
  }
  const { migrationCandidateId: _migrationCandidateId, ...validationRequest } = request;
  const validation = await validateWorkflowDraft(pool, {
    ...validationRequest,
    plannerAuthoredLiteralPaths: candidate?.validationContext.plannerAuthoredLiteralPaths ?? [],
    proposedApproverRole: actor.role,
  });
  if (
    !validation.decision.approvable ||
    validation.diagnostics.length > 0 ||
    validation.decision.recomputedIrHash === null
  ) {
    return { approved: false as const, validation };
  }

  const workflow = await verifyCompiledWorkflowVersionIntegrity(
    versionedCompiledWorkflowVersionSchema.parse(discardBackendOwnedDraftFields(request.draft)),
  );
  if (workflow.irHash !== validation.decision.recomputedIrHash) {
    throw new WorkflowApprovalConflict('Validated hash does not match the compiled workflow');
  }
  const artifact = await compileApprovedTemporalWorkflowArtifact(
    pool,
    { organizationId: request.organizationId, environmentId: request.environmentId },
    workflow,
  );
  const projection = await readPlannerCapabilityProjection(
    pool,
    request.organizationId,
    request.environmentId,
  );
  const source = renderWorkflowSource(workflow, projection);
  const sourceCompilation = await compileWorkflowSource(source, {
    organizationId: request.organizationId,
    workflowVersionId: workflow.workflowVersionId,
    projection,
  });
  if (!sourceCompilation.success || sourceCompilation.workflow.irHash !== workflow.irHash) {
    throw new WorkflowApprovalConflict(
      !sourceCompilation.success
        ? `Reviewable Atlas source did not compile: ${sourceCompilation.diagnostics.map(({ code }) => code).join(', ')}`
        : 'Reviewable Atlas source does not reproduce the approved workflow',
    );
  }
  const timestamp = new Date().toISOString();
  const signedBundle = await compileAtlasBundle(
    {
      environmentId: request.environmentId,
      compiledPlan: artifact,
      provenance: {
        sourceFormatVersion: 'atlas-source/v1',
        sourceSha256: sourceCompilation.provenance.sourceSha256,
        compiler: sourceCompilation.provenance.compiler,
        compiledAt: timestamp,
      },
      approval: {
        policyVersion: validation.decision.policyVersion,
        projectionFingerprint: validation.decision.projectionFingerprint,
        sandboxSuiteFingerprint: artifact.evidence.sandboxSuiteFingerprint,
        approvedBy: actor.actorId,
        approvedAt: timestamp,
      },
      signedAt: timestamp,
      contentPolicy: {
        literalClassifications: bundleLiteralClassifications(workflow),
      },
    },
    bundleSigner,
  );
  const executionArtifactId = signedBundle.bundle.artifactId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await persistImmutableWorkflow(client, workflow, request.environmentId);
    if (!candidate) {
      await client.query(
        `UPDATE workflow_approvals SET lifecycle_status = 'superseded'
         WHERE organization_id = $1 AND environment_id = $2
           AND lifecycle_status = 'current'
           AND workflow_id = (
             SELECT workflow_id FROM workflow_versions
             WHERE organization_id = $1 AND workflow_version_id = $3
           )`,
        [request.organizationId, request.environmentId, workflow.workflowVersionId],
      );
    }
    const approval = await client.query<{
      approved_by: string;
      approved_at: Date;
      lifecycle_status: 'approved' | 'current';
    }>(
      `INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, workflow_id, ir_hash, policy_version,
          projection_fingerprint, approved_by, lifecycle_status, artifact_id, artifact_manifest)
       VALUES ($1, $2, $3,
         (SELECT workflow_id FROM workflow_versions
          WHERE organization_id = $1 AND workflow_version_id = $3), $4, $5, $6, $7,
         CASE WHEN EXISTS (
           SELECT 1 FROM workflow_approvals
           WHERE organization_id = $1 AND environment_id = $2 AND lifecycle_status = 'current'
             AND workflow_id = (
               SELECT workflow_id FROM workflow_versions
               WHERE organization_id = $1 AND workflow_version_id = $3
             )
         ) THEN 'approved' ELSE 'current' END, $8, $9)
       ON CONFLICT (organization_id, environment_id, workflow_version_id) DO NOTHING
       RETURNING approved_by, approved_at, lifecycle_status`,
      [
        request.organizationId,
        request.environmentId,
        workflow.workflowVersionId,
        workflow.irHash,
        validation.decision.policyVersion,
        validation.decision.projectionFingerprint,
        actor.actorId,
        executionArtifactId,
        artifact,
      ],
    );
    if (!approval.rows[0]) {
      throw new WorkflowApprovalConflict('Workflow version is already approved');
    }
    if (approval.rows[0].lifecycle_status === 'current') {
      await demoteActiveWorkflowVersions(client, {
        organizationId: request.organizationId,
        environmentId: request.environmentId,
        replacingWorkflowVersionId: workflow.workflowVersionId,
      });
    }
    await recordWorkflowLifecycle(client, {
      organizationId: request.organizationId,
      environmentId: request.environmentId,
      workflowVersionId: workflow.workflowVersionId,
      status: approval.rows[0].lifecycle_status === 'current' ? 'active' : 'approved-inactive',
      isActive: approval.rows[0].lifecycle_status === 'current',
      observedAt: approval.rows[0].approved_at,
    });
    await persistDependencies(client, workflow);
    if (signedBundle) {
      await client.query(
        `INSERT INTO atlas_workflow_bundles
          (artifact_id, organization_id, environment_id, bundle_bytes,
           activation_artifact_id, approval_binding)
         VALUES ($1, $2, $3, $4, $1, $5)`,
        [
          signedBundle.bundle.artifactId,
          request.organizationId,
          request.environmentId,
          Buffer.from(signedBundle.bytes),
          {
            artifactId: signedBundle.bundle.artifactId,
            organizationId: request.organizationId,
            environmentId: request.environmentId,
            workflowVersionId: workflow.workflowVersionId,
            irHash: workflow.irHash,
            policyVersion: validation.decision.policyVersion,
            projectionFingerprint: validation.decision.projectionFingerprint,
            sandboxSuiteFingerprint: artifact.evidence.sandboxSuiteFingerprint,
            status: 'active',
          },
        ],
      );
    }
    await client.query('COMMIT');
    return {
      approved: true as const,
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      approvedBy: approval.rows[0].approved_by,
      approvedAt: approval.rows[0].approved_at.toISOString(),
      artifact,
      ...(signedBundle ? { bundle: signedBundle.bundle, source } : {}),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function bundleLiteralClassifications(
  workflow: z.infer<typeof versionedCompiledWorkflowVersionSchema>,
) {
  return workflow.executable.steps.flatMap((step) => {
    if (!isCapabilityStep(step)) return [];
    return Object.entries(step.arguments).flatMap(([argument, expression]) => {
      if (!containsLiteral(expression)) return [];
      const destination = 'inputSchema' in step ? step.inputSchema.required[argument] : undefined;
      return [
        {
          stepId: step.id,
          argument,
          classification: destination?.classification ?? ('internal' as const),
        },
      ];
    });
  });
}

function containsLiteral(value: unknown): boolean {
  let found = false;
  visitTransformationExpression(value, (node) => {
    if (node.source === 'literal') found = true;
  });
  return found;
}

async function persistImmutableWorkflow(
  client: PoolClient,
  workflow: z.infer<typeof versionedCompiledWorkflowVersionSchema>,
  environmentId: string,
) {
  // Resolve identity in application code. The previous INSERT asked Postgres for
  // "the" current workflow in the environment as a single value. That crashes
  // when more than one current exists, and Console showed it as a 500.
  const workflowId = await workflowIdForVersionPersist(client, {
    organizationId: workflow.executionRequirements.organizationId,
    workflowVersionId: workflow.workflowVersionId,
    environmentId,
  });
  const inserted = await client.query(
    `INSERT INTO workflow_versions
      (organization_id, workflow_version_id, workflow_id, ir_hash, compiled_workflow)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, workflow_version_id) DO UPDATE
       SET ir_hash = EXCLUDED.ir_hash, compiled_workflow = EXCLUDED.compiled_workflow
       WHERE workflow_versions.ir_hash IS NULL
          OR workflow_versions.ir_hash = EXCLUDED.ir_hash
     RETURNING workflow_version_id`,
    [
      workflow.executionRequirements.organizationId,
      workflow.workflowVersionId,
      workflowId,
      workflow.irHash,
      workflow,
    ],
  );
  if (!inserted.rows[0]) {
    throw new WorkflowApprovalConflict('Workflow version id already names different immutable IR');
  }
}

// Catalog allows many current workflows in one environment. Unique current is
// (organization, environment, workflow), not one current per environment.
//
// Approve used to copy identity from "the" current approval in the environment
// so an unnamed replacement stayed the same workflow. That lookup 500s as soon
// as a second workflow is already current (the Catalog path Console uses).
//
// Prefer this version's Catalog identity. Inherit current only when there is
// exactly one, which is the unnamed-replacement case. Otherwise leave it null
// and assign_unscoped_workflow_identity creates a new identity.
async function workflowIdForVersionPersist(
  client: PoolClient,
  input: {
    organizationId: string;
    workflowVersionId: string;
    environmentId: string;
  },
) {
  const existing = await client.query<{ workflow_id: string }>(
    `SELECT workflow_id FROM workflow_versions
     WHERE organization_id = $1 AND workflow_version_id = $2`,
    [input.organizationId, input.workflowVersionId],
  );
  if (existing.rows[0]?.workflow_id) return existing.rows[0].workflow_id;

  const currents = await client.query<{ workflow_id: string }>(
    `SELECT workflow_id FROM workflow_approvals
     WHERE organization_id = $1 AND environment_id = $2 AND lifecycle_status = 'current'`,
    [input.organizationId, input.environmentId],
  );
  return currents.rows.length === 1 ? currents.rows[0]!.workflow_id : null;
}

async function persistDependencies(
  client: PoolClient,
  workflow: z.infer<typeof versionedCompiledWorkflowVersionSchema>,
) {
  for (const step of workflow.executable.steps) {
    if (!isCapabilityStep(step)) continue;
    await client.query(
      `INSERT INTO workflow_capability_dependencies
        (organization_id, workflow_version_id, step_id, capability_version_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [
        workflow.executionRequirements.organizationId,
        workflow.workflowVersionId,
        step.id,
        step.capabilityVersionId,
      ],
    );
  }
}

export async function readApprovedWorkflow(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  environmentId: string,
  workflowVersionId: string,
) {
  const result = await pool.query<{ compiled_workflow: unknown }>(
    `SELECT version.compiled_workflow
     FROM workflow_versions version
     JOIN workflow_approvals approval
       ON approval.organization_id = version.organization_id
      AND approval.workflow_version_id = version.workflow_version_id
      AND approval.ir_hash = version.ir_hash
     WHERE version.organization_id = $1
       AND approval.environment_id = $2
       AND version.workflow_version_id = $3`,
    [organizationId, environmentId, workflowVersionId],
  );
  const row = result.rows[0];
  return row ? versionedCompiledWorkflowVersionSchema.parse(row.compiled_workflow) : undefined;
}

export async function issueApprovedExecutionGrant(
  pool: Pool,
  issuer: ExecutionGrantIssuer,
  request: z.infer<typeof executionGrantRequestSchema>,
) {
  const client = await pool.connect();
  let workflow: z.infer<typeof versionedCompiledWorkflowVersionSchema> | undefined;
  let artifactId: string | undefined;
  let authorization: { artifactId?: string; grant: ExecutionGrant } | undefined;
  try {
    await client.query('BEGIN');
    const existingRun = await client.query<{
      workflow_version_id: string;
      artifact_id: string | null;
      admission_binding: unknown;
    }>(
      `SELECT workflow_version_id, artifact_id, admission_binding FROM workflow_runs
       WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3
       FOR UPDATE`,
      [request.organizationId, request.environmentId, request.runId],
    );
    const storedBinding = runAdmissionBindingSchema.safeParse(
      existingRun.rows[0]?.admission_binding,
    );
    if (storedBinding.success) {
      authorization = {
        artifactId: storedBinding.data.artifactId,
        grant: storedBinding.data.executionGrant,
      };
    }
    const existingWorkflowVersionId = existingRun.rows[0]?.workflow_version_id;
    if (existingWorkflowVersionId && !authorization) {
      const deployment = await readApprovedDeployment(
        client,
        request.organizationId,
        request.environmentId,
        existingWorkflowVersionId,
      );
      workflow = deployment?.workflow;
      artifactId = existingRun.rows[0]?.artifact_id?.trim() ?? deployment?.artifactId;
    } else if (!authorization) {
      const deployment = request.runCommandId
        ? await readRunCommandDeployment(client, request)
        : await readCurrentApprovedWorkflow(client, request.organizationId, request.environmentId);
      workflow = deployment?.workflow;
      artifactId = deployment?.artifactId;
      if (deployment && !artifactId) {
        const storedBundle = await client.query<{ artifact_id: string; bundle_bytes: Buffer }>(
          `SELECT artifact_id, bundle_bytes FROM atlas_workflow_bundles
           WHERE organization_id = $1 AND environment_id = $2
             AND approval_binding->>'workflowVersionId' = $3
           ORDER BY created_at DESC LIMIT 1`,
          [request.organizationId, request.environmentId, deployment.workflow.workflowVersionId],
        );
        const restoredBundle = storedBundle.rows[0];
        const artifact = restoredBundle
          ? (
              JSON.parse(restoredBundle.bundle_bytes.toString('utf8')) as {
                compiledPlan: unknown;
              }
            ).compiledPlan
          : await compileApprovedTemporalWorkflowArtifact(
              client,
              { organizationId: request.organizationId, environmentId: request.environmentId },
              deployment.workflow,
            );
        const restoredArtifactId = restoredBundle?.artifact_id.trim();
        await client.query(
          `UPDATE workflow_approvals
           SET artifact_id = $4, artifact_manifest = $5
           WHERE organization_id = $1 AND environment_id = $2
             AND workflow_version_id = $3 AND lifecycle_status = 'current'
             AND artifact_id IS NULL`,
          [
            request.organizationId,
            request.environmentId,
            deployment.workflow.workflowVersionId,
            restoredArtifactId ?? (artifact as { artifactId: string }).artifactId,
            artifact,
          ],
        );
        artifactId = restoredArtifactId ?? (artifact as { artifactId: string }).artifactId;
      }
      if (!request.runCommandId && request.artifactId && artifactId !== request.artifactId) {
        throw new ExecutionArtifactMismatch('The requested artifact is no longer active');
      }
      if (deployment) {
        await assertWorkflowCapabilityLossOpen(client, {
          organizationId: request.organizationId,
          environmentId: request.environmentId,
          workflowVersionId: deployment.workflow.workflowVersionId,
        });
        if (!request.runCommandId) {
          await assertWorkflowIntakeOpen(
            client,
            request.organizationId,
            request.environmentId,
            deployment.workflow.workflowVersionId,
          );
        }
        await recordWorkflowRunStarted(client, {
          ...request,
          workflowVersionId: deployment.workflow.workflowVersionId,
          artifactId,
        });
      }
    }
    if (workflow && !authorization) {
      const approvedHostnames = await readApprovedExecutionHostnames(
        client,
        request.organizationId,
        request.environmentId,
        workflow.executionRequirements.requiredCapabilityVersionIds,
      );
      const grant = await issuer.issueForRun({
        environmentId: request.environmentId,
        runId: request.runId,
        workflow,
        approvedHostnames,
      });
      authorization = { ...(artifactId ? { artifactId } : {}), grant };
      if (artifactId) {
        const policy = await readPersistedBundlePolicy(client, request, artifactId);
        if (policy) {
          const binding = runAdmissionBindingSchema.parse({
            organizationId: request.organizationId,
            environmentId: request.environmentId,
            runId: request.runId,
            workflowVersionId: workflow.workflowVersionId,
            artifactId,
            irHash: workflow.irHash,
            capabilityVersionIds: workflow.executionRequirements.requiredCapabilityVersionIds,
            activationArtifactId: policy.activationArtifactId,
            approval: policy.approval,
            executionGrant: grant,
          });
          await client.query(
            `UPDATE workflow_runs SET admission_binding = $4
             WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3
               AND admission_binding IS NULL`,
            [request.organizationId, request.environmentId, request.runId, binding],
          );
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return authorization;
}

async function readApprovedExecutionHostnames(
  client: Pick<PoolClient, 'query'>,
  organizationId: string,
  environmentId: string,
  capabilityVersionIds: readonly string[],
) {
  if (capabilityVersionIds.length === 0) return [];
  const result = await client.query<{ hostname: string }>(
    `SELECT DISTINCT policy.hostname
     FROM capability_versions version
     JOIN capability_host_policies policy
       ON policy.organization_id = version.organization_id
      AND policy.capability_identity_id = version.capability_identity_id
     WHERE version.organization_id = $1
       AND policy.environment_id = $2
       AND version.capability_version_id = ANY($3::char(64)[])
       AND policy.revoked_at IS NULL
     ORDER BY policy.hostname`,
    [organizationId, environmentId, capabilityVersionIds],
  );
  return result.rows.map(({ hostname }) => hostname);
}

async function readPersistedBundlePolicy(
  pool: Pick<Pool, 'query'>,
  request: z.infer<typeof executionGrantRequestSchema>,
  artifactId: string,
) {
  const result = await pool.query<{
    activation_artifact_id: string;
    approval_binding: unknown;
  }>(
    `SELECT activation_artifact_id, approval_binding FROM atlas_workflow_bundles
     WHERE organization_id = $1 AND environment_id = $2 AND artifact_id = $3`,
    [request.organizationId, request.environmentId, artifactId],
  );
  const row = result.rows[0];
  return row
    ? { activationArtifactId: row.activation_artifact_id.trim(), approval: row.approval_binding }
    : undefined;
}

async function readRunCommandDeployment(
  pool: Pick<Pool, 'query'>,
  request: z.infer<typeof executionGrantRequestSchema>,
) {
  const result = await pool.query<{
    artifact_id: string;
    compiled_workflow: unknown;
    trigger_type: 'manual' | 'webhook' | 'schedule' | 'api';
    trigger_delivery_id: string | null;
    trigger_schedule_id: string | null;
    trigger_scheduled_for: Date | null;
  }>(
    `SELECT command.artifact_id, command.trigger_type, command.trigger_delivery_id,
            command.trigger_schedule_id, command.trigger_scheduled_for,
            version.compiled_workflow
     FROM workflow_run_commands command
     JOIN workflow_approvals approval
       ON approval.organization_id = command.organization_id
      AND approval.environment_id = command.environment_id
      AND approval.artifact_id = command.artifact_id
     JOIN workflow_versions version
       ON version.organization_id = approval.organization_id
      AND version.workflow_version_id = approval.workflow_version_id
      AND version.ir_hash = approval.ir_hash
     WHERE command.command_id = $1 AND command.organization_id = $2
       AND command.environment_id = $3 AND command.status = 'dispatched'
       AND command.artifact_id = $4
     LIMIT 1`,
    [request.runCommandId, request.organizationId, request.environmentId, request.artifactId],
  );
  const row = result.rows[0];
  const triggerMatches =
    row &&
    (request.trigger.type === 'manual'
      ? row.trigger_type === 'manual'
      : request.trigger.type === 'webhook'
        ? row.trigger_type === 'webhook' && row.trigger_delivery_id === request.trigger.deliveryId
        : request.trigger.type === 'api'
          ? row.trigger_type === 'api' && row.trigger_delivery_id === request.trigger.deliveryId
          : row.trigger_type === 'schedule' &&
            row.trigger_schedule_id === request.trigger.scheduleId &&
            row.trigger_scheduled_for?.toISOString() === request.trigger.scheduledFor);
  if (!row || !triggerMatches) {
    throw new ExecutionArtifactMismatch('The run command binding is invalid');
  }
  return {
    artifactId: row.artifact_id.trim(),
    workflow: versionedCompiledWorkflowVersionSchema.parse(row.compiled_workflow),
  };
}

async function readCurrentApprovedWorkflow(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  environmentId: string,
) {
  const result = await pool.query<{ workflow_version_id: string }>(
    `SELECT workflow_version_id FROM workflow_approvals
     WHERE organization_id = $1 AND environment_id = $2 AND lifecycle_status = 'current'
     FOR UPDATE`,
    [organizationId, environmentId],
  );
  const row = result.rows[0];
  return row
    ? readApprovedDeployment(pool, organizationId, environmentId, row.workflow_version_id)
    : undefined;
}

async function readApprovedDeployment(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  environmentId: string,
  workflowVersionId: string,
) {
  const result = await pool.query<{ compiled_workflow: unknown; artifact_id: string | null }>(
    `SELECT version.compiled_workflow, approval.artifact_id
     FROM workflow_versions version
     JOIN workflow_approvals approval
       ON approval.organization_id = version.organization_id
      AND approval.workflow_version_id = version.workflow_version_id
      AND approval.ir_hash = version.ir_hash
     WHERE version.organization_id = $1
       AND approval.environment_id = $2
       AND version.workflow_version_id = $3`,
    [organizationId, environmentId, workflowVersionId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  const workflow = versionedCompiledWorkflowVersionSchema.parse(row.compiled_workflow);
  return { workflow, artifactId: row.artifact_id?.trim() };
}
