import {
  compileTemporalWorkflowArtifact,
  verifyTemporalWorkflowArtifact,
} from '@atlas/workflow-artifact';
import type { VersionedCompiledWorkflowVersion } from '@atlas/workflow-ir';
import type { Pool } from 'pg';

import { canonicalJson, sha256 } from './capability-versioning.js';
import {
  readWorkflowSandboxReadinessForArtifact,
  workflowRequiresSandboxTests,
  WorkflowSandboxTestsUnavailable,
} from './workflow-sandbox.js';

export { compileTemporalWorkflowArtifact } from '@atlas/workflow-artifact';

export async function compileApprovedTemporalWorkflowArtifact(
  pool: Pick<Pool, 'query'>,
  scope: { readonly organizationId: string; readonly environmentId: string },
  workflow: VersionedCompiledWorkflowVersion,
) {
  const readiness = await readWorkflowSandboxReadinessForArtifact(pool, scope, workflow);
  if (workflowRequiresSandboxTests(workflow) && !readiness.ready) {
    throw new WorkflowSandboxTestsUnavailable(
      readiness.status === 'passed' ? 'failed' : readiness.status,
    );
  }
  const capabilityVersionIds = workflow.executionRequirements.requiredCapabilityVersionIds;
  const secretReferences: Array<{ capability_version_id: string; secret_alias: string | null }> =
    capabilityVersionIds.length === 0
      ? []
      : (
          await pool.query<{ capability_version_id: string; secret_alias: string | null }>(
            `SELECT version.capability_version_id, annotation.secret_alias
           FROM capability_versions version
           LEFT JOIN manifest_annotations annotation
             ON annotation.id = version.manifest_annotation_id
           WHERE version.organization_id = $1
             AND version.capability_version_id = ANY($2::text[])`,
            [scope.organizationId, capabilityVersionIds],
          )
        ).rows;
  return await compileTemporalWorkflowArtifact(workflow, {
    sandboxSuiteFingerprint:
      readiness.suiteFingerprint ?? sha256(canonicalJson({ providerContracts: [], tests: [] })),
    secretReferencesByCapabilityVersion: Object.fromEntries(
      secretReferences.flatMap((row) =>
        row.secret_alias ? [[row.capability_version_id.trim(), row.secret_alias]] : [],
      ),
    ),
  });
}

export async function readApprovedTemporalWorkflowArtifact(
  pool: Pick<Pool, 'query'>,
  scope: { readonly organizationId: string; readonly environmentId: string },
  artifactId: string,
) {
  if (!/^[a-f0-9]{64}$/.test(artifactId)) return undefined;
  const result = await pool.query<{ artifact_manifest: unknown }>(
    `SELECT artifact_manifest
     FROM workflow_approvals
     WHERE organization_id = $1 AND environment_id = $2 AND artifact_id = $3`,
    [scope.organizationId, scope.environmentId, artifactId],
  );
  const artifact = result.rows[0]?.artifact_manifest;
  if (!artifact) return undefined;
  try {
    return await verifyTemporalWorkflowArtifact(artifact);
  } catch {
    return undefined;
  }
}
