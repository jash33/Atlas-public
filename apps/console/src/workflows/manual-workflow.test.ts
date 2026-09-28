import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { createBuilderDocument } from './builder-model.js';
import {
  createManualWorkflowVersion,
  loadManualWorkflow,
  mergeBuilderExecutable,
  saveManualWorkflow,
  workflowEditSummary,
  workflowExecutableKey,
} from './manual-workflow.js';

afterEach(() => vi.unstubAllGlobals());

describe('manual workflow editing', () => {
  it('preserves labels, positions, notes and trigger when AI changes the executable', () => {
    const document = {
      ...createBuilderDocument(),
      labels: { finish: 'Return result' },
      notes: [{ id: 'note', text: 'Keep this', x: 1, y: 2 }],
      layout: { finish: { x: 24, y: 90 } },
      trigger: { type: 'webhook' as const },
    };
    const executable = {
      irVersion: 3,
      startStepId: 'done',
      steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
    };
    expect(mergeBuilderExecutable(document, executable)).toEqual({ ...document, executable });
  });

  it('compares behavior independently of JSON key order', () => {
    expect(
      workflowExecutableKey({ irVersion: 3, steps: [{ id: 'finish', kind: 'terminal' }] }),
    ).toBe(workflowExecutableKey({ steps: [{ kind: 'terminal', id: 'finish' }], irVersion: 3 }));
  });

  it('describes added, changed and removed steps in an AI proposal', () => {
    expect(
      workflowEditSummary(
        {
          steps: [
            { id: 'read', kind: 'capabilityCall' },
            { id: 'old', kind: 'sleep' },
          ],
        },
        {
          steps: [
            { id: 'read', kind: 'transform' },
            { id: 'new', kind: 'terminal' },
          ],
        },
      ),
    ).toEqual(['Change read', 'Add new', 'Remove old']);
  });

  it('saves incomplete drafts with an expected revision and reports concurrent edits', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: 'revision-conflict' }, { status: 409 }),
    );
    vi.stubGlobal('fetch', fetch);
    const document = { ...createBuilderDocument(), executable: { irVersion: 3, steps: [] } };
    await expect(
      saveManualWorkflow(
        { organizationId: 'org', environmentId: 'development', workflowId: 'flow' },
        { name: 'My workflow', expectedRevision: 4, document },
        'author',
        new AbortController().signal,
      ),
    ).rejects.toThrow('another session');
    const body = fetch.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new Error('Expected saved draft JSON');
    expect(JSON.parse(body)).toMatchObject({ expectedRevision: 4, document });
  });

  it('allows a new workflow with no saved working draft', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    expect(
      await loadManualWorkflow(
        { organizationId: 'org', environmentId: 'development', workflowId: 'new' },
        new AbortController().signal,
        'author-token',
      ),
    ).toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Bearer author-token',
    });
  });

  it('keeps node-specific validation details for the editor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(async () =>
        Response.json(
          {
            diagnostics: [
              { path: 'steps[sleep].durationMs', message: 'Choose a positive duration.' },
            ],
          },
          { status: 422 },
        ),
      ),
    );
    await expect(
      createManualWorkflowVersion(
        { organizationId: 'org', environmentId: 'development', workflowId: 'flow' },
        { expectedRevision: 1, projectionFingerprint: 'a'.repeat(64) },
        'author',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      issues: [{ stepId: 'sleep', message: 'Choose a positive duration.' }],
    });
  });
});
