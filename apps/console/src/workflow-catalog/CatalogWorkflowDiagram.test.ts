import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { CatalogWorkflowDiagram } from './CatalogWorkflowDiagram.js';
import { loadCatalogWorkflowReview, useScopedRemote } from './catalog.js';

vi.mock('../shell/session.js', () => ({
  useConsoleSession: () => ({
    organizationId: 'org_atlas',
    environmentId: 'development',
    role: 'author',
  }),
}));
vi.mock('./catalog.js', () => ({
  loadCatalogWorkflowReview: vi.fn<typeof loadCatalogWorkflowReview>(),
  useScopedRemote: vi.fn<typeof useScopedRemote>(),
}));

describe('catalog workflow diagram', () => {
  it('loads the selected immutable version and uses the creation diagram renderer', async () => {
    vi.mocked(loadCatalogWorkflowReview).mockResolvedValue({
      draft: {},
      projectionFingerprint: 'fingerprint',
      workflowId: 'orders',
      name: 'Orders',
      review: {
        graph: {
          nodes: [
            {
              stepId: 'done',
              kind: 'terminal',
              terminalState: 'completed',
              irreversible: false,
              retryPolicy: null,
            },
          ],
          edges: [],
        },
        steps: [],
        artifact: null,
      },
    });
    vi.mocked(useScopedRemote).mockReturnValue({
      remote: { status: 'ready', data: { nodes: [], edges: [] } },
      reload: vi.fn<() => void>(),
    });
    const html = renderToStaticMarkup(
      createElement(CatalogWorkflowDiagram, {
        workflowId: 'orders',
        workflowVersionId: 'orders@2',
        active: true,
      }),
    );
    expect(html).toContain('Workflow diagram');
    expect(html).toContain('Active version');
    expect(html).toContain('orders@2');
    expect(html).toContain('Saved version');
    expect(html).not.toContain('Draft graph');
    const load = vi.mocked(useScopedRemote).mock.calls.at(-1)![1];
    const signal = new AbortController().signal;
    await load(signal);
    expect(loadCatalogWorkflowReview).toHaveBeenCalledWith(
      'org_atlas',
      'development',
      'orders',
      'orders@2',
      signal,
    );
  });

  it('offers recovery when the diagram cannot load', () => {
    vi.mocked(useScopedRemote).mockReturnValue({
      remote: { status: 'error', message: 'Request failed' },
      reload: vi.fn<() => void>(),
    });
    const html = renderToStaticMarkup(
      createElement(CatalogWorkflowDiagram, {
        workflowId: 'orders',
        workflowVersionId: 'orders@2',
        active: true,
      }),
    );
    expect(html).toContain('Workflow diagram could not load');
    expect(html).toContain('Try again');
  });
});
