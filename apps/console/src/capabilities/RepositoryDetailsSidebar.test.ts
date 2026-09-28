import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { RepositoryDetailsSidebar } from './RepositoryDetailsSidebar.js';

describe('repository details sidebar', () => {
  it('shows a spaced repository summary and the existing analysis action without a backdrop', () => {
    const markup = renderToStaticMarkup(
      createElement(RepositoryDetailsSidebar, {
        source: {
          key: 'burgertown',
          label: 'example/burger-town',
          repository: 'https://github.com/example/burger-town',
          connectionId: 'repo-1',
          branches: ['main'],
          capabilities: [],
          services: [],
        },
        connection: {
          id: 'repo-1',
          repository: 'https://github.com/example/burger-town',
          branches: ['main'],
          last_checked_at: '2026-09-23T15:00:00.000Z',
          last_error: null,
          progress: {
            status: 'running',
            phase: 'discovering',
            updatedAt: '2999-09-23T15:00:00.000Z',
          },
          targets: [],
          candidates: [],
        },
        onViewAnalysis: vi.fn<() => void>(),
      }),
    );

    expect(markup).toContain('cat-repository-sidebar');
    expect(markup).toContain('example/burger-town');
    expect(markup).toContain('Finding services');
    expect(markup).toContain('View Analysis');
    expect(markup).not.toContain('cat-drawer-backdrop');
    expect(markup).not.toContain('Collapse repository sidebar');
  });
});
