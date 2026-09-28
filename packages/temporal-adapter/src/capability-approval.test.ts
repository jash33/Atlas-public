import { describe, expect, it, vi } from 'vite-plus/test';

import { createBackendCapabilityApprovalVerifier } from './capability-approval.js';

describe('pinned capability approval verifier', () => {
  it('denies execution when the backend reports a revoked pinned approval', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ allowed: false }, { status: 403 }));
    const verifier = createBackendCapabilityApprovalVerifier('http://backend.internal', fetch);

    await expect(
      verifier.assertPinnedExecutionAllowed({
        organizationId: 'org_atlas',
        grant: {
          organizationId: 'org_atlas',
          environmentId: 'production',
          runId: 'run_1',
          workflowVersionId: 'workflow@1',
          irHash: 'a'.repeat(64),
          approvedCapabilityVersionIds: ['capability@1'],
          approvedHostnames: ['provider.internal'],
          signatureAlgorithm: 'Ed25519',
          signature: 'signed',
        },
      }),
    ).rejects.toThrow('Pinned capability approval rejected (403)');
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://backend.internal/v1/pinned-execution-selections'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
