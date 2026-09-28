import { useId, useLayoutEffect, useState } from 'react';
import { OperationEvidenceDrawer } from '../capabilities/OperationEvidenceDrawer.js';

import { targetDiagramDiagnostics } from './diagram-diagnostics.js';

import { CheckFailurePanel } from './CheckFailurePanel.js';
import { BlockedOutcome } from './BlockedOutcome.js';
import { ClarificationPanel } from './ClarificationPanel.js';
import { ModelTraces } from './ModelTraces.js';
import { DraftProgress } from './DraftProgress.js';
import { WorkflowCompose } from './WorkflowCompose.js';
import { WorkflowDiagram } from './WorkflowDiagram.js';
import { WorkflowPlanReview } from './WorkflowPlanReview.js';
import { WorkflowBuilder } from './WorkflowBuilder.js';
import { SavedWorkflowDraftPicker } from './SavedWorkflowDraftPicker.js';

import { workflowEditSummary } from './manual-workflow.js';
import './manual-workflow.css';

import { RequestInterpretation } from './RequestInterpretation.js';

import { ValidatedRequestView } from './ValidatedRequestView.js';
import { WorkflowChecks } from './WorkflowChecks.js';

import { useWorkflowAuthoringSession } from './workflow-authoring-session.js';

export function WorkflowsPage() {
  const session = useWorkflowAuthoringSession();
  const [tracesCollapsed, setTracesCollapsed] = useState(false);
  const tracesId = useId();
  useLayoutEffect(() => {
    if (session.state.editorMode === 'builder') setTracesCollapsed(true);
  }, [session.state.editorMode]);
  const {
    draftProgress,
    drafting,
    canDraft,
    editor,
    error,
    busy,
    manual,
    hasWorkToReset,
    workflowName,
    editorMode,
    savedManualDrafts,
    savedDraftListStatus,
    workflowId,
    builderOpened,
    reviewFromBuilder,
    role,
    builderProjection,
    builderLoadError,
    organizationId,
    environmentId,
    builderCapabilities,
    diagramPreview,
    capabilityDrawer,
    checkFailure,
    review,
    referenceIdentities,
    draftConnectionLost,
    clarificationAnswer,
    aiProposal,
    reviewRequest,
    hasUnvalidatedChanges,
    editError,
    editMessage,
    revisionPrompt,
    artifactYaml,
    affordance,
    approvalMessage,
    sandbox,
  } = session.state;
  const {
    createDraft,
    startOver,
    updateEditor,
    renameWorkflow,
    openReferencedCapability,
    changeEditorMode,
    openSavedDraft,
    saveBuilder,
    validateBuilder,
    refreshSavedDrafts,
    changeBuilderDocument,
    closeCapabilityEvidence,
    openNode,
    cancelActiveDraft,
    reviseDraftWithPrompt,
    changeAnswer,
    submitAnswer,
    acceptAiProposal,
    keepCurrentWorkflow,
    changeRevisionPrompt,
    validateSource,
    editSource,
    approve,
    cancelActiveChecks,
    runSandboxTests,
    selectCapabilityVersion,
  } = session.commands;
  const hasTraces = Boolean(draftProgress || drafting.phase === 'drafting');
  const draftPicker = (
    <SavedWorkflowDraftPicker
      key={`${organizationId}:${environmentId}:${workflowId}`}
      drafts={savedManualDrafts}
      currentWorkflowId={workflowId}
      disabled={!canDraft || busy || manual.busy || drafting.phase === 'drafting'}
      status={savedDraftListStatus}
      hasUnsavedChanges={hasWorkToReset && manual.dirty}
      onRefresh={refreshSavedDrafts}
      onLoad={openSavedDraft}
    />
  );
  return (
    <div
      className={`wf${hasTraces ? ' wf-with-traces' : ''}${hasTraces && tracesCollapsed ? ' wf-traces-collapsed' : ''}${editorMode === 'builder' ? ' wf-builder' : ''}`}
    >
      <WorkflowCompose
        canDraft={canDraft}
        editor={editor}
        {...(error ? { error } : {})}
        isBusy={busy || manual.busy || drafting.phase === 'drafting'}
        onDraft={() => void createDraft()}
        {...(hasWorkToReset ? { onStartOver: () => void startOver() } : {})}
        resetDisabled={manual.busy || (drafting.phase !== 'drafting' && busy)}
        onEditorChange={updateEditor}
        onNameChange={renameWorkflow}
        onOpenCapability={openReferencedCapability}
        showDraft={drafting.phase !== 'clarification_required' && drafting.phase !== 'validated'}
        workflowName={workflowName}
        mode={editorMode}
        onModeChange={changeEditorMode}
        loadDraftAction={draftPicker}
        builder={
          builderOpened ? (
            <div className="wf-manual-editor">
              <div className="wf-manual-actions">
                <p role="status">
                  {manual.operation
                    ? manual.operation === 'validating'
                      ? 'Validating workflow…'
                      : manual.operation === 'saving'
                        ? 'Saving draft…'
                        : 'Loading draft…'
                    : manual.dirty
                      ? 'Working draft has unsaved changes'
                      : 'Working draft saved'}
                </p>
                <button
                  type="button"
                  className="wf-action"
                  disabled={!canDraft || busy || manual.busy || !workflowName.trim()}
                  onClick={() => void saveBuilder()}
                >
                  Save draft
                </button>
                <button
                  type="button"
                  className="wf-action"
                  disabled={!canDraft || busy || manual.busy || !builderProjection}
                  onClick={() => void validateBuilder()}
                >
                  Validate
                </button>
              </div>
              {builderLoadError && (
                <p role="alert" className="wf-error">
                  {builderLoadError}
                </p>
              )}
              <WorkflowBuilder
                key={`${organizationId}:${environmentId}:${workflowId}`}
                document={manual.document}
                onChange={changeBuilderDocument}
                capabilities={builderCapabilities}
                readOnly={!canDraft}
                disabled={busy || manual.busy || drafting.phase === 'drafting'}
              />
              {(manual.error || manual.message || review) && (
                <section
                  className="wf-builder-validation"
                  aria-label="Builder validation"
                  aria-live="polite"
                >
                  <h3>Validation results</h3>
                  {manual.error && (
                    <p role="alert" className="wf-error">
                      {manual.error}
                    </p>
                  )}
                  {manual.message && <p>{manual.message}</p>}
                  {manual.issues.length > 0 ? (
                    <ul>
                      {manual.issues.map((issue, index) => (
                        <li key={index}>
                          {issue.stepId && (
                            <strong>
                              {manual.document.labels[issue.stepId] ?? issue.stepId}:{' '}
                            </strong>
                          )}
                          <span>{issue.message}</span>
                        </li>
                      ))}
                    </ul>
                  ) : hasUnvalidatedChanges ? (
                    <p>Validate your changes to see updated results.</p>
                  ) : (
                    review &&
                    !manual.error &&
                    (review.approval.diagnostics.some(
                      (item) => item.code !== 'SANDBOX_TESTS_MISSING',
                    ) ? (
                      <ul>
                        {review.approval.diagnostics
                          .filter((item) => item.code !== 'SANDBOX_TESTS_MISSING')
                          .map((item, index) => (
                            <li key={index}>
                              <span>{item.message}</span>
                            </li>
                          ))}
                      </ul>
                    ) : (
                      <p>No validation issues found.</p>
                    ))
                  )}
                </section>
              )}
              {manual.document.trigger.type === 'webhook' && (
                <aside className="wf-webhook-help">
                  <strong>Start from a webhook</strong>
                  <p>
                    After approval and activation, send a JSON object to your environment’s ingest
                    gateway at <code>/webhooks/{workflowId}</code>. Use the gateway’s configured
                    bearer token and an <code>X-Delivery-Id</code> header to avoid duplicate runs.
                    The gateway returns an accepted command ID while the workflow runs.
                  </p>
                </aside>
              )}
            </div>
          ) : undefined
        }
        {...(diagramPreview.status !== 'hidden'
          ? {
              graph: (
                <WorkflowDiagram
                  drawer={capabilityDrawer}
                  {...(checkFailure?.stepId
                    ? {
                        failedStep: {
                          stepId: checkFailure.stepId,
                          message: checkFailure.graphMark,
                        },
                      }
                    : {})}
                  onCloseDrawer={closeCapabilityEvidence}
                  onOpenNode={openNode}
                  preview={diagramPreview}
                  targets={targetDiagramDiagnostics(
                    diagramPreview.status === 'server' && !reviewFromBuilder
                      ? (review?.approval.diagnostics ?? [])
                      : [],
                    review?.graph ?? { nodes: [], edges: [] },
                  )}
                />
              ),
            }
          : {})}
      >
        {drafting.phase === 'clarification_required' && drafting.interpretedRequest && (
          <RequestInterpretation
            annotations={drafting.interpretedRequestAnnotations ?? []}
            identities={referenceIdentities}
            interpretedRequest={drafting.interpretedRequest}
            onOpenCapability={openReferencedCapability}
          />
        )}
        {(drafting.phase === 'drafting' || draftProgress) && (
          <DraftProgress
            progress={draftProgress}
            connectionLost={draftConnectionLost}
            key={drafting.requestId}
            onCancel={cancelActiveDraft}
          />
        )}
        {checkFailure && (
          <CheckFailurePanel
            canDraft={canDraft}
            disabled={busy}
            explanation={checkFailure}
            onAcceptFix={(fix) => void reviseDraftWithPrompt(fix, { ignoreUnsaved: true })}
          />
        )}
        {drafting.phase === 'clarification_required' && (
          <ClarificationPanel
            key={drafting.requestId}
            answer={clarificationAnswer}
            canDraft={canDraft}
            diagnostics={drafting.validation?.diagnostics ?? []}
            disabled={busy}
            identities={referenceIdentities}
            {...(drafting.mapping ? { mapping: drafting.mapping } : {})}
            onAnswerChange={changeAnswer}
            onOpenCapability={openReferencedCapability}
            onSubmitAnswer={(answer) => void submitAnswer(answer)}
            question={drafting.question ?? ''}
            questionAnnotations={drafting.questionAnnotations ?? []}
            suggestedAnswerAnnotations={drafting.suggestedAnswerAnnotations ?? []}
            {...(drafting.suggestedAnswerSelections
              ? { suggestedAnswerSelections: drafting.suggestedAnswerSelections }
              : {})}
            suggestedAnswers={drafting.suggestedAnswers ?? []}
          />
        )}
        {drafting.phase === 'unsupported' && (
          <BlockedOutcome
            identities={referenceIdentities}
            phase="unsupported"
            {...(drafting.reason ? { reason: drafting.reason } : {})}
          />
        )}
        {drafting.phase === 'manual_review' && (
          <BlockedOutcome
            identities={referenceIdentities}
            phase="manual_review"
            {...((drafting.detail ?? drafting.reason)
              ? { detail: drafting.detail ?? drafting.reason }
              : {})}
            {...(drafting.validation?.diagnostics
              ? { diagnostics: drafting.validation.diagnostics }
              : {})}
            {...(drafting.reason ? { reason: drafting.reason } : {})}
          />
        )}
      </WorkflowCompose>

      {(draftProgress || drafting.phase === 'drafting') && (
        <ModelTraces
          key={draftProgress?.requestId ?? drafting.requestId}
          progress={draftProgress}
          id={tracesId}
          collapsed={tracesCollapsed}
          onCollapse={() => setTracesCollapsed(true)}
          onExpand={() => setTracesCollapsed(false)}
        />
      )}

      {review && (
        <section
          className="wf-evidence"
          aria-label={editorMode === 'ai' ? 'Validate and modify' : 'Workflow checks'}
        >
          <div data-ai-review hidden={editorMode !== 'ai'}>
            <header className="wf-evidence-heading">
              <div>
                <h2>Validate and modify</h2>
                <p>Run validation checks or adjust this workflow before approval.</p>
              </div>
              <span className={review.approval.enabled ? 'wf-ready' : 'wf-awaiting-approval'}>
                {review.approval.enabled ? 'Ready for approval' : 'Awaiting approval'}
              </span>
            </header>

            {aiProposal?.state.draft && (
              <section className="wf-ai-proposal" aria-label="Proposed AI changes">
                <h3>Review proposed changes</h3>
                <ul>
                  {workflowEditSummary(
                    reviewRequest?.draft.executable,
                    aiProposal.state.draft.executable,
                  ).map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
                <details>
                  <summary>Inspect proposed workflow</summary>
                  <pre>{JSON.stringify(aiProposal.state.draft.executable, null, 2)}</pre>
                </details>
                <button
                  type="button"
                  disabled={busy || manual.busy || hasUnvalidatedChanges}
                  onClick={() => void acceptAiProposal()}
                >
                  Apply changes
                </button>
                <button
                  type="button"
                  className="wf-action"
                  disabled={busy}
                  onClick={keepCurrentWorkflow}
                >
                  Keep current workflow
                </button>
              </section>
            )}

            <WorkflowPlanReview
              key={`${organizationId}:${environmentId}:${workflowId}`}
              canDraft={canDraft}
              {...(editError ? { editError } : {})}
              {...(editMessage ? { editMessage } : {})}
              followUp={revisionPrompt}
              hasUnvalidatedChanges={hasUnvalidatedChanges}
              isBusy={busy || manual.busy}
              onFollowUpChange={changeRevisionPrompt}
              {...(editorMode === 'ai' ? { onOpenBuilder: () => changeEditorMode('builder') } : {})}
              onRevise={() => void reviseDraftWithPrompt()}
              onValidateSource={() => void validateSource()}
              onYamlChange={editSource}
              yaml={artifactYaml}
            >
              {drafting.revealValidated &&
                drafting.clarifiedRequest &&
                drafting.originalRequest && (
                  <ValidatedRequestView
                    annotations={drafting.annotations ?? []}
                    clarifiedRequest={drafting.clarifiedRequest}
                    identities={referenceIdentities}
                    originalRequest={drafting.originalRequest}
                    onOpenCapability={openReferencedCapability}
                  />
                )}
            </WorkflowPlanReview>
          </div>

          <WorkflowChecks
            approval={affordance ?? { enabled: false, reason: null }}
            {...(approvalMessage ? { approvalMessage } : {})}
            busy={busy || manual.busy}
            {...(sandbox.error ? { error: sandbox.error } : {})}
            hasUnvalidatedChanges={hasUnvalidatedChanges}
            identities={referenceIdentities}
            onApprove={() => void approve()}
            {...(sandbox.progress ? { progress: sandbox.progress } : {})}
            onCancelChecks={() => void cancelActiveChecks()}
            onRunChecks={() => void runSandboxTests()}
            {...(sandbox.result
              ? { result: { status: sandbox.result.status, tests: sandbox.result.tests } }
              : {})}
            role={role}
            status={sandbox.status}
          />
        </section>
      )}

      {capabilityDrawer.capabilityVersionId && (
        <OperationEvidenceDrawer
          capabilityVersionId={capabilityDrawer.capabilityVersionId}
          environmentId={environmentId}
          onClose={closeCapabilityEvidence}
          onSelectVersion={selectCapabilityVersion}
          organizationId={organizationId}
          role={role}
        />
      )}
    </div>
  );
}
