import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { DraftProgress } from './DraftProgress.js';
import { ModelTraces } from './ModelTraces.js';
import { formatDraftElapsedTime } from './draft-progress.js';

describe('draft progress', () => {
  it.each(['unsupported', 'manual_review'])(
    'shows a completed %s outcome and keeps its log controls',
    (status) => {
      const markup = renderToStaticMarkup(
        createElement(ModelTraces, {
          progress: {
            requestId: 'rejected',
            status: 'completed',
            liveText: false,
            startedAt: '2026-09-19T22:00:00Z',
            finishedAt: '2026-09-19T22:00:01Z',
            result: {
              httpStatus: 200,
              body: {
                status,
                reason: 'The capability index has no capability for creating pickup orders.',
              },
            },
          },
        }),
      );
      expect(markup).toContain(
        'The capability index has no capability for creating pickup orders.',
      );
      expect(markup).toContain('Download draft log');
      expect(markup).toContain('Copy draft log');
      expect(markup).not.toContain('wf-draft-spinner');
    },
  );

  it.each(['running', 'failed'] as const)('keeps reasoning in the sidebar when %s', (status) => {
    const markup = renderToStaticMarkup(
      createElement(ModelTraces, {
        progress: {
          requestId: 'streamed',
          status,
          startedAt: new Date().toISOString(),
          liveText: true,
          events: [
            {
              sequence: 0,
              timestamp: 'now',
              kind: 'model.stream.event',
              data: {
                callId: 'c',
                name: 'draft',
                attempt: 1,
                event: { type: 'response.output_text.delta', delta: '<script>partial</script>' },
              },
            },
            {
              sequence: 1,
              timestamp: 'now',
              kind: 'model.stream.event',
              data: {
                callId: 'c',
                name: 'draft',
                attempt: 1,
                event: {
                  type: 'response.reasoning_summary_text.delta',
                  delta: 'Checking required fields',
                },
              },
            },
          ],
        },
      }),
    );
    expect(markup).toContain('Download draft log');
    expect(markup).not.toContain('<h4>Reasoning</h4>');
    expect(markup).toContain('Checking required fields');
    expect(markup).not.toContain('partial');
    expect(markup).not.toContain('Trace events');
    expect(markup).not.toContain('attempt 1');
    expect(markup).toContain('aria-label="Download draft log"');
    expect(markup).toContain('aria-label="Copy draft log"');
    expect(markup).toContain('Copy draft log');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('Live text is unavailable');
    expect(markup).toContain('<aside class="wf-model-traces" aria-label="Model traces">');
    expect(markup).toContain('wf-reasoning-section');
    expect(markup.includes('wf-draft-spinner')).toBe(status === 'running');
  });
  it('shows every drafting step while keeping the reported stage active after a long wait', () => {
    const markup = renderToStaticMarkup(
      createElement(DraftProgress, {
        onCancel: vi.fn<() => void>(),
        progress: {
          requestId: 'slow',
          status: 'running',
          stage: 'understanding',
          startedAt: new Date(Date.now() - 90_000).toISOString(),
          liveText: false,
        },
      }),
    );
    expect(markup).toContain('Understanding your request');
    expect(markup).toContain('Understand request');
    expect(markup).toContain('Build workflow');
    expect(markup).toContain('Validate draft');
    expect(markup).toContain('Repair if needed');
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain('Upcoming');
    expect(markup).not.toContain('Running checks');
    expect(markup).not.toContain('%');
    expect(markup).toContain('Thinking');
    expect(markup).not.toContain('Draft details');
  });
  it('reports lost connections', () => {
    const lost = renderToStaticMarkup(
      createElement(DraftProgress, { onCancel: vi.fn<() => void>(), connectionLost: true }),
    );
    expect(lost).toContain('Connection lost');
    expect(lost).not.toContain('Drafting failed');
  });
  it('hides failed progress and preserves the error in model traces', () => {
    const markup = renderToStaticMarkup(
      createElement(DraftProgress, {
        onCancel: vi.fn<() => void>(),
        progress: {
          requestId: 'failed',
          status: 'failed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          liveText: false,
          error: '<script>alert(1)</script>',
        },
      }),
    );
    expect(markup).toBe('');
    const traces = renderToStaticMarkup(
      createElement(ModelTraces, {
        progress: {
          requestId: 'failed',
          status: 'failed',
          startedAt: new Date().toISOString(),
          liveText: false,
          error: '<script>alert(1)</script>',
        },
      }),
    );
    expect(traces).toContain('Drafting failed');
    expect(traces).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(traces).not.toContain('Drafting steps');
    expect(traces).not.toContain('wf-draft-spinner');
  });
  it('formats elapsed time', () => {
    expect(formatDraftElapsedTime(0)).toBe('0:00');
    expect(formatDraftElapsedTime(65_000)).toBe('1:05');
  });
});
