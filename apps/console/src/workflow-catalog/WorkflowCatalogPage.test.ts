import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { WorkflowCatalogRow } from './catalog.js';
import {
  WorkflowCatalogContent,
  WorkflowCatalogTable,
  type WorkflowCatalogFilters,
} from './WorkflowCatalogPage.js';

function workflow(index: number, active = true): WorkflowCatalogRow {
  const padded = String(index).padStart(2, '0');
  return {
    workflowId: `workflow_${padded}`,
    name: `Workflow ${padded}`,
    activeVersion: active ? { workflowVersionId: `workflow-${padded}@2` } : null,
    latestVersion: {
      workflowVersionId: `workflow-${padded}@3`,
      status: active ? 'active' : 'draft',
    },
    mostRecentRun:
      index % 2 === 0
        ? {
            runId: `run_${padded}`,
            workflowVersionId: `workflow-${padded}@2`,
            state: 'completed',
            startedAt: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
          }
        : null,
    updatedAt: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
  };
}

describe('WorkflowCatalogPage', () => {
  it('renders a semantic table with the specified columns and stable-identity row links', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowCatalogTable, {
        filters: { search: '', status: '' },
        onFiltersChange: vi.fn<(filters: WorkflowCatalogFilters) => void>(),
        workflows: [workflow(0), workflow(1, false)],
      }),
    );

    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<tbody');
    expect(html).toContain('class="wfc-table-scroll" tabindex="0"');
    expect(html).toContain('aria-label="Sort by updated time, newest first"');
    expect(html).toContain('type="search"');
    expect(html).toContain('<select>');
    expect(html).toContain('>Previous</button>');
    expect(html).toContain('>Next</button>');
    for (const heading of [
      'Name',
      'Active version',
      'Latest version/status',
      'Last run',
      'Updated',
    ]) {
      expect(html).toContain(`>${heading}`);
    }
    expect(html).toContain('#/workflow-catalog?workflowId=workflow_00');
    expect(html).not.toContain('action=run');
    expect(html).not.toContain('>Run</a>');
    expect(html).not.toContain('class="wfc-run"');
  });

  it('sorts newest first by default and paginates large client-side results', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowCatalogTable, {
        filters: { search: '', status: '' },
        onFiltersChange: vi.fn<(filters: WorkflowCatalogFilters) => void>(),
        workflows: Array.from({ length: 26 }, (_, index) => workflow(index)),
      }),
    );

    expect(html.indexOf('Workflow 25')).toBeLessThan(html.indexOf('Workflow 24'));
    expect(html).not.toContain('Workflow 00');
    expect(html).toContain('1–25 of 26 workflows');
    expect(html.match(/<tr/g)).toHaveLength(26);
  });

  it('uses the rendered table engine for search, lifecycle filtering, and filtered-empty recovery', () => {
    const searchEmpty = renderToStaticMarkup(
      createElement(WorkflowCatalogTable, {
        filters: { search: 'does-not-exist', status: '' },
        onFiltersChange: vi.fn<(filters: WorkflowCatalogFilters) => void>(),
        workflows: [workflow(0), workflow(1, false)],
      }),
    );
    const draftOnly = renderToStaticMarkup(
      createElement(WorkflowCatalogTable, {
        filters: { search: '', status: 'draft' },
        onFiltersChange: vi.fn<(filters: WorkflowCatalogFilters) => void>(),
        workflows: [workflow(0), workflow(1, false)],
      }),
    );

    expect(searchEmpty).toContain('No matching workflows');
    expect(searchEmpty).toContain('Clear filters');
    expect(draftOnly).toContain('Workflow 01');
    expect(draftOnly).not.toContain('Workflow 00');
  });

  it('distinguishes loading, API failure, and a genuinely empty environment', () => {
    const reload = vi.fn<() => void>();
    const loading = renderToStaticMarkup(
      createElement(WorkflowCatalogContent, {
        environmentId: 'development',
        reload,
        remote: { status: 'loading' },
      }),
    );
    const failed = renderToStaticMarkup(
      createElement(WorkflowCatalogContent, {
        environmentId: 'development',
        reload,
        remote: { status: 'error', message: 'Catalog unavailable' },
      }),
    );
    const empty = renderToStaticMarkup(
      createElement(WorkflowCatalogContent, {
        environmentId: 'production',
        reload,
        remote: { status: 'ready', data: [] },
      }),
    );

    expect(loading).toContain('aria-busy="true"');
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Catalog unavailable');
    expect(empty).toContain('No workflows in Production');
    expect(empty).toContain('#/workflows');
  });
});
