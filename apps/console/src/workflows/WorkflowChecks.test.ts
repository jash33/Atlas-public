// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';

import { WorkflowChecks } from './WorkflowChecks.js';
import { workflowSandboxTestKinds } from '@atlas/demo-estate';
import type { SandboxCheckOutcome } from './workflow.js';

const checksCss = [
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './workflows-sandbox.css'), 'utf8'),
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../shell.css'), 'utf8'),
].join('\n');

const leaks = [
  'irHash',
  'suiteFingerprint',
  'workerVersion',
  'runtimeVersion',
  'capabilityVersionId',
  'documentHash',
  'secretAlias',
  'Approve exact artifact',
  'Server authorization remains authoritative.',
] as const;

const identities = [
  {
    capabilityVersionId: 'payment.get@v1',
    serviceId: 'payments',
    operationId: 'getPayment',
  },
];

const passedTests: SandboxCheckOutcome[] = [
  {
    status: 'passed',
    stepId: 'load-payment',
    capabilityVersionId: 'payment.get@v1',
    executionMethods: ['static-validation', 'local-test-service'],
    expectation: 'Returns the payment record',
  },
];

const failedTests: SandboxCheckOutcome[] = [
  {
    status: 'failed',
    stepId: 'create-stripe-intent',
    capabilityVersionId: 'stripe.payment-intents@v1',
    executionMethods: ['remote-sandbox'],
    expectation: 'Creates a payment intent',
    detail: 'Stripe rejected the amount.',
  },
  {
    status: 'passed',
    stepId: 'load-payment',
    capabilityVersionId: 'payment.get@v1',
    executionMethods: ['static-validation'],
    expectation: 'Returns the payment record',
  },
];

function renderChecks(overrides: Partial<Parameters<typeof WorkflowChecks>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(WorkflowChecks, {
      approval: { enabled: false, reason: 'Run the checks before approving this version.' },
      hasUnvalidatedChanges: false,
      identities,
      onApprove: vi.fn<() => void>(),
      onCancelChecks: vi.fn<() => void>(),
      onRunChecks: vi.fn<() => void>(),
      role: 'admin',
      status: 'not-run',
      ...overrides,
    }),
  );
}

function expectNoLeaks(html: string) {
  for (const leak of leaks) {
    expect(html).not.toContain(leak);
  }
}

describe('WorkflowChecks', () => {
  it('shows actual check activity and completion counts instead of a generic waiting message', () => {
    const html = renderChecks({
      status: 'running',
      progress: {
        phase: 'running',
        completed: 8,
        total: 16,
        currentTest: { kind: 'duplicate-event', stepId: 'create_fulfillment' },
      },
    });
    expect(html).toContain('Checking duplicate handling for Create fulfillment.');
    expect(html).toContain('8 of 16 checks completed.');
    expect(html).not.toContain('This may take a little while.');
  });

  it.each(workflowSandboxTestKinds)(
    'describes the %s check without exposing a raw check kind',
    (kind) => {
      const html = renderChecks({
        status: 'running',
        progress: {
          phase: 'running',
          completed: 0,
          total: 9,
          currentTest: { kind, stepId: 'create_fulfillment' },
        },
      });
      expect(html).toContain('Checking');
      expect(html).toContain('for Create fulfillment.');
      expect(html).not.toContain('undefined');
      expect(html).toContain('0 of 9 checks completed.');
    },
  );

  it('distinguishes preparation and finalization and hides completed progress', () => {
    const preparing = renderChecks({
      status: 'running',
      progress: { phase: 'preparing', completed: 0, total: 0 },
    });
    const finalizing = renderChecks({
      status: 'running',
      progress: { phase: 'finalizing', completed: 9, total: 9 },
    });
    const cancelled = renderChecks({
      status: 'cancelled',
      progress: { phase: 'running', completed: 2, total: 9 },
    });
    expect(preparing).toContain('Preparing workflow checks.');
    expect(preparing).not.toContain('0 of 0');
    expect(finalizing).toContain('Finishing workflow checks.');
    expect(finalizing).toContain('9 of 9 checks completed.');
    expect(cancelled).not.toContain('2 of 9');
    expect(cancelled).toContain('Checks were cancelled.');
  });

  it('shows a short English success without a test inventory', () => {
    const html = renderChecks({
      approval: { enabled: true, reason: null },
      result: { status: 'passed', tests: passedTests },
      status: 'passed',
    });

    expect(html).toContain('This version is ready to approve.');
    expect(html).toContain('Approve this version');
    expect(html).not.toContain('Returns the payment record');
    expect(html).not.toContain('Static schema validation');
    expect(html).not.toContain('Local test service');
    expect(html).not.toContain('<ol');
    expectNoLeaks(html);
  });

  it('names the first failed step and what went wrong', () => {
    const html = renderChecks({
      approval: {
        enabled: false,
        reason: 'Fix the failed check and run checks again before approving this version.',
      },
      result: { status: 'failed', tests: failedTests },
      status: 'failed',
    });

    expect(html).toContain('Create stripe intent failed because Stripe rejected the amount.');
    expect(html).not.toContain('Returns the payment record');
    expect(html).not.toContain('Creates a payment intent');
    expect(html).not.toContain('Checked by');
    expect(html).not.toContain('<ol');
    expectNoLeaks(html);
  });

  it('names the API action when the failed step is unknown', () => {
    const html = renderChecks({
      approval: {
        enabled: false,
        reason: 'Fix the failed check and run checks again before approving this version.',
      },
      result: {
        status: 'failed',
        tests: [
          {
            status: 'failed',
            capabilityVersionId: 'payment.get@v1',
            detail: 'The response did not match the expected shape.',
          },
        ],
      },
      status: 'failed',
    });

    expect(html).toContain(
      'The getPayment API action failed because the response did not match the expected shape.',
    );
    expectNoLeaks(html);
  });

  it('distinguishes loading, running, failed, and passed check states', () => {
    const loading = renderChecks({ loading: true });
    const running = renderChecks({ status: 'running' });
    const failed = renderChecks({
      result: { status: 'failed', tests: failedTests },
      status: 'failed',
    });
    const passed = renderChecks({
      approval: { enabled: true, reason: null },
      result: { status: 'passed', tests: passedTests },
      status: 'passed',
    });

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Loading checks');
    expect(loading).toMatch(/<button[^>]*disabled=""[^>]*>Run checks<\/button>/);
    expect(running).toContain('Cancel checks');
    expect(running).toContain('Running checks');
    expect(running).toContain('role="status"');
    expect(running).toContain('Testing this workflow. This may take a little while.');
    expect(running).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel checks<\/button>/);
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Create stripe intent failed because Stripe rejected the amount.');
    expect(passed).toContain('This version is ready to approve.');
    expect(passed).toContain('Approve this version');
    expectNoLeaks(loading);
    expectNoLeaks(running);
    expectNoLeaks(failed);
    expectNoLeaks(passed);
  });

  it('shows cancelled and timed-out checks as distinct terminal states', () => {
    const cancelled = renderChecks({ status: 'cancelled' });
    const timedOut = renderChecks({ status: 'timed_out' });

    expect(cancelled).toContain('Checks were cancelled.');
    expect(cancelled).toContain('>Run checks<');
    expect(timedOut).toContain('Checks took too long and were stopped.');
    expect(timedOut).toContain('role="alert"');
    expect(timedOut).toContain('>Run checks<');
  });

  it('blocks approval with a sentence until checks pass', () => {
    const notRun = renderChecks();
    const failed = renderChecks({
      approval: {
        enabled: false,
        reason: 'Fix the failed check and run checks again before approving this version.',
      },
      result: { status: 'failed', tests: failedTests },
      status: 'failed',
    });
    const unsaved = renderChecks({
      approval: {
        enabled: false,
        reason: 'Save the YAML changes before approving this version.',
      },
      hasUnvalidatedChanges: true,
    });
    const ready = renderChecks({
      approval: { enabled: true, reason: null },
      result: { status: 'passed', tests: passedTests },
      status: 'passed',
    });

    expect(notRun).toContain('Run the checks before approving this version.');
    expect(notRun).toMatch(/<button[^>]*disabled=""[^>]*>Approve this version<\/button>/);
    expect(failed).toContain(
      'Fix the failed check and run checks again before approving this version.',
    );
    expect(unsaved).toContain('Validate your changes before running checks.');
    expect(unsaved).toContain('Save the YAML changes before approving this version.');
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve this version<\/button>/);
    expect(ready).toContain('>Approve this version<');
  });

  it('lets an author inspect checks without running or approving them', () => {
    const html = renderChecks({
      approval: { enabled: false, reason: 'Switch to Admin to approve this version.' },
      role: 'author',
    });

    expect(html).toContain('Switch to Admin to run checks.');
    expect(html).toContain('Switch to Admin to approve this version.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Run checks<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve this version<\/button>/);
    expect(html).not.toContain('Admin view');
    expect(html).not.toContain('exact artifact');
    expectNoLeaks(html);
  });

  it('hides Run checks when Draft already ran them, including for authors', () => {
    const running = renderChecks({ role: 'author', runFromDraft: true, status: 'running' });
    const passed = renderChecks({
      approval: { enabled: false, reason: 'Switch to Admin to approve this version.' },
      result: { status: 'passed', tests: passedTests },
      role: 'author',
      runFromDraft: true,
      status: 'passed',
    });

    expect(running).toContain('Checks run when you Draft this version.');
    expect(running).toContain('Running checks…');
    expect(running).not.toContain('>Run checks<');
    expect(running).not.toContain('Switch to Admin to run checks.');
    expect(passed).toContain('This version is ready to approve.');
    expect(passed).not.toContain('>Run checks<');
    expect(passed).not.toContain('Returns the payment record');
    expect(passed).not.toContain('<ol');
    expectNoLeaks(running);
    expectNoLeaks(passed);
  });

  it('explains a Draft check failure in chat, not as a second Run checks action', () => {
    const waiting = renderChecks({ role: 'author', runFromDraft: true });
    const failed = renderChecks({
      approval: {
        enabled: false,
        reason: 'Fix the failed check before approving this version.',
      },
      result: { status: 'failed', tests: failedTests },
      role: 'author',
      runFromDraft: true,
      status: 'failed',
    });

    expect(waiting).toContain('Checks run when you Draft this version.');
    expect(waiting).not.toContain('No check results for this version yet.');
    expect(waiting).not.toContain('>Run checks<');
    expect(waiting).not.toContain('Switch to Admin to run checks.');
    expect(failed).not.toContain('Create stripe intent failed because Stripe rejected the amount.');
    expect(failed).not.toContain('>Run checks<');
    expect(failed).toContain('Fix the failed check before approving this version.');
    expectNoLeaks(waiting);
    expectNoLeaks(failed);
  });

  it('keeps checks and approval keyboard-reachable', () => {
    const html = renderChecks({
      approval: { enabled: true, reason: null },
      result: { status: 'passed', tests: passedTests },
      status: 'passed',
    });

    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Workflow checks"');
    expect(html).toContain('>Run checks<');
    expect(html).toContain('>Approve this version<');
    expect(html).not.toContain('tabindex="-1"');
    expectNoLeaks(html);
  });

  it('does not show an earlier success or allow approval while checks are running again', () => {
    const html = renderChecks({
      approval: { enabled: true, reason: null },
      approvalMessage: 'This version was approved.',
      result: { status: 'passed', tests: passedTests },
      status: 'running',
    });
    expect(html).toContain('Running checks');
    expect(html).not.toContain('This version is ready to approve.');
    expect(html).not.toContain('This version was approved.');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Approve this version<\/button>/);
  });

  it('shows live progress immediately after Run checks and clears it on cancel, failure, and success', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = document.createElement('div');
    const root = createRoot(container);
    const passed = { status: 'passed', tests: passedTests } as const;
    let props: Parameters<typeof WorkflowChecks>[0] = {
      approval: { enabled: true, reason: null },
      hasUnvalidatedChanges: false,
      identities,
      loading: true,
      onApprove: vi.fn<() => void>(),
      onRunChecks: vi.fn<() => void>(() => update({ status: 'running' })),
      onCancelChecks: vi.fn<() => void>(() => update({ status: 'cancelled' })),
      result: passed,
      role: 'admin',
      status: 'passed',
    };
    function update(next: Partial<typeof props>) {
      props = { ...props, ...next };
      root.render(createElement(WorkflowChecks, props));
    }
    function button(label: string) {
      const element = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === label,
      );
      expect(element).toBeDefined();
      return element!;
    }
    const liveStatus = () => container.querySelector('[aria-live="polite"]');
    try {
      await act(async () => update({}));
      expect(liveStatus()?.textContent).toContain('Loading checks');
      expect(container.textContent).not.toContain('This version is ready to approve.');
      expect(button('Run checks').disabled).toBe(true);
      await act(async () => update({ loading: false }));
      await act(async () => button('Run checks').click());
      expect(props.onRunChecks).toHaveBeenCalledOnce();
      expect(liveStatus()?.textContent).toContain('Running checks');
      expect(liveStatus()?.closest('[aria-busy="true"]')).toBeNull();
      expect(liveStatus()?.querySelector('.wf-checks-spinner')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
      expect(container.textContent).not.toContain('This version is ready to approve.');
      expect(button('Approve this version').disabled).toBe(true);
      await act(async () => update({ busy: true }));
      expect(button('Cancel checks').disabled).toBe(false);
      await act(async () => button('Cancel checks').click());
      expect(props.onCancelChecks).toHaveBeenCalledOnce();
      expect(container.textContent).toContain('Checks were cancelled.');
      expect(container.querySelector('.wf-checks-spinner')).toBeNull();
      expect(container.textContent).not.toContain('This version is ready to approve.');
      expect(button('Approve this version').disabled).toBe(true);
      await act(async () => update({ busy: false }));
      await act(async () => button('Run checks').click());
      await act(async () =>
        update({ status: 'failed', result: { status: 'failed', tests: failedTests } }),
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Stripe rejected the amount.',
      );
      expect(container.querySelector('.wf-checks-spinner')).toBeNull();
      await act(async () => button('Run checks').click());
      expect(liveStatus()?.textContent).toContain('Running checks');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      await act(async () => update({ status: 'passed', result: passed }));
      expect(container.querySelector('.wf-checks-spinner')).toBeNull();
      expect(container.textContent).toContain('This version is ready to approve.');
      expect(button('Approve this version').disabled).toBe(false);
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('keeps checks and approval from overflowing on a narrow screen', () => {
    const html = renderChecks();

    expect(html).toContain('class="wf-sandbox wf-checks"');
    expect(html).toContain('class="wf-approval wf-checks-approval"');
    expect(checksCss).toContain('.wf-checks');
    expect(checksCss).toMatch(/\.wf-checks[\s\S]*min-width:\s*0/);
    expect(checksCss).toMatch(/@media \(max-width: 640px\)[\s\S]*\.wf-checks[\s\S]*min-width:\s*0/);
    expectNoLeaks(html);
  });
});
