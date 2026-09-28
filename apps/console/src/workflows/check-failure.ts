import { humanStepName } from './diagram-model.js';
import {
  sandboxResultSummary,
  type SandboxCheckIdentity,
  type SandboxCheckOutcome,
} from './workflow.js';

export interface CheckFailureExplanation {
  error: string;
  graphMark: string;
  stepId: string | null;
  suggestedFix: string;
  why: string;
}

export const maxCheckRepairAttempts = 1;

export function shouldRepairCheckFailure(
  tests: ReadonlyArray<{ readonly status?: 'passed' | 'failed'; readonly stepId?: string | null }>,
  attempts: number,
): boolean {
  return attempts < maxCheckRepairAttempts && tests.some((test) => test.status === 'failed');
}

export function explainCheckFailure(
  tests: readonly SandboxCheckOutcome[],
  options: {
    identities?: readonly SandboxCheckIdentity[];
    stepName?: (stepId: string) => string;
  } = {},
): CheckFailureExplanation | undefined {
  const failed = tests.find((test) => test.status === 'failed');
  if (!failed) return undefined;
  const stepName = failed.stepId ? (options.stepName ?? humanStepName)(failed.stepId) : undefined;
  const identity = failed.capabilityVersionId
    ? options.identities?.find(
        (candidate) => candidate.capabilityVersionId === failed.capabilityVersionId,
      )
    : undefined;
  const apiAction = identity
    ? `${identity.serviceId} · ${identity.operationId}`
    : stepName
      ? `${stepName}`
      : 'This API action';

  if (isIdempotencyFailure(failed)) {
    return {
      error: `${apiAction} expects an idempotency key.`,
      why: 'The draft did not provide one.',
      suggestedFix: 'Map the idempotency key from paymentId.',
      stepId: failed.stepId ?? null,
      graphMark: `${apiAction} expects an idempotency key and none was provided.`,
    };
  }

  const summary = sandboxResultSummary('failed', [failed], options);
  return {
    error: summary,
    why: 'A check on this version failed, so Atlas cannot approve it yet.',
    suggestedFix: stepName
      ? `Revise ${stepName} so the check can pass.`
      : 'Revise the failed step so the check can pass.',
    stepId: failed.stepId ?? null,
    graphMark: summary,
  };
}

function isIdempotencyFailure(test: SandboxCheckOutcome): boolean {
  const text = `${test.detail ?? ''} ${test.expectation ?? ''}`.toLowerCase();
  return text.includes('idempotency');
}
