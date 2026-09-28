export interface MarqueeCapability {
  capabilityVersionId: string;
  kind: 'openapi' | 'asyncapi';
  serviceId: string;
  operationId: string;
  owner: string;
}

export function CapabilityMarquee({
  capabilities,
  onOpenCapability,
}: {
  capabilities: MarqueeCapability[];
  onOpenCapability: (capabilityVersionId: string) => void;
}) {
  if (capabilities.length === 0) return null;

  const rows = [
    capabilities.filter((_, index) => index % 2 === 0),
    capabilities.filter((_, index) => index % 2 === 1),
  ];
  if (rows[1]?.length === 0) rows[1] = capabilities;

  return (
    <section
      aria-label="Available capabilities you can use in this workflow"
      className="wf-capability-marquee"
    >
      <div className="wf-capability-rows">
        {rows.map((row, rowIndex) => (
          <div className="wf-capability-row" key={rowIndex}>
            <div
              className={rowIndex === 0 ? 'wf-capability-track' : 'wf-capability-track is-reverse'}
            >
              <ul aria-label={`Available capabilities, row ${rowIndex + 1}`}>
                {row.map((capability) => (
                  <li key={capability.capabilityVersionId}>
                    <CapabilityCard capability={capability} onOpenCapability={onOpenCapability} />
                  </li>
                ))}
              </ul>
              <ul aria-hidden="true">
                {row.map((capability) => (
                  <li key={capability.capabilityVersionId}>
                    <CapabilityCard capability={capability} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CapabilityCard({
  capability,
  onOpenCapability,
}: {
  capability: MarqueeCapability;
  onOpenCapability?: (capabilityVersionId: string) => void;
}) {
  const content = (
    <>
      <span className="wf-capability-identity">
        <span className="cat-entity-label">Operation</span>
        <strong>{capability.operationId}</strong>
        <code>
          {capability.serviceId} · {capability.kind === 'openapi' ? 'OpenAPI' : 'AsyncAPI'}
        </code>
      </span>
      <span className="cat-operation-meta">
        <span className="cat-operation-owner">
          <small>Owner</small>
          {capability.owner}
        </span>
        <Chip tone="good">Annotated</Chip>
      </span>
      <span className="cat-operation-action">
        View details <span aria-hidden="true">→</span>
      </span>
    </>
  );

  return onOpenCapability ? (
    <button
      aria-label={`Open ${capability.serviceId} · ${capability.operationId} capability details`}
      className="cat-operation wf-capability-card"
      onClick={() => onOpenCapability(capability.capabilityVersionId)}
      title={capability.capabilityVersionId}
      type="button"
    >
      {content}
    </button>
  ) : (
    <div className="cat-operation wf-capability-card" title={capability.capabilityVersionId}>
      {content}
    </div>
  );
}
import { Chip } from '../capabilities/OperationEvidence.js';
