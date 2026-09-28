import { switchRoleToCreateWorkflow } from './conversation-copy.js';
import type { CheckFailureExplanation } from './check-failure.js';

export function CheckRunError({ error }: { error: string }) {
  return (
    <div className="wf-clarification">
      <div className="wf-question" role="alert">
        <strong>Checks could not run</strong>
        <p>{error}</p>
        <p>Atlas could not finish checks for this version.</p>
      </div>
    </div>
  );
}

export function CheckFailurePanel({
  canDraft,
  disabled = false,
  explanation,
  onAcceptFix,
}: {
  canDraft: boolean;
  disabled?: boolean;
  explanation: CheckFailureExplanation;
  onAcceptFix: (fix: string) => void;
}) {
  return (
    <div aria-busy={disabled || undefined} aria-live="polite" className="wf-clarification">
      <div className="wf-question" role="alert">
        <strong>Checks found a problem</strong>
        <p>{explanation.error}</p>
        <p>{explanation.why}</p>
      </div>
      {canDraft ? (
        <div aria-label="Suggested fix" className="wf-clarification-options">
          <button
            className="wf-clarification-option"
            disabled={disabled}
            onClick={() => onAcceptFix(explanation.suggestedFix)}
            type="button"
          >
            {explanation.suggestedFix}
          </button>
        </div>
      ) : (
        <p className="wf-role-note">{switchRoleToCreateWorkflow}</p>
      )}
    </div>
  );
}
