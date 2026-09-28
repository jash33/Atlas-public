import {
  executionGrantSchema,
  verifyExecutionGrant,
  type ExecutionGrant,
} from '@atlas/execution-grant';
import {
  versionedCompiledWorkflowVersionSchema,
  verifyCompiledWorkflowVersionIntegrity,
  type VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import { verifyTemporalWorkflowArtifact } from '@atlas/workflow-artifact';

export interface AuthorizedWorkflowRequest {
  readonly workflowVersionId: string;
  readonly artifactId?: string;
  readonly grant: ExecutionGrant;
  readonly runId: string;
}

export interface WorkflowLoader {
  loadAuthorizedWorkflow(
    request: AuthorizedWorkflowRequest,
  ): Promise<VersionedCompiledWorkflowVersion>;
}

export class WorkflowBackendUnavailable extends Error {
  constructor(message = 'Atlas backend is unavailable on a workflow cache miss') {
    super(message);
    this.name = 'WorkflowBackendUnavailable';
  }
}

export class WorkflowAuthorizationRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowAuthorizationRejected';
  }
}

interface BackendWorkflowSource {
  readonly backendUrl: string;
  readonly workerToken: string;
  readonly organizationId: string;
  readonly environmentId: string;
}

interface BackendWorkflowLoaderOptions extends BackendWorkflowSource {
  readonly executionGrantPublicKey: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createBackendWorkflowLoader(options: BackendWorkflowLoaderOptions): WorkflowLoader {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const cache = new Map<string, VersionedCompiledWorkflowVersion>();

  return {
    async loadAuthorizedWorkflow(request) {
      const parsedGrant = executionGrantSchema.parse(request.grant);
      const cacheKey = request.artifactId ?? parsedGrant.irHash;
      let workflow = cache.get(cacheKey);
      if (!workflow) {
        workflow = await fetchWorkflow(options, fetchImplementation, request);
      }
      try {
        workflow = await verifyCompiledWorkflowVersionIntegrity(workflow);
        if (workflow.executionRequirements.organizationId !== options.organizationId) {
          throw new WorkflowAuthorizationRejected('Fetched IR organization does not match worker');
        }
        await verifyExecutionGrant(options.executionGrantPublicKey, parsedGrant, {
          organizationId: options.organizationId,
          environmentId: options.environmentId,
          runId: request.runId,
          workflowVersionId: request.workflowVersionId,
          irHash: workflow.irHash,
          requiredCapabilityVersionIds: workflow.executionRequirements.requiredCapabilityVersionIds,
        });
      } catch (error) {
        if (error instanceof WorkflowAuthorizationRejected) throw error;
        throw new WorkflowAuthorizationRejected(
          error instanceof Error ? error.message : 'Fetched IR authorization failed',
        );
      }
      cache.set(cacheKey, workflow);
      return workflow;
    },
  };
}

async function fetchWorkflow(
  options: BackendWorkflowSource,
  fetchImplementation: typeof globalThis.fetch,
  request: Pick<AuthorizedWorkflowRequest, 'artifactId' | 'workflowVersionId'>,
): Promise<VersionedCompiledWorkflowVersion> {
  const url = new URL(
    request.artifactId
      ? `/v1/workflow-artifacts/${encodeURIComponent(request.artifactId)}`
      : `/v1/workflow-versions/${encodeURIComponent(request.workflowVersionId)}`,
    options.backendUrl,
  );
  url.searchParams.set('organizationId', options.organizationId);
  url.searchParams.set('environmentId', options.environmentId);
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      headers: { authorization: `Bearer ${options.workerToken}` },
    });
  } catch (error) {
    throw new WorkflowBackendUnavailable(
      error instanceof Error ? `Atlas backend unavailable: ${error.message}` : undefined,
    );
  }
  if (response.status >= 500 || response.status === 429) {
    throw new WorkflowBackendUnavailable(`Atlas backend returned ${response.status}`);
  }
  if (!response.ok) {
    throw new WorkflowAuthorizationRejected(`Approved IR fetch rejected (${response.status})`);
  }
  try {
    const body: unknown = await response.json();
    return request.artifactId
      ? (await verifyTemporalWorkflowArtifact(body)).workflow
      : versionedCompiledWorkflowVersionSchema.parse(body);
  } catch (error) {
    throw new WorkflowAuthorizationRejected(
      error instanceof Error ? error.message : 'Approved IR response was invalid',
    );
  }
}
