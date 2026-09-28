import { describe, expect, it } from 'vite-plus/test';

import {
  buildRunEvidence,
  canRepair,
  filterRuns,
  runStatePresentation,
  type WorkflowRunDetail,
  type WorkflowRunSummary,
} from './runs.js';

const runs: WorkflowRunSummary[] = [
  {
    runId: 'run_completed',
    workflowVersionId: 'payment@1',
    intakeReference: 'ref_100',
    state: 'completed',
    startedAt: '2026-08-15T10:00:00.000Z',
    updatedAt: '2026-08-15T10:00:04.000Z',
    trigger: { type: 'manual' },
    lifecycle: {
      workflowName: 'Settle payments',
      startedAt: '2026-08-15T10:00:00.000Z',
      endedAt: '2026-08-15T10:00:04.000Z',
      durationMs: 4000,
      retryCount: 0,
      outcome: 'succeeded',
      inProgress: false,
    },
  },
  {
    runId: 'run_parked',
    workflowVersionId: 'payment@2',
    intakeReference: 'ref_200',
    state: 'repair_required',
    startedAt: '2026-08-15T12:00:00.000Z',
    updatedAt: '2026-08-15T12:00:10.000Z',
    trigger: { type: 'webhook', deliveryId: 'delivery-1' },
    lifecycle: {
      workflowName: 'Settle payments',
      startedAt: '2026-08-15T12:00:00.000Z',
      endedAt: null,
      durationMs: null,
      retryCount: null,
      outcome: null,
      inProgress: true,
    },
  },
  {
    runId: 'run_failed',
    workflowVersionId: 'payment@2',
    intakeReference: 'REF_201',
    state: 'validation_failed',
    startedAt: '2026-08-15T11:00:00.000Z',
    updatedAt: '2026-08-15T11:00:01.000Z',
    trigger: { type: 'manual' },
    lifecycle: null,
  },
];

describe('run queue', () => {
  it('searches intake references case-insensitively and keeps newest runs first', () => {
    expect(filterRuns(runs, 'attention', 'ref_2').map(({ runId }) => runId)).toEqual([
      'run_parked',
      'run_failed',
    ]);
  });

  it('keeps completed runs out of the attention filter', () => {
    expect(filterRuns(runs, 'completed', '').map(({ runId }) => runId)).toEqual(['run_completed']);
  });

  it('gives operational states distinct plain-language labels', () => {
    expect(runStatePresentation('validation_failed')).toMatchObject({ label: 'Failed' });
    expect(runStatePresentation('repair_required')).toMatchObject({ label: 'Parked' });
    expect(runStatePresentation('running')).toMatchObject({ label: 'Running' });
    expect(runStatePresentation('completed')).toMatchObject({ label: 'Completed' });
  });
});

describe('selected run evidence', () => {
  it('summarizes attempts, duration, capability pins, and committed effects', () => {
    const run: WorkflowRunDetail = {
      ...runs[1]!,
      temporalWorkflowId: 'run_parked',
      artifactId: 'artifact-1',
      trigger: { type: 'webhook', deliveryId: 'delivery-1' },
      disposition: 'active',
      failure: {
        bucket: 'permanent-operational',
        type: 'EventPublishRejected',
        stepId: 'publish-event',
      },
      steps: [
        {
          stepId: 'mark-paid',
          capabilityVersionId: 'billing.mark-paid@v1',
          irreversible: true,
          idempotency: { protected: true, evidence: 'Stable key reused.' },
          attempts: [
            {
              attempt: 1,
              durationMs: 18,
              status: 'succeeded',
              redactedInput: { paymentId: '[REDACTED]' },
              redactedOutput: { status: '[REDACTED]' },
              recordedAt: '2026-08-15T12:00:01.000Z',
            },
          ],
        },
        {
          stepId: 'publish-event',
          capabilityVersionId: 'events.invoice-paid@v2',
          irreversible: false,
          idempotency: { protected: true, evidence: 'Stable key reused.' },
          attempts: [
            {
              attempt: 3,
              durationMs: 9,
              status: 'failed',
              redactedInput: { paymentId: '[REDACTED]' },
              failureType: 'EventPublishRejected',
              recordedAt: '2026-08-15T12:00:02.000Z',
            },
          ],
        },
      ],
      saga: [{ stepId: 'unmark-paid', compensatesStepId: 'mark-paid', state: 'frozen' }],
      controls: {
        retryStep: {
          enabled: true,
          stepId: 'publish-event',
          repairedCapabilityVersionId: 'events.invoice-paid@v2',
          safetyBasis: 'stable-idempotency-key',
          priorStepsNotRerun: ['mark-paid'],
          committedIrreversibleEffects: ['mark-paid'],
        },
        resumeRun: {
          enabled: true,
          priorStepsNotRerun: ['mark-paid'],
          committedIrreversibleEffects: ['mark-paid'],
        },
        abandonRun: {
          enabled: true,
          priorStepsNotRerun: ['mark-paid'],
          committedIrreversibleEffects: ['mark-paid'],
        },
      },
      repairHistory: [],
      traceHistory: [],
      effects: [],
      privacy: { payloadsRedactedAt: 'customer-worker', plaintextStoredByAtlas: false },
      idempotencyEvidence: {
        duplicateSubmissions: 1,
        durableRunIdentities: 1,
        effectExecutions: [{ stepId: 'mark-paid', successfulAttempts: 1 }],
      },
    };

    expect(buildRunEvidence(run)).toEqual({
      attemptCount: 2,
      durationMs: 27,
      capabilityPins: ['billing.mark-paid@v1', 'events.invoice-paid@v2'],
      irreversibleEffects: ['mark-paid'],
    });
  });

  it('offers repair only to Operator and Admin views', () => {
    expect(canRepair('author')).toBe(false);
    expect(canRepair('operator')).toBe(true);
    expect(canRepair('admin')).toBe(true);
  });
});
