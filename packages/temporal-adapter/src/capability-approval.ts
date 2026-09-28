import type { ExecutionGrant } from '@atlas/execution-grant';

export interface CapabilityApprovalVerifier {
  assertPinnedExecutionAllowed(input: {
    readonly organizationId: string;
    readonly grant: ExecutionGrant;
  }): Promise<void>;
}

export function createBackendCapabilityApprovalVerifier(
  backendUrl: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): CapabilityApprovalVerifier {
  return {
    async assertPinnedExecutionAllowed({ organizationId, grant }) {
      const response = await fetch(new URL('/v1/pinned-execution-selections', backendUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId,
          approvedCapabilityVersionIds: grant.approvedCapabilityVersionIds,
        }),
      });
      if (!response.ok) {
        throw new Error(`Pinned capability approval rejected (${response.status})`);
      }
    },
  };
}
