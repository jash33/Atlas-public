import type { ReactNode } from 'react';

import { switchRoleToCreateWorkflow } from './conversation-copy.js';
import { RequestPromptEditor } from './RequestPromptEditor.js';
import type { RequestEditor } from './request-editor.js';

export function WorkflowCompose({
  canDraft,
  children,
  editor,
  error,
  graph,
  isBusy = false,
  onDraft,
  onEditorChange,
  onNameChange,
  onOpenCapability,
  onStartOver,
  resetDisabled = false,
  showDraft = true,
  workflowName,
  mode = 'ai',
  onModeChange,
  builder,
  loadDraftAction,
}: {
  canDraft: boolean;
  children?: ReactNode;
  editor: RequestEditor;
  error?: string;
  graph?: ReactNode;
  isBusy?: boolean;
  onDraft: () => void;
  onEditorChange: (editor: RequestEditor) => void;
  onNameChange: (name: string) => void;
  onOpenCapability?: (capabilityVersionId: string) => void;
  onStartOver?: () => void;
  resetDisabled?: boolean;
  showDraft?: boolean;
  workflowName: string;
  mode?: 'ai' | 'builder';
  onModeChange?: (mode: 'ai' | 'builder') => void;
  builder?: ReactNode;
  loadDraftAction?: ReactNode;
}) {
  return (
    <>
      <header className="wf-heading">
        <div>
          <h1>Create Workflow</h1>
          <p>
            Describe your workflow with AI or build it step by step. Review and check it before
            approval.
          </p>
        </div>
      </header>

      {(onModeChange || onStartOver || loadDraftAction) && (
        <div className="wf-authoring-controls">
          {onModeChange && (
            <nav className="wf-authoring-tabs" aria-label="Workflow editor">
              <button
                type="button"
                aria-pressed={mode === 'ai'}
                disabled={isBusy}
                onClick={() => onModeChange('ai')}
              >
                Describe with AI
              </button>
              <button
                type="button"
                aria-pressed={mode === 'builder'}
                disabled={isBusy}
                onClick={() => onModeChange('builder')}
              >
                Build manually
              </button>
            </nav>
          )}
          {(loadDraftAction || onStartOver) && (
            <div className="wf-authoring-actions">
              {loadDraftAction}
              {onStartOver && (
                <button
                  className="wf-action"
                  type="button"
                  disabled={resetDisabled}
                  onClick={onStartOver}
                >
                  Start over
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <section
        aria-busy={isBusy || undefined}
        aria-label="Workflow creation studio"
        className={
          mode === 'builder'
            ? 'wf-manual-studio'
            : graph
              ? 'wf-studio wf-compose wf-compose-split'
              : 'wf-studio wf-compose'
        }
      >
        <div className="wf-conversation">
          <label htmlFor="workflow-name">Workflow name</label>
          <input
            disabled={!canDraft || isBusy}
            id="workflow-name"
            onChange={(event) => onNameChange(event.target.value)}
            placeholder="For example, Settle payments"
            required
            value={workflowName}
          />
          {mode === 'ai' && (
            <>
              <label htmlFor="workflow-prompt">What should this workflow do?</label>
              <RequestPromptEditor
                canDraft={canDraft}
                editor={editor}
                isLoading={isBusy}
                onEditorChange={onEditorChange}
                {...(onOpenCapability ? { onOpenCapability } : {})}
              />
              {children}
              {showDraft && (
                <button
                  disabled={!canDraft || !workflowName.trim() || !editor.text.trim() || isBusy}
                  onClick={onDraft}
                  type="button"
                >
                  Draft
                </button>
              )}
            </>
          )}
          {!canDraft && <p className="wf-role-note">{switchRoleToCreateWorkflow}</p>}
          {error && (
            <p className="wf-error" role="alert">
              {error}
            </p>
          )}
        </div>
        {builder && <div hidden={mode !== 'builder'}>{builder}</div>}
        {mode === 'ai' && graph}
      </section>
    </>
  );
}
