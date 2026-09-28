import { z } from 'zod';

import {
  matchCapabilityReferences,
  plannerCapabilityReferenceIndex,
  type FieldDirection,
  type PlannerCapabilityReference,
} from './capability-reference-index.js';

export const annotationKindSchema = z.enum(['capability', 'requestField', 'responseField']);

export const proposedAnnotationSchema = z
  .object({
    start: z.number().int(),
    end: z.number().int(),
    text: z.string().min(1),
    kind: annotationKindSchema,
    capabilityVersionId: z.string().min(1),
    direction: z.enum(['request', 'response']).optional(),
    path: z.string().min(1).optional(),
  })
  .strict();

export type ProposedAnnotation = z.infer<typeof proposedAnnotationSchema>;

export interface AnnotationEvidence {
  readonly projectionFingerprint: string;
  readonly capabilityVersionId: string;
  readonly path?: string;
  readonly matchedTerms: readonly string[];
}

export interface VerifiedAnnotation extends ProposedAnnotation {
  readonly evidence: AnnotationEvidence;
}

export type AnnotationVerification =
  | { status: 'verified'; annotations: VerifiedAnnotation[] }
  | {
      status: 'clarification_required';
      reason: 'duplicate-field-candidates' | 'missing-business-fact';
      question: string;
      suggestedAnswers: [string, string, string];
    }
  | {
      status: 'rejected';
      reason:
        | 'unknown-capability'
        | 'malformed-annotation'
        | 'html-not-allowed'
        | 'unsupported-behavior';
      detail: string;
    };

export type AnnotationProjection = {
  fingerprint: string;
  capabilities: Array<{
    capabilityVersionId: string;
    identity: {
      kind: 'openapi' | 'asyncapi';
      serviceId: string;
      operationId: string;
      channelAddress?: string;
      messageKey?: string;
    };
    fragment: unknown;
    annotation: {
      owner: string;
      businessSemantics: Record<string, unknown> | null;
      idempotencyField: string | null;
      compensatedBy: PlannerCapabilityReference['safety']['compensatedBy'];
      irreversibleAfter: boolean | null;
    };
  }>;
};

const htmlMarkup = /<\/?[a-z][\s\S]*>/i;

export function containsHtmlMarkup(value: string) {
  return htmlMarkup.test(value);
}

function tokenize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function normalizeTerm(value: string) {
  return value.toLowerCase().replace(/[-_]/g, '');
}

function referenceText(value: string) {
  return value.startsWith('@') ? value.slice(1) : value;
}

function groundedTokens(originalRequest: string, answers: readonly string[]) {
  return new Set(tokenize([originalRequest, ...answers].join(' ')));
}

function capabilityMentionTokens(reference: PlannerCapabilityReference) {
  return new Set([
    ...tokenize(reference.identity.operationId),
    ...tokenize(reference.identity.serviceId),
    ...reference.fields.flatMap((field) => tokenize(field.label)),
    normalizeTerm(reference.identity.operationId),
    normalizeTerm(reference.identity.serviceId),
  ]);
}

function hasGroundedOverlap(reference: PlannerCapabilityReference, grounded: Set<string>) {
  const mentions = capabilityMentionTokens(reference);
  return [...mentions].some((token) => token.length > 2 && grounded.has(token));
}

function matchedTermsFor(text: string, searchTerms: readonly string[]) {
  const terms = new Set<string>();
  const normalized = normalizeTerm(text);
  if (searchTerms.includes(normalized) || searchTerms.includes(text.toLowerCase())) {
    terms.add(normalized);
  }
  for (const token of tokenize(text)) {
    if (searchTerms.some((term) => term === token || term.startsWith(token))) terms.add(token);
  }
  if (searchTerms.includes(normalized)) terms.add(normalized);
  return [...terms];
}

function expectedDirection(kind: ProposedAnnotation['kind']): FieldDirection | undefined {
  if (kind === 'requestField') return 'request';
  if (kind === 'responseField') return 'response';
  return undefined;
}

function exactRanges(text: string, term: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  const source = text.toLowerCase();
  const needle = term.toLowerCase();
  let from = 0;
  while (needle && from <= source.length - needle.length) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    const end = start + needle.length;
    const before = start === 0 ? '' : text[start - 1];
    const after = end >= text.length ? '' : text[end];
    if (!/[A-Za-z0-9_-]/.test(before ?? '') && !/[A-Za-z0-9_-]/.test(after ?? '')) {
      ranges.push({ start, end });
    }
    from = start + 1;
  }
  return ranges;
}

function referenceRanges(text: string, term: string) {
  const words = tokenize(term);
  if (words.length < 2) return exactRanges(text, term);
  const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]*');
  const ranges = [...text.matchAll(new RegExp(pattern, 'gi'))]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .filter(({ start, end }) => {
      const before = start === 0 ? '' : text[start - 1];
      const after = end >= text.length ? '' : text[end];
      return !/[A-Za-z0-9_-]/.test(before ?? '') && !/[A-Za-z0-9_-]/.test(after ?? '');
    });
  return [...new Map(ranges.map((range) => [`${range.start}:${range.end}`, range])).values()];
}

function pointerLabel(path: string) {
  return path.split('/').filter(Boolean).at(-1)?.replaceAll('~1', '/').replaceAll('~0', '~');
}

function capabilityAliases(reference: PlannerCapabilityReference) {
  return [
    reference.identity.serviceId,
    reference.identity.channelAddress,
    reference.identity.messageKey,
    reference.owner,
  ].filter((term): term is string => Boolean(term && tokenize(term).join('').length > 2));
}

export function verifiedReferencesInText(input: {
  projection: AnnotationProjection;
  text: string;
  context?: string;
}): VerifiedAnnotation[] {
  const index = plannerCapabilityReferenceIndex(input.projection);
  if (index.status !== 'ok') return [];
  const annotations: VerifiedAnnotation[] = [];
  const mentionedCapabilities = new Set<string>();

  for (const reference of index.references) {
    if (
      input.context &&
      referenceRanges(input.context, reference.identity.operationId).length > 0
    ) {
      mentionedCapabilities.add(reference.capabilityVersionId);
    }
    for (const range of referenceRanges(input.text, reference.identity.operationId)) {
      mentionedCapabilities.add(reference.capabilityVersionId);
      annotations.push({
        ...range,
        text: input.text.slice(range.start, range.end),
        kind: 'capability',
        capabilityVersionId: reference.capabilityVersionId,
        evidence: {
          projectionFingerprint: input.projection.fingerprint,
          capabilityVersionId: reference.capabilityVersionId,
          matchedTerms: [normalizeTerm(reference.identity.operationId)],
        },
      });
    }
  }

  const aliasCandidates = index.references.flatMap((reference) =>
    capabilityAliases(reference).flatMap((term) =>
      referenceRanges(input.text, term).map((range) => ({ reference, range })),
    ),
  );
  const contextAliasCandidates = input.context
    ? index.references.flatMap((reference) =>
        capabilityAliases(reference).flatMap((term) =>
          referenceRanges(input.context!, term).map((range) => ({ reference, range })),
        ),
      )
    : [];
  for (const matches of Map.groupBy(
    contextAliasCandidates,
    ({ range }) => `${range.start}:${range.end}`,
  ).values()) {
    const capabilityIds = new Set(matches.map(({ reference }) => reference.capabilityVersionId));
    if (capabilityIds.size === 1) mentionedCapabilities.add([...capabilityIds][0]!);
  }
  for (const matches of Map.groupBy(
    aliasCandidates,
    ({ range }) => `${range.start}:${range.end}`,
  ).values()) {
    const narrowed = matches.filter(
      ({ reference }) =>
        mentionedCapabilities.size === 0 ||
        mentionedCapabilities.has(reference.capabilityVersionId),
    );
    const unique = [
      ...new Map(narrowed.map((match) => [match.reference.capabilityVersionId, match])).values(),
    ];
    if (unique.length !== 1) continue;
    const { reference, range } = unique[0]!;
    if (
      annotations.some((annotation) => range.start < annotation.end && annotation.start < range.end)
    )
      continue;
    mentionedCapabilities.add(reference.capabilityVersionId);
    annotations.push({
      ...range,
      text: input.text.slice(range.start, range.end),
      kind: 'capability',
      capabilityVersionId: reference.capabilityVersionId,
      evidence: {
        projectionFingerprint: input.projection.fingerprint,
        capabilityVersionId: reference.capabilityVersionId,
        matchedTerms: [normalizeTerm(input.text.slice(range.start, range.end))],
      },
    });
  }

  const referenceContext = `${input.context ?? ''} ${input.text}`;
  const direction =
    /\b(request field|input|lookup|argument|runtime|suppl(?:y|ied)|identif(?:y|ied))\b/i.test(
      referenceContext,
    )
      ? 'request'
      : /\b(response field|output|result|return(?:ed)?)\b/i.test(referenceContext)
        ? 'response'
        : undefined;
  const candidates = index.references.flatMap((reference) =>
    reference.fields.flatMap((field) => {
      const terms = new Set([field.label, pointerLabel(field.path)].filter(Boolean) as string[]);
      return [...terms].flatMap((term) =>
        referenceRanges(input.text, term).map((range) => ({ reference, field, range })),
      );
    }),
  );
  const grouped = Map.groupBy(candidates, ({ range }) => `${range.start}:${range.end}`);
  for (const matches of grouped.values()) {
    const narrowed = matches.filter(
      ({ reference, field }) =>
        (mentionedCapabilities.size === 0 ||
          mentionedCapabilities.has(reference.capabilityVersionId)) &&
        (!direction || field.direction === direction),
    );
    const unique = [
      ...new Map(
        narrowed.map((match) => [
          `${match.field.capabilityVersionId}:${match.field.direction}:${match.field.path}`,
          match,
        ]),
      ).values(),
    ];
    if (unique.length !== 1) continue;
    const { field, range } = unique[0]!;
    if (
      annotations.some((annotation) => range.start < annotation.end && annotation.start < range.end)
    )
      continue;
    annotations.push({
      ...range,
      text: input.text.slice(range.start, range.end),
      kind: field.direction === 'request' ? 'requestField' : 'responseField',
      capabilityVersionId: field.capabilityVersionId,
      direction: field.direction,
      path: field.path,
      evidence: {
        projectionFingerprint: input.projection.fingerprint,
        capabilityVersionId: field.capabilityVersionId,
        path: field.path,
        matchedTerms: [normalizeTerm(input.text.slice(range.start, range.end))],
      },
    });
  }
  return annotations.sort((left, right) => left.start - right.start);
}

function suggestedReferenceAnswers(
  matches: ReturnType<typeof matchCapabilityReferences>,
  text: string,
): [string, string, string] {
  const matched = matches.map((match) =>
    match.path
      ? `Use ${match.identity.operationId} ${match.direction} field ${match.path}`
      : `Use ${match.identity.operationId}`,
  );
  const distinct = [
    ...new Set([
      ...matched,
      `Use workflow input ${text}`,
      'Use another authorized source',
      `Keep ${text} as written`,
    ]),
  ].slice(0, 3);
  return [distinct[0]!, distinct[1]!, distinct[2]!];
}

export function verifyProposedAnnotations(input: {
  projection: AnnotationProjection;
  clarifiedRequest: string;
  originalRequest: string;
  answers?: readonly string[];
  proposed: unknown;
}): AnnotationVerification {
  if (containsHtmlMarkup(input.clarifiedRequest)) {
    return {
      status: 'rejected',
      reason: 'html-not-allowed',
      detail: 'The clarified request cannot contain HTML',
    };
  }
  const parsed = z.array(proposedAnnotationSchema).safeParse(input.proposed);
  if (!parsed.success) {
    return {
      status: 'rejected',
      reason: 'malformed-annotation',
      detail: 'Annotation proposals must be structured reference records',
    };
  }

  const index = plannerCapabilityReferenceIndex(input.projection);
  if (index.status !== 'ok') {
    return {
      status: 'rejected',
      reason: 'malformed-annotation',
      detail: 'Annotations cannot be verified against an unavailable projection',
    };
  }

  const grounded = groundedTokens(input.originalRequest, input.answers ?? []);
  if (parsed.data.length === 0) {
    const annotations = verifiedReferencesInText({
      projection: input.projection,
      text: input.clarifiedRequest,
      context: [input.originalRequest, ...(input.answers ?? [])].join(' '),
    }).filter((annotation) => {
      const reference = index.references.find(
        (candidate) => candidate.capabilityVersionId === annotation.capabilityVersionId,
      );
      return Boolean(reference && hasGroundedOverlap(reference, grounded));
    });
    return { status: 'verified', annotations };
  }

  const sorted = [...parsed.data].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  let previousEnd = 0;
  const verified: VerifiedAnnotation[] = [];

  for (const annotation of sorted) {
    if (containsHtmlMarkup(annotation.text)) {
      return {
        status: 'rejected',
        reason: 'html-not-allowed',
        detail: 'Annotation text cannot contain HTML',
      };
    }
    if (
      annotation.start < 0 ||
      annotation.start >= annotation.end ||
      annotation.end > input.clarifiedRequest.length ||
      input.clarifiedRequest.slice(annotation.start, annotation.end) !== annotation.text ||
      annotation.start < previousEnd
    ) {
      return {
        status: 'rejected',
        reason: 'malformed-annotation',
        detail: 'Annotation ranges must be in-bounds, exact, and non-overlapping',
      };
    }
    previousEnd = annotation.end;

    const reference = index.references.find(
      (candidate) => candidate.capabilityVersionId === annotation.capabilityVersionId,
    );
    if (!reference) {
      return {
        status: 'rejected',
        reason: 'unknown-capability',
        detail: 'Annotation capabilityVersionId is not in the active projection',
      };
    }
    if (!hasGroundedOverlap(reference, grounded)) {
      return {
        status: 'rejected',
        reason: 'unsupported-behavior',
        detail: 'Clarified request annotations cannot introduce unmentioned capabilities',
      };
    }

    const semanticText = referenceText(annotation.text);
    const textMatches = matchCapabilityReferences(index, semanticText);
    const direction = annotation.direction ?? expectedDirection(annotation.kind);

    if (annotation.kind === 'capability') {
      const matchedTerms = matchedTermsFor(semanticText, reference.searchTerms);
      verified.push({
        ...annotation,
        evidence: {
          projectionFingerprint: input.projection.fingerprint,
          capabilityVersionId: annotation.capabilityVersionId,
          matchedTerms:
            matchedTerms.length > 0
              ? matchedTerms
              : [normalizeTerm(reference.identity.operationId)],
        },
      });
      continue;
    }

    if (!annotation.path || !direction || direction !== expectedDirection(annotation.kind)) {
      const fieldMatches = textMatches.filter((match) => match.path !== undefined);
      if (fieldMatches.length > 1) {
        return {
          status: 'clarification_required',
          reason: 'duplicate-field-candidates',
          question: `Which ${annotation.kind === 'responseField' ? 'response' : 'request'} field does "${annotation.text}" refer to?`,
          suggestedAnswers: suggestedReferenceAnswers(fieldMatches, annotation.text),
        };
      }
      return {
        status: 'rejected',
        reason: 'malformed-annotation',
        detail: 'Field annotations require a unique capabilityVersionId, direction, and path',
      };
    }

    const field = reference.fields.find(
      (candidate) => candidate.direction === direction && candidate.path === annotation.path,
    );
    if (!field) {
      return {
        status: 'rejected',
        reason: 'unknown-capability',
        detail: 'Annotation field path is not in the cited capability',
      };
    }
    const fieldMatches = textMatches.filter(
      (match) => match.path !== undefined && match.direction === direction,
    );
    const pinned = fieldMatches.filter(
      (match) =>
        match.capabilityVersionId === annotation.capabilityVersionId &&
        match.path === annotation.path,
    );
    const textResolves =
      pinned.length === 1 ||
      field.searchTerms.includes(normalizeTerm(semanticText)) ||
      field.path.endsWith(`/${semanticText}`) ||
      normalizeTerm(field.label) === normalizeTerm(semanticText);
    if (!textResolves) {
      return {
        status: 'rejected',
        reason: 'malformed-annotation',
        detail: 'Field annotation text does not resolve to the cited path',
      };
    }
    if (fieldMatches.length > 1 && pinned.length !== 1) {
      return {
        status: 'clarification_required',
        reason: 'duplicate-field-candidates',
        question: `Which ${direction} field does "${annotation.text}" refer to?`,
        suggestedAnswers: suggestedReferenceAnswers(fieldMatches, annotation.text),
      };
    }

    verified.push({
      ...annotation,
      direction,
      path: annotation.path,
      evidence: {
        projectionFingerprint: input.projection.fingerprint,
        capabilityVersionId: annotation.capabilityVersionId,
        path: annotation.path,
        matchedTerms: matchedTermsFor(semanticText, field.searchTerms),
      },
    });
  }

  return { status: 'verified', annotations: verified };
}

/**
 * Model annotation ranges are often wrong on a short request. Keep a valid
 * draft: drop unusable proposals and recover references from the clarified text.
 */
export function verifyDraftRequestAnnotations(
  input: Parameters<typeof verifyProposedAnnotations>[0],
): AnnotationVerification {
  const verification = verifyProposedAnnotations(input);
  if (verification.status !== 'rejected') return verification;
  if (verification.reason !== 'malformed-annotation') return verification;
  if (verification.detail === 'Annotations cannot be verified against an unavailable projection') {
    return verification;
  }
  const proposed = input.proposed;
  if (!Array.isArray(proposed) || proposed.length === 0) return verification;
  return verifyProposedAnnotations({ ...input, proposed: [] });
}
