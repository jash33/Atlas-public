import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';
import { draftPreview, readPartialJson } from './draft-preview.js';
import { DraftPreview } from './DraftPreview.js';
import type { DraftRequestProgress } from './draft-request-progress.js';

function progress(
  chunks: { name: string; text: string; attempt?: number }[],
): DraftRequestProgress {
  return {
    requestId: 'preview',
    status: 'running',
    startedAt: 'now',
    liveText: true,
    events: chunks.map((chunk, sequence) => ({
      sequence,
      timestamp: 'now',
      kind: 'model.stream.event',
      data: {
        name: chunk.name,
        callId: chunk.name,
        attempt: chunk.attempt ?? 1,
        event: { type: 'response.output_text.delta', delta: chunk.text },
      },
    })),
  };
}

describe('live draft preview', () => {
  it('interleaves reasoning with preview output and shimmers unfinished reasoning', () => {
    const state = progress([{ name: 'atlas_intent_frame', text: '{"summary":"Create an order"}' }]);
    state.events!.push({
      sequence: 1,
      timestamp: 'later',
      kind: 'model.stream.event',
      data: {
        callId: 'planner',
        attempt: 1,
        event: {
          type: 'response.reasoning_summary_text.delta',
          item_id: 'reasoning',
          summary_index: 0,
          delta: '**Choosing operations**\n\nComparing available actions.',
        },
      },
    });
    const markup = renderToStaticMarkup(createElement(DraftPreview, { progress: state }));
    expect(markup.indexOf('Understanding')).toBeLessThan(markup.indexOf('Choosing operations'));
    expect(markup).toContain('class="wf-heading-shimmer">Choosing operations');
    expect(markup).not.toContain('<h4>Reasoning</h4>');
    expect(markup.match(/class="wf-reasoning-thread"/g)).toHaveLength(1);
    state.events!.push({
      sequence: 2,
      timestamp: 'done',
      kind: 'model.stream.event',
      data: {
        callId: 'planner',
        attempt: 1,
        event: {
          type: 'response.reasoning_summary_text.done',
          item_id: 'reasoning',
          summary_index: 0,
          text: '**Choosing operations**\n\nComparing available actions.',
        },
      },
    });
    expect(renderToStaticMarkup(createElement(DraftPreview, { progress: state }))).not.toContain(
      'wf-heading-shimmer',
    );
  });
  it('keeps the current proposal visible while a repair replacement streams', () => {
    const state = progress([
      {
        name: 'atlas_planner_output',
        text: '{"result":{"draft":{"executable":{"steps":[{"id":"original_step"}]}}}}',
      },
      {
        name: 'atlas_planner_repair',
        text: '{"result":{"draft":{"executable":{"steps":[{"id":"replacement_step"}',
      },
    ]);
    expect(draftPreview(state).steps.map((step) => step.id)).toEqual(['original_step']);
    expect(draftPreview(state).active).toBe('steps');
    state.events!.push({
      sequence: 2,
      timestamp: 'now',
      kind: 'model.stream.event',
      data: {
        name: 'atlas_planner_repair',
        callId: 'atlas_planner_repair',
        attempt: 1,
        event: { type: 'response.output_text.delta', delta: ']}}}}' },
      },
    });
    expect(draftPreview(state).steps.map((step) => step.id)).toEqual(['replacement_step']);
  });
  it('shimmers only the field being written and stops when it closes', () => {
    const state = progress([{ name: 'atlas_intent_frame', text: '{"summary":"Create an' }]);
    expect(draftPreview(state).active).toBe('summary');
    expect(renderToStaticMarkup(createElement(DraftPreview, { progress: state }))).toContain(
      'class="wf-heading-shimmer">Understanding',
    );
    state.events![0]!.data.event = {
      type: 'response.output_text.delta',
      delta: '{"summary":"Create an order","requiredInputs":["id",',
    };
    expect(draftPreview(state).active).toBe('inputs');
    state.events![0]!.data.event = {
      type: 'response.output_text.delta',
      delta: '{"summary":"Create an order","requiredInputs":["id"]}',
    };
    expect(draftPreview(state).active).toBeUndefined();
  });
  it('keeps steps active while their mappings stream and stops on cancellation', () => {
    const state = progress([
      {
        name: 'atlas_planner_output',
        text: '{"result":{"draft":{"executable":{"steps":[{"id":"create_check","arguments":{"id":{"source":"input","path":["id"',
      },
    ]);
    expect(draftPreview(state).active).toBe('steps');
    state.status = 'cancelled';
    expect(draftPreview(state).active).toBeUndefined();
  });
  it('shows complete fields while later JSON fields are still streaming', () => {
    const state = progress([
      {
        name: 'atlas_intent_frame',
        text: '{"summary":"Create an order","requiredInputs":["location_id","unfinished',
      },
      {
        name: 'atlas_planner_output',
        text: '{"result":{"draft":{"executable":{"steps":[{"id":"create_check","arguments":{"location_id":{"source":"input","path":["location_id"]}}},{"id":"add_item","arguments":{"check_id":{"source":"stepOutput","stepId":"create_check","path":["id"]}},"next',
      },
    ]);
    const preview = draftPreview(state);
    expect(preview.summary).toBe('Create an order');
    expect(preview.inputs).toEqual(['location_id']);
    expect(preview.steps).toHaveLength(2);
    const markup = renderToStaticMarkup(createElement(DraftPreview, { progress: state }));
    expect(markup).not.toContain('<h4>');
    expect(markup).not.toContain('Proposed details may change during validation.');
    expect(markup).toContain('Create check');
    expect(markup).toContain('check_id: Create check: id');
    expect(markup).not.toContain('unfinished');
  });
  it('handles split escaped strings and nested values at every chunk boundary', () => {
    const text = JSON.stringify({
      summary: 'Use "pickup"\nThen send 🚀',
      requiredInputs: ['item_id'],
      supported: true,
    });
    for (let index = 0; index <= text.length; index++) {
      expect(() => readPartialJson(text.slice(0, index))).not.toThrow();
      const state = progress([
        { name: 'atlas_intent_frame', text: text.slice(0, index) },
        { name: 'atlas_intent_frame', text: text.slice(index) },
      ]);
      expect(draftPreview(state).summary).toBe('Use "pickup"\nThen send 🚀');
    }
  });
  it('replaces previous attempts and repair proposals rather than concatenating them', () => {
    const state = progress([
      {
        name: 'atlas_planner_output',
        text: '{"result":{"draft":{"executable":{"steps":[{"id":"old_step"}]}}}}',
      },
      {
        name: 'atlas_planner_repair',
        text: '{"result":{"draft":{"executable":{"steps":[{"id":"new_step"}]}}}}',
      },
    ]);
    expect(draftPreview(state).steps.map((step) => step.id)).toEqual(['new_step']);
  });
  it('escapes model text and preserves incomplete previews after failure', () => {
    const state = progress([
      { name: 'atlas_intent_frame', text: '{"summary":"<script>alert(1)</script>"' },
    ]);
    state.status = 'failed';
    const markup = renderToStaticMarkup(createElement(DraftPreview, { progress: state }));
    expect(markup).toContain('&lt;script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('Still drafting');
  });
});
