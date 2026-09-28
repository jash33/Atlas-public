import type { CapabilityObservation } from './capability-definition-status.js';

export type FieldDirection = 'request' | 'response';
export type SuggestionKind = 'capability' | 'request-field' | 'response-field';

export interface PlannerCapabilityIdentity {
  kind: 'openapi' | 'asyncapi';
  serviceId: string;
  operationId: string;
  channelAddress?: string;
  messageKey?: string;
}

export interface CapabilityFieldReference {
  capabilityVersionId: string;
  direction: FieldDirection;
  path: string;
  type: string;
  required: boolean;
  label: string;
  searchTerms: string[];
}

export interface CapabilityReferenceProvenance {
  evidence:
    | {
        kind: 'atlas-generated';
        repository: string;
        commit: string;
        candidateId: string;
        label: string;
        confirmedBy: string;
        confirmedAt: string;
      }
    | {
        kind: 'repository' | 'github';
        repository: string;
        commit: string;
        path: string;
      }
    | {
        kind: 'human-confirmed';
        label: string;
        confirmedBy: string;
        confirmedAt: string;
      };
}

export interface CapabilityReferenceSafety {
  idempotencyField: string | null;
  compensatedBy: {
    kind: 'openapi' | 'asyncapi';
    serviceId: string;
    operationId: string;
    channelAddress: string | null;
    messageKey: string | null;
  } | null;
  irreversibleAfter: boolean | null;
}

export interface PlannerCapabilityReference {
  capabilityVersionId: string;
  identity: PlannerCapabilityIdentity;
  owner: string;
  businessSemantics: Record<string, unknown> | null;
  safety: CapabilityReferenceSafety;
  provenance: CapabilityReferenceProvenance | null;
  searchTerms: string[];
  fields: CapabilityFieldReference[];
  observation?: CapabilityObservation;
}

export type ReferenceIndexOk = {
  status: 'ok';
  fingerprint: string;
  references: PlannerCapabilityReference[];
};

export type ReferenceIndexLoad =
  | ReferenceIndexOk
  | { status: 'stale'; fingerprint: string }
  | { status: 'unavailable' }
  | { status: 'invalid'; error: string };

export interface Suggestion {
  kind: SuggestionKind;
  capabilityVersionId: string;
  identity: PlannerCapabilityIdentity;
  owner: string;
  label: string;
  observation?: CapabilityObservation;
  direction?: FieldDirection;
  path?: string;
}

export interface SuggestionGroups {
  capabilities: Suggestion[];
  requestFields: Suggestion[];
  responseFields: Suggestion[];
}

export interface CapabilityAnnotationRange {
  start: number;
  end: number;
  capabilityVersionId: string;
  direction?: FieldDirection;
  path?: string;
  kind: SuggestionKind;
}

export interface RuntimeInputAnnotationRange {
  start: number;
  end: number;
  kind: 'runtime-input';
  inputName: string;
}

export type AnnotationRange = CapabilityAnnotationRange | RuntimeInputAnnotationRange;

interface DismissedRange {
  start: number;
  end: number;
  value: string;
}

export interface SuggestionListState {
  open: boolean;
  activeIndex: number;
}

export interface RequestEditor {
  text: string;
  cursor: number;
  annotations: AnnotationRange[];
  suggestions: SuggestionGroups;
  list: SuggestionListState;
  indexStatus: 'empty' | 'ok' | 'stale' | 'unavailable' | 'invalid';
  fingerprint: string | null;
  organizationId: string | null;
  environmentId: string | null;
  index?: ReferenceIndexOk | undefined;
  explicit?: AnnotationRange[];
  dismissed?: DismissedRange[];
}

const emptySuggestions: SuggestionGroups = {
  capabilities: [],
  requestFields: [],
  responseFields: [],
};

export function createRequestEditor(
  initial: { text?: string; cursor?: number } = {},
): RequestEditor {
  return {
    text: initial.text ?? '',
    cursor: initial.cursor ?? 0,
    annotations: [],
    suggestions: emptySuggestions,
    list: { open: false, activeIndex: 0 },
    indexStatus: 'empty',
    fingerprint: null,
    organizationId: null,
    environmentId: null,
  };
}

export function applyReferenceIndex(
  editor: RequestEditor,
  payload: unknown,
  scope: { organizationId: string; environmentId: string },
): RequestEditor {
  const loaded = interpretReferenceIndex(payload);
  const previous = editor;
  const scopeChanged =
    previous.organizationId !== scope.organizationId ||
    previous.environmentId !== scope.environmentId ||
    previous.fingerprint !==
      (loaded.status === 'ok' || loaded.status === 'stale' ? loaded.fingerprint : null);
  if (loaded.status !== 'ok') {
    return {
      ...editor,
      annotations: [],
      suggestions: emptySuggestions,
      list: { open: false, activeIndex: 0 },
      indexStatus: loaded.status,
      fingerprint: loaded.status === 'stale' ? loaded.fingerprint : null,
      organizationId: scope.organizationId,
      environmentId: scope.environmentId,
      index: undefined,
      explicit: [],
      dismissed: [],
    };
  }
  const next: RequestEditor = {
    ...editor,
    indexStatus: 'ok',
    fingerprint: loaded.fingerprint,
    organizationId: scope.organizationId,
    environmentId: scope.environmentId,
    explicit: scopeChanged ? [] : (previous.explicit ?? []),
    dismissed: scopeChanged ? [] : (previous.dismissed ?? []),
  };
  return refreshEditor(next, editor.text, editor.cursor, loaded);
}

export function interpretReferenceIndex(payload: unknown): ReferenceIndexLoad {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'unavailable' };
  }
  const record = payload as Record<string, unknown>;
  if (record.status === 'stale' && typeof record.fingerprint === 'string') {
    return { status: 'stale', fingerprint: record.fingerprint };
  }
  if (record.status === 'unavailable') return { status: 'unavailable' };
  if (typeof record.error === 'string') return { status: 'invalid', error: record.error };
  if (
    record.status !== 'ok' ||
    typeof record.fingerprint !== 'string' ||
    !Array.isArray(record.references)
  ) {
    return { status: 'unavailable' };
  }
  return payload as ReferenceIndexOk;
}

export function syncRequest(editor: RequestEditor, text: string, cursor: number): RequestEditor {
  return refreshEditor(editor, text, cursor, editor.index);
}

export function handleSuggestionKey(
  editor: RequestEditor,
  key: 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Escape' | 'Tab',
): RequestEditor {
  const options = flattenedSuggestions(editor.suggestions);
  if (key === 'Escape') {
    return { ...editor, list: { open: false, activeIndex: 0 } };
  }
  if (!editor.list.open || options.length === 0) return editor;
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const delta = key === 'ArrowDown' ? 1 : -1;
    const activeIndex = (editor.list.activeIndex + delta + options.length) % options.length;
    return { ...editor, list: { open: true, activeIndex } };
  }
  const suggestion = options[editor.list.activeIndex];
  return suggestion ? selectSuggestion(editor, suggestion) : editor;
}

export function suggestionListbox(editor: RequestEditor) {
  const options = flattenedSuggestions(editor.suggestions).map((suggestion, index) => ({
    id: `wf-suggestion-${index}`,
    role: 'option' as const,
    'aria-selected': editor.list.open && editor.list.activeIndex === index,
    suggestion,
  }));
  return {
    id: 'wf-capability-suggestions',
    role: 'listbox' as const,
    'aria-expanded': editor.list.open,
    'aria-activedescendant': editor.list.open
      ? `wf-suggestion-${editor.list.activeIndex}`
      : undefined,
    options,
  };
}

export interface CapabilityReferenceTooltip {
  kind?: never;
  capabilityVersionId: string;
  serviceId: string;
  operationId: string;
  owner: string;
  direction?: FieldDirection;
  path?: string;
  provenanceSummary: string;
  observation?: CapabilityObservation;
}

export interface RuntimeInputTooltip {
  kind: 'runtime-input';
  inputName: string;
  label: 'Runtime input';
}

export type ReferenceTooltip = CapabilityReferenceTooltip | RuntimeInputTooltip;

export function tooltipForAnnotation(
  editor: RequestEditor,
  annotation: AnnotationRange,
): ReferenceTooltip | null {
  if (annotation.kind === 'runtime-input') {
    return { kind: 'runtime-input', inputName: annotation.inputName, label: 'Runtime input' };
  }
  const reference = editor.index?.references.find(
    (candidate) => candidate.capabilityVersionId === annotation.capabilityVersionId,
  );
  if (!reference) return null;
  return {
    capabilityVersionId: annotation.capabilityVersionId,
    serviceId: reference.identity.serviceId,
    operationId: reference.identity.operationId,
    owner: reference.owner,
    ...(reference.observation ? { observation: reference.observation } : {}),
    ...(annotation.direction ? { direction: annotation.direction } : {}),
    ...(annotation.path ? { path: annotation.path } : {}),
    provenanceSummary: provenanceSummary(reference.provenance),
  };
}

export function flattenedSuggestions(groups: SuggestionGroups): Suggestion[] {
  return [...groups.capabilities, ...groups.requestFields, ...groups.responseFields];
}

export function requestHighlightSegments(editor: RequestEditor) {
  const segments: Array<
    | { type: 'text'; value: string }
    | { type: 'reference'; value: string; annotation: AnnotationRange; tooltip: ReferenceTooltip }
  > = [];
  let cursor = 0;
  for (const annotation of [...editor.annotations].sort(
    (left, right) => left.start - right.start,
  )) {
    if (annotation.start > cursor) {
      segments.push({ type: 'text', value: editor.text.slice(cursor, annotation.start) });
    }
    const tooltip = tooltipForAnnotation(editor, annotation);
    if (tooltip) {
      segments.push({
        type: 'reference',
        value: editor.text.slice(annotation.start, annotation.end),
        annotation,
        tooltip,
      });
    } else {
      segments.push({ type: 'text', value: editor.text.slice(annotation.start, annotation.end) });
    }
    cursor = annotation.end;
  }
  if (cursor < editor.text.length)
    segments.push({ type: 'text', value: editor.text.slice(cursor) });
  return segments;
}

export function selectSuggestion(editor: RequestEditor, suggestion: Suggestion): RequestEditor {
  const state = editor;
  const token = activeMention(editor.text, editor.cursor);
  const reference = `@${readablePlainText(suggestion)}`;
  const insert = `${reference}  `;
  const start = token.query ? token.start : editor.cursor;
  const end = token.query ? token.end : editor.cursor;
  const text = `${editor.text.slice(0, start)}${insert}${editor.text.slice(end)}`;
  const cursor = start + insert.length;
  const range = annotationFrom(suggestion, start, start + reference.length);
  const mapped = survivingExplicit(state.explicit ?? [], editor.text, text, state.index);
  const explicit = [...mapped.filter((existing) => !rangesOverlap(existing, range)), range];
  return refreshEditor({ ...state, text, explicit }, text, cursor, state.index);
}

export function markAnnotationAsRuntimeInput(
  editor: RequestEditor,
  annotation: AnnotationRange,
): RequestEditor {
  const inputName = referenceText(editor.text.slice(annotation.start, annotation.end));
  if (!inputName) return editor;
  const runtimeInput: RuntimeInputAnnotationRange = {
    start: annotation.start,
    end: annotation.end,
    kind: 'runtime-input',
    inputName,
  };
  const explicit = [
    ...(editor.explicit ?? []).filter((range) => !sameRange(range, annotation)),
    runtimeInput,
  ];
  return refreshEditor({ ...editor, explicit }, editor.text, editor.cursor, editor.index);
}

export function removeAnnotation(
  editor: RequestEditor,
  annotation: AnnotationRange,
): RequestEditor {
  const value = editor.text.slice(annotation.start, annotation.end);
  if (!value) return editor;
  const explicit = (editor.explicit ?? []).filter((range) => !sameRange(range, annotation));
  const dismissed = [
    ...(editor.dismissed ?? []).filter((range) => !sameRange(range, annotation)),
    { start: annotation.start, end: annotation.end, value },
  ];
  return refreshEditor(
    { ...editor, explicit, dismissed },
    editor.text,
    editor.cursor,
    editor.index,
  );
}

function readablePlainText(suggestion: Suggestion) {
  if (suggestion.kind === 'capability') return suggestion.identity.operationId;
  return suggestion.path ? lastPointerSegment(suggestion.path) : suggestion.label;
}

function refreshEditor(
  editor: RequestEditor,
  text: string,
  cursor: number,
  index: ReferenceIndexOk | undefined,
): RequestEditor {
  const explicit = survivingExplicit(editor.explicit ?? [], editor.text, text, index);
  const dismissed = survivingDismissed(editor.dismissed ?? [], editor.text, text);
  const annotations = index ? bindUniqueMatches(text, index, explicit, dismissed) : [...explicit];
  const token = activeMention(text, cursor);
  const activeBound = annotations.some(
    (range) =>
      rangesOverlap(range, { start: token.start, end: token.end }) && token.end > token.start,
  );
  const suggestions = index && !activeBound ? suggestionsFor(token.query, index) : emptySuggestions;
  const open = hasSuggestions(suggestions);
  const next: RequestEditor = {
    ...editor,
    text,
    cursor,
    annotations,
    suggestions,
    list: { open, activeIndex: open ? 0 : 0 },
    index,
    explicit,
    dismissed,
  };
  return next;
}

function survivingExplicit(
  ranges: AnnotationRange[],
  oldText: string,
  newText: string,
  index: ReferenceIndexOk | undefined,
): AnnotationRange[] {
  const kept: AnnotationRange[] = [];
  for (const range of ranges) {
    const bound = oldText.slice(range.start, range.end);
    if (!bound) continue;
    const relocated = closestRange(findTermRanges(newText, bound), range.start);
    if (!relocated) continue;
    const next = { ...range, start: relocated.start, end: relocated.end };
    if (index && !annotationMatches(newText, next, index)) continue;
    if (kept.some((existing) => rangesOverlap(existing, next))) continue;
    kept.push(next);
  }
  return kept;
}

function closestRange(ranges: Array<{ start: number; end: number }>, target: number) {
  return ranges.reduce<{ start: number; end: number } | undefined>((best, range) => {
    if (!best) return range;
    return Math.abs(range.start - target) < Math.abs(best.start - target) ? range : best;
  }, undefined);
}

function annotationMatches(text: string, range: AnnotationRange, index: ReferenceIndexOk) {
  const slice = referenceText(text.slice(range.start, range.end));
  if (range.kind === 'runtime-input') return slice === range.inputName;
  const suggestion = allSuggestions(index).find(
    (candidate) =>
      candidate.capabilityVersionId === range.capabilityVersionId &&
      candidate.kind === range.kind &&
      candidate.path === range.path &&
      candidate.direction === range.direction,
  );
  if (!suggestion) return false;
  return identityTokens(suggestion).some((token) => token.toLowerCase() === slice.toLowerCase());
}

function referenceText(value: string) {
  return value.startsWith('@') ? value.slice(1) : value;
}

function suggestionsFor(query: string, index: ReferenceIndexOk): SuggestionGroups {
  if (nonWhitespaceCount(query) < 3) return emptySuggestions;
  const groups: SuggestionGroups = {
    capabilities: [],
    requestFields: [],
    responseFields: [],
  };
  for (const candidate of matchReferences(index, query)) {
    if (candidate.kind === 'capability') groups.capabilities.push(candidate);
    else if (candidate.kind === 'request-field') groups.requestFields.push(candidate);
    else groups.responseFields.push(candidate);
  }
  return groups;
}

function hasSuggestions(groups: SuggestionGroups) {
  return (
    groups.capabilities.length > 0 ||
    groups.requestFields.length > 0 ||
    groups.responseFields.length > 0
  );
}

function activeMention(text: string, cursor: number) {
  const clamped = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, clamped);
  const startMatch = before.match(/@([A-Za-z0-9_-]*)$/);
  const after = text.slice(clamped).match(/^[A-Za-z0-9_-]*/)?.[0] ?? '';
  if (!startMatch) return { start: clamped, end: clamped, query: '' };
  const start = clamped - startMatch[0].length;
  if (start > 0 && isTokenChar(text[start - 1])) {
    return { start: clamped, end: clamped, query: '' };
  }
  const end = clamped + after.length;
  return {
    start,
    end,
    query: text.slice(start + 1, end),
  };
}

function bindUniqueMatches(
  text: string,
  index: ReferenceIndexOk,
  explicit: AnnotationRange[],
  dismissed: DismissedRange[],
): AnnotationRange[] {
  const annotations = [...explicit].sort((left, right) => left.start - right.start);
  const terms = uniqueIdentityTerms(index).sort(
    (left, right) => right.term.length - left.term.length,
  );
  for (const { term, suggestion } of terms) {
    for (const range of findTermRanges(text, term)) {
      if (range.start > 0 && text[range.start - 1] === '@') continue;
      if (dismissed.some((existing) => rangesOverlap(existing, range))) continue;
      if (annotations.some((existing) => rangesOverlap(existing, range))) continue;
      annotations.push(annotationFrom(suggestion, range.start, range.end));
    }
  }
  return annotations.sort((left, right) => left.start - right.start);
}

function survivingDismissed(ranges: DismissedRange[], oldText: string, newText: string) {
  return ranges.flatMap((range) => {
    const value = oldText.slice(range.start, range.end) || range.value;
    const relocated = closestRange(findTermRanges(newText, value), range.start);
    return relocated ? [{ ...relocated, value }] : [];
  });
}

function sameRange(left: { start: number; end: number }, right: { start: number; end: number }) {
  return left.start === right.start && left.end === right.end;
}

function uniqueIdentityTerms(
  index: ReferenceIndexOk,
): Array<{ term: string; suggestion: Suggestion }> {
  const grouped = new Map<string, Suggestion[]>();
  for (const suggestion of allSuggestions(index)) {
    for (const token of identityTokens(suggestion)) {
      const key = token.toLowerCase();
      const current = grouped.get(key) ?? [];
      current.push(suggestion);
      grouped.set(key, current);
    }
  }
  const unique: Array<{ term: string; suggestion: Suggestion }> = [];
  for (const [term, suggestions] of grouped) {
    const first = suggestions[0];
    if (!first || !suggestions.every((candidate) => sameSuggestion(candidate, first))) continue;
    unique.push({ term, suggestion: first });
  }
  return unique;
}

function allSuggestions(index: ReferenceIndexOk): Suggestion[] {
  const suggestions: Suggestion[] = [];
  for (const reference of index.references) {
    suggestions.push({
      kind: 'capability',
      capabilityVersionId: reference.capabilityVersionId,
      identity: reference.identity,
      owner: reference.owner,
      label: reference.identity.operationId,
      ...(reference.observation ? { observation: reference.observation } : {}),
    });
    for (const field of reference.fields) {
      suggestions.push({
        kind: field.direction === 'request' ? 'request-field' : 'response-field',
        capabilityVersionId: field.capabilityVersionId,
        identity: reference.identity,
        owner: reference.owner,
        label: field.label,
        ...(reference.observation ? { observation: reference.observation } : {}),
        direction: field.direction,
        path: field.path,
      });
    }
  }
  return suggestions;
}

function identityTokens(suggestion: Suggestion): string[] {
  if (suggestion.kind === 'capability') {
    return [suggestion.label, suggestion.identity.operationId];
  }
  return [suggestion.label, suggestion.path ? lastPointerSegment(suggestion.path) : ''].filter(
    Boolean,
  );
}

function lastPointerSegment(path: string) {
  const segment = path.split('/').filter(Boolean).at(-1) ?? '';
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function sameSuggestion(left: Suggestion, right: Suggestion) {
  return (
    left.kind === right.kind &&
    left.capabilityVersionId === right.capabilityVersionId &&
    left.path === right.path &&
    left.direction === right.direction
  );
}

function annotationFrom(suggestion: Suggestion, start: number, end: number): AnnotationRange {
  return {
    start,
    end,
    capabilityVersionId: suggestion.capabilityVersionId,
    kind: suggestion.kind,
    ...(suggestion.direction ? { direction: suggestion.direction } : {}),
    ...(suggestion.path ? { path: suggestion.path } : {}),
  };
}

function findTermRanges(text: string, term: string): Array<{ start: number; end: number }> {
  if (!term) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  const source = text.toLowerCase();
  const needle = term.toLowerCase();
  let from = 0;
  while (from <= source.length - needle.length) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    const end = start + needle.length;
    if (isTokenBoundary(text, start, end)) ranges.push({ start, end });
    from = start + 1;
  }
  return ranges;
}

function isTokenBoundary(text: string, start: number, end: number) {
  const before = start === 0 ? '' : text[start - 1];
  const after = end >= text.length ? '' : text[end];
  return !isTokenChar(before) && !isTokenChar(after);
}

function isTokenChar(character: string | undefined) {
  return Boolean(character && /[A-Za-z0-9_-]/.test(character));
}

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
) {
  return left.start < right.end && right.start < left.end;
}

function provenanceSummary(provenance: CapabilityReferenceProvenance | null) {
  if (!provenance) return 'No provenance recorded';
  const evidence = provenance.evidence;
  if (evidence.kind === 'human-confirmed') {
    return `Human-confirmed · ${evidence.label} · ${evidence.confirmedBy}`;
  }
  if (evidence.kind === 'atlas-generated')
    return `Atlas-generated · ${evidence.repository} @ ${evidence.commit}`;
  return `${evidence.repository} @ ${evidence.commit} · ${evidence.path}`;
}

function nonWhitespaceCount(value: string) {
  return value.replace(/\s+/g, '').length;
}

function matchReferences(index: ReferenceIndexOk, query: string): Suggestion[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const matches: Suggestion[] = [];
  for (const reference of index.references) {
    if (matchesTerms(reference.searchTerms, tokens)) {
      matches.push({
        kind: 'capability',
        capabilityVersionId: reference.capabilityVersionId,
        identity: reference.identity,
        owner: reference.owner,
        label: reference.identity.operationId,
        ...(reference.observation ? { observation: reference.observation } : {}),
      });
    }
    for (const field of reference.fields) {
      if (!matchesTerms(field.searchTerms, tokens)) continue;
      matches.push({
        kind: field.direction === 'request' ? 'request-field' : 'response-field',
        capabilityVersionId: field.capabilityVersionId,
        identity: reference.identity,
        owner: reference.owner,
        label: field.label,
        ...(reference.observation ? { observation: reference.observation } : {}),
        direction: field.direction,
        path: field.path,
      });
    }
  }
  return matches;
}

function tokenize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesTerms(searchTerms: string[], tokens: string[]) {
  return tokens.every((token) => searchTerms.some((term) => term.startsWith(token)));
}
