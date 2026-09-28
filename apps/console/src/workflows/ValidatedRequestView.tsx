import { ReferencedText } from './ReferencedText.js';
import type {
  CandidateRequestAnnotation,
  VerifiedCapabilityIdentity,
} from './validated-request.js';

export function ValidatedRequestView({
  annotations,
  clarifiedRequest,
  identities = [],
  onOpenCapability,
  originalRequest,
}: {
  annotations: readonly CandidateRequestAnnotation[];
  clarifiedRequest: string;
  identities?: readonly VerifiedCapabilityIdentity[];
  onOpenCapability?: (capabilityVersionId: string) => void;
  originalRequest: string;
}) {
  return (
    <div className="wf-validated-request">
      <section className="wf-request-column" aria-label="Original request">
        <div className="wf-panel-heading">
          <h3>Original request</h3>
        </div>
        <div className="wf-original-request">{originalRequest}</div>
      </section>
      <section className="wf-request-column" aria-label="Inferred request">
        <div className="wf-panel-heading">
          <h3>Inferred request</h3>
        </div>
        <div className="wf-clarified-request">
          <ReferencedText
            annotations={annotations}
            identities={identities}
            {...(onOpenCapability ? { onOpenCapability } : {})}
            text={clarifiedRequest}
          />
        </div>
        <p className="wf-validated-kicker">
          Atlas’s interpretation of your request. Highlighted phrases link to API actions and
          fields.
        </p>
      </section>
    </div>
  );
}
