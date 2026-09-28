export const maxClarificationTurns = 6;

export type DraftingPhase =
  | 'editing'
  | 'drafting'
  | 'clarification_required'
  | 'validated'
  | 'unsupported'
  | 'manual_review';

export interface ClarificationTurn {
  question: string;
  answer?: string;
}

export interface ClarificationMapping {
  intentFingerprint: string;
  projectionFingerprint: string;
  sourceSteps: Array<{ stepId: string; capabilityVersionId: string }>;
  destinationCapabilityVersionId: string;
  destinationStepId: string;
  history: Array<ClarificationMapping>;
  selections?: Record<string, string>;
}

export interface SuggestedAnswerSelection {
  answer: string;
  candidateId: string;
  destinationPath: string[];
}

export interface SuggestedAnswerAction {
  answer: string;
  action: 'change-environment';
  environmentId: 'development' | 'production';
}

export interface VerifiedAnnotationEvidence {
  projectionFingerprint: string;
  capabilityVersionId: string;
  path?: string;
  matchedTerms: readonly string[];
}

export interface VerifiedDraftAnnotation {
  start: number;
  end: number;
  text: string;
  kind: 'capability' | 'requestField' | 'responseField';
  capabilityVersionId: string;
  direction?: 'request' | 'response';
  path?: string;
  evidence: VerifiedAnnotationEvidence;
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

export type GroundedDraftAnnotation = VerifiedDraftAnnotation | VerifiedRuntimeInputAnnotation;

export interface SuggestedAnswerAnnotations {
  answer: string;
  annotations: GroundedDraftAnnotation[];
}

export interface DraftingState {
  phase: DraftingPhase;
  requestId: number;
  request: string;
  transcript: ClarificationTurn[];
  revealEvidence: boolean;
  revealValidated: boolean;
  question?: string;
  questionAnnotations?: GroundedDraftAnnotation[];
  suggestedAnswers?: readonly string[];
  suggestedAnswerAnnotations?: SuggestedAnswerAnnotations[];
  suggestedAnswerSelections?: SuggestedAnswerSelection[];
  suggestedAnswerActions?: SuggestedAnswerAction[];
  mapping?: ClarificationMapping;
  reason?: string;
  detail?: string;
  continuation?: string;
  answer?: string;
  originalRequest?: string;
  interpretedRequest?: string;
  interpretedRequestAnnotations?: GroundedDraftAnnotation[];
  clarifiedRequest?: string;
  annotations?: VerifiedDraftAnnotation[];
  intentFingerprint?: string;
  projectionFingerprint?: string;
  draft?: Record<string, unknown>;
  validation?: { diagnostics?: Array<{ code: string; path: string; message: string }> };
  revisionContext?: DraftRevisionContext;
  sandboxRepair?: {
    tests: Array<{
      status?: 'passed' | 'failed';
      kind?: string;
      stepId?: string | null;
      capabilityVersionId?: string | null;
      detail?: string;
      expectation?: string;
    }>;
  };
}

export interface DraftRevisionContext {
  previousRequest: string;
  draft: Record<string, unknown>;
}

export interface ClarificationRequiredResponse {
  status: 'clarification_required';
  reason: string;
  question: string;
  questionAnnotations?: GroundedDraftAnnotation[];
  suggestedAnswers: string[];
  suggestedAnswerAnnotations?: SuggestedAnswerAnnotations[];
  intentFrame?: { summary?: string };
  interpretedRequest?: string;
  interpretedRequestAnnotations?: GroundedDraftAnnotation[];
  suggestedAnswerSelections?: SuggestedAnswerSelection[];
  suggestedAnswerActions?: SuggestedAnswerAction[];
  mapping?: ClarificationMapping;
  validation?: DraftingState['validation'];
  continuation: string;
}

export interface ValidatedDraftResponse {
  status: 'validated';
  originalRequest: string;
  clarifiedRequest: string;
  annotations?: Array<
    Partial<VerifiedDraftAnnotation> & { start: number; end: number; text: string }
  >;
  intentFingerprint: string;
  projectionFingerprint: string;
  draft: Record<string, unknown>;
}

export interface UnsupportedDraftResponse {
  status: 'unsupported';
  reason: string;
}

export interface ManualReviewDraftResponse {
  status: 'manual_review';
  reason: string;
  detail: string;
  validation?: { diagnostics?: Array<{ code: string; path: string; message: string }> };
}

export type DraftResponse =
  | ClarificationRequiredResponse
  | ValidatedDraftResponse
  | UnsupportedDraftResponse
  | ManualReviewDraftResponse;

export function createDraftingState(request = ''): DraftingState {
  return {
    phase: 'editing',
    requestId: 0,
    request,
    transcript: [],
    revealEvidence: false,
    revealValidated: false,
  };
}

export function submitDraft(state: DraftingState, request: string): DraftingState {
  return {
    phase: 'drafting',
    requestId: state.requestId + 1,
    request,
    transcript: [],
    revealEvidence: false,
    revealValidated: false,
  };
}

export function cancelDraft(
  state: DraftingState,
  fallback = createDraftingState(state.request),
): DraftingState {
  if (state.phase !== 'drafting') return state;
  return {
    ...fallback,
    requestId: state.requestId + 1,
  };
}

export function submitDraftRevision(
  state: DraftingState,
  request: string,
  revisionContext: NonNullable<DraftingState['revisionContext']>,
): DraftingState {
  return {
    ...submitDraft(state, request),
    revisionContext,
  };
}

function attemptCore(state: DraftingState) {
  return {
    requestId: state.requestId,
    request: state.request,
    transcript: state.transcript,
    ...(state.revisionContext ? { revisionContext: state.revisionContext } : {}),
    revealEvidence: false as const,
    revealValidated: false as const,
  };
}

export function receiveDraftResponse(
  state: DraftingState,
  requestId: number,
  response: DraftResponse,
): DraftingState {
  if (state.phase !== 'drafting' || requestId !== state.requestId) return state;
  if (response.status === 'clarification_required') {
    if (state.transcript.length >= maxClarificationTurns) {
      return {
        ...attemptCore(state),
        phase: 'manual_review',
        reason: 'clarification-exhausted',
        detail: 'Six clarification rounds did not produce a grounded request',
      };
    }
    const interpretedRequest = response.interpretedRequest ?? response.intentFrame?.summary;
    const mapping = response.mapping ?? state.mapping;
    return {
      ...attemptCore(state),
      phase: 'clarification_required',
      question: response.question,
      ...(response.questionAnnotations
        ? { questionAnnotations: response.questionAnnotations }
        : {}),
      suggestedAnswers: response.suggestedAnswers,
      ...(response.suggestedAnswerAnnotations
        ? { suggestedAnswerAnnotations: response.suggestedAnswerAnnotations }
        : {}),
      ...(typeof interpretedRequest === 'string' ? { interpretedRequest } : {}),
      ...(response.interpretedRequestAnnotations
        ? { interpretedRequestAnnotations: response.interpretedRequestAnnotations }
        : {}),
      ...(response.suggestedAnswerSelections
        ? { suggestedAnswerSelections: response.suggestedAnswerSelections }
        : {}),
      ...(response.suggestedAnswerActions
        ? { suggestedAnswerActions: response.suggestedAnswerActions }
        : {}),
      ...(mapping ? { mapping } : {}),
      ...(response.validation ? { validation: response.validation } : {}),
      reason: response.reason,
      continuation: response.continuation,
      transcript: [...state.transcript, { question: response.question }],
    };
  }
  if (response.status === 'validated') {
    const annotations = verifiedAnnotations(response);
    if (!annotations) {
      return {
        ...attemptCore(state),
        phase: 'manual_review',
        reason: 'unresolved-reference',
        detail: 'Validated drafts cannot include unresolved references',
      };
    }
    return {
      ...attemptCore(state),
      phase: 'validated',
      originalRequest: response.originalRequest,
      clarifiedRequest: response.clarifiedRequest,
      annotations,
      intentFingerprint: response.intentFingerprint,
      projectionFingerprint: response.projectionFingerprint,
      draft: response.draft,
      revealEvidence: true,
      revealValidated: true,
    };
  }
  if (response.status === 'unsupported') {
    return {
      ...attemptCore(state),
      phase: 'unsupported',
      reason: response.reason,
    };
  }
  if (response.status === 'manual_review') {
    return {
      ...attemptCore(state),
      phase: 'manual_review',
      reason: response.reason,
      detail: response.detail,
      ...(response.validation ? { validation: response.validation } : {}),
    };
  }
  return state;
}

export function reviseRequest(state: DraftingState): DraftingState {
  return {
    phase: 'editing',
    requestId: state.requestId + 1,
    request: state.request,
    transcript: [],
    revealEvidence: false,
    revealValidated: false,
    ...(state.revisionContext ? { revisionContext: state.revisionContext } : {}),
  };
}

const requestRevisionReasons = new Set([
  'ambiguity',
  'clarification-exhausted',
  'unresolved-reference',
]);

export function canReviseDraftRequest(reason: string | undefined): boolean {
  return reason !== undefined && requestRevisionReasons.has(reason);
}

export function environmentActionForAnswer(state: DraftingState, answer: string) {
  return state.suggestedAnswerActions?.find(
    (candidate) => candidate.action === 'change-environment' && candidate.answer === answer,
  );
}

function verifiedAnnotations(
  response: ValidatedDraftResponse,
): VerifiedDraftAnnotation[] | undefined {
  if (!Array.isArray(response.annotations)) return undefined;
  const annotations: VerifiedDraftAnnotation[] = [];
  for (const annotation of response.annotations) {
    const evidence = annotation.evidence;
    if (
      !evidence ||
      typeof evidence.projectionFingerprint !== 'string' ||
      typeof evidence.capabilityVersionId !== 'string' ||
      !Array.isArray(evidence.matchedTerms) ||
      typeof annotation.capabilityVersionId !== 'string' ||
      typeof annotation.kind !== 'string' ||
      annotation.start < 0 ||
      annotation.start >= annotation.end ||
      annotation.end > response.clarifiedRequest.length ||
      response.clarifiedRequest.slice(annotation.start, annotation.end) !== annotation.text
    ) {
      return undefined;
    }
    annotations.push(annotation as VerifiedDraftAnnotation);
  }
  return annotations;
}

export function editRequest(state: DraftingState, request: string): DraftingState {
  if (request === state.request) return state;
  return {
    phase: 'editing',
    requestId: state.requestId + 1,
    request,
    transcript: [],
    revealEvidence: false,
    revealValidated: false,
  };
}

export function submitClarificationAnswer(state: DraftingState, answer: string): DraftingState {
  if (state.phase !== 'clarification_required' || !state.continuation || !state.question) {
    return state;
  }
  const transcript = state.transcript.map((turn, index) =>
    index === state.transcript.length - 1 ? { ...turn, answer } : turn,
  );
  const selected = state.suggestedAnswerSelections?.find(
    (suggestion) => suggestion.answer === answer,
  );
  const destinationKey = selected?.destinationPath.at(-1);
  const mapping =
    state.mapping && selected && destinationKey
      ? {
          ...state.mapping,
          selections: {
            ...state.mapping.selections,
            [destinationKey]: selected.candidateId,
          },
        }
      : state.mapping;
  return {
    ...state,
    phase: 'drafting',
    requestId: state.requestId + 1,
    answer,
    ...(mapping ? { mapping } : {}),
    transcript,
    revealEvidence: false,
    revealValidated: false,
  };
}
