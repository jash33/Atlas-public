// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

import { ModelTraces } from './ModelTraces.js';
import type { DraftRequestProgress } from './draft-request-progress.js';

const observers: TestResizeObserver[] = [];
class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  notify() {
    this.callback([], this);
  }
}

let container: HTMLDivElement;
let topbar: HTMLElement;
let root: Root;
const progress: DraftRequestProgress = {
  requestId: 'trace-layout',
  status: 'running',
  stage: 'understanding',
  startedAt: '2026-09-19T22:00:00Z',
  liveText: false,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1200);
  observers.length = 0;
  const shell = document.createElement('div');
  shell.className = 'shell-main';
  topbar = document.createElement('header');
  topbar.className = 'topbar';
  vi.spyOn(topbar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1200, 64));
  container = document.createElement('div');
  shell.append(topbar, container);
  document.body.append(shell);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sidebar() {
  const element = container.querySelector('aside');
  if (!element) throw new Error('Missing trace sidebar');
  return element;
}

it('keeps the heading visible while new trace content scrolls to the bottom', () => {
  act(() => root.render(createElement(ModelTraces, { progress })));
  expect(sidebar().scrollTop).toBe(0);
  const log = container.querySelector<HTMLElement>('[aria-label="AI trace log"]');
  expect(log).not.toBeNull();
  expect(log?.contains(container.querySelector('h2'))).toBe(false);
  expect(log?.scrollTop).toBe(1200);

  act(() =>
    root.render(createElement(ModelTraces, { progress: { ...progress, stage: 'building' } })),
  );
  act(() => observers.forEach((observer) => observer.notify()));
  expect(sidebar().scrollTop).toBe(0);
  expect(log?.scrollTop).toBe(1200);
});

it('reserves the actual navigation height and updates it when the navigation wraps', () => {
  act(() => root.render(createElement(ModelTraces, { progress })));
  expect(sidebar().style.getPropertyValue('--wf-traces-top')).toBe('64px');
  vi.spyOn(topbar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1200, 104));
  act(() => observers.forEach((observer) => observer.notify()));
  expect(sidebar().style.getPropertyValue('--wf-traces-top')).toBe('104px');
});

it('follows the visible bottom of the navigation as it scrolls out of view', () => {
  act(() => root.render(createElement(ModelTraces, { progress })));
  vi.spyOn(topbar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -32, 1200, 64));
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
  expect(sidebar().style.getPropertyValue('--wf-traces-top')).toBe('32px');
  vi.spyOn(topbar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, -100, 1200, 64));
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
  expect(sidebar().style.getPropertyValue('--wf-traces-top')).toBe('0px');
  vi.spyOn(topbar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1200, 64));
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
  expect(sidebar().style.getPropertyValue('--wf-traces-top')).toBe('64px');
});

it('hides traces without discarding their error details and restores them when expanded', () => {
  const onCollapse = vi.fn<() => void>();
  const onExpand = vi.fn<() => void>();
  const failed = { ...progress, status: 'failed' as const, error: 'Drafting could not finish.' };
  act(() => root.render(createElement(ModelTraces, { progress: failed, onCollapse })));
  act(() =>
    container.querySelector<HTMLButtonElement>('[aria-label="Collapse model traces"]')!.click(),
  );
  expect(onCollapse).toHaveBeenCalledOnce();
  act(() =>
    root.render(
      createElement(ModelTraces, { progress: failed, collapsed: true, onCollapse, onExpand }),
    ),
  );
  expect(sidebar().hidden).toBe(false);
  expect(sidebar().classList.contains('is-collapsed')).toBe(true);
  expect(container.querySelector<HTMLElement>('[aria-label="AI trace log"]')?.hidden).toBe(true);
  const expand = container.querySelector<HTMLButtonElement>('[aria-label="Expand model traces"]')!;
  expect(expand.getAttribute('aria-expanded')).toBe('false');
  expect(expand.querySelector('svg')).not.toBeNull();
  act(() => expand.click());
  expect(onExpand).toHaveBeenCalledOnce();
  expect(sidebar().textContent).toContain('Drafting could not finish.');
  act(() =>
    root.render(createElement(ModelTraces, { progress: failed, collapsed: false, onCollapse })),
  );
  expect(sidebar().hidden).toBe(false);
  expect(container.querySelector<HTMLElement>('[aria-label="AI trace log"]')?.hidden).toBe(false);
  expect(sidebar().textContent).toContain('Drafting could not finish.');
});
