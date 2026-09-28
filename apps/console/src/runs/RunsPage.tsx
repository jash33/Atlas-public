import { useEffect, useMemo, useState } from 'react';

import { demoTokenForRole } from '../config.js';
import { formatRelativeTime } from '../home/summaries.js';
import { RemoteView } from '../shell/RemoteView.js';
import { parseHashParameter } from '../shell/router.js';
import { useConsoleSession } from '../shell/session.js';
import {
  queueRunRepair,
  repairProviderCondition,
  useRunDetail,
  useRuns,
  type RunRepairRequest,
} from './data.js';
import { RunLauncher } from './RunLauncher.js';
import {
  buildRunEvidence,
  canRepair,
  filterRuns,
  runStatePresentation,
  type RepairControl,
  type RunFilter,
  type RunStep,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from './runs.js';

const filters: Array<{ value: RunFilter; label: string }> = [
  { value: 'attention', label: 'Attention' },
  { value: 'repair_required', label: 'Parked' },
  { value: 'validation_failed', label: 'Failed' },
  { value: 'manual_review', label: 'Manual review' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'all', label: 'All' },
];

function filterCount(runs: readonly WorkflowRunSummary[], filter: RunFilter): number {
  return filterRuns(runs, filter, '').length;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function formatLifecycleOutcome(outcome: 'succeeded' | 'failed' | null | undefined): string | null {
  if (outcome === 'succeeded') return 'Succeeded';
  if (outcome === 'failed') return 'Failed';
  return null;
}

function formatDomainLabel(value: string): string {
  return value.replaceAll('-', ' ');
}

function formatRunTriggerLabel(
  trigger: { type: string; deliveryId?: string; scheduleId?: string },
  options: { readonly includeKey?: boolean } = {},
): string {
  if (trigger.type === 'webhook') {
    return options.includeKey && trigger.deliveryId ? `Webhook · ${trigger.deliveryId}` : 'Webhook';
  }
  if (trigger.type === 'api') {
    return options.includeKey && trigger.deliveryId ? `API · ${trigger.deliveryId}` : 'API';
  }
  if (trigger.type === 'schedule') {
    return options.includeKey && trigger.scheduleId
      ? `Schedule · ${trigger.scheduleId}`
      : 'Schedule';
  }
  return 'Manual';
}

function RunStatusBadge({ state }: { state: WorkflowRunSummary['state'] }) {
  const presentation = runStatePresentation(state);
  return <span className={`run-status run-status-${presentation.tone}`}>{presentation.label}</span>;
}

function compactRunId(runId: string): string {
  const identifier = runId.split(':').at(-1) ?? runId;
  return identifier.length > 16 ? `${identifier.slice(0, 8)}…${identifier.slice(-4)}` : identifier;
}

function RunQueueStatus({ run }: { run: WorkflowRunSummary }) {
  if (run.lifecycle?.inProgress)
    return <span className="run-status run-status-info">In progress</span>;
  const outcome = formatLifecycleOutcome(run.lifecycle?.outcome);
  if (outcome) {
    return (
      <span
        className={
          run.lifecycle?.outcome === 'succeeded'
            ? 'run-status run-status-good'
            : 'run-status run-status-bad'
        }
      >
        {outcome}
      </span>
    );
  }
  return <RunStatusBadge state={run.state} />;
}

export function RunQueue({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: WorkflowRunSummary[];
  selectedRunId: string | undefined;
  onSelect: (runId: string) => void;
}) {
  return (
    <aside className="run-queue-pane">
      <div className="run-pane-heading">
        <span>Newest first</span>
        <b>{runs.length} shown</b>
      </div>
      <div className="run-queue">
        {runs.length === 0 ? (
          <p className="run-empty">No runs match this intake reference and state.</p>
        ) : (
          runs.map((run) => (
            <button
              aria-pressed={selectedRunId === run.runId}
              className={selectedRunId === run.runId ? 'run-item run-item-selected' : 'run-item'}
              key={run.runId}
              onClick={() => onSelect(run.runId)}
              type="button"
            >
              <span className="run-item-summary">
                <strong>
                  {run.lifecycle?.workflowName ? run.lifecycle.workflowName : 'Workflow run'}
                </strong>
                <RunQueueStatus run={run} />
              </span>
              <span className="run-item-meta">
                <code title={run.runId}>{compactRunId(run.runId)}</code>
                <time dateTime={run.startedAt}>{formatRelativeTime(run.startedAt)}</time>
              </span>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

function redactedJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? 'No worker-redacted value recorded';
}

function StepStatus({ step }: { step: RunStep }) {
  const latest = step.attempts.at(-1);
  if (!latest) return <span className="run-step-status run-step-pending">Not reached</span>;
  return (
    <span className={`run-step-status run-step-${latest.status}`}>
      {latest.status === 'succeeded' ? 'Succeeded' : 'Failed'}
    </span>
  );
}

function TimelineStep({ step, index }: { step: RunStep; index: number }) {
  const duration = step.attempts.reduce((total, attempt) => total + attempt.durationMs, 0);
  return (
    <article className="run-step">
      <div className="run-step-rail">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <i />
      </div>
      <details open={step.attempts.at(-1)?.status === 'failed'}>
        <summary>
          <span>
            <strong>{step.stepId}</strong>
            <code>{step.capabilityVersionId}</code>
          </span>
          <span className="run-step-summary">
            <StepStatus step={step} />
            <small>
              {step.attempts.length} attempt{step.attempts.length === 1 ? '' : 's'} ·{' '}
              {formatDuration(duration)}
            </small>
          </span>
        </summary>
        {step.irreversible && (
          <p className="run-irreversible">Irreversible effect after this step succeeds.</p>
        )}
        <p className={step.idempotency.protected ? 'run-idempotency' : 'run-idempotency-muted'}>
          {step.idempotency.protected ? 'Duplicate-safe' : 'No duplicate guarantee'} ·{' '}
          {step.idempotency.evidence}
        </p>
        {step.retry && (
          <p className="run-retry-policy">
            Retry safety: {formatDomainLabel(step.retry.safety.basis)}; up to{' '}
            {step.retry.maximumAttempts} attempts; backoff {step.retry.backoff.initialInterval}, x
            {step.retry.backoff.coefficient}, capped at {step.retry.backoff.maximumInterval}
          </p>
        )}
        <ol className="run-attempts">
          {step.attempts.map((attempt) => (
            <li key={`${step.stepId}:${attempt.attempt}:${attempt.recordedAt}`}>
              <header>
                <strong>Attempt {attempt.attempt}</strong>
                <span>
                  {attempt.status} · {formatDuration(attempt.durationMs)}
                </span>
              </header>
              {attempt.failureType && <p>Failure: {attempt.failureType}</p>}
              {attempt.failureClassification && (
                <p>
                  Classified {formatDomainLabel(attempt.failureClassification)};{' '}
                  {attempt.retryDecision ? formatDomainLabel(attempt.retryDecision) : ''}
                </p>
              )}
              <div className="run-payloads">
                <div>
                  <small>Worker-redacted input</small>
                  <pre>{redactedJson(attempt.redactedInput)}</pre>
                </div>
                <div>
                  <small>Worker-redacted output</small>
                  <pre>
                    {attempt.redactedOutput === undefined
                      ? 'No output recorded'
                      : redactedJson(attempt.redactedOutput)}
                  </pre>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </details>
    </article>
  );
}

type RepairAction = RunRepairRequest['action'];

interface RepairCommandScope {
  organizationId: string;
  environmentId: string;
  runId: string;
  bearerToken: string;
}

interface RepairActionDescriptor {
  action: RepairAction;
  label: string;
  enabled: boolean;
  heading: string;
  explanation: string;
  control: RepairControl;
  needsReason?: boolean;
  className?: string;
  request: (scope: RepairCommandScope, reason: string) => RunRepairRequest;
}

function repairActionDescriptors(run: WorkflowRunDetail): RepairActionDescriptor[] {
  const retryStepId = run.controls.retryStep.stepId;
  const repairedCapabilityVersionId = run.controls.retryStep.repairedCapabilityVersionId;
  return [
    {
      action: 'retry_step',
      label: 'Retry failed step',
      enabled:
        run.controls.retryStep.enabled &&
        retryStepId !== null &&
        repairedCapabilityVersionId !== null,
      heading: `Confirm ${repairedCapabilityVersionId ?? 'the failed capability version'} is repaired?`,
      explanation:
        run.controls.retryStep.safetyBasis === 'read-only-operation'
          ? 'Atlas records the repaired capabilityVersionId. This read-only operation cannot repeat a write.'
          : 'Atlas records the repaired capabilityVersionId and preserves the stable idempotency key.',
      control: run.controls.retryStep,
      request: (scope) => ({
        ...scope,
        action: 'retry_step',
        stepId: retryStepId ?? '',
        repairedCapabilityVersionId: repairedCapabilityVersionId ?? '',
      }),
    },
    {
      action: 'resume_run',
      label: 'Resume from history',
      enabled: run.controls.resumeRun.enabled,
      heading: 'Resume from recorded history?',
      explanation: 'Recorded history is replayed; completed effects do not execute again.',
      control: run.controls.resumeRun,
      request: (scope) => ({ ...scope, action: 'resume_run' }),
    },
    {
      action: 'cancel_run',
      label: 'Cancel review',
      enabled: run.state === 'manual_review' && run.disposition === 'active',
      heading: 'Cancel this manual-review run?',
      explanation: 'This ends the run without rerunning completed effects.',
      control: run.controls.abandonRun,
      request: (scope) => ({ ...scope, action: 'cancel_run' }),
    },
    {
      action: 'abandon_run',
      label: 'Abandon run…',
      enabled: run.controls.abandonRun.enabled,
      heading: 'Abandon this run?',
      explanation: 'This ends the run without rerunning completed effects.',
      control: run.controls.abandonRun,
      needsReason: true,
      className: 'run-danger',
      request: (scope, reason) => ({ ...scope, action: 'abandon_run', reason }),
    },
  ];
}

function RepairWarning({ control }: { control: RepairControl }) {
  return (
    <div className="run-repair-warning">
      <strong>
        {control.priorStepsNotRerun.length === 0
          ? 'No completed steps will be replayed.'
          : `${control.priorStepsNotRerun.length} completed step${control.priorStepsNotRerun.length === 1 ? '' : 's'} will not rerun.`}
      </strong>
      {control.priorStepsNotRerun.length > 0 && (
        <ul>
          {control.priorStepsNotRerun.map((stepId) => (
            <li key={stepId}>{stepId}</li>
          ))}
        </ul>
      )}
      {control.committedIrreversibleEffects.length > 0 && (
        <div className="run-effects-warning">
          Irreversible effects already occurred: {control.committedIrreversibleEffects.join(', ')}
        </div>
      )}
    </div>
  );
}

function RepairPanel({ run, reload }: { run: WorkflowRunDetail; reload: () => void }) {
  const { organizationId, environmentId, role } = useConsoleSession();
  const [action, setAction] = useState<RepairAction>();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string>();
  const authorizedView = canRepair(role);
  const actions = repairActionDescriptors(run);
  const activeAction = actions.find((item) => item.action === action);

  async function submitRepair() {
    if (!activeAction || !authorizedView) return;
    setSubmitting(true);
    setMessage(undefined);
    try {
      const scope = {
        organizationId,
        environmentId,
        runId: run.runId,
        bearerToken: demoTokenForRole(role),
      };
      const request = activeAction.request(scope, reason);
      if (request.action === 'retry_step') {
        await repairProviderCondition({
          ...scope,
          repairedCapabilityVersionId: request.repairedCapabilityVersionId,
        });
      }
      await queueRunRepair(request);
      setMessage('Repair command queued through the Atlas API.');
      setAction(undefined);
      setReason('');
      reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Repair command could not be queued');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="run-repair">
      <header>
        <div>
          <small>Bounded repair</small>
          <h2>Operator controls</h2>
        </div>
        <RunStatusBadge state={run.state} />
      </header>
      <RepairWarning control={run.controls.resumeRun} />
      <div className="run-repair-actions">
        {actions.map((item) => (
          <button
            className={item.className}
            disabled={!authorizedView || !item.enabled || submitting}
            key={item.action}
            onClick={() => {
              setAction(item.action);
              setMessage(undefined);
            }}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      {!authorizedView && (
        <small className="run-role-note">
          Switch to Operator or Admin to request repair. The server still authorizes every command.
        </small>
      )}
      {activeAction && (
        <div className="run-confirm">
          <strong>{activeAction.heading}</strong>
          <p>{activeAction.explanation}</p>
          <RepairWarning control={activeAction.control} />
          {activeAction.needsReason && (
            <label>
              <span>Operator reason</span>
              <textarea
                onChange={(event) => setReason(event.target.value)}
                placeholder="Why is abandonment the correct terminal disposition?"
                rows={4}
                value={reason}
              />
            </label>
          )}
          <div>
            <button disabled={submitting} onClick={() => setAction(undefined)} type="button">
              Keep investigating
            </button>
            <button
              disabled={submitting || (activeAction.needsReason && reason.trim().length === 0)}
              onClick={() => void submitRepair()}
              type="button"
            >
              {submitting ? 'Queueing…' : 'Confirm command'}
            </button>
          </div>
        </div>
      )}
      {message && <p className="run-message">{message}</p>}
      <section aria-label="Immutable repair history">
        <h3>Repair history</h3>
        <p>Every operator command and worker result is retained in the append-only audit log.</p>
        {run.repairHistory.length === 0 ? (
          <small>No repair commands have been requested.</small>
        ) : (
          <ol>
            {run.repairHistory.map((repair) => (
              <li key={repair.repairId}>
                <strong>{formatDomainLabel(repair.action)}</strong>
                <span>
                  {repair.status} · {repair.operatorId}
                  {repair.stepId ? ` · ${repair.stepId}` : ''}
                </span>
                {repair.repairedCapabilityVersionId && (
                  <small>capabilityVersionId {repair.repairedCapabilityVersionId}</small>
                )}
                {repair.reason && <small>{repair.reason}</small>}
                {repair.error && <small>{repair.error}</small>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

export function RunTimeline({ run, reload }: { run: WorkflowRunDetail; reload: () => void }) {
  const evidence = buildRunEvidence(run);
  return (
    <>
      <section className="run-timeline-pane">
        <header className="run-selected-heading">
          <div>
            <small>{run.runId}</small>
            <h2>{run.lifecycle?.workflowName ?? 'Workflow run'}</h2>
            <span>
              {run.workflowVersionId} · started{' '}
              {formatRelativeTime(run.lifecycle?.startedAt ?? run.startedAt)}
            </span>
          </div>
          <span className="run-item-badges">
            <RunStatusBadge state={run.state} />
            {run.lifecycle?.inProgress ? (
              <span className="run-status run-status-info">In progress</span>
            ) : null}
            {formatLifecycleOutcome(run.lifecycle?.outcome) ? (
              <span
                className={
                  run.lifecycle?.outcome === 'succeeded'
                    ? 'run-status run-status-good'
                    : 'run-status run-status-bad'
                }
              >
                {formatLifecycleOutcome(run.lifecycle?.outcome)}
              </span>
            ) : null}
          </span>
        </header>
        <dl className="run-facts">
          <div>
            <dt>Duration</dt>
            <dd>
              {run.lifecycle?.durationMs === null || run.lifecycle?.durationMs === undefined
                ? formatDuration(evidence.durationMs)
                : formatDuration(run.lifecycle.durationMs)}
            </dd>
          </div>
          <div>
            <dt>Retries</dt>
            <dd>
              {run.lifecycle?.retryCount === null || run.lifecycle?.retryCount === undefined
                ? '—'
                : run.lifecycle.retryCount}
            </dd>
          </div>
          <div>
            <dt>Outcome</dt>
            <dd>{formatLifecycleOutcome(run.lifecycle?.outcome) ?? 'In progress'}</dd>
          </div>
          <div>
            <dt>Attempts</dt>
            <dd>{evidence.attemptCount}</dd>
          </div>
          <div>
            <dt>Failure bucket</dt>
            <dd>{run.failure?.bucket ?? 'None'}</dd>
          </div>
          <div>
            <dt>Workflow</dt>
            <dd>{run.lifecycle?.workflowName || 'Unknown'}</dd>
          </div>
          <div>
            <dt>Workflow version</dt>
            <dd>{run.workflowVersionId}</dd>
          </div>
          <div>
            <dt>Artifact</dt>
            <dd>
              <code>{run.artifactId ?? 'Legacy run'}</code>
            </dd>
          </div>
          <div>
            <dt>Temporal workflow</dt>
            <dd>
              <code>{run.temporalWorkflowId}</code>
            </dd>
          </div>
          <div>
            <dt>Trigger</dt>
            <dd>{formatRunTriggerLabel(run.trigger, { includeKey: true })}</dd>
          </div>
        </dl>
        <section className="run-timeline" aria-label="Execution timeline">
          {run.steps.length === 0 ? (
            <p className="run-empty">No executable steps have been recorded.</p>
          ) : (
            run.steps.map((step, index) => (
              <TimelineStep index={index} key={step.stepId} step={step} />
            ))
          )}
        </section>
      </section>
      <RepairPanel reload={reload} run={run} />
    </>
  );
}

function SelectedRun({ runId, reloadRuns }: { runId: string; reloadRuns: () => void }) {
  const { organizationId, environmentId } = useConsoleSession();
  const detail = useRunDetail(organizationId, environmentId, runId);
  const reload = () => {
    detail.reload();
    reloadRuns();
  };
  return (
    <RemoteView remote={detail.remote} reload={detail.reload}>
      {(run) => <RunTimeline reload={reload} run={run} />}
    </RemoteView>
  );
}

function RunsWorkspace({
  initialRunId,
  runs,
  reload,
}: {
  initialRunId: string | null;
  runs: WorkflowRunSummary[];
  reload: () => void;
}) {
  const linkedRun = initialRunId ? runs.find((run) => run.runId === initialRunId) : undefined;
  const [filter, setFilter] = useState<RunFilter>(linkedRun ? 'all' : 'attention');
  const [search, setSearch] = useState('');
  const visibleRuns = useMemo(() => filterRuns(runs, filter, search), [filter, runs, search]);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    linkedRun?.runId ?? visibleRuns[0]?.runId,
  );

  useEffect(() => {
    if (!visibleRuns.some((run) => run.runId === selectedRunId)) {
      setSelectedRunId(visibleRuns[0]?.runId);
    }
  }, [selectedRunId, visibleRuns]);

  return (
    <>
      <div className="run-toolbar">
        <div className="run-filters" role="group" aria-label="Filter runs by state">
          {filters.map((item) => (
            <button
              aria-pressed={filter === item.value}
              className={filter === item.value ? 'run-filter-active' : ''}
              key={item.value}
              onClick={() => setFilter(item.value)}
              type="button"
            >
              {item.label} <b>{filterCount(runs, item.value)}</b>
            </button>
          ))}
        </div>
        <label className="run-search">
          <span>Search intake reference</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="pay_1048"
            type="search"
            value={search}
          />
        </label>
      </div>
      <div className="run-layout">
        <RunQueue onSelect={setSelectedRunId} runs={visibleRuns} selectedRunId={selectedRunId} />
        {selectedRunId ? (
          <SelectedRun reloadRuns={reload} runId={selectedRunId} />
        ) : (
          <section className="run-no-selection">
            <strong>No run selected</strong>
            <span>Change the state filter or intake-reference search.</span>
          </section>
        )}
      </div>
    </>
  );
}

export function RunsPage() {
  const { organizationId, environmentId, demoProfileId, customerUser } = useConsoleSession();
  const runs = useRuns(organizationId, environmentId);
  const initialRunId = parseHashParameter(window.location.hash, 'runId');
  return (
    <div className="runs">
      <header className="runs-heading">
        <div>
          <p>Operations</p>
          <h1>Workflow runs</h1>
          <span>
            Live execution history from Atlas's customer-data-safe Temporal projection. Refreshes
            every five seconds.
          </span>
        </div>
        <div>
          <small>Selected environment</small>
          <strong>{environmentId}</strong>
        </div>
      </header>
      {!customerUser && demoProfileId === 'sample' && <RunLauncher />}
      <RemoteView remote={runs.remote} reload={runs.reload}>
        {(data) => <RunsWorkspace initialRunId={initialRunId} reload={runs.reload} runs={data} />}
      </RemoteView>
    </div>
  );
}
