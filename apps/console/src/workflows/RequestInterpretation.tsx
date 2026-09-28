import { ReferencedText } from './ReferencedText.js';
import type {
  CandidateRequestAnnotation,
  VerifiedCapabilityIdentity,
} from './validated-request.js';

export function RequestInterpretation({
  annotations,
  identities = [],
  interpretedRequest,
  onOpenCapability,
}: {
  annotations: readonly CandidateRequestAnnotation[];
  identities?: readonly VerifiedCapabilityIdentity[];
  interpretedRequest: string;
  onOpenCapability?: (capabilityVersionId: string) => void;
}) {
  return (
    <section className="wf-request-interpretation" aria-label="Atlas interpretation">
      <div className="wf-panel-heading">
        <h3>Atlas interpretation</h3>
      </div>
      <p className="wf-validated-kicker">
        Your original request remains editable above. Atlas connected the highlighted phrases to
        authorized capabilities and fields.
      </p>
      <div className="wf-clarified-request">
        <ReferencedText
          annotations={annotations}
          identities={identities}
          {...(onOpenCapability ? { onOpenCapability } : {})}
          text={interpretedRequest}
        />
      </div>
    </section>
  );
}
