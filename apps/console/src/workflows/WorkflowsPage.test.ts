// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  demoTokenForRole: () => 'test-only-admin',
}));

// Drive real React effects with controlled network responses.
const hooks = vi.hoisted(() => ({
  hash: '',
  environmentId: 'development',
  customerUser: {
    actorId: 'atlas-admin',
    organizationId: 'org_atlas',
    role: 'admin' as const,
  } as { actorId: string; organizationId: string; role: 'admin' } | undefined,
}));
vi.mock('../shell/session.js', () => ({
  useConsoleSession: () => ({
    organizationId: 'org_atlas',
    environmentId: hooks.environmentId,
    role: 'admin',
    customerUser: hooks.customerUser,
  }),
}));
vi.mock('../shell/router.js', () => ({
  useLocationHash: () => hooks.hash,
  parseHashParameter: (hash: string, name: string) =>
    new URLSearchParams(hash.split('?')[1] ?? '').get(name) ?? undefined,
}));

import { WorkflowsPage } from './WorkflowsPage.js';
import { WorkflowChecks } from './WorkflowChecks.js';
import { DraftProgress } from './DraftProgress.js';
import { ModelTraces } from './ModelTraces.js';
import { WorkflowBuilder } from './WorkflowBuilder.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';
import { SavedWorkflowDraftPicker } from './SavedWorkflowDraftPicker.js';
import { WorkflowPlanReview } from './WorkflowPlanReview.js';
import { parseWorkflowArtifactYaml } from './workflow.js';
import { WorkflowCompose } from './WorkflowCompose.js';
import { RequestPromptEditor } from './RequestPromptEditor.js';
import { createBuilderDocument, type BuilderDocument } from './builder-model.js';
import type { ComponentProps, ReactElement } from 'react';

const draft = {
  workflowVersionId: 'demo@1',
  irHash: 'a'.repeat(64),
  executionRequirements: {
    organizationId: 'org_atlas',
    workflowVersionId: 'demo@1',
    irHash: 'a'.repeat(64),
    requiredCapabilityVersionIds: [],
  },
  executable: { irVersion: 1, steps: [{ id: 'done', kind: 'terminal', state: 'completed' }] },
};
const review = {
  workflowVersionId: draft.workflowVersionId,
  artifact: draft,
  source: null,
  binding: { irHash: draft.irHash, policyVersion: 'test', projectionFingerprint: 'b'.repeat(64) },
  migration: null,
  irreversibleBoundary: null,
  steps: [],
  graph: {
    nodes: [
      {
        stepId: 'done',
        kind: 'terminal',
        terminalState: 'completed',
        irreversible: false,
        retryPolicy: null,
      },
    ],
    edges: [],
  },
  approval: { enabled: false, diagnostics: [] },
};
function requestUrl(input: Parameters<typeof fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
}

function requestBody(init?: RequestInit) {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body);
}

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';

let lastPage: ReturnType<typeof WorkflowsPage>;
let root: Root;
function PageProbe() {
  lastPage = WorkflowsPage();
  return null;
}
async function waitFor(assertion: () => void, options?: Parameters<typeof vi.waitFor>[1]) {
  await vi.waitFor(async () => {
    await act(async () => {});
    assertion();
  }, options);
}
function renderPage() {
  act(() => flushSync(() => root.render(createElement(PageProbe))));
  return lastPage.props.children[0].props;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.createElement('div'));
  const storage = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  hooks.hash = '';
  hooks.environmentId = 'development';
  hooks.customerUser = {
    actorId: 'atlas-admin',
    organizationId: 'org_atlas',
    role: 'admin',
  };
});
afterEach(() => {
  act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('draft checks preserve the workflow diagram', () => {
  it.each([true, false])(
    'ignores a late approval after switching environment (success=%s)',
    async (success) => {
      const approval = Promise.withResolvers<Response>();
      const newDraft = Promise.withResolvers<Response>();
      const fetch = builderApi();
      const original = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (input, init) => {
        const url = requestUrl(input);
        if (url.endsWith('/workflow-approvals')) return approval.promise;
        if (url.includes('/draft-requests/') && hooks.environmentId === 'production')
          return newDraft.promise;
        if (url.endsWith('/workflow-reviews'))
          return Response.json({ ...review, approval: { enabled: true, diagnostics: [] } });
        return original(input, init);
      });
      const checks = () => {
        renderPage();
        const found = findElement<ComponentProps<typeof WorkflowChecks>>(
          lastPage,
          (element) => element.type === WorkflowChecks,
        );
        if (!found) throw new Error('Expected workflow checks');
        return found.props;
      };
      act(() => {
        renderPage().onNameChange('First environment');
      });
      act(() => {
        renderPage().onDraft();
      });
      await waitFor(() => expect(renderPage().isBusy).toBe(false));
      act(() => {
        checks().onRunChecks();
      });
      await waitFor(() => expect(checks().approval.enabled).toBe(true));
      act(() => {
        checks().onApprove();
      });
      expect(renderPage().isBusy).toBe(true);
      hooks.environmentId = 'production';
      expect(renderPage().workflowName).toBe('');
      expect(renderPage().graph).toBeUndefined();
      act(() => {
        renderPage().onNameChange('Second environment');
      });
      act(() => {
        renderPage().onDraft();
      });
      await act(async () =>
        approval.resolve(
          Response.json(success ? {} : { error: 'old-approval-error' }, {
            status: success ? 200 : 500,
          }),
        ),
      );
      expect(renderPage().error).toBeUndefined();
      expect(renderPage().isBusy).toBe(true);
      const approvalCall = fetch.mock.calls.find(([url]) =>
        requestUrl(url).endsWith('/workflow-approvals'),
      );
      expect(approvalCall?.[1]?.signal?.aborted).toBe(true);
      await act(async () => newDraft.resolve(Response.json({ status: 'cancelled' })));
    },
  );

  it.each(['unsupported', 'manual_review', 'failed'] as const)(
    'keeps the AI trace after an immediate %s result and while refining the prompt',
    async (status) => {
      const reason = 'The capability index has no capability for creating pickup orders.';
      const progress = {
        requestId: 'rejected-draft',
        status: status === 'failed' ? 'failed' : 'completed',
        startedAt: '2026-09-19T22:00:00Z',
        finishedAt: '2026-09-19T22:00:01Z',
        liveText: true,
        events: [
          { sequence: 1, timestamp: 'now', kind: 'model.attempt.failed', data: { detail: reason } },
        ],
        ...(status === 'failed'
          ? { error: reason }
          : { result: { httpStatus: 200, body: { status, reason, detail: reason } } }),
      };
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input) =>
          requestUrl(input).includes('/draft-requests/')
            ? Response.json(progress)
            : Response.json({}),
        ),
      );
      act(() => {
        renderPage().onNameChange('Pickup order');
      });
      act(() => {
        renderPage().onDraft();
      });
      await waitFor(() => expect(renderPage().isBusy).toBe(false));
      const before = findElement<ComponentProps<typeof ModelTraces>>(
        lastPage,
        (element) => element.type === ModelTraces,
      );
      expect(before?.props.progress).toEqual(progress);
      act(() => {
        renderPage().onEditorChange({
          ...renderPage().editor,
          text: 'Open a pickup order using the available order service.',
        });
      });
      renderPage();
      const after = findElement<ComponentProps<typeof ModelTraces>>(
        lastPage,
        (element) => element.type === ModelTraces,
      );
      expect(after?.props.progress).toEqual(progress);
      expect(after?.key).toBe(before?.key);
      expect(lastPage.props.className).toContain('wf-with-traces');
    },
  );

  it('keeps a failed AI trace when the request is rejected before progress arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) =>
        requestUrl(input).includes('/draft-requests/')
          ? Response.json({ error: 'author-role-required' }, { status: 403 })
          : Response.json({}),
      ),
    );
    act(() => {
      renderPage().onNameChange('Pickup order');
    });
    act(() => {
      renderPage().onDraft();
    });
    await waitFor(() => expect(renderPage().error).toBeDefined());
    renderPage();
    const traces = findElement<ComponentProps<typeof ModelTraces>>(
      lastPage,
      (element) => element.type === ModelTraces,
    );
    expect(traces?.props.progress).toMatchObject({
      status: 'failed',
      result: { httpStatus: 403, body: { error: 'author-role-required' } },
    });
    expect(lastPage.props.className).toContain('wf-with-traces');
  });

  it('keeps an untouched create-workflow page idle', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>(() => Promise.resolve(Response.json({}))),
    );

    const compose = renderPage();

    expect(compose.isBusy).toBe(false);
    expect(compose.children.filter(Boolean)).toEqual([]);
    expect(lastPage.props.children.filter(Boolean)).not.toContainEqual(
      expect.objectContaining({ type: ModelTraces }),
    );
  });

  it('does not restore a previous anonymous draft after entering the demo', () => {
    hooks.customerUser = undefined;
    sessionStorage.setItem(
      'atlas-draft:org_atlas:development:admin',
      JSON.stringify({
        url: 'http://localhost/v1/draft-requests/previous-guest-draft',
        state: {
          request: 'Old request',
          requestId: 8,
          phase: 'drafting',
          revealEvidence: false,
          revealValidated: false,
        },
        workflowName: 'Old workflow',
        workflowId: 'old-workflow',
      }),
    );
    const pending = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise);
    vi.stubGlobal('fetch', fetch);

    const compose = renderPage();

    expect(compose.isBusy).toBe(false);
    expect(compose.children.filter(Boolean)).not.toContainEqual(
      expect.objectContaining({ type: DraftProgress }),
    );
    expect(lastPage.props.children.filter(Boolean)).not.toContainEqual(
      expect.objectContaining({ type: ModelTraces }),
    );
    expect(
      fetch.mock.calls.some(([input]) =>
        requestUrl(input).includes('/draft-requests/previous-guest-draft'),
      ),
    ).toBe(false);
    expect(sessionStorage.getItem('atlas-draft:org_atlas:development:admin')).toBeNull();
  });

  it('restores the sample prompt when starting over and discards late drafting results', async () => {
    const late = Promise.withResolvers<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, options) => {
        if (requestUrl(input).includes('/draft-requests/')) {
          if (options?.method === 'DELETE') return Response.json({ status: 'cancelled' });
          return late.promise;
        }
        return Response.json({});
      }),
    );
    expect(renderPage().onStartOver).toBeUndefined();
    const samplePrompt = renderPage().editor.text;
    act(() => {
      renderPage().onEditorChange({ ...renderPage().editor, text: '' });
    });
    expect(renderPage().onStartOver).toBeTypeOf('function');
    act(() => {
      renderPage().onEditorChange({ ...renderPage().editor, text: 'Process a new order' });
    });
    act(() => {
      renderPage().onNameChange('Old workflow');
    });
    expect(renderPage().onStartOver).toBeTypeOf('function');
    act(() => {
      renderPage().onDraft();
    });
    await act(async () => {
      await renderPage().onStartOver();
    });
    await waitFor(() => expect(renderPage().workflowName).toBe(''));
    expect(renderPage().editor.text).toBe(samplePrompt);
    expect(renderPage().isBusy).toBe(false);
    expect(renderPage().onStartOver).toBeUndefined();
    expect(sessionStorage.getItem('atlas-draft:org_atlas:development:atlas-admin')).toBeNull();
    late.resolve(
      Response.json({
        status: 'completed',
        result: { httpStatus: 200, body: { status: 'validated', draft } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderPage().workflowName).toBe('');
    expect(renderPage().graph).toBeUndefined();
    expect(renderPage().editor.text).toBe(samplePrompt);
    expect(renderPage().onStartOver).toBeUndefined();
  });
  it('clears the finished timer and stepper and mounts fresh progress after starting over', async () => {
    let attempts = 0;
    const pending = Promise.withResolvers<Response>();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        const url = requestUrl(input);
        if (url.includes('/draft-requests/')) {
          if (++attempts > 1) return pending.promise;
          return Response.json({
            requestId: 'finished',
            status: 'completed',
            liveText: false,
            startedAt: '2026-09-13T01:00:00Z',
            finishedAt: '2026-09-13T01:02:00Z',
            stage: 'validating',
            result: {
              httpStatus: 200,
              body: {
                status: 'validated',
                annotations: [],
                originalRequest: 'Finish order',
                clarifiedRequest: 'Finish order',
                projectionFingerprint: 'b'.repeat(64),
                draft,
              },
            },
          });
        }
        if (url.endsWith('/workflow-reviews')) return Response.json(review);
        return Response.json({});
      }),
    );
    const progress = () =>
      (renderPage().children as ReactElement<{ progress?: { finishedAt?: string } }>[]).find(
        (child) => child?.type === DraftProgress,
      );
    act(() => {
      renderPage().onNameChange('First draft');
    });
    act(() => {
      renderPage().onDraft();
    });
    await waitFor(() => expect(renderPage().isBusy).toBe(false));
    const previous = progress();
    expect(previous?.props.progress?.finishedAt).toBe('2026-09-13T01:02:00Z');
    act(() => {
      renderPage().onStartOver();
    });
    expect(progress()).toBeUndefined();
    expect(renderPage().graph).toBeUndefined();
    act(() => {
      renderPage().onNameChange('Fresh draft');
    });
    act(() => {
      renderPage().onDraft();
    });
    expect(progress()).toBeDefined();
    expect(progress()?.key).not.toBe(previous?.key);
    expect(progress()?.props.progress).toBeUndefined();
    pending.resolve(Response.json({ status: 'failed', error: 'Stopped test draft' }));
    await waitFor(() => expect(renderPage().isBusy).toBe(false));
  });

  it('does not save a late result after the user cancels', async () => {
    const late = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
      const url = requestUrl(input);
      if (url.includes('/draft-requests/')) {
        if (options?.method === 'DELETE')
          return Response.json({
            requestId: 'cancelled',
            status: 'cancelled',
            liveText: false,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          });
        return late.promise;
      }
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetch);
    act(() => {
      renderPage().onNameChange('Cancelled order');
    });
    act(() => {
      renderPage().onDraft();
    });
    const progress = (
      renderPage().children as ReactElement<{ onCancel: () => Promise<void> }>[]
    ).find((child) => child?.type === DraftProgress);
    await act(async () => {
      await progress!.props.onCancel();
    });
    late.resolve(
      Response.json({
        status: 'completed',
        result: {
          httpStatus: 200,
          body: {
            status: 'validated',
            projectionFingerprint: 'b'.repeat(64),
            draft,
          },
        },
      }),
    );
    await waitFor(() => expect(renderPage().isBusy).toBe(false));
    expect(
      fetch.mock.calls.some(([url]) => requestUrl(url).includes('/workflow-catalog/versions')),
    ).toBe(false);
    expect(sessionStorage.getItem('atlas-draft:org_atlas:development:atlas-admin')).toContain(
      '"cancelRequested":true',
    );
  });
  it('restores a finished request after refresh without drafting or running checks again', async () => {
    const savedState = {
      request: 'Finish order',
      requestId: 8,
      phase: 'drafting',
      revealEvidence: false,
      revealValidated: false,
    };
    sessionStorage.setItem(
      'atlas-draft:org_atlas:development:atlas-admin',
      JSON.stringify({
        url: 'http://localhost/v1/draft-requests/restored',
        state: savedState,
        workflowName: 'Recovered order',
        workflowId: 'recovered-workflow',
      }),
    );
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.includes('/v1/draft-requests/'))
        return Response.json({
          requestId: 'restored',
          status: 'completed',
          liveText: false,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          result: {
            httpStatus: 200,
            body: {
              status: 'validated',
              annotations: [],
              originalRequest: 'Finish order',
              clarifiedRequest: 'Finish order',
              projectionFingerprint: 'b'.repeat(64),
              draft,
            },
          },
        });
      if (url.endsWith('/v1/workflow-reviews')) return Response.json(review);
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetch);
    renderPage();
    await waitFor(() => {
      const compose = renderPage();
      expect(compose.graph).toBeDefined();
      expect(compose.isBusy).toBe(false);
    });
    expect(
      fetch.mock.calls
        .filter(([url]) => requestUrl(url).includes('/draft-requests/'))
        .map(([, options]) => options?.method),
    ).toEqual(['GET']);
    expect(
      fetch.mock.calls.some(([url]) => requestUrl(url).includes('/workflow-sandbox-tests')),
    ).toBe(false);
    const saved = fetch.mock.calls.find(([url]) =>
      requestUrl(url).includes('/workflow-catalog/versions'),
    );
    const savedBody = saved?.[1]?.body;
    if (typeof savedBody !== 'string') throw new Error('Expected a saved draft body');
    expect(JSON.parse(savedBody)).toMatchObject({
      workflowId: 'recovered-workflow',
      name: 'Recovered order',
    });
  });
  it.each(['passed', 'failed'] as const)('runs checks only when requested (%s)', async (status) => {
    const pendingChecks = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = requestUrl(input);
      if (url.includes('/v1/draft-requests/'))
        return Response.json({
          status: 'completed',
          result: {
            httpStatus: 200,
            body: {
              status: 'validated',
              annotations: [],
              originalRequest: 'Finish order',
              clarifiedRequest: 'Finish order',
              projectionFingerprint: 'b'.repeat(64),
              draft,
            },
          },
        });
      if (url.endsWith('/v1/workflow-reviews')) return Response.json(review);
      if (url.includes('/v1/workflow-sandbox-test-requests/')) return pendingChecks.promise;
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetch);
    const checks = () => {
      renderPage();
      const evidence = lastPage.props.children.find(
        (child: ReactElement) => child?.type === 'section',
      );
      return evidence.props.children.find((child: ReactElement) => child?.type === WorkflowChecks)
        .props;
    };
    act(() => {
      renderPage().onNameChange('My order');
    });
    act(() => {
      renderPage().onDraft();
    });
    await waitFor(() => {
      expect(renderPage().graph).toBeDefined();
      expect(renderPage().isBusy).toBe(false);
    });
    expect(
      fetch.mock.calls.some(([url]) =>
        requestUrl(url).includes('/workflow-sandbox-test-requests/'),
      ),
    ).toBe(false);
    expect(checks().runFromDraft).toBeUndefined();
    expect(checks().status).toBe('not-run');
    act(() => {
      checks().onRunChecks();
    });
    expect(checks().status).toBe('running');
    expect(renderPage().isBusy).toBe(false);
    pendingChecks.resolve(
      Response.json({
        requestId: 'checks',
        status,
        startedAt: new Date().toISOString(),
        result: { status, tests: [{ status, stepId: 'done', detail: 'Check result' }] },
      }),
    );
    await waitFor(() => expect(checks().status).toBe(status));
    expect(renderPage().graph).toBeDefined();
    expect(
      fetch.mock.calls.filter(([url]) => requestUrl(url).includes('/draft-requests/')),
    ).toHaveLength(1);
  });

  it('cancels a running check request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, options) => {
      const url = requestUrl(input);
      if (url.includes('/v1/draft-requests/'))
        return Response.json({
          status: 'completed',
          result: {
            httpStatus: 200,
            body: {
              status: 'validated',
              annotations: [],
              originalRequest: 'Finish order',
              clarifiedRequest: 'Finish order',
              projectionFingerprint: 'b'.repeat(64),
              draft,
            },
          },
        });
      if (url.endsWith('/v1/workflow-reviews')) return Response.json(review);
      if (url.includes('/v1/workflow-sandbox-test-requests/')) {
        return options?.method === 'DELETE'
          ? Response.json({ requestId: 'checks', status: 'cancelled', startedAt: 'now' })
          : Response.json({ requestId: 'checks', status: 'running', startedAt: 'now' });
      }
      return Response.json({});
    });
    vi.stubGlobal('fetch', fetch);
    const checks = () => {
      renderPage();
      const evidence = lastPage.props.children.find(
        (child: ReactElement) => child?.type === 'section',
      );
      return evidence.props.children.find((child: ReactElement) => child?.type === WorkflowChecks)
        .props;
    };

    act(() => {
      renderPage().onNameChange('My order');
    });
    act(() => {
      renderPage().onDraft();
    });
    await waitFor(() => expect(checks().status).toBe('not-run'));
    act(() => {
      checks().onRunChecks();
    });
    await waitFor(() => expect(checks().status).toBe('running'));
    act(() => {
      checks().onCancelChecks();
    });
    await waitFor(() => expect(checks().status).toBe('cancelled'));
    expect(
      fetch.mock.calls.some(
        ([url, options]) =>
          requestUrl(url).includes('/workflow-sandbox-test-requests/') &&
          options?.method === 'DELETE',
      ),
    ).toBe(true);
  });

  it('carries polled progress through the session into Checks and clears it on completion, rerun, cancellation, and failure', async () => {
    const fetch = builderApi();
    const fallback = fetch.getMockImplementation()!;
    const response = (body: Record<string, unknown>) =>
      Response.json({ requestId: 'checks', startedAt: 'now', ...body });
    let responses: Array<Response | Promise<Response>> = [
      response({ status: 'running', progress: { phase: 'preparing', completed: 0, total: 16 } }),
      response({
        status: 'running',
        progress: {
          phase: 'running',
          completed: 8,
          total: 16,
          currentTest: { kind: 'duplicate-event', stepId: 'create_fulfillment' },
        },
      }),
      response({ status: 'running', progress: { phase: 'finalizing', completed: 16, total: 16 } }),
      response({
        status: 'passed',
        result: { status: 'passed', tests: [] },
        progress: { phase: 'finalizing', completed: 16, total: 16 },
      }),
    ];
    fetch.mockImplementation(async (input, init) => {
      if (!requestUrl(input).includes('/workflow-sandbox-test-requests/'))
        return fallback(input, init);
      if (init?.method === 'DELETE')
        return response({
          status: 'cancelled',
          progress: { phase: 'running', completed: 8, total: 16 },
        });
      const next = responses.shift();
      if (!next) throw new Error('Unexpected check poll');
      return next;
    });
    await generateAndOpenBuilder();
    vi.useFakeTimers();
    const checksMarkup = () => renderToStaticMarkup(createElement(WorkflowChecks, checkProps()));
    try {
      await act(async () => checkProps().onRunChecks());
      expect(checksMarkup()).toContain('Preparing workflow checks.');
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(checksMarkup()).toContain('Checking duplicate handling for Create fulfillment.');
      expect(checksMarkup()).toContain('8 of 16 checks completed.');
      await act(async () => vi.advanceTimersByTimeAsync(400));
      expect(checksMarkup()).toContain('8 of 16 checks completed.');
      await act(async () => vi.advanceTimersByTimeAsync(600));
      expect(checksMarkup()).toContain('Finishing workflow checks.');
      expect(checksMarkup()).toContain('16 of 16 checks completed.');
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(checkProps().progress).toBeUndefined();
      expect(checksMarkup()).toContain('This version is ready to approve.');
      const restarting = Promise.withResolvers<Response>();
      responses = [restarting.promise];
      await act(async () => checkProps().onRunChecks());
      expect(checkProps().progress).toBeUndefined();
      expect(checksMarkup()).not.toContain('16 of 16');
      expect(checksMarkup()).toContain('This may take a little while.');
      await act(async () =>
        restarting.resolve(
          response({ status: 'running', progress: { phase: 'running', completed: 8, total: 16 } }),
        ),
      );
      expect(checksMarkup()).toContain('8 of 16 checks completed.');
      await act(async () => checkProps().onCancelChecks());
      expect(checkProps().progress).toBeUndefined();
      expect(checksMarkup()).toContain('Checks were cancelled.');
      responses = [
        response({
          status: 'running',
          progress: {
            phase: 'running',
            completed: 0,
            total: 9,
            currentTest: { kind: 'authentication', stepId: 'create_fulfillment' },
          },
        }),
        response({
          status: 'failed',
          error: 'Authentication check failed.',
          progress: { phase: 'running', completed: 1, total: 9 },
        }),
      ];
      await act(async () => checkProps().onRunChecks());
      expect(checksMarkup()).toContain('Checking authentication for Create fulfillment.');
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(checkProps().progress).toBeUndefined();
      expect(checksMarkup()).toContain('Authentication check failed.');
      expect(checksMarkup()).not.toContain('checks completed.');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['workflow-reviews', 'workflow-catalog/versions'])(
    'keeps the generated diagram when %s fails',
    async (failedRoute) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url.endsWith(`/v1/${failedRoute}`))
            return Response.json({ error: 'service unavailable' }, { status: 503 });
          if (url.includes('/v1/draft-requests/'))
            return Response.json({
              status: 'completed',
              result: {
                httpStatus: 200,
                body: {
                  status: 'validated',
                  annotations: [],
                  originalRequest: 'Finish order',
                  clarifiedRequest: 'Finish order',
                  projectionFingerprint: 'b'.repeat(64),
                  draft,
                },
              },
            });
          if (url.endsWith('/v1/workflow-reviews')) return Response.json(review);
          return Response.json({});
        }),
      );
      act(() => {
        renderPage().onNameChange('My order');
      });
      act(() => {
        renderPage().onDraft();
      });
      await waitFor(
        () => {
          const compose = renderPage();
          expect(compose.error).toBeTruthy();
          expect(compose.isBusy).toBe(false);
          expect(compose.graph).toBeDefined();
        },
        { timeout: 1000, interval: 5 },
      );
    },
  );
});

function findElement<P>(
  node: unknown,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<P> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement<P>(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object' || !('props' in node) || !('type' in node))
    return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (predicate(element)) return element as ReactElement<P>;
  return findElement<P>(element.props.children, predicate);
}

function builderProps() {
  const compose = renderPage();
  const builder = findElement<ComponentProps<typeof WorkflowBuilder>>(
    compose.builder,
    (element) => element.type === WorkflowBuilder,
  );
  if (!builder) throw new Error('Expected the manual builder');
  return builder.props;
}

function planProps() {
  renderPage();
  const plan = findElement<ComponentProps<typeof WorkflowPlanReview>>(
    lastPage,
    (element) => element.type === WorkflowPlanReview,
  );
  if (!plan) throw new Error('Expected a workflow review');
  return plan.props;
}

function draftPickerProps() {
  const compose = renderPage();
  const picker = findElement<ComponentProps<typeof SavedWorkflowDraftPicker>>(
    compose.loadDraftAction,
    (element) => element.type === SavedWorkflowDraftPicker,
  );
  if (!picker) throw new Error('Expected the saved draft picker');
  return picker.props;
}

function reviewedVersionId() {
  return parseWorkflowArtifactYaml(planProps().yaml).workflowVersionId;
}

function checkProps() {
  renderPage();
  const checks = findElement<ComponentProps<typeof WorkflowChecks>>(
    lastPage,
    (element) => element.type === WorkflowChecks,
  );
  if (!checks) throw new Error('Expected workflow checks');
  return checks.props;
}

function pressButton(label: string) {
  const compose = renderPage();
  const find = (element: ReactElement<Record<string, unknown>>) =>
    element.type === 'button' && element.props.children === label;
  const button =
    findElement<{ onClick: () => void; disabled?: boolean }>(compose.builder, find) ??
    findElement<{ onClick: () => void; disabled?: boolean }>(lastPage, find);
  if (!button) throw new Error(`Expected button '${label}'`);
  expect(button.props.disabled).not.toBe(true);
  act(() => {
    button.props.onClick();
  });
}

function draftForDocument(document: BuilderDocument, workflowVersionId = 'manual@2') {
  return {
    ...draft,
    workflowVersionId,
    executable: document.executable,
    executionRequirements: { ...draft.executionRequirements, workflowVersionId },
  };
}

function reviewForDraft(value: ReturnType<typeof draftForDocument>) {
  return { ...review, workflowVersionId: value.workflowVersionId, artifact: value };
}

function builderApi(
  options: {
    saved?: { name: string; document: BuilderDocument };
    catalog?: ReturnType<typeof draftForDocument>;
    proposal?: ReturnType<typeof draftForDocument>;
    sourceResponse?: Promise<Response>;
  } = {},
) {
  let saved = options.saved;
  let revision = saved ? 3 : 0;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(requestUrl(input));
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (path.includes('/draft-requests/')) {
      return Response.json({
        status: 'completed',
        result: {
          httpStatus: 200,
          body: {
            status: 'validated',
            annotations: [],
            originalRequest: 'Finish order',
            clarifiedRequest: 'Finish order',
            projectionFingerprint: 'b'.repeat(64),
            draft: body.revisionContext ? (options.proposal ?? draft) : draft,
          },
        },
      });
    }
    if (path === '/v1/planner-capabilities')
      return Response.json({ fingerprint: 'b'.repeat(64), capabilities: [] });
    if (path === '/v1/workflow-editor-drafts') return Response.json({ drafts: [] });
    if (path.startsWith('/v1/workflow-editor-drafts/')) {
      const workflowId = decodeURIComponent(path.split('/')[3]!);
      if (path.endsWith('/validation')) {
        const value = draftForDocument(body.document);
        return Response.json({ workflowId, draft: value, review: reviewForDraft(value) });
      }
      if (path.endsWith('/versions')) {
        if (!saved) throw new Error('Expected a saved manual draft before creating its version');
        const value = draftForDocument(saved.document);
        return Response.json(
          { workflowId, name: saved.name, draft: value, review: reviewForDraft(value) },
          { status: 201 },
        );
      }
      if (init?.method === 'PUT') {
        saved = { name: body.name, document: body.document };
        revision += 1;
      }
      return saved
        ? Response.json({ workflowId, ...saved, revision, updatedAt: '2026-09-19T12:00:00Z' })
        : new Response(null, { status: 404 });
    }
    if (path === '/v1/workflow-reviews') return Response.json(reviewForDraft(body.draft));
    if (path === '/v1/workflow-edits')
      return options.sourceResponse ?? Response.json({ draft, review });
    if (path.includes('/workflow-catalog/catalog-flow/versions/'))
      return Response.json({ draft: options.catalog });
    if (path === '/v1/workflow-catalog/catalog-flow')
      return Response.json({
        workflowId: 'catalog-flow',
        name: 'Selected version',
        activeVersion: null,
      });
    if (path.includes('/workflow-sandbox-test-requests/'))
      return Response.json({
        requestId: 'checks',
        status: 'passed',
        startedAt: '2026-09-19T12:00:00Z',
        result: { status: 'passed', tests: [] },
      });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function generateAndOpenBuilder() {
  act(() => {
    renderPage().onNameChange('My workflow');
  });
  act(() => {
    renderPage().onDraft();
  });
  await waitFor(() => {
    expect(renderPage().graph).toBeDefined();
    expect(renderPage().isBusy).toBe(false);
  });
  act(() => {
    renderPage().onModeChange('builder');
  });
  await waitFor(() => expect(builderProps().disabled).toBe(false));
}

describe('shared AI and manual workflow editing', () => {
  it('collapses traces on entering Builder and lets the user reopen them', async () => {
    builderApi();
    await generateAndOpenBuilder();
    const traces = () =>
      findElement<ComponentProps<typeof ModelTraces>>(
        lastPage,
        (element) => element.type === ModelTraces,
      )!.props;
    expect(traces().collapsed).toBe(true);
    expect(lastPage.props.className).toContain('wf-builder');
    expect(lastPage.props.className).toContain('wf-traces-collapsed');
    expect(
      findElement(
        renderPage().loadDraftAction,
        (element) => element.props.children === 'Show model traces',
      ),
    ).toBeUndefined();
    act(() => traces().onExpand?.());
    expect(traces().collapsed).toBe(false);
    expect(lastPage.props.className).toContain('wf-with-traces');
    expect(lastPage.props.className).not.toContain('wf-traces-collapsed');
    act(() => traces().onCollapse?.());
    expect(traces().collapsed).toBe(true);
    act(() => {
      renderPage().onModeChange('ai');
    });
    act(() => {
      renderPage().onModeChange('builder');
    });
    expect(traces().collapsed).toBe(true);
    expect(traces().progress).toBeDefined();
  });

  it('closes the AI review and scrolls to the top when opening Builder', async () => {
    builderApi();
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    await generateAndOpenBuilder();
    act(() => {
      renderPage().onModeChange('ai');
    });
    act(() => planProps().onOpenBuilder?.());
    expect(renderPage().mode).toBe('builder');
    expect(scroll).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(
      findElement<{ hidden: boolean }>(
        lastPage,
        (element) => element.props['data-ai-review'] === true,
      )?.props.hidden,
    ).toBe(true);
    expect(checkProps()).toBeDefined();
  });

  it('shows Builder validation results beneath the canvas instead of on the AI graph', async () => {
    const fetch = builderApi();
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith('/validation')) {
        const value = draftForDocument(requestBody(init).document);
        return Response.json({
          draft: value,
          review: {
            ...reviewForDraft(value),
            approval: {
              enabled: false,
              diagnostics: [
                {
                  code: 'INVALID_MAPPING',
                  kind: 'error',
                  path: 'steps[done]',
                  message: 'Choose an input for this step.',
                },
              ],
            },
          },
        });
      }
      return fallback(input, init);
    });
    await generateAndOpenBuilder();
    pressButton('Validate');
    await waitFor(() =>
      expect(
        findElement(
          renderPage().builder,
          (element) => element.props.children === 'Choose an input for this step.',
        ),
      ).toBeDefined(),
    );
    expect(builderProps().issues).toBeUndefined();
    expect(renderPage().mode).toBe('builder');
    act(() => {
      renderPage().onModeChange('ai');
    });
    expect(
      (renderPage().graph as ReactElement<ComponentProps<typeof WorkflowDiagram>>).props.targets,
    ).toEqual({ nodeMarkers: {}, edgeMarkers: {}, diagramMarkers: [] });
    act(() => {
      renderPage().onModeChange('builder');
    });
    act(() =>
      builderProps().onChange(
        createBuilderDocument({
          irVersion: 3,
          startStepId: 'end',
          steps: [{ id: 'end', kind: 'terminal', state: 'completed' }],
        }),
      ),
    );
    expect(
      findElement(
        renderPage().builder,
        (element) => element.props.children === 'Choose an input for this step.',
      ),
    ).toBeUndefined();
    expect(
      findElement(
        renderPage().builder,
        (element) => element.props.children === 'Validate your changes to see updated results.',
      ),
    ).toBeDefined();
  });

  it('lists compilation errors below Builder without passing them into the canvas', async () => {
    const fetch = builderApi();
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith('/validation'))
        return Response.json(
          { diagnostics: [{ path: 'steps[done]', message: 'Connect this step to the workflow.' }] },
          { status: 422 },
        );
      return fallback(input, init);
    });
    await generateAndOpenBuilder();
    pressButton('Validate');
    await waitFor(() =>
      expect(
        findElement(
          renderPage().builder,
          (element) => element.props.children === 'Connect this step to the workflow.',
        ),
      ).toBeDefined(),
    );
    expect(builderProps().issues).toBeUndefined();
    expect(renderPage().mode).toBe('builder');
  });

  beforeEach(() => {
    vi.spyOn(window.location, 'hash', 'get').mockImplementation(() => hooks.hash);
    vi.spyOn(window.location, 'hash', 'set').mockImplementation((value) => {
      hooks.hash = value;
    });
  });

  it('shows Start over for actual builder edits, not for browsing the editor tabs', async () => {
    builderApi();
    expect(renderPage().onStartOver).toBeUndefined();
    act(() => {
      renderPage().onModeChange('builder');
    });
    expect(renderPage().onStartOver).toBeUndefined();
    await waitFor(() => expect(builderProps().disabled).toBe(false));
    const empty = builderProps().document;
    expect(renderPage().onStartOver).toBeUndefined();
    act(() => {
      renderPage().onModeChange('ai');
    });
    expect(renderPage().onStartOver).toBeUndefined();
    act(() => {
      renderPage().onModeChange('builder');
    });
    act(() => {
      builderProps().onChange({
        ...empty,
        notes: [{ id: 'note', text: 'Process an order', x: 0, y: 0 }],
      });
    });
    expect(renderPage().onStartOver).toBeTypeOf('function');
    act(() => {
      builderProps().onChange(empty);
    });
    expect(renderPage().onStartOver).toBeUndefined();
  });

  it('lets users return from Builder and generate from a prompt without saving a manual version', async () => {
    const fetch = builderApi();
    act(() => {
      renderPage().onModeChange('builder');
    });
    await waitFor(() => expect(builderProps().disabled).toBe(false));
    act(() => {
      renderPage().onModeChange('ai');
    });

    const compose = renderPage();
    expect(
      findElement(WorkflowCompose(compose), (element) => element.type === RequestPromptEditor),
    ).toBeDefined();
    expect(compose.showDraft).toBe(true);
    act(() => {
      compose.onNameChange('Process an order');
    });
    act(() => {
      renderPage().onEditorChange({
        ...renderPage().editor,
        text: 'Find the order, process its payment, and send a receipt.',
      });
    });
    act(() => {
      renderPage().onDraft();
    });
    await waitFor(() => {
      expect(renderPage().graph).toBeDefined();
      expect(renderPage().isBusy).toBe(false);
    });
    expect(renderPage().mode).toBe('ai');
    expect(
      fetch.mock.calls.some(
        ([url, init]) =>
          requestUrl(url).includes('/workflow-editor-drafts/') &&
          (init?.method === 'PUT' || init?.method === 'POST'),
      ),
    ).toBe(false);
    act(() => {
      renderPage().onModeChange('builder');
    });
    expect(builderProps().document.executable).toMatchObject({ startStepId: 'done' });
  });

  it('keeps the prompt available after generation and when editing an AI request after visiting Builder', async () => {
    builderApi();
    await generateAndOpenBuilder();
    const original = builderProps().document;
    act(() => {
      renderPage().onModeChange('ai');
    });
    expect(
      findElement(WorkflowCompose(renderPage()), (element) => element.type === RequestPromptEditor),
    ).toBeDefined();
    act(() => {
      renderPage().onEditorChange({
        ...renderPage().editor,
        text: 'Process payments and send receipts for completed orders.',
      });
    });
    expect(renderPage().showDraft).toBe(true);
    expect(
      findElement(WorkflowCompose(renderPage()), (element) => element.type === RequestPromptEditor),
    ).toBeDefined();
    expect(builderProps().document).toEqual(original);
  });

  it('imports an AI workflow and preserves manual behavior and notes when switching views', async () => {
    builderApi();
    await generateAndOpenBuilder();
    expect(builderProps().document.executable).toMatchObject({
      irVersion: 3,
      startStepId: 'done',
      steps: [{ id: 'done', kind: 'terminal' }],
    });
    const next = {
      ...builderProps().document,
      notes: [{ id: 'note-1', text: 'Wait for processing', x: 100, y: 20 }],
      executable: {
        irVersion: 3,
        startStepId: 'pause',
        steps: [
          { id: 'pause', kind: 'sleep', durationMs: 1_000, next: 'done' },
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      },
    };
    act(() => {
      builderProps().onChange(next);
    });
    act(() => {
      renderPage().onModeChange('ai');
    });
    act(() => {
      renderPage().onModeChange('builder');
    });
    expect(builderProps().document).toEqual(next);
    expect(checkProps().hasUnvalidatedChanges).toBe(true);
  });

  it('loads a selected saved draft with its author token and saved notes', async () => {
    const document = {
      ...createBuilderDocument(),
      notes: [{ id: 'note', text: 'Saved incomplete work', x: 1, y: 2 }],
    };
    const fetch = builderApi({ saved: { name: 'Saved workflow', document } });
    hooks.hash = '#/workflows?editorWorkflowId=saved-flow';
    renderPage();
    await waitFor(() => expect(renderPage().workflowName).toBe('Saved workflow'));
    expect(builderProps().document).toEqual(document);
    const load = fetch.mock.calls.find(
      ([url, init]) =>
        requestUrl(url).includes('/workflow-editor-drafts/saved-flow?') && !init?.method,
    );
    expect(load?.[1]?.headers).toMatchObject({ authorization: 'Bearer test-only-admin' });
  });

  it('offers multiple saved drafts, refreshes the choices, and loads or reloads the selected workflow', async () => {
    const fetch = builderApi();
    const fallback = fetch.getMockImplementation()!;
    const drafts = [
      { workflowId: 'first', name: 'First workflow', document: createBuilderDocument() },
      {
        workflowId: 'second',
        name: 'Second workflow',
        document: {
          ...createBuilderDocument(),
          notes: [{ id: 'note', text: 'Second workflow notes', x: 20, y: 30 }],
        },
      },
    ];
    fetch.mockImplementation(async (input, init) => {
      const path = new URL(requestUrl(input)).pathname;
      if (path === '/v1/workflow-editor-drafts') return Response.json({ drafts });
      const saved = drafts.find(
        ({ workflowId }) => path === `/v1/workflow-editor-drafts/${workflowId}`,
      );
      if (saved) return Response.json({ ...saved, revision: 3, updatedAt: '2026-09-19T12:00:00Z' });
      return fallback(input, init);
    });
    renderPage();
    await waitFor(() => expect(draftPickerProps().drafts).toHaveLength(2));
    act(() => draftPickerProps().onLoad('first'));
    await waitFor(() => expect(renderPage().workflowName).toBe('First workflow'));
    expect(builderProps().document).toEqual(drafts[0]!.document);
    act(() => draftPickerProps().onLoad('second'));
    await waitFor(() => expect(renderPage().workflowName).toBe('Second workflow'));
    expect(builderProps().document).toEqual(drafts[1]!.document);
    act(() => builderProps().onChange({ ...builderProps().document, notes: [] }));
    expect(draftPickerProps().hasUnsavedChanges).toBe(true);
    act(() => draftPickerProps().onLoad('second'));
    await waitFor(() => expect(builderProps().document).toEqual(drafts[1]!.document));
    drafts.push({ workflowId: 'third', name: 'Third workflow', document: createBuilderDocument() });
    act(() => draftPickerProps().onRefresh());
    await waitFor(() => expect(draftPickerProps().drafts).toHaveLength(3));
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('keeps an explicitly opened catalog version when an older saved draft exists', async () => {
    const selected = createBuilderDocument({
      irVersion: 3,
      startStepId: 'selected',
      steps: [{ id: 'selected', kind: 'terminal', state: 'completed' }],
    });
    const stale = createBuilderDocument({
      irVersion: 3,
      startStepId: 'stale',
      steps: [{ id: 'stale', kind: 'terminal', state: 'manual_review' }],
    });
    const fetch = builderApi({
      catalog: draftForDocument(selected, 'catalog@2'),
      saved: { name: 'Old working draft', document: stale },
    });
    hooks.hash =
      '#/workflows?catalogWorkflowId=catalog-flow&catalogWorkflowVersionId=catalog%402&action=edit';
    renderPage();
    await waitFor(() => {
      expect(renderPage().mode).toBe('builder');
      expect(builderProps().disabled).toBe(false);
    });
    expect(
      fetch.mock.calls.some(([url]) =>
        requestUrl(url).includes('/workflow-editor-drafts/catalog-flow?'),
      ),
    ).toBe(true);
    expect(builderProps().document.executable).toEqual(selected.executable);
    expect(renderPage().workflowName).toBe('Selected version');
    expect(reviewedVersionId()).toBe('catalog@2');
  });

  it('discards a late source-validation result after changing environment', async () => {
    const late = Promise.withResolvers<Response>();
    const fetch = builderApi({ sourceResponse: late.promise });
    await generateAndOpenBuilder();
    act(() => {
      planProps().onYamlChange(planProps().yaml.replace('completed', 'manual_review'));
    });
    act(() => {
      planProps().onValidateSource();
    });
    await waitFor(() =>
      expect(fetch.mock.calls.some(([url]) => requestUrl(url).endsWith('/workflow-edits'))).toBe(
        true,
      ),
    );
    hooks.environmentId = 'production';
    renderPage();
    late.resolve(Response.json({ draft, review }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderPage();
    expect(findElement(lastPage, (element) => element.type === WorkflowPlanReview)).toBeUndefined();
    expect(renderPage().workflowName).toBe('');
    act(() => {
      renderPage().onModeChange('builder');
    });
    await waitFor(() => expect(builderProps().disabled).toBe(false));
    expect(builderProps().document.executable).toMatchObject({ startStepId: 'finish' });
  });

  it.each([false, true])(
    'sends the validated unsaved manual definition to AI and accepts its proposal (normalized=%s)',
    async (normalized) => {
      const proposed = createBuilderDocument({
        irVersion: 3,
        startStepId: 'proposed',
        steps: [{ id: 'proposed', kind: 'terminal', state: 'completed' }],
      });
      const fetch = builderApi({ proposal: draftForDocument(proposed, 'proposed@3') });
      const fallback = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (input, init) => {
        if (normalized && requestUrl(input).endsWith('/validation')) {
          const body = requestBody(init);
          const value = draftForDocument({
            ...body.document,
            executable: {
              ...body.document.executable,
              inputSchema: { required: { atlasWorkflowRunId: { type: 'string' } } },
            },
          });
          return Response.json({
            workflowId: 'manual',
            draft: value,
            review: reviewForDraft(value),
          });
        }
        return fallback(input, init);
      });
      await generateAndOpenBuilder();
      const manuallyEdited = {
        ...builderProps().document,
        executable: {
          irVersion: 3,
          startStepId: 'pause',
          steps: [
            { id: 'pause', kind: 'sleep', durationMs: 500, next: 'done' },
            { id: 'done', kind: 'terminal', state: 'completed' },
          ],
        },
      };
      act(() => {
        builderProps().onChange(manuallyEdited);
      });
      pressButton('Validate');
      await waitFor(() => {
        expect(reviewedVersionId()).toBe('manual@2');
        expect(builderProps().disabled).toBe(false);
      });
      act(() => {
        planProps().onFollowUpChange('Change the finish step');
      });
      act(() => {
        planProps().onRevise();
      });
      await waitFor(() => {
        renderPage();
        expect(
          findElement(lastPage, (element) => element.props['aria-label'] === 'Proposed AI changes'),
        ).toBeDefined();
      });
      renderPage();
      expect(builderProps().document.executable).toEqual(manuallyEdited.executable);
      const revisionRequest = fetch.mock.calls.find(
        ([url, init]) =>
          requestUrl(url).includes('/draft-requests/') &&
          typeof init?.body === 'string' &&
          init.body.includes('revisionContext'),
      );
      const revisionBody = revisionRequest?.[1]?.body;
      if (typeof revisionBody !== 'string')
        throw new Error('Expected the AI revision request body');
      expect(JSON.parse(revisionBody).revisionContext.draft.executable).toMatchObject(
        manuallyEdited.executable,
      );
      pressButton('Apply changes');
      await waitFor(() => expect(builderProps().document.executable).toEqual(proposed.executable));
    },
  );

  it('validates an unnamed unsaved canvas without saving it, and saves only on Save draft', async () => {
    const fetch = builderApi();
    act(() => {
      renderPage().onModeChange('builder');
    });
    await waitFor(() => expect(builderProps().disabled).toBe(false));
    const original = builderProps().document;
    const next = { ...original, notes: [{ id: 'note', text: 'Unfinished work', x: 0, y: 0 }] };
    act(() => builderProps().onChange(next));
    const requestStart = fetch.mock.calls.length;
    pressButton('Validate');
    await waitFor(() => expect(reviewedVersionId()).toBe('manual@2'));
    expect(builderProps().document).toEqual(next);
    expect(renderPage().workflowName).toBe('');
    expect(checkProps().hasUnvalidatedChanges).toBe(false);
    const requests = fetch.mock.calls.slice(requestStart).filter(([, init]) => init?.method);
    expect(requests).toHaveLength(1);
    expect(requestUrl(requests[0]![0])).toMatch(/\/validation$/);
    expect(requestBody(requests[0]![1])).toMatchObject({ document: next });
    expect(
      findElement(
        renderPage().builder,
        (element) => element.props.children === 'Working draft has unsaved changes',
      ),
    ).toBeDefined();
    expect(
      findElement(
        renderPage().builder,
        (element) => element.props.children === 'Save version and validate',
      ),
    ).toBeUndefined();

    act(() => {
      renderPage().onNameChange('My manual workflow');
    });
    pressButton('Save draft');
    await waitFor(() =>
      expect(
        findElement(
          renderPage().builder,
          (element) => element.props.children === 'Working draft saved',
        ),
      ).toBeDefined(),
    );
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    expect(
      fetch.mock.calls.filter(([url]) => requestUrl(url).endsWith('/validation')),
    ).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => requestUrl(url).endsWith('/versions'))).toBe(false);
  });

  it('keeps the saved draft and canvas unchanged when validating a normalized definition', async () => {
    const saved = createBuilderDocument();
    const fetch = builderApi({ saved: { name: 'Saved workflow', document: saved } });
    const fallback = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (requestUrl(input).endsWith('/validation')) {
        const body = requestBody(init);
        const value = draftForDocument({
          ...body.document,
          executable: {
            ...body.document.executable,
            inputSchema: { required: { atlasWorkflowRunId: { type: 'string' } } },
          },
        });
        return Response.json({
          workflowId: 'saved-flow',
          draft: value,
          review: reviewForDraft(value),
        });
      }
      return fallback(input, init);
    });
    hooks.hash = '#/workflows?editorWorkflowId=saved-flow';
    renderPage();
    await waitFor(() => expect(renderPage().workflowName).toBe('Saved workflow'));
    const next = createBuilderDocument({
      irVersion: 3,
      startStepId: 'wait',
      steps: [
        { id: 'wait', kind: 'sleep', durationMs: 500, next: 'finish' },
        { id: 'finish', kind: 'terminal', state: 'completed' },
      ],
    });
    act(() => builderProps().onChange(next));
    pressButton('Validate');
    await waitFor(() => expect(reviewedVersionId()).toBe('manual@2'));
    expect(builderProps().document).toEqual(next);
    expect(checkProps().hasUnvalidatedChanges).toBe(false);
    act(() => draftPickerProps().onLoad('saved-flow'));
    await waitFor(() => expect(builderProps().document).toEqual(saved));
    expect(checkProps().hasUnvalidatedChanges).toBe(true);
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it.each([false, true])(
    'saves an unsaved validated version under its workflow only when approving (source edit=%s)',
    async (editSource) => {
      const fetch = builderApi();
      const fallback = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (input, init) => {
        const url = requestUrl(input);
        if (url.endsWith('/workflow-reviews')) {
          const body = requestBody(init);
          return Response.json({
            ...reviewForDraft(body.draft),
            approval: { enabled: true, diagnostics: [] },
          });
        }
        if (url.endsWith('/validation') || url.endsWith('/workflow-edits')) {
          const body = requestBody(init);
          const value = draftForDocument(
            body.document ?? createBuilderDocument(body.executable),
            url.endsWith('/workflow-edits') ? 'source@3' : 'manual@2',
          );
          return Response.json({
            workflowId: 'manual-flow',
            draft: value,
            review: {
              ...reviewForDraft(value),
              approval: { enabled: true, diagnostics: [] },
            },
          });
        }
        return fallback(input, init);
      });
      hooks.hash = '#/workflows?editorWorkflowId=manual-flow';
      renderPage();
      await waitFor(() => expect(builderProps().disabled).toBe(false));
      act(() => {
        renderPage().onNameChange('My manual workflow');
      });
      pressButton('Validate');
      await waitFor(() => expect(reviewedVersionId()).toBe('manual@2'));
      if (editSource) {
        act(() => planProps().onYamlChange(planProps().yaml.replace('completed', 'manual_review')));
        act(() => planProps().onValidateSource());
      }
      await waitFor(() => expect(reviewedVersionId()).toBe(editSource ? 'source@3' : 'manual@2'));
      expect(checkProps().hasUnvalidatedChanges).toBe(false);
      act(() => checkProps().onRunChecks());
      await waitFor(() => expect(checkProps().approval.enabled).toBe(true));
      expect(
        fetch.mock.calls.some(([url]) => requestUrl(url).endsWith('/workflow-catalog/versions')),
      ).toBe(false);
      act(() => checkProps().onApprove());
      await waitFor(() => expect(renderPage().isBusy).toBe(false));
      const saving = fetch.mock.calls.findIndex(([url]) =>
        requestUrl(url).endsWith('/workflow-catalog/versions'),
      );
      const approval = fetch.mock.calls.findIndex(([url]) =>
        requestUrl(url).endsWith('/workflow-approvals'),
      );
      expect(saving).toBeGreaterThanOrEqual(0);
      expect(approval).toBeGreaterThan(saving);
      expect(requestBody(fetch.mock.calls[saving]?.[1])).toMatchObject({
        workflowId: 'manual-flow',
        name: 'My manual workflow',
        draft: { workflowVersionId: editSource ? 'source@3' : 'manual@2' },
      });
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            requestUrl(url).includes('/workflow-editor-drafts/') && init?.method === 'PUT',
        ),
      ).toBe(false);
    },
  );

  it('keeps passed checks when only positions, labels and notes change', async () => {
    builderApi();
    await generateAndOpenBuilder();
    act(() => {
      checkProps().onRunChecks();
    });
    await waitFor(() => expect(checkProps().status).toBe('passed'));
    act(() => {
      builderProps().onChange({
        ...builderProps().document,
        layout: { done: { x: 30, y: 90 } },
        labels: { done: 'Done processing' },
        notes: [{ id: 'note', text: 'This is the result', x: 40, y: 80 }],
      });
    });
    expect(checkProps().status).toBe('passed');
    expect(checkProps().hasUnvalidatedChanges).toBe(false);
  });
});
