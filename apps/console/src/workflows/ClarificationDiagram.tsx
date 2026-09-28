import { clarificationDiagram } from './clarification-diagram.js';
import type { ClarificationMapping, SuggestedAnswerSelection } from './drafting-state.js';
import type { VerifiedCapabilityIdentity } from './validated-request.js';

export function ClarificationDiagram({
  answer,
  identities,
  mapping,
  selection,
}: {
  answer: string;
  identities: readonly VerifiedCapabilityIdentity[];
  mapping: ClarificationMapping;
  selection: SuggestedAnswerSelection;
}) {
  const diagram = clarificationDiagram({ identities, mapping, selection });

  return (
    <span className="wf-clarification-preview" aria-label={`Proposed mapping for ${answer}`}>
      <span className="wf-clarification-preview-inner">
        <span className="wf-clarification-preview-heading">
          <span>Proposed mapping</span>
          <small>Hover or focus to compare</small>
        </span>
        <span className="wf-clarification-preview-change">
          <b>{diagram.sourceLabel}</b>
          <span aria-hidden="true">→</span>
          <b>{diagram.focusLabel}</b>
        </span>
        <span className="wf-clarification-preview-flow">
          {diagram.nodes.map((node, index) => (
            <span className="wf-clarification-preview-step-wrap" key={node.id}>
              {index > 0 && <span className="wf-clarification-preview-arrow">→</span>}
              <span
                className={[
                  'wf-clarification-preview-step',
                  node.focus ? 'is-focus' : '',
                  node.source ? 'is-source' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <small>{node.kind === 'capability' ? 'Step' : node.kind}</small>
                <strong>{node.label}</strong>
                <span>{node.detail}</span>
              </span>
            </span>
          ))}
        </span>
        <small className="wf-clarification-preview-note">
          Mapping only — Atlas validates the full workflow after you choose.
        </small>
      </span>
    </span>
  );
}
