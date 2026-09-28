import { useEffect, useState, type ReactNode } from 'react';

export interface RepositoryProgress {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'outdated';
  phase: 'connecting' | 'discovering' | 'extracting' | 'checking' | 'complete';
  message: string;
  startedAt: string;
  updatedAt: string;
  targetKey?: string;
  servicesFound?: number;
  sourceFiles?: number;
  filesRead?: number;
  operationsDrafted?: number;
  operationsDiscovered?: number | null;
  workflowsDrafted?: number;
  activity: Array<{ at: string; message: string; phase: string }>;
}
interface Source {
  id: string;
  repository: string;
  branches: string[];
  last_error: string | null;
  progress?: Partial<RepositoryProgress>;
  targets: Array<{ last_successful_at: string | null }>;
  candidates: Array<{ id: string; status: string; kind: string }>;
}
const phases = ['connecting', 'discovering', 'extracting', 'checking', 'complete'];
const steps = [
  'Connect repository',
  'Find API services',
  'Read contracts',
  'Check results',
  'Review contracts',
];
const phaseLabels = [
  'Connecting',
  'Finding services',
  'Reading contracts',
  'Checking results',
  'Check complete',
];

export function repositoryAnalysisState(source: Source, now: number, disconnected = false) {
  const progress = source.progress;
  const status =
    progress?.status ??
    (source.last_error
      ? 'failed'
      : source.targets.some((target) => target.last_successful_at)
        ? 'succeeded'
        : 'queued');
  const phase = Math.max(
    0,
    phases.indexOf(progress?.phase ?? (status === 'succeeded' ? 'complete' : 'connecting')),
  );
  const stalled =
    status === 'running' &&
    (disconnected || !progress?.updatedAt || now - Date.parse(progress.updatedAt) > 2 * 60_000);
  const review = source.candidates.find((candidate) => candidate.status === 'review');
  const error =
    status === 'failed'
      ? (progress?.message ?? source.last_error ?? 'Repository analysis failed.')
      : null;
  return {
    status,
    phase,
    stalled,
    review,
    error,
    label:
      status === 'failed'
        ? 'Analysis failed'
        : stalled
          ? 'Updates interrupted'
          : status === 'queued'
            ? 'Queued'
            : status === 'outdated'
              ? 'Source changed'
              : status === 'succeeded' && review
                ? 'Ready for review'
                : phaseLabels[phase]!,
    tone:
      status === 'failed'
        ? 'error'
        : stalled || status === 'outdated'
          ? 'warning'
          : status === 'succeeded'
            ? 'success'
            : 'active',
  };
}

function duration(from: string, to: number) {
  const seconds = Math.max(0, Math.floor((to - Date.parse(from)) / 1000));
  if (!Number.isFinite(seconds)) return 'Unknown';
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function time(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })
    : 'Unknown';
}

export function RepositoryLoading() {
  return (
    <div className="repository-loading" aria-busy="true" role="status">
      <div>
        <span className="repository-spinner" />
        <strong>Loading repositories…</strong>
      </div>
      <p>Getting the latest saved progress and contracts.</p>
      <div className="repository-skeleton" />
      <div className="repository-skeleton repository-skeleton-short" />
    </div>
  );
}

export function RepositoryAnalysis({
  connection,
  disconnected,
  busy,
  onRefresh,
  onReview,
  onClose,
  children,
}: {
  connection: Source;
  disconnected: boolean;
  busy: boolean;
  onRefresh: () => void;
  onReview: (candidateId: string) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const view = repositoryAnalysisState(connection, now, disconnected);
  const repositoryName = connection.repository.replace('https://github.com/', '');
  const repositoryUnavailable = view.error === 'This repository is either private or unreachable.';
  const progress = connection.progress;
  const active = view.status === 'running' && !view.stalled;
  const drafted = progress?.operationsDrafted ?? 0;
  const discovered = progress?.operationsDiscovered;
  const activities = progress?.activity?.slice(-5).reverse() ?? [];
  const currentMessage =
    view.status === 'queued'
      ? 'Your analysis is queued. Waiting for a worker to start.'
      : view.stalled
        ? 'We haven’t received a recent update. Analysis may still be running; the last confirmed progress is shown below.'
        : (progress?.message ??
          (view.status === 'succeeded'
            ? 'The latest repository check is complete.'
            : 'Checking repository access.'));
  const stepIndex = view.status === 'queued' ? -1 : view.phase;
  return (
    <article
      className="repository-guided"
      aria-label={`${connection.repository.replace('https://github.com/', '')} analysis`}
    >
      <aside className="repository-step-rail" aria-label="Analysis steps">
        <p className="repository-eyebrow">From source to contracts</p>
        <ol>
          {steps.map((label, index) => {
            const current = index === stepIndex;
            const complete =
              index < stepIndex || (index === 4 && view.status === 'succeeded' && !view.review);
            return (
              <li
                key={label}
                className={`${current ? `repository-step-current repository-tone-${view.tone}` : ''} ${complete ? 'repository-step-complete' : ''}`}
                aria-current={current ? 'step' : undefined}
              >
                <span aria-hidden="true">{complete ? '✓' : index + 1}</span>
                <div>
                  <strong>{label}</strong>
                  <small>
                    {complete
                      ? 'Complete'
                      : current
                        ? view.status === 'failed'
                          ? 'Action needed'
                          : view.stalled
                            ? 'Update overdue'
                            : view.status === 'succeeded'
                              ? 'Waiting for you'
                              : view.status === 'outdated'
                                ? 'Will check again'
                                : 'In progress'
                        : 'Not started'}
                  </small>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="repository-rail-note">
          Source contracts describe your code. You review them before adding them to the catalog.
        </p>
      </aside>
      <div className="repository-run-content">
        <header className="repository-run-heading">
          <div>
            <h2>
              <a href={connection.repository} target="_blank" rel="noreferrer">
                {connection.repository.replace('https://github.com/', '')}
              </a>
            </h2>
            <p>Tracking {connection.branches.join(', ')}</p>
            {progress?.targetKey && (
              <small>
                {progress.targetKey.startsWith('pr:')
                  ? `Pull request #${progress.targetKey.slice(3)}`
                  : `Branch ${progress.targetKey.replace('branch:', '')}`}
              </small>
            )}
          </div>
          <span className={`repository-status repository-tone-${view.tone}`}>
            <span
              className={
                active ? 'repository-status-dot repository-pulse' : 'repository-status-dot'
              }
            />
            {view.label}
          </span>
          <button className="cat-secondary" type="button" disabled={busy} onClick={onClose}>
            Back to repository list
          </button>
        </header>
        {view.error ? (
          <div
            className="repository-alert repository-tone-error"
            role="alert"
            aria-label={`${repositoryName} analysis error`}
          >
            <span className="repository-alert-icon" aria-hidden="true">
              !
            </span>
            <div>
              <h3>
                {repositoryUnavailable
                  ? `Couldn’t connect to ${repositoryName}`
                  : 'Analysis needs attention'}
              </h3>
              <p>{view.error}</p>
              <p className="repository-alert-help">
                {repositoryUnavailable
                  ? 'Check the repository address, public visibility and tracked branches before retrying.'
                  : 'Your existing catalog is unchanged. Check the error before retrying.'}
              </p>
            </div>
          </div>
        ) : view.stalled ? (
          <div className="repository-alert repository-tone-warning" role="status">
            <span className="repository-alert-icon" aria-hidden="true">
              !
            </span>
            <div>
              <h3>
                {disconnected ? 'Connection to Atlas interrupted' : 'No recent analysis updates'}
              </h3>
              <p>{currentMessage}</p>
              <button className="cat-secondary" type="button" disabled={busy} onClick={onRefresh}>
                Refresh updates
              </button>
            </div>
          </div>
        ) : view.status === 'succeeded' ? (
          <div className="repository-alert repository-tone-success" role="status">
            <span className="repository-alert-icon" aria-hidden="true">
              ✓
            </span>
            <div>
              <h3>
                {view.review ? 'Your contracts are ready to review' : 'Repository check complete'}
              </h3>
              <p>
                {view.review
                  ? 'Review the proposed definitions and open questions before accepting them.'
                  : currentMessage}
              </p>
              {view.review && (
                <button
                  className="cat-primary"
                  type="button"
                  disabled={busy}
                  onClick={() => onReview(view.review!.id)}
                >
                  Review contracts →
                </button>
              )}
            </div>
          </div>
        ) : view.status === 'outdated' ? (
          <div className="repository-alert repository-tone-warning" role="status">
            <span className="repository-alert-icon" aria-hidden="true">
              !
            </span>
            <div>
              <h3>The source changed during analysis</h3>
              <p>{currentMessage}</p>
            </div>
          </div>
        ) : null}
        {view.status !== 'failed' && view.status !== 'succeeded' && (
          <section
            className={`repository-current-work ${view.stalled ? 'repository-work-stalled' : ''}`}
          >
            {!view.stalled && (
              <div className="repository-current-message" role="status" aria-live="polite">
                <span
                  className={active ? 'repository-spinner' : 'repository-queued-symbol'}
                  aria-hidden="true"
                >
                  {!active && '◷'}
                </span>
                <div>
                  <h3>{view.status === 'queued' ? 'Waiting to start' : phaseLabels[view.phase]}</h3>
                  <p>{currentMessage}</p>
                </div>
              </div>
            )}
            {(drafted > 0 || (discovered ?? 0) > 0) && (
              <div className="repository-progress">
                <div>
                  <strong>{drafted}</strong>
                  <span>
                    {discovered
                      ? `of ${discovered} discovered operations drafted`
                      : 'operation definitions drafted'}
                  </span>
                </div>
                {discovered && drafted <= discovered ? (
                  <progress
                    max={discovered}
                    value={drafted}
                    aria-label="Operation definitions drafted"
                  />
                ) : null}
                <p>
                  Drafts still need final checks and your review. More routes may be found as
                  analysis continues.
                </p>
              </div>
            )}
            <div className="repository-work-counts">
              {(progress?.servicesFound ?? 0) > 0 && (
                <span>
                  <b>{progress?.servicesFound}</b> services found
                </span>
              )}
              {(progress?.sourceFiles ?? 0) > 0 && (
                <span>
                  <b>{progress?.sourceFiles}</b> files found
                </span>
              )}
              {(progress?.filesRead ?? 0) > 0 && (
                <span>
                  <b>{progress?.filesRead}</b> files inspected
                </span>
              )}
              {progress?.startedAt && <span>{duration(progress.startedAt, now)} elapsed</span>}
            </div>
          </section>
        )}
        <section className="repository-activity" aria-label="Latest analysis updates">
          <div className="repository-section-title">
            <h3>Latest updates</h3>
            {progress?.updatedAt && <small>Last update {time(progress.updatedAt)}</small>}
          </div>
          {activities.length ? (
            <ol>
              {activities.map((event, index) => (
                <li key={`${event.at}:${index}`}>
                  <span className="repository-event-dot" aria-hidden="true" />
                  <p>{event.message}</p>
                  <time dateTime={event.at}>{time(event.at)}</time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="repository-muted">Updates appear here as each step finishes.</p>
          )}
        </section>
        {children}
        <p className="repository-background-note">
          {view.status === 'failed'
            ? 'Previous results remain available in analysis history.'
            : view.stalled
              ? 'Your last confirmed progress is saved. You can return here for updates.'
              : view.status === 'succeeded'
                ? 'Nothing is published without an explicit review and acceptance.'
                : view.status === 'outdated'
                  ? 'Another check is scheduled to analyze the updated source.'
                  : 'You can keep working. Analysis runs in the background, and progress is saved here.'}
        </p>
      </div>
    </article>
  );
}
