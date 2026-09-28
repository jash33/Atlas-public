import type { WorkflowSandboxTestKind } from '@atlas/demo-estate';
import type { DemoRole } from '../shell/session.js';
import { humanStepName } from './diagram-model.js';
import {
  sandboxResultSummary,
  type SandboxCheckIdentity,
  type SandboxCheckOutcome,
  type SandboxRunStatus,
} from './workflow.js';
import './workflows-sandbox.css';
import type { WorkflowCheckProgress } from './workflow-check-request.js';

const checkActions: Record<WorkflowSandboxTestKind, string> = {
  'happy-path': 'Checking the normal path',
  'contract-mapping': 'Checking input and output mappings',
  authentication: 'Checking authentication',
  retry: 'Checking retries',
  'rate-limit': 'Checking rate limits',
  timeout: 'Checking timeout handling',
  'duplicate-event': 'Checking duplicate handling',
  'partial-failure': 'Checking partial failure handling',
  compatibility: 'Checking compatibility',
};

function progressDescription(progress?: WorkflowCheckProgress): string {
  if (!progress) return 'Testing this workflow. This may take a little while.';
  if (progress.phase === 'preparing') return 'Preparing workflow checks.';
  if (progress.phase === 'finalizing') return 'Finishing workflow checks.';
  const test = progress.currentTest;
  if (!test) return 'Running workflow checks.';
  const action = checkActions[test.kind] ?? 'Running a check';
  return `${action}${test.stepId ? ` for ${humanStepName(test.stepId)}` : ''}.`;
}

export function WorkflowChecks({
  approval,
  approvalMessage,
  busy = false,
  error,
  hasUnvalidatedChanges,
  identities = [],
  loading = false,
  onApprove,
  onCancelChecks,
  onRunChecks,
  progress,
  result,
  role,
  runFromDraft = false,
  status,
}: {
  approval: { enabled: boolean; reason: string | null };
  approvalMessage?: string;
  busy?: boolean;
  error?: string;
  hasUnvalidatedChanges: boolean;
  identities?: readonly SandboxCheckIdentity[];
  loading?: boolean;
  onApprove: () => void;
  onCancelChecks: () => void;
  onRunChecks: () => void;
  progress?: WorkflowCheckProgress;
  result?: { status: 'passed' | 'failed'; tests: readonly SandboxCheckOutcome[] };
  role: DemoRole;
  runFromDraft?: boolean;
  status: SandboxRunStatus;
}) {
  const running = status === 'running';
  const waiting = loading || running;
  const resultCopy =
    !waiting && result && status === result.status
      ? sandboxResultSummary(result.status, result.tests, {
          identities,
          stepName: humanStepName,
        })
      : undefined;
  const showRunChecks = !runFromDraft;

  return (
    <>
      <section aria-label="Workflow checks" className="wf-sandbox wf-checks">
        <header>
          <div>
            <h3>Checks</h3>
            <p>
              {runFromDraft
                ? 'Checks run when you Draft this version.'
                : 'Run checks on this version, then approve it if they pass.'}
            </p>
          </div>
          {showRunChecks && (
            <button
              className="wf-action"
              disabled={
                role !== 'admin' || (!running && (loading || hasUnvalidatedChanges || busy))
              }
              onClick={status === 'running' ? onCancelChecks : onRunChecks}
              type="button"
            >
              {status === 'running' ? 'Cancel checks' : 'Run checks'}
            </button>
          )}
        </header>
        <div
          className={waiting ? 'wf-checks-progress' : undefined}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {waiting && (
            <>
              <span className="wf-checks-spinner" aria-hidden="true" />
              <div>
                <strong>{running ? 'Running checks…' : 'Loading checks…'}</strong>
                <p>
                  {running
                    ? progressDescription(progress)
                    : 'Getting the check results for this version.'}
                </p>
                {running && progress && progress.total > 0 && (
                  <p className="wf-checks-count">
                    {progress.completed} of {progress.total} checks completed.
                  </p>
                )}
              </div>
            </>
          )}
        </div>
        <div aria-busy={waiting || undefined}>
          {showRunChecks && role !== 'admin' && <p>Switch to Admin to run checks.</p>}
          {hasUnvalidatedChanges && <p>Validate your changes before running checks.</p>}
          {!waiting && error && (
            <p className="wf-error" role="alert">
              {error}
            </p>
          )}
          {!loading && !result && status === 'not-run' && !error && !runFromDraft && (
            <p className="wf-empty">No check results for this version yet.</p>
          )}
          {!waiting && status === 'cancelled' && (
            <p className="wf-empty" role="status">
              Checks were cancelled.
            </p>
          )}
          {!waiting && status === 'timed_out' && (
            <p className="wf-error" role="alert">
              Checks took too long and were stopped.
            </p>
          )}
          {resultCopy && !(runFromDraft && result?.status === 'failed') && (
            <p
              className={result?.status === 'passed' ? 'wf-approved wf-check-result' : 'wf-error'}
              role={result?.status === 'failed' ? 'alert' : 'status'}
            >
              {resultCopy}
            </p>
          )}
        </div>
      </section>
      <footer className="wf-approval wf-checks-approval">
        <div className="wf-approval-action">
          {!waiting && approval.reason && <p>{approval.reason}</p>}
          {!waiting && status === 'passed' && approvalMessage && (
            <p className="wf-approved">{approvalMessage}</p>
          )}
          <button
            className="wf-action"
            disabled={!approval.enabled || busy || waiting || status !== 'passed'}
            onClick={onApprove}
            type="button"
          >
            Approve this version
          </button>
        </div>
      </footer>
    </>
  );
}
