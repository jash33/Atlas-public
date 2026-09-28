import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { RunLauncherView, type ApiRunReadiness } from './RunLauncher.js';
import { RunQueue, RunsPage, RunTimeline } from './RunsPage.js';
import type { WorkflowRunDetail } from './runs.js';
import { SessionProvider } from '../shell/session.js';

afterEach(() => vi.unstubAllGlobals());

const readyWorkflow: ApiRunReadiness = {
  workflowId: 'invoice-drift-demo',
  name: 'Invoice drift demo workflow',
  ready: true,
  workflowVersionId: 'invoice-drift-demo@1',
  artifactId: 'a'.repeat(64),
  targetWorkerId: 'atlas-production/atlas-production',
  runCommandPublicKey: 'public-key',
  inputSchema: { required: { paymentId: { type: 'string' } } },
  blockers: [],
};

function render(readiness: ApiRunReadiness) {
  return renderToStaticMarkup(
    createElement(RunLauncherView, {
      canStart: true,
      message: undefined,
      onPaymentIdChange: vi.fn<(value: string) => void>(),
      onScenarioSelect: vi.fn<(value: string) => void>(),
      onStart: vi.fn<() => void>(),
      paymentId: 'payment_demo_001',
      readiness,
      submitting: false,
    }),
  );
}

describe('Runs launcher', () => {
  it('does not request the sample launcher on the Burger Town Runs route', () => {
    vi.stubGlobal('window', {
      location: {
        hash: '#/runs',
        href: 'http://localhost:5173/?demoProfile=burger-town#/runs',
      },
      localStorage: {
        getItem: () => null,
        setItem: vi.fn<(key: string, value: string) => void>(),
      },
      history: { replaceState: vi.fn<() => void>() },
    });

    const html = renderToStaticMarkup(
      createElement(SessionProvider, null, createElement(RunsPage)),
    );

    expect(html).toContain('Workflow runs');
    expect(html).not.toContain('Checking whether the active workflow can start');
  });

  it('is mounted on the Runs route independently of run history', () => {
    vi.stubGlobal('window', {
      location: { hash: '#/runs', href: 'http://localhost:5173/#/runs' },
      localStorage: {
        getItem: () => null,
        setItem: vi.fn<(key: string, value: string) => void>(),
      },
      history: { replaceState: vi.fn<() => void>() },
    });

    const html = renderToStaticMarkup(
      createElement(SessionProvider, null, createElement(RunsPage)),
    );

    expect(html).toContain('Workflow runs');
    expect(html).toContain('Checking whether the active workflow can start');
  });

  it('renders every documented control when reset readiness reports the workflow runnable', () => {
    const html = render(readyWorkflow);

    expect(html).toContain('invoice-drift-demo@1');
    expect(html).toContain('payment_demo_001');
    expect(html).toContain('Use retry rehearsal input');
    expect(html).toContain('Use repair rehearsal input');
    expect(html).toContain('Start on Temporal');
  });

  it('does not offer start controls when public readiness blocks the workflow', () => {
    const html = render({
      ...readyWorkflow,
      ready: false,
      blockers: ['No active workflow is available for new runs.'],
    });

    expect(html).toContain('No active workflow is available for new runs.');
    expect(html).not.toContain('Start on Temporal');
    expect(html).not.toContain('Use retry rehearsal input');
  });

  it('disables every input while a start request is in flight', () => {
    const html = renderToStaticMarkup(
      createElement(RunLauncherView, {
        canStart: true,
        message: { tone: 'status', text: 'Encrypting input for the customer worker…' },
        onPaymentIdChange: vi.fn<(value: string) => void>(),
        onScenarioSelect: vi.fn<(value: string) => void>(),
        onStart: vi.fn<() => void>(),
        paymentId: 'payment_demo_001',
        readiness: readyWorkflow,
        submitting: true,
      }),
    );

    expect(html.match(/disabled=""/g)).toHaveLength(5);
    expect(html).toContain('Starting on Temporal…');
  });
});

describe('selected run', () => {
  it('omits internal trace, proof, and effect sections', () => {
    const run: WorkflowRunDetail = {
      runId: 'run-completed',
      workflowVersionId: 'workflow-version',
      intakeReference: 'intake-reference',
      state: 'completed',
      startedAt: '2026-09-07T19:33:05.000Z',
      updatedAt: '2026-09-07T19:33:06.000Z',
      trigger: { type: 'manual' },
      lifecycle: {
        workflowName: 'Customer workflow',
        startedAt: '2026-09-07T19:33:05.000Z',
        endedAt: '2026-09-07T19:33:06.000Z',
        durationMs: 1_000,
        retryCount: 0,
        outcome: 'succeeded',
        inProgress: false,
      },
      temporalWorkflowId: 'temporal-workflow',
      artifactId: 'artifact',
      disposition: 'active',
      failure: null,
      steps: [
        {
          stepId: 'visible-step',
          capabilityVersionId: 'visible-capability',
          irreversible: true,
          idempotency: { protected: true, evidence: 'Visible step evidence' },
          attempts: [
            {
              attempt: 1,
              durationMs: 25,
              status: 'succeeded',
              redactedInput: {},
              recordedAt: '2026-09-07T19:33:05.000Z',
            },
          ],
        },
      ],
      saga: [{ stepId: 'internal-saga', compensatesStepId: 'visible-step', state: 'armed' }],
      controls: {
        retryStep: {
          enabled: false,
          stepId: null,
          repairedCapabilityVersionId: null,
          safetyBasis: 'stable-idempotency-key',
          priorStepsNotRerun: [],
          committedIrreversibleEffects: [],
        },
        resumeRun: {
          enabled: false,
          priorStepsNotRerun: [],
          committedIrreversibleEffects: [],
        },
        abandonRun: {
          enabled: false,
          priorStepsNotRerun: [],
          committedIrreversibleEffects: [],
        },
      },
      repairHistory: [],
      traceHistory: [{ type: 'workflow.started', recordedAt: '2026-09-07T19:33:05.000Z' }],
      effects: [
        {
          stepId: 'internal-effect',
          capabilityVersionId: 'internal-pin',
          status: 'confirmed',
          evidence: 'Internal provider proof',
        },
      ],
      privacy: { payloadsRedactedAt: 'customer-worker', plaintextStoredByAtlas: false },
      idempotencyEvidence: {
        duplicateSubmissions: 0,
        durableRunIdentities: 1,
        effectExecutions: [{ stepId: 'internal-effect', successfulAttempts: 1 }],
      },
    };

    const html = renderToStaticMarkup(
      createElement(SessionProvider, {
        customerUser: { actorId: 'customer-admin', organizationId: 'customer', role: 'admin' },
        // oxlint-disable-next-line react/no-children-prop
        children: createElement(RunTimeline, { run, reload: vi.fn<() => void>() }),
      }),
    );

    expect(html).toContain('Execution timeline');
    expect(html).toContain('visible-step');
    expect(html).toContain('run-completed');
    expect(html).not.toContain('intake-reference');
    expect(html).not.toContain('Atlas reuses recorded execution history');
    for (const internalContent of [
      'Worker-redacted structured logs',
      'Trace history',
      'Payloads were redacted inside the customer worker',
      'Internal and provider outcomes',
      'Confirmed effects',
      'Duplicate proof',
      'Saga state',
      'Capability pins',
      '<h3>Irreversible effects</h3>',
      'Internal provider proof',
      'internal-saga',
    ]) {
      expect(html).not.toContain(internalContent);
    }
  });
});

describe('run queue', () => {
  it('keeps completed runs compact and avoids duplicate status and identifiers', () => {
    const runId = `atlas:run:atlas.workflow-run-id:${'5e2c246e'.padEnd(64, '7')}`;
    const html = renderToStaticMarkup(
      createElement(RunQueue, {
        runs: [
          {
            runId,
            workflowVersionId: 'workflow-20260907-222502-659',
            intakeReference: `atlas.private-intake-key:${'d'.repeat(64)}`,
            state: 'completed',
            startedAt: '2026-09-07T19:33:05.000Z',
            updatedAt: '2026-09-07T19:33:06.000Z',
            trigger: { type: 'manual' },
            lifecycle: {
              workflowName: 'demo',
              startedAt: '2026-09-07T19:33:05.000Z',
              endedAt: '2026-09-07T19:33:06.000Z',
              durationMs: 1_700,
              retryCount: 0,
              outcome: 'succeeded',
              inProgress: false,
            },
          },
        ],
        selectedRunId: runId,
        onSelect: vi.fn<(runId: string) => void>(),
      }),
    );

    expect(html).toContain('demo');
    expect(html).toContain('Succeeded');
    expect(html).toContain('5e2c246e…7777');
    expect(html).toContain(`title="${runId}"`);
    expect(html).not.toContain('>Completed<');
    expect(html).not.toContain('workflow-20260907-222502-659');
    expect(html).not.toContain('atlas.private-intake-key');
    expect(html).not.toContain('1.7s');
    expect(html.match(/class="run-status /g)).toHaveLength(1);
  });
});

it('does not mount the sample launcher for customer sessions', () => {
  vi.stubGlobal('window', {
    location: { hash: '#/runs', href: 'https://atlas.example/#/runs' },
    localStorage: { getItem: () => null, setItem: vi.fn<(key: string, value: string) => void>() },
  });
  const html = renderToStaticMarkup(
    createElement(SessionProvider, {
      customerUser: { actorId: 'customer-admin', organizationId: 'customer', role: 'admin' },
      // oxlint-disable-next-line react/no-children-prop
      children: createElement(RunsPage),
    }),
  );
  expect(html).toContain('Workflow runs');
  expect(html).not.toContain('Checking whether the active workflow can start');
});
