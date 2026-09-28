import { environmentQuery, useRemote } from '../home/data.js';
import { requestJson } from '../shell/api.js';
import type { CapabilityDiscovery } from '../home/summaries.js';
import type { ChangeDiscoveryDetail } from './changes.js';

function describeChangeFailure(status: number, body: unknown): string {
  return body && typeof body === 'object' && 'error' in body
    ? String((body as { error: unknown }).error).replaceAll('-', ' ')
    : `Request failed (${status})`;
}

export function useChangeDiscoveries(organizationId: string, environmentId: string) {
  return useRemote([environmentId, organizationId], async (signal: AbortSignal) => {
    const query = environmentQuery(organizationId, environmentId);
    const summary = await requestJson<{ discoveries: CapabilityDiscovery[] }>(
      `/v1/capability-discoveries?${query}`,
      { signal },
    );
    return Promise.all(
      summary.discoveries.map((discovery) =>
        requestJson<ChangeDiscoveryDetail>(
          `/v1/capability-discoveries/${discovery.discoveryId}?${new URLSearchParams({ organizationId, environmentId })}`,
          { signal },
          describeChangeFailure,
        ),
      ),
    );
  });
}

export async function createMigrationCandidate(input: {
  organizationId: string;
  environmentId: string;
  sourceWorkflowVersionId: string;
  workflowVersionId: string;
  fromCapabilityVersionId: string;
  toCapabilityVersionId: string;
  projectionFingerprint: string;
  bearerToken: string;
}): Promise<{ candidateId: string }> {
  const { bearerToken, ...body } = input;
  return requestJson<{ candidateId: string }>(
    '/v1/workflow-migration-candidates',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    describeChangeFailure,
  );
}

export async function readProjectionFingerprint(
  organizationId: string,
  environmentId: string,
): Promise<string> {
  const query = new URLSearchParams({ organizationId, environmentId });
  const result = await requestJson<{ fingerprint: string }>(
    `/v1/planner-capabilities?${query}`,
    undefined,
    describeChangeFailure,
  );
  return result.fingerprint;
}
