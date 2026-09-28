import { expect, it } from 'vite-plus/test';

import {
  issuePlanningContinuation,
  nextClarificationRound,
  verifyPlanningContinuation,
} from './planning-continuation.js';

const payload = {
  v: 1 as const,
  organizationId: 'org_atlas',
  environmentId: 'production',
  actorId: 'author-a',
  request: 'Read the payment record.',
  intentFingerprint: 'a'.repeat(64),
  projectionFingerprint: 'b'.repeat(64),
  answers: [] as string[],
  round: 1,
};

it('binds and verifies a continuation handle for the original planning context', () => {
  const token = issuePlanningContinuation(payload);
  expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  expect(
    verifyPlanningContinuation(token, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      actorId: 'author-a',
      request: 'Read the payment record.',
      projectionFingerprint: 'b'.repeat(64),
    }),
  ).toEqual({ status: 'ok', payload });
});

it('rejects replay in another organization, environment, author, or request', () => {
  const token = issuePlanningContinuation(payload);
  const expected = {
    organizationId: 'org_atlas',
    environmentId: 'production',
    actorId: 'author-a',
    request: 'Read the payment record.',
  };
  expect(verifyPlanningContinuation(token, { ...expected, organizationId: 'org_other' })).toEqual({
    status: 'rejected',
    reason: 'continuation-context-mismatch',
  });
  expect(verifyPlanningContinuation(token, { ...expected, environmentId: 'sandbox' })).toEqual({
    status: 'rejected',
    reason: 'continuation-context-mismatch',
  });
  expect(verifyPlanningContinuation(token, { ...expected, actorId: 'author-b' })).toEqual({
    status: 'rejected',
    reason: 'continuation-context-mismatch',
  });
  expect(
    verifyPlanningContinuation(token, { ...expected, request: 'Read a different record.' }),
  ).toEqual({ status: 'rejected', reason: 'continuation-context-mismatch' });
  expect(verifyPlanningContinuation(`${token}tampered`, expected)).toEqual({
    status: 'rejected',
    reason: 'invalid-continuation',
  });
});

it('rejects projection drift and stops after six clarification rounds', () => {
  const token = issuePlanningContinuation(payload);
  expect(
    verifyPlanningContinuation(token, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      actorId: 'author-a',
      request: 'Read the payment record.',
      projectionFingerprint: 'c'.repeat(64),
    }),
  ).toEqual({ status: 'rejected', reason: 'projection-drift' });
  expect(nextClarificationRound(0)).toBe(1);
  expect(nextClarificationRound(2)).toBe(3);
  expect(nextClarificationRound(3)).toBe(4);
  expect(nextClarificationRound(5)).toBe(6);
  expect(nextClarificationRound(6)).toBeUndefined();
});
