// PROTOTYPE: Three synthesized repository-analysis sidebars on the existing Capabilities route.
import { useEffect, useState } from 'react';

import type { CatalogRepositoryConnection, CatalogSourceGroup } from './repository-sources.js';
import './repository-analysis-sidebar.prototype.css';

const variants = ['A', 'B', 'C'] as const;
type Variant = (typeof variants)[number];

const variantNames: Record<Variant, string> = {
  A: 'Guided steps',
  B: 'Now and next',
  C: 'Run console',
};

const steps = [
  'Connect repository',
  'Find API services',
  'Read contracts',
  'Check results',
  'Review contracts',
] as const;

type AnalysisSummary = {
  key: 'not-started' | 'running' | 'failed' | 'complete' | 'review' | 'outdated';
  label: string;
  message: string;
  currentStep: number;
  completedSteps: number;
  next: string;
};

function prototypeVariant(): Variant | null {
  if (!import.meta.env.DEV) return null;
  const candidate = new URLSearchParams(window.location.search).get('variant');
  return variants.find((variant) => variant === candidate) ?? null;
}

export function repositoryAnalysisSidebarPrototypeEnabled(): boolean {
  return prototypeVariant() !== null;
}

function analysisSummary(connection: CatalogRepositoryConnection | undefined): AnalysisSummary {
  const progress = connection?.progress;
  const hasSuccessfulCheck = connection?.targets?.some((target) => target.last_successful_at);
  const review = connection?.candidates?.some((candidate) => candidate.status === 'review');

  if (!connection || (!progress && !connection.last_error && !hasSuccessfulCheck)) {
    return {
      key: 'not-started',
      label: 'Connection not established',
      message:
        'Atlas has not connected to this repository yet. No analysis is running or waiting in a queue.',
      currentStep: 0,
      completedSteps: 0,
      next: 'Verify repository access, then start the first connection attempt.',
    };
  }
  if (connection.last_error || progress?.status === 'failed') {
    return {
      key: 'failed',
      label: 'Connection needs attention',
      message:
        progress?.message ??
        connection.last_error ??
        'Atlas could not complete the repository analysis.',
      currentStep: Math.max(0, phaseIndex(progress?.phase)),
      completedSteps: Math.max(0, phaseIndex(progress?.phase)),
      next: 'Check repository visibility, address, and branch access before retrying.',
    };
  }
  if (progress?.status === 'outdated') {
    return {
      key: 'outdated',
      label: 'Source changed',
      message: progress.message ?? 'The repository changed during its last analysis.',
      currentStep: Math.max(0, phaseIndex(progress.phase)),
      completedSteps: Math.max(0, phaseIndex(progress.phase)),
      next: 'Run another check against the latest source.',
    };
  }
  if (progress?.status === 'running') {
    const currentStep = Math.max(0, phaseIndex(progress.phase));
    return {
      key: 'running',
      label: stepWorkingLabel(currentStep),
      message: progress.message ?? 'Atlas is analyzing the repository.',
      currentStep,
      completedSteps: currentStep,
      next:
        currentStep < 4
          ? (steps[currentStep + 1] ?? 'Continue repository analysis.')
          : 'Review the proposed contracts.',
    };
  }
  if (progress?.status === 'queued') {
    return {
      key: 'not-started',
      label: 'Waiting for first connection',
      message: 'Atlas has the repository details but has not started a connection attempt.',
      currentStep: 0,
      completedSteps: 0,
      next: 'Connect to the repository and verify access.',
    };
  }
  if (review) {
    return {
      key: 'review',
      label: 'Contracts ready to review',
      message: 'Repository analysis is complete and proposed contracts are waiting for review.',
      currentStep: 4,
      completedSteps: 4,
      next: 'Review the proposed API contracts before adding them to the catalog.',
    };
  }
  return {
    key: 'complete',
    label: 'Repository check complete',
    message: 'The latest repository analysis finished successfully.',
    currentStep: 4,
    completedSteps: 5,
    next: 'Atlas will check the tracked source again when it changes.',
  };
}

function phaseIndex(phase: string | undefined): number {
  return ['connecting', 'discovering', 'extracting', 'checking', 'complete'].indexOf(phase ?? '');
}

function stepWorkingLabel(index: number): string {
  return [
    'Connecting repository',
    'Finding API services',
    'Reading contracts',
    'Checking results',
    'Finishing analysis',
  ][index]!;
}

function StepList({ summary, compact = false }: { summary: AnalysisSummary; compact?: boolean }) {
  return (
    <ol className={compact ? 'ras-steps is-compact' : 'ras-steps'}>
      {steps.map((step, index) => {
        const complete = index < summary.completedSteps;
        const current = index === summary.currentStep && summary.completedSteps < 5;
        return (
          <li className={complete ? 'is-complete' : current ? 'is-current' : ''} key={step}>
            <span aria-hidden="true">{complete ? '✓' : index + 1}</span>
            <div>
              <strong>{step}</strong>
              {!compact && (
                <small>
                  {complete
                    ? 'Complete'
                    : current
                      ? summary.key === 'not-started'
                        ? 'Not connected'
                        : summary.key === 'failed'
                          ? 'Action needed'
                          : 'In progress'
                      : 'Not started'}
                </small>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function SidebarHeader({ title }: { title: string }) {
  return (
    <header className="ras-heading">
      <small>Repository analysis</small>
      <h2>{title}</h2>
    </header>
  );
}

function FullAnalysisAction({ onViewAnalysis }: { onViewAnalysis: () => void }) {
  return (
    <footer className="ras-footer">
      <button className="cat-primary" onClick={onViewAnalysis} type="button">
        View full analysis
      </button>
    </footer>
  );
}

export function VariantA({ summary, onViewAnalysis }: VariantProps) {
  return (
    <aside aria-label="Repository analysis prototype" className="ras-sidebar ras-variant-a">
      <SidebarHeader title="From source to contracts" />
      <div className="ras-scroll">
        <section className={`ras-state ras-state-${summary.key}`}>
          <strong>{summary.label}</strong>
          <p>{summary.message}</p>
        </section>
        <StepList summary={summary} />
      </div>
      <FullAnalysisAction onViewAnalysis={onViewAnalysis} />
    </aside>
  );
}

export function VariantB({ summary, onViewAnalysis }: VariantProps) {
  const needsCurrentStep = ['not-started', 'failed', 'outdated'].includes(summary.key);
  const nextStep = needsCurrentStep
    ? summary.currentStep
    : Math.min(summary.currentStep + 1, steps.length - 1);
  return (
    <aside aria-label="Repository analysis prototype" className="ras-sidebar ras-variant-b">
      <SidebarHeader title="What needs attention" />
      <div className="ras-scroll">
        <section className={`ras-brief ras-state-${summary.key}`}>
          <span>Now</span>
          <h3>{summary.label}</h3>
          <p>{summary.message}</p>
        </section>
        <div className="ras-segments" aria-label={`${summary.completedSteps} of 5 steps complete`}>
          {steps.map((step, index) => (
            <span
              aria-label={step}
              className={
                index < summary.completedSteps
                  ? 'is-complete'
                  : index === summary.currentStep
                    ? 'is-current'
                    : ''
              }
              key={step}
            />
          ))}
        </div>
        <section className="ras-next">
          <span>Next</span>
          <strong>
            {summary.completedSteps === 5 ? 'Keep monitoring the source' : steps[nextStep]}
          </strong>
          <p>{summary.next}</p>
        </section>
        <details className="ras-disclosure">
          <summary>See the full analysis path</summary>
          <StepList compact summary={summary} />
        </details>
      </div>
      <FullAnalysisAction onViewAnalysis={onViewAnalysis} />
    </aside>
  );
}

export function VariantC({ summary, connection, onViewAnalysis }: VariantProps) {
  const activity = connection?.progress?.activity?.slice(-4).reverse() ?? [];
  return (
    <aside aria-label="Repository analysis prototype" className="ras-sidebar ras-variant-c">
      <SidebarHeader title="Analysis run" />
      <div className="ras-console-status">
        <span className={`ras-console-light ras-console-light-${summary.key}`} aria-hidden="true" />
        <strong>{summary.label}</strong>
        <small>{summary.completedSteps}/5 complete</small>
      </div>
      <div className="ras-scroll">
        <StepList compact summary={summary} />
        <section className="ras-console-log">
          <header>
            <span>Latest activity</span>
            <small>{connection?.progress?.updatedAt ? 'Saved progress' : 'No run yet'}</small>
          </header>
          {activity.length ? (
            <ol>
              {activity.map((event, index) => (
                <li key={`${event.at}:${index}`}>
                  <time>
                    {new Date(event.at).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          ) : (
            <div className="ras-console-empty">
              <strong>No analysis activity</strong>
              <p>{summary.message}</p>
            </div>
          )}
        </section>
      </div>
      <FullAnalysisAction onViewAnalysis={onViewAnalysis} />
    </aside>
  );
}

type VariantProps = {
  summary: AnalysisSummary;
  connection: CatalogRepositoryConnection | undefined;
  onViewAnalysis: () => void;
};

function PrototypeSwitcher({
  current,
  source,
  summary,
  onChange,
}: {
  current: Variant;
  source: CatalogSourceGroup | undefined;
  summary: AnalysisSummary;
  onChange: (variant: Variant) => void;
}) {
  const move = (offset: number) => {
    const index = variants.indexOf(current);
    onChange(variants[(index + offset + variants.length) % variants.length]!);
  };
  useEffect(() => {
    const changeOnArrow = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
    };
    window.addEventListener('keydown', changeOnArrow);
    return () => window.removeEventListener('keydown', changeOnArrow);
  });
  return (
    <div className="ras-switcher" aria-label="Repository analysis sidebar prototype variants">
      <button aria-label="Previous prototype" onClick={() => move(-1)} type="button">
        ←
      </button>
      <div>
        <strong>
          {current} · {variantNames[current]}
        </strong>
        <small>
          repository={source?.label ?? 'none'} · state={summary.key}
        </small>
      </div>
      <button aria-label="Next prototype" onClick={() => move(1)} type="button">
        →
      </button>
    </div>
  );
}

export function RepositoryAnalysisSidebarPrototype({
  source,
  connection,
  onViewAnalysis,
}: {
  source: CatalogSourceGroup | undefined;
  connection: CatalogRepositoryConnection | undefined;
  onViewAnalysis: () => void;
}) {
  const [variant, setVariant] = useState<Variant | null>(prototypeVariant);
  if (!variant) return null;

  const summary = analysisSummary(connection);
  const changeVariant = (next: Variant) => {
    const url = new URL(window.location.href);
    url.searchParams.set('variant', next);
    window.history.replaceState(null, '', url);
    setVariant(next);
  };
  const props = { summary, connection, onViewAnalysis };
  return (
    <>
      {source && variant === 'A' && <VariantA {...props} />}
      {source && variant === 'B' && <VariantB {...props} />}
      {source && variant === 'C' && <VariantC {...props} />}
      <PrototypeSwitcher
        current={variant}
        onChange={changeVariant}
        source={source}
        summary={summary}
      />
    </>
  );
}
