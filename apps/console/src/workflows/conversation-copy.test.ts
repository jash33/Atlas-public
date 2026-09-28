import { describe, expect, it } from 'vite-plus/test';

import {
  blockedOutcomeCopy,
  isDiagnosticToken,
  switchRoleToCreateWorkflow,
} from './conversation-copy.js';

describe('conversation copy', () => {
  it('uses the ticket sentence when an Operator cannot create a workflow', () => {
    expect(switchRoleToCreateWorkflow).toBe('Switch to Author or Admin to create a workflow');
  });

  it('treats diagnostic codes and kebab reasons as technical tokens', () => {
    expect(isDiagnosticToken('SOURCE_PATH_NOT_FOUND')).toBe(true);
    expect(isDiagnosticToken('clarification-exhausted')).toBe(true);
    expect(isDiagnosticToken('Atlas cannot create this workflow.')).toBe(false);
  });

  it('explains an unsupported request as a sentence and keeps codes off the default copy', () => {
    const copy = blockedOutcomeCopy({
      phase: 'unsupported',
      reason: 'No authorized capability can delete a bank account',
    });

    expect(copy.sentence).toBe('No authorized capability can delete a bank account.');
    expect(copy.technicalReason).toBeUndefined();
    expect(copy.sentence).not.toMatch(/SOURCE_PATH_NOT_FOUND|clarification-exhausted/);
  });

  it('prints the planner reason for an unsupported request even when it uses internal words', () => {
    const copy = blockedOutcomeCopy({
      phase: 'unsupported',
      reason: 'The projection cannot satisfy this intent',
    });

    expect(copy.sentence).toBe('The projection cannot satisfy this intent.');
    expect(copy.technicalReason).toBeUndefined();
  });

  it('prints a code-shaped unsupported reason instead of hiding it', () => {
    const copy = blockedOutcomeCopy({
      phase: 'unsupported',
      reason: 'no-matching-capability',
    });

    expect(copy.sentence).toBe('no-matching-capability.');
  });

  it('names the known API action when an unsupported request has no sentence of its own', () => {
    const copy = blockedOutcomeCopy({
      identities: [{ operationId: 'getPayment' }],
      phase: 'unsupported',
    });

    expect(copy.sentence).toBe('For the getPayment API action, Atlas cannot create this workflow.');
  });

  it('does not invent an API action when several identities are present', () => {
    const copy = blockedOutcomeCopy({
      identities: [{ operationId: 'getPayment' }, { operationId: 'PostPaymentIntents' }],
      phase: 'unsupported',
    });

    expect(copy.sentence).toBe('Atlas cannot create this workflow.');
    expect(copy.sentence).not.toContain('getPayment');
    expect(copy.sentence).not.toContain('PostPaymentIntents');
  });

  it('explains a blocked manual-review outcome in a sentence and parks the reason code', () => {
    const copy = blockedOutcomeCopy({
      detail: 'The model response is not bound to the active intent and projection fingerprints',
      phase: 'manual_review',
      reason: 'capability-drift',
    });

    expect(copy.sentence).toBe(
      'Atlas could not finish this draft because the approved API actions changed while it was working.',
    );
    expect(copy.technicalReason).toBe('capability-drift');
    expect(copy.technicalDetail).toBe(
      'The model response is not bound to the active intent and projection fingerprints',
    );
    expect(copy.sentence).not.toContain('capability-drift');
    expect(copy.sentence).not.toContain('fingerprint');
  });

  it('uses the supplied sentence for exhausted questions without exposing the reason code', () => {
    const copy = blockedOutcomeCopy({
      detail: 'Six clarification rounds did not produce a grounded request',
      identities: [{ operationId: 'PostPaymentIntents' }],
      phase: 'manual_review',
      reason: 'clarification-exhausted',
    });

    expect(copy.sentence).toBe(
      'For the PostPaymentIntents API action, Atlas asked for missing details several times and still cannot create this workflow.',
    );
    expect(copy.technicalReason).toBe('clarification-exhausted');
  });
});
