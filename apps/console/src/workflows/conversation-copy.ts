export const switchRoleToCreateWorkflow = 'Switch to Author or Admin to create a workflow';

const diagnosticCode = /^(?:[A-Z][A-Z0-9_]+|[a-z0-9]+(?:-[a-z0-9]+)+)$/;
const controlPlaneJargon =
  /fingerprint|IntentFrame|closed-schema|projection|capabilityVersionId|irHash|control plane|backend-verified/i;

const manualReviewSentences: Record<string, string> = {
  'clarification-exhausted':
    'Atlas asked for missing details several times and still cannot create this workflow.',
  'unresolved-reference':
    'Atlas cannot create this workflow because a mentioned API action or field is not grounded.',
  'planner-contract-invalid':
    'Atlas could not finish a draft from this request and needs a person to review it.',
  'capability-drift':
    'Atlas could not finish this draft because the approved API actions changed while it was working.',
  ambiguity: 'Atlas could not finish this draft because the request is still unclear.',
  'continuation-context-mismatch':
    'Atlas could not continue this conversation and needs a person to review it.',
};

export function isDiagnosticToken(value: string): boolean {
  return diagnosticCode.test(value.trim());
}

function looksLikeOrdinarySentence(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed) && !isDiagnosticToken(trimmed) && !controlPlaneJargon.test(trimmed);
}

function withPeriod(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function namedApiAction(
  identities: readonly { operationId?: string }[] | undefined,
): string | undefined {
  if (!identities || identities.length !== 1) return undefined;
  const operationId = identities[0]?.operationId?.trim();
  return operationId || undefined;
}

function includeKnownAction(sentence: string, operationId: string | undefined): string {
  if (!operationId || sentence.includes(operationId)) return sentence;
  return `For the ${operationId} API action, ${sentence}`;
}

export function blockedOutcomeCopy({
  detail,
  identities,
  phase,
  reason,
}: {
  detail?: string;
  identities?: readonly { operationId?: string }[];
  phase: 'unsupported' | 'manual_review';
  reason?: string;
}): { sentence: string; technicalReason?: string; technicalDetail?: string } {
  const operationId = namedApiAction(identities);
  const technicalReason = reason && isDiagnosticToken(reason) ? reason : undefined;
  const technicalDetail =
    detail && (!looksLikeOrdinarySentence(detail) || technicalReason) && detail !== reason
      ? detail
      : undefined;

  if (phase === 'unsupported') {
    // The planner explains why it refused. Always show that explanation, even
    // when it uses internal words. Hiding it leaves the person with nothing to act on.
    const sentence = includeKnownAction(
      reason?.trim() ? withPeriod(reason) : 'Atlas cannot create this workflow.',
      operationId,
    );
    return {
      sentence,
      ...(detail && detail !== reason ? { technicalDetail: detail } : {}),
    };
  }

  const mapped = reason ? manualReviewSentences[reason] : undefined;
  const ordinaryDetail =
    detail && looksLikeOrdinarySentence(detail) ? withPeriod(detail) : undefined;
  const ordinaryReason =
    reason && looksLikeOrdinarySentence(reason) ? withPeriod(reason) : undefined;
  const sentence = includeKnownAction(
    mapped ??
      ordinaryDetail ??
      ordinaryReason ??
      'Atlas stopped drafting this workflow and needs a person to review it.',
    operationId,
  );

  return {
    sentence,
    ...(technicalReason ? { technicalReason } : {}),
    ...(technicalDetail || (detail && !ordinaryDetail && detail !== reason)
      ? { technicalDetail: technicalDetail ?? detail }
      : {}),
  };
}
