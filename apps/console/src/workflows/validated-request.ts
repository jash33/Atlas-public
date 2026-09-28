import type { CapabilityObservation } from './capability-definition-status.js';

export interface VerifiedRequestEvidence {
  projectionFingerprint: string;
  capabilityVersionId: string;
  path?: string;
  matchedTerms: readonly string[];
}

export interface VerifiedRequestAnnotation {
  start: number;
  end: number;
  text: string;
  kind: 'capability' | 'requestField' | 'responseField';
  capabilityVersionId: string;
  direction?: 'request' | 'response';
  path?: string;
  evidence: VerifiedRequestEvidence;
}

export interface VerifiedRuntimeInputAnnotation {
  start: number;
  end: number;
  text: string;
  kind: 'runtimeInput';
  inputName: string;
  evidence: {
    intentFingerprint: string;
    source: 'intentFrame.requiredInputs';
  };
}

export type GroundedRequestAnnotation = VerifiedRequestAnnotation | VerifiedRuntimeInputAnnotation;

export type CandidateRequestAnnotation =
  | (Omit<VerifiedRequestAnnotation, 'evidence'> & { evidence?: VerifiedRequestEvidence })
  | VerifiedRuntimeInputAnnotation;

export interface VerifiedCapabilityIdentity {
  capabilityVersionId: string;
  serviceId: string;
  operationId: string;
  owner?: string;
  observation?: CapabilityObservation;
}

export interface VerifiedCapabilityReferenceTooltip {
  capabilityVersionId: string;
  serviceId?: string;
  operationId?: string;
  owner?: string;
  observation?: CapabilityObservation;
  kind: VerifiedRequestAnnotation['kind'];
  direction?: 'request' | 'response';
  path?: string;
}

export interface VerifiedRuntimeInputTooltip {
  kind: 'runtimeInput';
  inputName: string;
  label: 'Runtime input';
}

export type VerifiedReferenceTooltip =
  | VerifiedCapabilityReferenceTooltip
  | VerifiedRuntimeInputTooltip;

export type VerifiedRequestSegment =
  | { type: 'text'; value: string }
  | {
      type: 'verified-reference';
      value: string;
      annotation: GroundedRequestAnnotation;
      tooltip: VerifiedReferenceTooltip;
    };

export function verifiedReferenceTooltip(
  annotation: CandidateRequestAnnotation,
  identities: readonly VerifiedCapabilityIdentity[] = [],
): VerifiedReferenceTooltip | null {
  if (isRuntimeInputAnnotation(annotation)) {
    return { kind: 'runtimeInput', inputName: annotation.inputName, label: 'Runtime input' };
  }
  if (!isVerifiedAnnotation(annotation)) return null;
  const identity = identities.find(
    (candidate) => candidate.capabilityVersionId === annotation.capabilityVersionId,
  );
  return {
    capabilityVersionId: annotation.capabilityVersionId,
    kind: annotation.kind,
    ...(identity
      ? {
          serviceId: identity.serviceId,
          operationId: identity.operationId,
          ...(identity.owner ? { owner: identity.owner } : {}),
          ...(identity.observation ? { observation: identity.observation } : {}),
        }
      : {}),
    ...(annotation.direction ? { direction: annotation.direction } : {}),
    ...(annotation.path ? { path: annotation.path } : {}),
  };
}

export function verifiedRequestSegments(
  clarifiedRequest: string,
  annotations: readonly CandidateRequestAnnotation[],
  identities: readonly VerifiedCapabilityIdentity[] = [],
): VerifiedRequestSegment[] {
  const segments: VerifiedRequestSegment[] = [];
  let cursor = 0;
  const verified = annotations
    .filter(
      (annotation): annotation is GroundedRequestAnnotation =>
        (isVerifiedAnnotation(annotation) || isRuntimeInputAnnotation(annotation)) &&
        annotation.start >= 0 &&
        annotation.start < annotation.end &&
        annotation.end <= clarifiedRequest.length &&
        clarifiedRequest.slice(annotation.start, annotation.end) === annotation.text,
    )
    .sort((left, right) => left.start - right.start);
  const grouped = coalesceQualifiedCapabilityAnnotations(clarifiedRequest, verified);

  for (const annotation of grouped) {
    if (annotation.start < cursor) continue;
    if (annotation.start > cursor) {
      segments.push({ type: 'text', value: clarifiedRequest.slice(cursor, annotation.start) });
    }
    const tooltip = verifiedReferenceTooltip(annotation, identities);
    if (!tooltip) continue;
    segments.push({
      type: 'verified-reference',
      value: annotation.text,
      annotation,
      tooltip,
    });
    cursor = annotation.end;
  }
  if (cursor < clarifiedRequest.length) {
    segments.push({ type: 'text', value: clarifiedRequest.slice(cursor) });
  }
  return segments;
}

function coalesceQualifiedCapabilityAnnotations(
  text: string,
  annotations: readonly GroundedRequestAnnotation[],
) {
  const grouped: GroundedRequestAnnotation[] = [];
  for (const annotation of annotations) {
    const previous = grouped.at(-1);
    if (
      previous?.kind === 'capability' &&
      annotation.kind === 'capability' &&
      previous.capabilityVersionId === annotation.capabilityVersionId &&
      text.slice(previous.end, annotation.start) === '.'
    ) {
      grouped[grouped.length - 1] = {
        ...previous,
        end: annotation.end,
        text: text.slice(previous.start, annotation.end),
        evidence: {
          ...previous.evidence,
          matchedTerms: [
            ...new Set([...previous.evidence.matchedTerms, ...annotation.evidence.matchedTerms]),
          ],
        },
      };
      continue;
    }
    grouped.push(annotation);
  }
  return grouped;
}

function isVerifiedAnnotation(
  annotation: CandidateRequestAnnotation,
): annotation is VerifiedRequestAnnotation {
  if (annotation.kind === 'runtimeInput') return false;
  const evidence = annotation.evidence;
  return Boolean(
    evidence &&
    typeof evidence.projectionFingerprint === 'string' &&
    typeof evidence.capabilityVersionId === 'string' &&
    Array.isArray(evidence.matchedTerms),
  );
}

function isRuntimeInputAnnotation(
  annotation: CandidateRequestAnnotation,
): annotation is VerifiedRuntimeInputAnnotation {
  return (
    annotation.kind === 'runtimeInput' &&
    typeof annotation.inputName === 'string' &&
    annotation.evidence.source === 'intentFrame.requiredInputs' &&
    typeof annotation.evidence.intentFingerprint === 'string'
  );
}
