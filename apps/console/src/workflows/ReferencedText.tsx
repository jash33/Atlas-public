import { useEffect, useId, useRef, useState } from 'react';
import {
  lastKnownDefinitionMessage,
  usesLastKnownDefinition,
} from './capability-definition-status.js';

import {
  verifiedRequestSegments,
  type CandidateRequestAnnotation,
  type VerifiedCapabilityIdentity,
  type VerifiedReferenceTooltip,
} from './validated-request.js';

function tooltipLabel(tooltip: VerifiedReferenceTooltip, fallbackName: string) {
  if (tooltip.kind === 'runtimeInput') return tooltip.label;
  const identity =
    tooltip.serviceId && tooltip.operationId
      ? `${tooltip.serviceId} · ${tooltip.operationId}`
      : tooltip.operationId || fallbackName;
  const field = [tooltip.direction, tooltip.path].filter(Boolean).join(' ');
  return field ? `${identity} · ${field}` : identity;
}

function referenceKindLabel(tooltip: VerifiedReferenceTooltip) {
  if (tooltip.kind === 'runtimeInput') return tooltip.label;
  if (tooltip.kind === 'capability') return 'Capability';
  return tooltip.kind === 'requestField' ? 'Request field' : 'Response field';
}

function referenceLabel(tooltip: VerifiedReferenceTooltip, fallbackName: string) {
  if (tooltip.kind === 'runtimeInput') return `${tooltip.label}: ${tooltip.inputName}`;
  return `${referenceKindLabel(tooltip)}: ${tooltipLabel(tooltip, fallbackName)}${usesLastKnownDefinition(tooltip.observation) ? ' · Last known definition' : ''}`;
}

export function ReferencedText({
  annotations,
  identities = [],
  onOpenCapability,
  text,
}: {
  annotations: readonly CandidateRequestAnnotation[];
  identities?: readonly VerifiedCapabilityIdentity[];
  onOpenCapability?: (capabilityVersionId: string) => void;
  text: string;
}) {
  const segments = verifiedRequestSegments(text, annotations, identities);
  const [activeReference, setActiveReference] = useState<string | null>(null);
  const [hoveredReference, setHoveredReference] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  const popoverIdPrefix = useId();
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!activeReference) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setActiveReference(null);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [activeReference]);

  return (
    <span className="wf-referenced-text" ref={rootRef}>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <span key={`text:${index}`}>{segment.value}</span>
        ) : (
          (() => {
            const capabilityVersionId =
              segment.tooltip.kind === 'runtimeInput' ? null : segment.tooltip.capabilityVersionId;
            const capabilityName =
              segment.annotation.kind === 'capability'
                ? segment.value
                : (annotations.find(
                    (annotation) =>
                      annotation.kind === 'capability' &&
                      annotation.capabilityVersionId === capabilityVersionId,
                  )?.text ?? 'Referenced capability');
            const referenceKey = `${segment.annotation.start}:${segment.annotation.end}`;
            const popoverId = `${popoverIdPrefix}-${index}`;
            const expanded = (hoveredReference ?? activeReference) === referenceKey;
            return (
              <span
                className="wf-reference-popover-anchor"
                onMouseEnter={() => {
                  clearTimeout(hoverTimer.current);
                  setHoveredReference(referenceKey);
                }}
                onMouseLeave={() => {
                  hoverTimer.current = setTimeout(() => setHoveredReference(null), 150);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setActiveReference(null);
                    setHoveredReference(null);
                  }
                }}
                key={`ref:${referenceKey}:${
                  segment.annotation.kind === 'runtimeInput'
                    ? segment.annotation.inputName
                    : segment.annotation.capabilityVersionId
                }`}
              >
                <mark
                  aria-controls={popoverId}
                  aria-expanded={expanded}
                  aria-haspopup="dialog"
                  aria-label={referenceLabel(segment.tooltip, capabilityName)}
                  className={
                    segment.annotation.kind === 'runtimeInput'
                      ? 'wf-ref wf-ref-verified wf-ref-runtime-input wf-ref-identified-input'
                      : 'wf-ref wf-ref-verified wf-ref-identified-reference'
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setActiveReference((current) =>
                      current === referenceKey ? null : referenceKey,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    setActiveReference((current) =>
                      current === referenceKey ? null : referenceKey,
                    );
                  }}
                  role="button"
                  tabIndex={0}
                >
                  {segment.value}
                </mark>
                {expanded && (
                  <span
                    aria-label={`${referenceKindLabel(segment.tooltip)} details`}
                    className="wf-reference-popover"
                    id={popoverId}
                    role="dialog"
                  >
                    <strong>{referenceKindLabel(segment.tooltip)}</strong>
                    <span>{tooltipLabel(segment.tooltip, capabilityName)}</span>
                    {'owner' in segment.tooltip && segment.tooltip.owner && (
                      <small>Owner: {segment.tooltip.owner}</small>
                    )}
                    {'observation' in segment.tooltip &&
                      usesLastKnownDefinition(segment.tooltip.observation) && (
                        <small>{lastKnownDefinitionMessage}</small>
                      )}
                    <span className="wf-reference-popover-actions">
                      {capabilityVersionId && onOpenCapability && (
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            setActiveReference(null);
                            setHoveredReference(null);
                            onOpenCapability(capabilityVersionId);
                          }}
                          type="button"
                        >
                          View capability
                        </button>
                      )}
                      <button
                        aria-label="Close annotation details"
                        onClick={(event) => {
                          event.stopPropagation();
                          setActiveReference(null);
                          setHoveredReference(null);
                        }}
                        type="button"
                      >
                        Close
                      </button>
                    </span>
                  </span>
                )}
              </span>
            );
          })()
        ),
      )}
    </span>
  );
}
