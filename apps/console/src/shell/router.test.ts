import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  parseHashParameter,
  parseSurfaceHash,
  readLocationHash,
  runDetailHash,
  surfaceHash,
  surfaces,
  subscribeToHashChanges,
  workflowCatalogDetailHash,
  workflowEditHash,
  workflowReviewHash,
} from './router.js';

afterEach(() => vi.unstubAllGlobals());

describe('parseSurfaceHash', () => {
  it('treats an empty or bare hash as home', () => {
    expect(parseSurfaceHash('')).toBe('home');
    expect(parseSurfaceHash('#')).toBe('home');
    expect(parseSurfaceHash('#/')).toBe('home');
  });

  it('resolves each surface path', () => {
    expect(parseSurfaceHash('#/workflows')).toBe('workflows');
    expect(parseSurfaceHash('#/workflow-catalog')).toBe('workflow-catalog');
    expect(parseSurfaceHash('#/capabilities')).toBe('capabilities');
    expect(parseSurfaceHash('#/runs')).toBe('runs');
    expect(parseSurfaceHash('#/changes')).toBe('changes');
    expect(parseSurfaceHash('#/evidence-monitoring')).toBe('capabilities');
    expect(parseSurfaceHash('#/activity')).toBe('activity');
    expect(parseSurfaceHash('#/usage')).toBe('usage');
    expect(parseSurfaceHash('#/settings')).toBe('settings');
    expect(parseSurfaceHash('#/control-center')).toBe('home');
  });

  it('ignores a trailing slash', () => {
    expect(parseSurfaceHash('#/runs/')).toBe('runs');
  });

  it('opens an exact linked run in the production Runs timeline', () => {
    const hash = runDetailHash('run/with spaces');
    expect(hash).toBe('#/runs?runId=run%2Fwith+spaces');
    expect(parseSurfaceHash(hash)).toBe('runs');
    expect(parseHashParameter(hash, 'runId')).toBe('run/with spaces');
  });

  it('reads detail links from a surface hash', () => {
    expect(
      parseHashParameter(
        '#/capabilities?capabilityVersionId=capability%2Fnew',
        'capabilityVersionId',
      ),
    ).toBe('capability/new');
    expect(parseHashParameter('#/workflows', 'workflowVersionId')).toBeNull();
  });

  it('links Catalog rows by stable workflow identity', () => {
    expect(workflowCatalogDetailHash('workflow/with spaces')).toBe(
      '#/workflow-catalog?workflowId=workflow%2Fwith+spaces',
    );
    expect(
      parseHashParameter(workflowCatalogDetailHash('workflow/with spaces'), 'workflowId'),
    ).toBe('workflow/with spaces');
  });

  it('keeps workflow detail history navigable through direct links and browser history', () => {
    const detail = workflowCatalogDetailHash('workflow_payment');
    expect(parseSurfaceHash(detail)).toBe('workflow-catalog');
    expect(parseHashParameter(detail, 'workflowId')).toBe('workflow_payment');
  });

  it('observes the full hash when browser history changes within the Catalog surface', () => {
    let hashChange: (() => void) | undefined;
    const onChange = vi.fn<() => void>();
    const removeEventListener = vi.fn<(type: string, listener: () => void) => void>();
    const fakeWindow = {
      location: { hash: '#/workflow-catalog' },
      addEventListener: vi.fn<(type: string, listener: () => void) => void>((_type, listener) => {
        hashChange = listener;
      }),
      removeEventListener,
    };
    vi.stubGlobal('window', fakeWindow);

    const unsubscribe = subscribeToHashChanges(onChange);
    fakeWindow.location.hash = workflowCatalogDetailHash('workflow_payment');
    hashChange?.();

    expect(onChange).toHaveBeenCalledOnce();
    expect(readLocationHash()).toBe('#/workflow-catalog?workflowId=workflow_payment');
    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith('hashchange', onChange);
  });

  it('routes an exact Catalog version into the existing workflow review surface', () => {
    const hash = workflowReviewHash('workflow/payment', 'payment@3');
    expect(hash).toBe(
      '#/workflows?catalogWorkflowId=workflow%2Fpayment&catalogWorkflowVersionId=payment%403&action=review',
    );
    expect(parseHashParameter(hash, 'catalogWorkflowId')).toBe('workflow/payment');
    expect(parseHashParameter(hash, 'catalogWorkflowVersionId')).toBe('payment@3');

    const editHash = workflowEditHash('workflow/payment', 'payment@4');
    expect(editHash).toBe(
      '#/workflows?catalogWorkflowId=workflow%2Fpayment&catalogWorkflowVersionId=payment%404&action=edit',
    );
    expect(parseHashParameter(editHash, 'action')).toBe('edit');
  });

  it('falls back to home for unknown destinations', () => {
    expect(parseSurfaceHash('#/nonsense')).toBe('home');
    expect(parseSurfaceHash('#/runs/extra/segments')).toBe('home');
  });

  it('round-trips every surface through its hash', () => {
    expect(surfaces).toEqual([
      'home',
      'workflows',
      'workflow-catalog',
      'capabilities',
      'runs',
      'changes',
      'activity',
      'usage',
      'settings',
    ]);
    for (const surface of surfaces) {
      expect(parseSurfaceHash(surfaceHash(surface))).toBe(surface);
    }
  });
});
