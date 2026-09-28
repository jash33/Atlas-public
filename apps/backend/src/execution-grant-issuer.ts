import {
  issueExecutionGrant,
  type ExecutionGrant,
  type ExecutionGrantClaims,
} from '@atlas/execution-grant';
import {
  verifyCompiledWorkflowVersionIntegrity,
  type VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';

export interface ExecutionGrantRun {
  readonly environmentId: string;
  readonly runId: string;
  readonly workflow: VersionedCompiledWorkflowVersion;
  readonly approvedHostnames: readonly string[];
}

export interface ExecutionGrantIssuer {
  issueForRun(run: ExecutionGrantRun): Promise<ExecutionGrant>;
}

export function createExecutionGrantIssuer(signingPrivateKey: string): ExecutionGrantIssuer {
  return {
    async issueForRun(run) {
      const workflow = await verifyCompiledWorkflowVersionIntegrity(run.workflow);
      return issueExecutionGrant(signingPrivateKey, claimsForRun(run, workflow));
    },
  };
}

export function createEnvironmentExecutionGrantIssuer(
  signingPrivateKeys: Readonly<Record<string, string>>,
): ExecutionGrantIssuer {
  return {
    async issueForRun(run) {
      const signingPrivateKey = signingPrivateKeys[run.environmentId];
      if (!signingPrivateKey) {
        throw new Error(`No execution-grant signing key is configured for '${run.environmentId}'`);
      }
      return createExecutionGrantIssuer(signingPrivateKey).issueForRun(run);
    },
  };
}

function claimsForRun(
  run: ExecutionGrantRun,
  workflow: VersionedCompiledWorkflowVersion,
): ExecutionGrantClaims {
  return {
    organizationId: workflow.executionRequirements.organizationId,
    environmentId: run.environmentId,
    runId: run.runId,
    workflowVersionId: workflow.executionRequirements.workflowVersionId,
    irHash: workflow.executionRequirements.irHash,
    approvedCapabilityVersionIds: workflow.executionRequirements.requiredCapabilityVersionIds,
    approvedHostnames: run.approvedHostnames,
  };
}
