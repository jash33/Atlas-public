import { useState } from 'react';

import { ClarificationDiagram } from './ClarificationDiagram.js';
import { switchRoleToCreateWorkflow } from './conversation-copy.js';
import type {
  ClarificationMapping,
  GroundedDraftAnnotation,
  SuggestedAnswerAnnotations,
  SuggestedAnswerSelection,
} from './drafting-state.js';
import { ReferencedText } from './ReferencedText.js';
import type { VerifiedCapabilityIdentity } from './validated-request.js';

export function ClarificationPanel({
  answer,
  canDraft,
  diagnostics = [],
  disabled,
  onAnswerChange,
  onOpenCapability,
  onSubmitAnswer,
  question,
  questionAnnotations = [],
  identities = [],
  mapping,
  suggestedAnswerAnnotations = [],
  suggestedAnswerSelections = [],
  suggestedAnswers,
}: {
  answer: string;
  canDraft: boolean;
  diagnostics?: Array<{ code: string; path: string; message: string }>;
  disabled: boolean;
  onAnswerChange: (value: string) => void;
  onOpenCapability?: (capabilityVersionId: string) => void;
  onSubmitAnswer: (answer: string) => void;
  question: string;
  questionAnnotations?: readonly GroundedDraftAnnotation[];
  identities?: readonly VerifiedCapabilityIdentity[];
  mapping?: ClarificationMapping;
  suggestedAnswerAnnotations?: readonly SuggestedAnswerAnnotations[];
  suggestedAnswerSelections?: readonly SuggestedAnswerSelection[];
  suggestedAnswers: readonly string[];
}) {
  const [showCustomAnswer, setShowCustomAnswer] = useState(suggestedAnswers.length === 0);

  return (
    <div aria-busy={disabled || undefined} aria-live="polite" className="wf-clarification">
      <div className="wf-question">
        <strong>Atlas needs one detail</strong>
        <p>
          <ReferencedText
            annotations={questionAnnotations}
            identities={identities}
            {...(onOpenCapability ? { onOpenCapability } : {})}
            text={question}
          />
        </p>
      </div>
      {diagnostics.length > 0 && (
        <details className="wf-clarification-details">
          <summary>Technical details</summary>
          <ul className="wf-inline-diagnostics">
            {diagnostics.map((diagnostic) => (
              <li key={`${diagnostic.code}:${diagnostic.path}`}>
                <code>{diagnostic.code}</code> · {diagnostic.path} · {diagnostic.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {canDraft ? (
        <>
          <div className="wf-clarification-options" aria-label="Suggested answers">
            {suggestedAnswers.map((suggestion) => {
              const answerAnnotations =
                suggestedAnswerAnnotations.find(({ answer }) => answer === suggestion)
                  ?.annotations ?? [];
              const selection = suggestedAnswerSelections.find(
                ({ answer }) => answer === suggestion,
              );
              return (
                <button
                  className="wf-clarification-option"
                  disabled={disabled}
                  key={suggestion}
                  onClick={() => onSubmitAnswer(suggestion)}
                  type="button"
                >
                  <ReferencedText
                    annotations={answerAnnotations}
                    identities={identities}
                    {...(onOpenCapability ? { onOpenCapability } : {})}
                    text={suggestion}
                  />
                  {mapping && selection && (
                    <ClarificationDiagram
                      answer={suggestion}
                      identities={identities}
                      mapping={mapping}
                      selection={selection}
                    />
                  )}
                </button>
              );
            })}
            <button
              aria-expanded={showCustomAnswer}
              className="wf-clarification-option wf-clarification-option-custom"
              disabled={disabled}
              onClick={() => setShowCustomAnswer(true)}
              type="button"
            >
              Write my own
            </button>
          </div>
          {showCustomAnswer && (
            <div className="wf-clarification-custom">
              <label htmlFor="workflow-clarification-answer">Your answer</label>
              <textarea
                autoFocus
                id="workflow-clarification-answer"
                onChange={(event) => onAnswerChange(event.target.value)}
                rows={1}
                value={answer}
              />
              <button
                disabled={disabled || !answer.trim()}
                onClick={() => onSubmitAnswer(answer)}
                type="button"
              >
                Submit answer
              </button>
            </div>
          )}
        </>
      ) : (
        <p className="wf-role-note">{switchRoleToCreateWorkflow}</p>
      )}
    </div>
  );
}
