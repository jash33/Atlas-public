// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vite-plus/test';

const scope = vi.hoisted(() => ({ environmentId: 'development' }));
vi.mock('../shell/session.js', () => ({
  useConsoleSession: () => ({
    organizationId: 'org',
    environmentId: scope.environmentId,
    role: 'admin',
    customerUser: { actorId: 'author' },
    setEnvironmentId: vi.fn<(environmentId: string) => void>(),
  }),
}));
vi.mock('../shell/router.js', () => ({
  useLocationHash: () => '',
  parseHashParameter: () => undefined,
}));

import { useWorkflowAuthoringSession } from './workflow-authoring-session.js';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  scope.environmentId = 'development';
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

it('updates the actual preview immediately, rejects stale checks, and resets on scope change', async () => {
  const draft = {
    workflowVersionId: 'flow@1',
    irHash: 'a'.repeat(64),
    executionRequirements: {
      organizationId: 'org',
      workflowVersionId: 'flow@1',
      irHash: 'a'.repeat(64),
      requiredCapabilityVersionIds: [],
    },
    executable: { irVersion: 1, steps: [{ id: 'done', kind: 'terminal', state: 'completed' }] },
  };
  const review = {
    workflowVersionId: 'flow@1',
    artifact: draft,
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
    approval: { enabled: true, diagnostics: [] },
  };
  const pendingChecks = Promise.withResolvers<Response>();
  let checkSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, options) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes('/draft-requests/'))
        return Response.json({
          status: 'completed',
          result: {
            httpStatus: 200,
            body: {
              status: 'validated',
              annotations: [],
              originalRequest: 'Finish',
              clarifiedRequest: 'Finish',
              projectionFingerprint: 'b'.repeat(64),
              draft,
            },
          },
        });
      if (url.endsWith('/workflow-reviews')) return Response.json(review);
      if (url.includes('/workflow-sandbox-test-requests/')) {
        checkSignal = options?.signal;
        return pendingChecks.promise;
      }
      return Response.json({});
    }),
  );
  const container = document.createElement('div');
  const root = createRoot(container);
  let session!: ReturnType<typeof useWorkflowAuthoringSession>;
  function Probe() {
    session = useWorkflowAuthoringSession();
    return createElement('pre', null, JSON.stringify(session.state.diagramPreview));
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    act(() => session.commands.renameWorkflow('Example'));
    await act(async () => session.commands.createDraft());
    expect(container.textContent).toContain('"status":"server"');
    act(() => {
      void session.commands.runSandboxTests();
    });
    expect(session.state.sandbox.status).toBe('running');
    await act(async () =>
      session.commands.editSource(session.state.artifactYaml.replace('completed', 'manual_review')),
    );
    expect(container.textContent).toContain('"status":"unsaved-preview"');
    expect(container.textContent).toContain('manual_review');
    expect(checkSignal?.aborted).toBe(true);
    await act(async () =>
      pendingChecks.resolve(
        Response.json({ status: 'passed', result: { status: 'passed', tests: [] } }),
      ),
    );
    expect(session.state.sandbox.status).toBe('not-run');
    scope.environmentId = 'production';
    await act(async () => root.render(createElement(Probe)));
    expect(session.state.workflowName).toBe('');
    expect(session.state.review).toBeUndefined();
    expect(session.state.busy).toBe(false);
    expect(session.state.error).toBeUndefined();
    expect(container.textContent).toBe('{"status":"hidden"}');
  } finally {
    act(() => root.unmount());
  }
});
