import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  catalogLifecycleStatuses,
  loadWorkflowDetail,
  loadCatalogWorkflowReview,
  loadWorkflowCatalog,
  matchesCatalogSearch,
  remoteForScope,
  saveWorkflowCatalogDraft,
  type WorkflowCatalogRow,
} from './catalog.js';

const workflow: WorkflowCatalogRow = {
  workflowId: 'workflow_payment_recovery',
  name: 'Payment recovery',
  activeVersion: { workflowVersionId: 'payment-recovery@2' },
  latestVersion: { workflowVersionId: 'payment-recovery@3', status: 'draft' },
  mostRecentRun: {
    runId: 'run_42',
    workflowVersionId: 'payment-recovery@2',
    state: 'completed',
    startedAt: '2026-08-25T12:00:00.000Z',
  },
  updatedAt: '2026-08-26T12:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('Workflow Catalog', () => {
  it('requests the complete Catalog for exactly the selected organization and environment', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ workflows: [workflow] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadWorkflowCatalog('org_atlas', 'production', new AbortController().signal),
    ).resolves.toEqual([workflow]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/v1/workflow-catalog?organizationId=org_atlas&environmentId=production',
      ),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('searches human names and stable workflow IDs case-insensitively', () => {
    expect(matchesCatalogSearch(workflow, 'PAYMENT RECOVERY')).toBe(true);
    expect(matchesCatalogSearch(workflow, 'workflow_payment')).toBe(true);
    expect(matchesCatalogSearch(workflow, 'invoice')).toBe(false);
  });

  it('offers every saved lifecycle state without inventing role policy', () => {
    expect(catalogLifecycleStatuses).toEqual([
      'draft',
      'testing',
      'awaiting-approval',
      'approved-inactive',
      'active',
      'blocked',
      'action-required',
    ]);
  });

  it('saves a new draft with its required human name and stable workflow identity', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ workflowId: 'workflow_payment', name: 'Settle payments' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveWorkflowCatalogDraft(
      {
        organizationId: 'org_atlas',
        environmentId: 'development',
        workflowId: 'workflow_payment',
        name: 'Settle payments',
        draft: { workflowVersionId: 'payment@1' },
      },
      'author-token',
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/v1/workflow-catalog/versions'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer author-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          workflowId: 'workflow_payment',
          name: 'Settle payments',
          draft: { workflowVersionId: 'payment@1' },
          status: 'draft',
        }),
      }),
    );
  });

  it('hides the prior environment immediately while the next Catalog loads', () => {
    expect(
      remoteForScope('org_atlas\u0000production', {
        scope: 'org_atlas\u0000development',
        remote: { status: 'ready', data: [workflow] },
      }),
    ).toEqual({ status: 'loading' });
  });

  it('loads a stable workflow detail through the selected organization and environment', async () => {
    const detail = {
      ...workflow,
      inputSchema: null,
      versions: [],
      recentRuns: [],
    };
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json(detail),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadWorkflowDetail(
        'org_atlas',
        'production',
        'workflow/payment recovery',
        new AbortController().signal,
      ),
    ).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/v1/workflow-catalog/workflow%2Fpayment%20recovery?organizationId=org_atlas&environmentId=production',
      ),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('fills the ingest payload schema from the active version when Catalog detail omits it', async () => {
    const liveDetail = {
      workflowId: 'invoice-drift-demo',
      name: 'Invoice drift demo workflow',
      activeVersion: { workflowVersionId: 'invoice-drift-demo@1' },
      latestVersion: { workflowVersionId: 'invoice-drift-demo@1', status: 'active' },
      updatedAt: '2026-09-04T16:01:06.774Z',
      versions: [],
      recentRuns: [],
    };
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async (input) => {
        if (String(input).includes('/versions/')) {
          return Response.json({
            draft: {
              executable: {
                irVersion: 1,
                inputSchema: { required: { paymentId: { type: 'string' } } },
              },
            },
          });
        }
        return Response.json(liveDetail);
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadWorkflowDetail(
        'org_atlas',
        'production',
        'invoice-drift-demo',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      workflowId: 'invoice-drift-demo',
      inputSchema: { required: { paymentId: { type: 'string' } } },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/v1/workflow-catalog/invoice-drift-demo/versions/invoice-drift-demo%401',
      ),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('hands the exact scoped Catalog version to the Create Workflow review API', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
      async (input) => {
        if (input.includes('/versions/')) return Response.json({ draft: { version: 3 } });
        if (input.includes('/planner-capabilities')) {
          return Response.json({ fingerprint: 'f'.repeat(64) });
        }
        if (input.includes('/workflow-catalog/workflow_payment?')) {
          return Response.json({ workflowId: 'workflow_payment', name: 'Payment recovery' });
        }
        return Response.json({ workflowVersionId: 'payment@3' });
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      loadCatalogWorkflowReview<{ workflowVersionId: string }>(
        'org_atlas',
        'development',
        'workflow_payment',
        'payment@3',
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      draft: { version: 3 },
      projectionFingerprint: 'f'.repeat(64),
      review: { workflowVersionId: 'payment@3' },
      workflowId: 'workflow_payment',
      name: 'Payment recovery',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/workflow_payment/versions/payment%403'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining('/v1/workflow-reviews'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'development',
          projectionFingerprint: 'f'.repeat(64),
          draft: { version: 3 },
        }),
      }),
    );
  });

  it('never exposes another environment workflow detail during a scope change', () => {
    expect(
      remoteForScope('org_atlas\u0000production\u0000workflow_payment', {
        scope: 'org_atlas\u0000development\u0000workflow_payment',
        remote: {
          status: 'ready',
          data: { ...workflow, inputSchema: null, versions: [], recentRuns: [] },
        },
      }),
    ).toEqual({ status: 'loading' });
  });
});
