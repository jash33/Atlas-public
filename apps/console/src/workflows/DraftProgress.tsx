import { useEffect, useState } from 'react';
import { formatDraftElapsedTime } from './draft-progress.js';
import type { DraftRequestProgress } from './draft-request-progress.js';

const labels = {
  understanding: 'Understanding your request',
  building: 'Building workflow steps and mappings',
  validating: 'Validating the draft',
  repairing: 'Repairing validation issues',
};
const steps = [
  { stage: 'understanding', label: 'Understand request' },
  { stage: 'building', label: 'Build workflow' },
  { stage: 'validating', label: 'Validate draft' },
  { stage: 'repairing', label: 'Repair if needed' },
] as const;

export function DraftProgress({
  onCancel,
  progress,
  connectionLost = false,
}: {
  onCancel: () => void;
  progress?: DraftRequestProgress | undefined;
  connectionLost?: boolean;
}) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now);
  const startedAt = progress ? Date.parse(progress.startedAt) : mountedAt;
  const elapsedMs = (progress?.finishedAt ? Date.parse(progress.finishedAt) : now) - startedAt;
  const running = !progress || progress.status === 'running';
  const currentStep = steps.findIndex((step) => step.stage === progress?.stage);
  const repaired =
    progress?.stage === 'repairing' ||
    progress?.events?.some(
      (event) => event.kind === 'planning.stage' && event.data.stage === 'repairing',
    );
  const result = progress?.result?.body;
  const validated =
    progress?.status === 'completed' &&
    result !== null &&
    typeof result === 'object' &&
    'status' in result &&
    result.status === 'validated';
  const label =
    progress?.status === 'completed'
      ? null
      : progress?.status === 'failed'
        ? 'Drafting failed'
        : progress?.status === 'cancelled'
          ? 'Draft cancelled'
          : progress?.stage
            ? progress.stage === 'understanding'
              ? 'Thinking'
              : progress.stage === 'validating'
                ? 'Checking draft'
                : 'Working'
            : 'Starting';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (progress?.status === 'failed') return null;
  return (
    <section
      aria-busy={running}
      aria-label="Draft and validation progress"
      className="wf-draft-progress"
    >
      <div className="wf-draft-progress-heading">
        {label && (
          <strong>
            {running && <span className="wf-draft-spinner" aria-hidden="true" />}
            {label}
          </strong>
        )}
        <div className="wf-draft-progress-actions">
          <time aria-label={`${Math.floor(elapsedMs / 1_000)} seconds elapsed`}>
            {formatDraftElapsedTime(elapsedMs)}
          </time>
          {running && (
            <button type="button" className="wf-draft-cancel" onClick={onCancel}>
              Cancel draft
            </button>
          )}
        </div>
      </div>
      {(label || connectionLost) && (
        <p aria-live="polite">
          {connectionLost
            ? 'Connection lost. Reconnecting to this draft; its result is not yet known.'
            : running && progress?.stage
              ? labels[progress.stage]
              : label}
        </p>
      )}
      <ol className="wf-draft-steps" aria-label="Drafting steps">
        {steps.map((step, index) => {
          const active = running && index === currentStep;
          const needsRecheck =
            !validated && progress?.stage === 'repairing' && step.stage === 'validating';
          const skipped = validated && step.stage === 'repairing' && !repaired;
          const complete =
            !skipped &&
            !needsRecheck &&
            (validated ||
              index < currentStep ||
              (step.stage === 'repairing' && repaired && progress?.stage === 'validating'));
          const stopped = !running && !validated && index === currentStep;
          const status = active
            ? 'In progress'
            : skipped
              ? 'Not needed'
              : needsRecheck
                ? 'Will check again'
                : complete
                  ? 'Done'
                  : stopped
                    ? 'Stopped here'
                    : step.stage === 'repairing'
                      ? 'Only if needed'
                      : 'Upcoming';
          return (
            <li
              key={step.stage}
              className={active ? 'is-active' : complete ? 'is-past' : ''}
              aria-current={active ? 'step' : undefined}
            >
              <span aria-hidden="true">{complete ? '✓' : index + 1}</span>
              <div>
                <strong>{step.label}</strong>
                <small>{status}</small>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
