import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { canonicalJson } from './capability-versioning.js';

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const MAX_CLARIFICATION_ROUNDS = 6;

const continuationPayloadSchema = z
  .object({
    v: z.literal(1),
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    actorId: z.string().min(1),
    request: z.string().min(1),
    intentFingerprint: fingerprintSchema,
    projectionFingerprint: fingerprintSchema,
    answers: z.array(z.string().min(1)),
    round: z.number().int().min(1).max(MAX_CLARIFICATION_ROUNDS),
  })
  .strict();

export type PlanningContinuationPayload = z.infer<typeof continuationPayloadSchema>;

export type PlanningContinuationVerification =
  | { status: 'ok'; payload: PlanningContinuationPayload }
  | {
      status: 'rejected';
      reason:
        | 'invalid-continuation'
        | 'continuation-context-mismatch'
        | 'projection-drift'
        | 'clarification-exhausted';
    };

const defaultSecret = () =>
  process.env.ATLAS_PLANNING_CONTINUATION_SECRET ?? 'atlas-local-planning-continuation';

function sign(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function signaturesEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function issuePlanningContinuation(
  payload: PlanningContinuationPayload,
  secret = defaultSecret(),
) {
  const parsed = continuationPayloadSchema.parse(payload);
  const body = Buffer.from(canonicalJson(parsed)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function verifyPlanningContinuation(
  token: string,
  expected: {
    organizationId: string;
    environmentId: string;
    actorId: string;
    request: string;
    projectionFingerprint?: string;
  },
  secret = defaultSecret(),
): PlanningContinuationVerification {
  const [body, signature] = token.split('.');
  if (!body || !signature || token.split('.').length !== 2) {
    return { status: 'rejected', reason: 'invalid-continuation' };
  }
  if (!signaturesEqual(signature, sign(body, secret))) {
    return { status: 'rejected', reason: 'invalid-continuation' };
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { status: 'rejected', reason: 'invalid-continuation' };
  }
  const parsed = continuationPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return { status: 'rejected', reason: 'invalid-continuation' };
  }
  const payload = parsed.data;
  if (
    payload.organizationId !== expected.organizationId ||
    payload.environmentId !== expected.environmentId ||
    payload.actorId !== expected.actorId ||
    payload.request !== expected.request
  ) {
    return { status: 'rejected', reason: 'continuation-context-mismatch' };
  }
  if (
    expected.projectionFingerprint &&
    payload.projectionFingerprint !== expected.projectionFingerprint
  ) {
    return { status: 'rejected', reason: 'projection-drift' };
  }
  if (payload.round > MAX_CLARIFICATION_ROUNDS) {
    return { status: 'rejected', reason: 'clarification-exhausted' };
  }
  return { status: 'ok', payload };
}

export function nextClarificationRound(issuedRounds: number) {
  if (issuedRounds >= MAX_CLARIFICATION_ROUNDS) return undefined;
  return issuedRounds + 1;
}
