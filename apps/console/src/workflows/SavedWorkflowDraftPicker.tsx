import { useId, useRef, useState } from 'react';

export function SavedWorkflowDraftPicker({
  drafts,
  currentWorkflowId,
  disabled,
  status,
  hasUnsavedChanges,
  onRefresh,
  onLoad,
}: {
  drafts: readonly { workflowId: string; name: string }[];
  currentWorkflowId: string;
  disabled: boolean;
  status: 'loading' | 'ready' | 'error';
  hasUnsavedChanges: boolean;
  onRefresh: () => void;
  onLoad: (workflowId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selectedId = drafts.some((draft) => draft.workflowId === selection)
    ? selection
    : (drafts.find((draft) => draft.workflowId === currentWorkflowId)?.workflowId ??
      drafts[0]?.workflowId ??
      '');

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div
      className="wf-draft-picker"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="wf-action"
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else {
            setSelection(currentWorkflowId);
            setOpen(true);
            onRefresh();
          }
        }}
      >
        Load draft
      </button>
      {open && (
        <section className="wf-draft-picker-panel" id={id} aria-label="Load a saved draft">
          {status === 'loading' ? (
            <p role="status">Loading saved drafts…</p>
          ) : status === 'error' ? (
            <>
              <p role="alert">Could not load saved drafts.</p>
              <button type="button" disabled={disabled} onClick={onRefresh}>
                Try again
              </button>
            </>
          ) : drafts.length === 0 ? (
            <p>No saved drafts in this environment yet.</p>
          ) : (
            <>
              <label htmlFor={`${id}-choice`}>Choose a saved draft</label>
              <select
                id={`${id}-choice`}
                value={selectedId}
                size={Math.min(6, Math.max(2, drafts.length))}
                disabled={disabled}
                onChange={(event) => setSelection(event.target.value)}
              >
                {drafts.map((draft) => (
                  <option key={draft.workflowId} value={draft.workflowId}>
                    {draft.name}
                    {draft.workflowId === currentWorkflowId ? ' (current)' : ''}
                  </option>
                ))}
              </select>
              {hasUnsavedChanges && <p>Loading a draft will replace your unsaved changes.</p>}
            </>
          )}
          <div className="wf-draft-picker-actions">
            <button
              type="button"
              disabled={disabled || status !== 'ready' || !selectedId}
              onClick={() => {
                onLoad(selectedId);
                close();
              }}
            >
              Load selected draft
            </button>
            <button type="button" onClick={close}>
              Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
