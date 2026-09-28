// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

import { renderHook } from '../test-render.js';
import { useManualWorkflow } from './manual-workflow-session.js';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

it.each(['edit', 'scope'] as const)(
  'ignores a validation result after a subsequent %s',
  async (change) => {
    const response = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => response.promise);
    vi.stubGlobal('fetch', fetch);
    let environmentId = 'development';
    const hook = renderHook(() =>
      useManualWorkflow({
        scope: { organizationId: 'org', environmentId, workflowId: 'flow' },
        enabled: false,
        preferSaved: false,
        token: 'author',
        name: '',
        executable: undefined,
        onLoadName: () => {},
      }),
    );
    try {
      let result!: ReturnType<typeof hook.current.validate>;
      act(() => {
        result = hook.current.validate('b'.repeat(64));
      });
      expect(hook.current.operation).toBe('validating');
      const next = {
        ...hook.current.document,
        notes: [{ id: 'new', text: 'Edited while checking', x: 0, y: 0 }],
      };
      const expectedDocument = change === 'edit' ? next : hook.current.document;
      if (change === 'edit') act(() => hook.current.update(next));
      else {
        environmentId = 'production';
        hook.render();
      }
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(change === 'scope');
      await act(async () => {
        response.resolve(Response.json({ workflowId: 'flow', draft: {}, review: {} }));
        expect(await result).toBeUndefined();
      });
      expect(hook.current.busy).toBe(false);
      expect(hook.current.message).toBeUndefined();
      expect(hook.current.revision).toBeNull();
      expect(hook.current.dirty).toBe(true);
      expect(hook.current.document).toEqual(expectedDocument);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
    }
  },
);
