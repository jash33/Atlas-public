import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';
import { DraftLog } from './DraftLog.js';
import { reasoningSections } from './reasoning-sections.js';
import type { DraftRequestProgress } from './draft-request-progress.js';

function progress(events: Record<string, unknown>[]): DraftRequestProgress {
  return {
    requestId: 'sections',
    status: 'running',
    startedAt: '2026-09-13T00:00:00Z',
    liveText: true,
    events: events.map((event, sequence) => ({
      sequence,
      timestamp: 'now',
      kind: 'model.stream.event',
      data: {
        callId: 'call',
        attempt: 1,
        event: { item_id: 'reasoning', summary_index: 0, ...event },
      },
    })),
  };
}

const text =
  '**Clarifying service structure**\n\nChecking services.\n\n**Choosing steps**\n\nComparing actions.';

describe('reasoning sections', () => {
  it.each(['running', 'completed', 'failed'] as const)(
    'hides reasoning until there is text (%s)',
    (status) => {
      const state = progress([]);
      state.status = status;
      const markup = renderToStaticMarkup(createElement(DraftLog, { progress: state }));
      expect(markup).not.toContain('aria-label="Reasoning"');
      expect(markup).not.toContain('<h4>Reasoning</h4>');
      expect(markup).not.toContain('Waiting for reasoning');
    },
  );
  it.each([
    ['completed', 'validated', true],
    ['completed', 'clarification_required', false],
    ['completed', 'manual_review', false],
    ['completed', 'unsupported', false],
    ['running', 'validated', false],
    ['failed', 'validated', false],
    ['cancelled', 'validated', false],
  ] as const)(
    'shows draft success only for a completed validated draft (%s, %s)',
    (status, resultStatus, visible) => {
      const state = progress([]);
      state.status = status;
      state.result = { httpStatus: 200, body: { status: resultStatus } };
      const markup = renderToStaticMarkup(createElement(DraftLog, { progress: state }));
      expect(markup.includes('Workflow draft successfully created.')).toBe(visible);
      if (visible) {
        expect(markup).toContain('class="wf-reasoning-success" role="status"');
        expect(markup).not.toContain('No reasoning summary was provided.');
      }
    },
  );
  it('joins streamed chunks into headings and marks only the unfinished section active', () => {
    const state = progress([
      { type: 'response.reasoning_summary_text.delta', delta: '**Clarifying service ' },
      {
        type: 'response.reasoning_summary_text.delta',
        delta: text.slice('**Clarifying service '.length),
      },
    ]);
    expect(reasoningSections(state)).toMatchObject([
      { title: 'Clarifying service structure', body: 'Checking services.', active: false },
      { title: 'Choosing steps', body: 'Comparing actions.', active: true },
    ]);
    const markup = renderToStaticMarkup(createElement(DraftLog, { progress: state }));
    expect(markup).not.toContain('**');
    expect(markup.match(/<details /g)).toHaveLength(2);
    expect(markup.match(/class="wf-draft-spinner"/g)).toHaveLength(1);
    expect(markup).toContain('wf-reasoning-thread');
  });

  it('stops the spinner when the summary finishes even if drafting continues', () => {
    const state = progress([
      { type: 'response.reasoning_summary_text.delta', delta: text },
      { type: 'response.reasoning_summary_text.done', text },
    ]);
    expect(reasoningSections(state).every((section) => !section.active)).toBe(true);
    expect(renderToStaticMarkup(createElement(DraftLog, { progress: state }))).not.toContain(
      'wf-draft-spinner',
    );
  });

  it.each(['response.completed', 'response.failed', 'response.incomplete', 'error'])(
    'stops unfinished sections on %s',
    (type) => {
      const state = progress([
        { type: 'response.reasoning_summary_text.delta', delta: text },
        { type },
      ]);
      expect(reasoningSections(state).every((section) => !section.active)).toBe(true);
    },
  );

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'stops spinners when the draft is %s',
    (status) => {
      const state = progress([{ type: 'response.reasoning_summary_text.delta', delta: text }]);
      state.status = status;
      expect(reasoningSections(state).every((section) => !section.active)).toBe(true);
    },
  );

  it('preserves unheaded text and escapes model HTML', () => {
    const state = progress([
      { type: 'response.reasoning_summary_text.delta', delta: '<script>alert(1)</script>' },
    ]);
    const markup = renderToStaticMarkup(createElement(DraftLog, { progress: state }));
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('<script>');
  });

  it('restores completed sections from a saved response without duplicating streamed text', () => {
    const state = progress([
      { type: 'response.reasoning_summary_text.delta', delta: text },
      {
        type: 'response.completed',
        response: { output: [{ id: 'reasoning', type: 'reasoning', summary: [{ text }] }] },
      },
    ]);
    expect(reasoningSections(state)).toHaveLength(2);
    expect(reasoningSections(state).every((section) => !section.active)).toBe(true);
  });
});
