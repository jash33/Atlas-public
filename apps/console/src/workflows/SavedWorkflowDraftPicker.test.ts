// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

import { SavedWorkflowDraftPicker } from './SavedWorkflowDraftPicker.js';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it('lets users choose a saved draft before loading, or cancel without replacing their work', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onLoad = vi.fn<(id: string) => void>();
  const onRefresh = vi.fn<() => void>();
  const button = (text: string) => {
    const found = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === text,
    );
    if (!found) throw new Error(`Expected ${text}`);
    return found;
  };
  try {
    act(() =>
      root.render(
        createElement(SavedWorkflowDraftPicker, {
          drafts: [
            { workflowId: 'first', name: 'Orders' },
            { workflowId: 'second', name: 'Receipts' },
          ],
          currentWorkflowId: 'first',
          disabled: false,
          status: 'ready',
          hasUnsavedChanges: true,
          onRefresh,
          onLoad,
        }),
      ),
    );
    act(() => button('Load draft').click());
    expect(onRefresh).toHaveBeenCalledOnce();
    const select = container.querySelector('select')!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Orders (current)',
      'Receipts',
    ]);
    expect(container.textContent).toContain('Loading a draft will replace your unsaved changes.');
    act(() => {
      select.value = 'second';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onLoad).not.toHaveBeenCalled();
    act(() => button('Cancel').click());
    expect(onLoad).not.toHaveBeenCalled();
    expect(container.querySelector('select')).toBeNull();
    act(() => button('Load draft').click());
    act(() => {
      const choice = container.querySelector('select')!;
      choice.value = 'second';
      choice.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => button('Load selected draft').click());
    expect(onLoad).toHaveBeenCalledExactlyOnceWith('second');
    expect(container.querySelector('select')).toBeNull();
    expect(document.activeElement).toBe(button('Load draft'));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
