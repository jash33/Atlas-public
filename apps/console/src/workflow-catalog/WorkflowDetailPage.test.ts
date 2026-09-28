import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { WorkflowCatalogDetail } from './catalog.js';
import { approvedDiagramVersion, WorkflowDetailContent } from './WorkflowDetailPage.js';

const detail: WorkflowCatalogDetail = {
  workflowId: 'workflow_payment',
  name: 'Settle payments',
  activeVersion: { workflowVersionId: 'payment@2' },
  inputSchema: { required: { paymentId: { type: 'string' } } },
  latestVersion: { workflowVersionId: 'payment@3', status: 'draft' },
  updatedAt: '2026-08-26T12:00:00.000Z',
  versions: [
    {
      workflowVersionId: 'payment@3',
      status: 'draft',
      isActive: false,
      createdAt: '2026-08-26T11:00:00.000Z',
      updatedAt: '2026-08-26T12:00:00.000Z',
      approval: null,
    },
    {
      workflowVersionId: 'payment@2',
      status: 'active',
      isActive: true,
      createdAt: '2026-08-25T11:00:00.000Z',
      updatedAt: '2026-08-25T12:00:00.000Z',
      approval: {
        approvedBy: 'admin@example.com',
        approvedAt: '2026-08-25T12:00:00.000Z',
      },
    },
  ],
  recentRuns: [
    {
      runId: 'run_42',
      workflowVersionId: 'payment@2',
      trigger: { type: 'manual' },
      state: 'completed',
      startedAt: '2026-08-26T10:00:00.000Z',
      durationMs: 4250,
      outcome: 'succeeded',
    },
  ],
};

describe('WorkflowDetailPage', () => {
  it('hides diagrams until approval and never substitutes a newer draft for an approved version', () => {
    const unapproved: WorkflowCatalogDetail = {
      ...detail,
      activeVersion: null,
      versions: detail.versions.map((version) => ({ ...version, approval: null, isActive: false })),
    };
    expect(approvedDiagramVersion(unapproved)).toBeUndefined();
    const html = renderToStaticMarkup(
      createElement(WorkflowDetailContent, {
        environmentId: 'development',
        reload: vi.fn<() => void>(),
        remote: { status: 'ready', data: unapproved },
        diagram: createElement('section', null, 'Saved workflow diagram'),
      }),
    );
    expect(html).not.toContain('Saved workflow diagram');
    expect(approvedDiagramVersion(detail)).toBe('payment@2');
    expect(approvedDiagramVersion({ ...detail, activeVersion: null })).toBe('payment@2');
  });
  it('places the workflow diagram beside the catalog run controls', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowDetailContent, {
        environmentId: 'development',
        reload: vi.fn<() => void>(),
        remote: { status: 'ready', data: detail },
        diagram: createElement('section', null, 'Saved workflow diagram'),
      }),
    );
    expect(html.indexOf('Saved workflow diagram')).toBeLessThan(html.indexOf('Invoke via API'));
  });
  it('shows the scoped overview, immutable history, approval evidence, and Runs links', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowDetailContent, {
        environmentId: 'development',
        reload: vi.fn<() => void>(),
        remote: { status: 'ready', data: detail },
      }),
    );

    expect(html).toContain('Settle payments');
    expect(html).toContain('workflow_payment');
    expect(html).toContain('payment@2');
    expect(html).toContain('payment@3');
    expect(html).toContain('Latest lifecycle');
    expect(html).toContain('admin@example.com');
    expect(html).toContain('Active version');
    expect(html).toContain('Invoke via API');
    expect(html).toContain('Settle payments');
    expect(html).toContain('POST http://localhost:4300/ingest');
    expect(html).toContain('paymentId');
    expect(html).toContain('string, required');
    expect(html).toContain('Copy sample request');
    expect(html).not.toContain('Guarded run launcher');
    expect(html).not.toContain('Run approved workflow');
    expect(html).toContain('#/runs?runId=run_42');
    expect(html).toContain('Succeeded');
    expect(html).toContain('4.3s');
    expect(html).toContain(
      '#/workflows?catalogWorkflowId=workflow_payment&amp;catalogWorkflowVersionId=payment%403&amp;action=edit',
    );
    expect(html.indexOf('payment@3')).toBeLessThan(html.lastIndexOf('payment@2'));
    expect(html.match(/<a /g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain('tabindex="-1"');
    expect(html).not.toContain('Evidence Desk');
  });

  it('sends review and approval to Create Workflow instead of Evidence Desk', () => {
    const awaiting = renderToStaticMarkup(
      createElement(WorkflowDetailContent, {
        environmentId: 'development',
        reload: vi.fn<() => void>(),
        remote: {
          status: 'ready',
          data: {
            ...detail,
            latestVersion: { workflowVersionId: 'payment@3', status: 'awaiting-approval' },
          },
        },
      }),
    );
    const active = renderToStaticMarkup(
      createElement(WorkflowDetailContent, {
        environmentId: 'development',
        reload: vi.fn<() => void>(),
        remote: {
          status: 'ready',
          data: {
            ...detail,
            activeVersion: { workflowVersionId: 'payment@2' },
            latestVersion: { workflowVersionId: 'payment@2', status: 'active' },
          },
        },
      }),
    );

    expect(awaiting).toContain('Review and approve this version in Create Workflow');
    expect(active).toContain('Review this version in Create Workflow');
    expect(awaiting).not.toContain('Evidence Desk');
    expect(active).not.toContain('Evidence Desk');
  });

  it('explains empty history, empty runs, and why an inactive workflow cannot be invoked', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowDetailContent, {
        environmentId: 'production',
        reload: vi.fn<() => void>(),
        remote: {
          status: 'ready',
          data: {
            ...detail,
            activeVersion: null,
            inputSchema: null,
            latestVersion: { workflowVersionId: 'payment@3', status: 'blocked' },
            versions: [],
            recentRuns: [],
          },
        },
      }),
    );

    expect(html).toContain('No version history is available');
    expect(html).toContain('No runs have started');
    expect(html).toContain('cannot be invoked until a version is approved and active');
    expect(html).toContain('Invoke via API');
    expect(html).not.toContain('http://localhost:4301/ingest');
  });

  it('distinguishes loading and scoped API failure with recovery', () => {
    const loading = renderToStaticMarkup(
      createElement(WorkflowDetailContent, {
        environmentId: 'development',
        reload: vi.fn<() => void>(),
        remote: { status: 'loading' },
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(WorkflowDetailContent, {
        environmentId: 'development',
        reload: vi.fn<() => void>(),
        remote: { status: 'error', message: 'Unavailable in this environment' },
      }),
    );

    expect(loading).toContain('aria-busy="true"');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Try again');
  });
});
