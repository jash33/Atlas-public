import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export function WorkflowPlanReview({
  canDraft,
  children,
  editError,
  editMessage,
  error,
  followUp,
  hasUnvalidatedChanges,
  isBusy = false,
  onFollowUpChange,
  onOpenBuilder,
  onRevise,
  onValidateSource,
  onYamlChange,
  yaml,
}: {
  canDraft: boolean;
  children?: ReactNode;
  editError?: string;
  editMessage?: string;
  error?: string;
  followUp: string;
  hasUnvalidatedChanges: boolean;
  isBusy?: boolean;
  onFollowUpChange: (value: string) => void;
  onOpenBuilder?: () => void;
  onRevise: () => void;
  onValidateSource: () => void;
  onYamlChange: (yaml: string) => void;
  yaml: string;
}) {
  const [followUpOpen, setFollowUpOpen] = useState(false);
  const followUpId = useId();
  const followUpInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (followUpOpen) followUpInput.current?.focus();
  }, [followUpOpen]);

  return (
    <div aria-busy={isBusy || undefined} className="wf-plan">
      <div className="wf-review-actions">
        {onOpenBuilder && (
          <button className="wf-action" disabled={isBusy} onClick={onOpenBuilder} type="button">
            Open in Builder
          </button>
        )}
        <button
          aria-controls={followUpId}
          aria-expanded={followUpOpen}
          className="wf-action"
          disabled={!canDraft || isBusy}
          onClick={() => setFollowUpOpen((open) => !open)}
          type="button"
        >
          Modify with AI
        </button>
      </div>
      {error && (
        <p className="wf-error" role="alert">
          {error}
        </p>
      )}
      {children}
      {followUpOpen && (
        <div className="wf-plan-followup" id={followUpId}>
          <label htmlFor={`${followUpId}-prompt`}>What should Atlas change?</label>
          <textarea
            aria-label="Workflow follow-up"
            disabled={!canDraft || isBusy}
            id={`${followUpId}-prompt`}
            onChange={(event) => onFollowUpChange(event.target.value)}
            placeholder="Add a step, change a mapping, or clarify the intended behavior…"
            rows={2}
            ref={followUpInput}
            value={followUp}
          />
          <button
            className="wf-action"
            disabled={!canDraft || !followUp.trim() || isBusy || hasUnvalidatedChanges}
            onClick={onRevise}
            type="button"
          >
            Propose changes
          </button>
          {hasUnvalidatedChanges && (
            <small>Validate your workflow changes before asking AI for another edit.</small>
          )}
        </div>
      )}
      <section className="wf-plan-source" aria-label="YAML definition">
        <h3>YAML definition</h3>
        <section className="wf-yaml-editor" aria-label="Editable workflow YAML">
          <textarea
            aria-label="Workflow YAML"
            className="wf-yaml-source"
            disabled={!canDraft || isBusy}
            onChange={(event) => onYamlChange(event.target.value)}
            rows={36}
            spellCheck={false}
            autoCapitalize="off"
            wrap="off"
            value={yaml}
          />
          <button
            className="wf-action"
            disabled={!canDraft || isBusy}
            onClick={onValidateSource}
            type="button"
          >
            Validate definition
          </button>
          {!canDraft && <small>Switch to Author or Admin to edit this workflow.</small>}
          {editMessage && <p className="wf-approved">{editMessage}</p>}
          {editError && <p className="wf-error">{editError}</p>}
        </section>
      </section>
    </div>
  );
}
