import { describe, expect, it, vi } from 'vite-plus/test';

import { humanStepName } from './diagram-model.js';
import {
  approvalAffordance,
  describeWorkflowFailure,
  graphEdgeLabel,
  immutableArtifactFieldsMatch,
  sampleDemoWorkflowRequest,
  nextWorkflowVersionId,
  parseWorkflowArtifactYaml,
  readWorkflowResponseJson,
  refreshReviewAfterSandboxRun,
  retryPolicySummary,
  sandboxApprovalAffordance,
  sandboxResultSummary,
  workflowArtifactYaml,
  type WorkflowReview,
} from './workflow.js';

const review: WorkflowReview = {
  workflowVersionId: 'payment-to-billing@2',
  artifact: null,
  source: null,
  binding: {
    irHash: 'a'.repeat(64),
    policyVersion: 'mvp-validation-v1',
    projectionFingerprint: 'b'.repeat(64),
  },
  migration: null,
  irreversibleBoundary: 'publish-invoice-paid',
  steps: [],
  graph: {
    nodes: [],
    edges: [],
  },
  approval: { enabled: true, diagnostics: [] },
};

describe('workflow presentation model', () => {
  it('keeps the demo request aligned with the Burgertown pickup workflow', () => {
    expect(sampleDemoWorkflowRequest).toBe(
      'When someone orders pickup, open a pickup order, start a ticket, add the burger, and send it to the kitchen.',
    );
  });

  it('round-trips the reviewed artifact through editable YAML', () => {
    const artifact = {
      workflowVersionId: 'payment-to-billing@2',
      irHash: 'a'.repeat(64),
      executionRequirements: {
        organizationId: 'org_atlas',
        workflowVersionId: 'payment-to-billing@2',
        irHash: 'a'.repeat(64),
        requiredCapabilityVersionIds: [],
      },
      executable: {
        irVersion: 1,
        steps: [{ id: 'completed', kind: 'terminal', state: 'completed' }],
      },
    };

    const yaml = workflowArtifactYaml(artifact);

    expect(yaml).toContain('workflowVersionId: payment-to-billing@2');
    expect(parseWorkflowArtifactYaml(yaml)).toEqual(artifact);
  });

  it('rejects YAML that is not a workflow artifact', () => {
    expect(() => parseWorkflowArtifactYaml('- just\n- a\n- list')).toThrow(
      'YAML must contain a workflow artifact',
    );
    expect(() => parseWorkflowArtifactYaml('workflowVersionId: broken')).toThrow(
      'YAML must contain an executable workflow',
    );
  });

  it('treats artifact identity fields as immutable while allowing executable edits', () => {
    const artifact = parseWorkflowArtifactYaml(
      workflowArtifactYaml({
        workflowVersionId: 'payment-to-billing@2',
        irHash: 'a'.repeat(64),
        executionRequirements: { workflowVersionId: 'payment-to-billing@2' },
        executable: { irVersion: 1, steps: [] },
      }),
    );
    expect(
      immutableArtifactFieldsMatch(
        { ...artifact, executable: { irVersion: 1, steps: [{ id: 'completed' }] } },
        artifact,
      ),
    ).toBe(true);
    expect(immutableArtifactFieldsMatch({ ...artifact, irHash: 'b'.repeat(64) }, artifact)).toBe(
      false,
    );
  });

  it('creates unique version ids for repeated drafts', () => {
    expect(nextWorkflowVersionId(new Date('2026-08-15T12:34:56.789Z'))).toBe(
      'workflow-20260815-123456-789',
    );
  });

  it('keeps approval admin-only even when the artifact is approvable', () => {
    expect(approvalAffordance('author', review)).toEqual({
      enabled: false,
      reason: 'Switch to Admin to approve this version.',
    });
    expect(approvalAffordance('operator', review).enabled).toBe(false);
    expect(approvalAffordance('admin', review)).toEqual({ enabled: true, reason: null });
  });

  it('does not crash when switching to admin if the review omitted diagnostics', () => {
    const incomplete = {
      ...review,
      approval: { enabled: false },
    } as WorkflowReview;

    expect(approvalAffordance('author', incomplete)).toEqual({
      enabled: false,
      reason: 'Switch to Admin to approve this version.',
    });
    expect(approvalAffordance('admin', incomplete)).toEqual({
      enabled: false,
      reason: 'Resolve the remaining problems before approving this version.',
    });
  });

  it('keeps every diagnostic blocking and explains it beside approval', () => {
    const blocked = {
      ...review,
      approval: {
        enabled: false,
        diagnostics: [
          { kind: 'warning', code: 'RISK', path: 'steps[0]', message: 'Review the retry limit' },
        ],
      },
    };
    expect(approvalAffordance('admin', blocked)).toEqual({
      enabled: false,
      reason: 'Resolve the remaining problems before approving this version.',
    });
  });

  it('blocks approval while YAML changes have not been validated', () => {
    expect(approvalAffordance('admin', review, true)).toEqual({
      enabled: false,
      reason: 'Save the YAML changes before approving this version.',
    });
  });

  it('presents missing sandbox evidence as a next step instead of an error', () => {
    const awaitingSandbox = {
      ...review,
      approval: {
        enabled: false,
        diagnostics: [
          {
            kind: 'approvalRequirement',
            code: 'SANDBOX_TESTS_MISSING',
            path: 'workflowVersionId',
            message: 'Run the generated workflow checks for this exact workflow artifact.',
          },
        ],
      },
    };

    expect(approvalAffordance('admin', awaitingSandbox)).toEqual({
      enabled: false,
      reason: 'Run the checks before approving this version.',
    });
  });

  it('blocks approval until checks pass for this version', () => {
    expect(sandboxApprovalAffordance('not-run')).toEqual({
      enabled: false,
      reason: 'Run the checks before approving this version.',
    });
    expect(sandboxApprovalAffordance('running')).toEqual({
      enabled: false,
      reason: 'Wait for the checks to finish before approving this version.',
    });
    expect(sandboxApprovalAffordance('failed')).toEqual({
      enabled: false,
      reason: 'Fix the failed check and run checks again before approving this version.',
    });
    expect(sandboxApprovalAffordance('passed')).toEqual({ enabled: true, reason: null });
  });

  it('says a passing run is ready to approve without listing methods or fingerprints', () => {
    expect(
      sandboxResultSummary('passed', [
        { executionMethods: ['local-test-service'] },
        { executionMethods: ['static-validation'] },
      ]),
    ).toBe('This version is ready to approve.');
    expect(sandboxResultSummary('passed', [])).toBe('This version is ready to approve.');
  });

  it('names the failed step or API action and what went wrong', () => {
    expect(
      sandboxResultSummary(
        'failed',
        [
          {
            status: 'failed',
            stepId: 'load-payment',
            detail: 'The payment record was not found.',
          },
        ],
        { stepName: humanStepName },
      ),
    ).toBe('Load payment failed because the payment record was not found.');
    expect(
      sandboxResultSummary(
        'failed',
        [
          {
            status: 'failed',
            capabilityVersionId: 'payment.get@v1',
            detail: 'The response did not match the expected shape.',
          },
        ],
        {
          identities: [
            {
              capabilityVersionId: 'payment.get@v1',
              serviceId: 'payments',
              operationId: 'getPayment',
            },
          ],
        },
      ),
    ).toBe(
      'The getPayment API action failed because the response did not match the expected shape.',
    );
    expect(
      sandboxResultSummary(
        'failed',
        [{ status: 'failed', capabilityVersionId: 'payment.get@v1', detail: 'Timed out.' }],
        {
          identities: [
            {
              capabilityVersionId: 'payment.get@v1',
              serviceId: 'payments',
              operationId: undefined as unknown as string,
            },
          ],
        },
      ),
    ).toBe('A check failed because Timed out.');
    expect(
      sandboxResultSummary(
        'failed',
        [
          {
            status: 'failed',
            stepId: 'load-payment',
            detail: 'SANDBOX_SCHEMA_MISMATCH at irHash abcdef',
          },
        ],
        { stepName: humanStepName },
      ),
    ).toBe('Load payment failed.');
    expect(sandboxResultSummary('failed', [])).toBe('A check failed.');
    expect(
      sandboxResultSummary('failed', [
        {
          status: 'failed',
          detail:
            'Atlas used the event channel invoice.paid as a URL instead of calling /events/invoice.paid.',
        },
      ]),
    ).toBe(
      'A check failed because Atlas used the event channel invoice.paid as a URL instead of calling /events/invoice.paid.',
    );
  });

  it('refreshes server-authoritative approval diagnostics after sandbox tests pass', async () => {
    const refreshedReview = { ...review, approval: { enabled: true, diagnostics: [] } };
    const refresh = vi.fn<() => Promise<WorkflowReview>>().mockResolvedValue(refreshedReview);

    await expect(refreshReviewAfterSandboxRun('passed', refresh)).resolves.toBe(refreshedReview);
    expect(refresh).toHaveBeenCalledOnce();

    refresh.mockClear();
    await expect(refreshReviewAfterSandboxRun('running', refresh)).resolves.toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('labels supported graph relationships without inventing branches or loops', () => {
    expect(graphEdgeLabel({ kind: 'next', fromStepId: 'a', toStepId: 'b' })).toBe('then');
    expect(
      graphEdgeLabel({
        kind: 'mapping',
        fromStepId: 'a',
        toStepId: 'b',
        label: 'invoiceId',
      }),
    ).toBe('maps invoiceId');
    expect(
      graphEdgeLabel({
        kind: 'mapping',
        fromStepId: 'a',
        toStepId: 'b',
        label: 'amount',
        origin: 'requested',
      }),
    ).toBe('maps amount · you asked for this');
    expect(
      graphEdgeLabel({
        kind: 'mapping',
        fromStepId: 'a',
        toStepId: 'b',
        label: 'Idempotency-Key',
        origin: 'inferred',
      }),
    ).toBe('maps Idempotency-Key · Atlas inferred this');
    expect(graphEdgeLabel({ kind: 'compensation', fromStepId: 'b', toStepId: 'undo-b' })).toBe(
      'compensates with',
    );
    expect(graphEdgeLabel({ kind: 'revalidation', fromStepId: 'b', toStepId: 'a' })).toBe(
      'revalidates from',
    );
    expect(
      graphEdgeLabel({
        kind: 'revalidation',
        fromStepId: 'b',
        toStepId: 'a',
        maxRevalidations: 1,
      }),
    ).toBe('revalidates from (max 1)');
  });

  it('summarizes exact retry behavior for the graph', () => {
    expect(
      retryPolicySummary({
        initialInterval: '1s',
        backoffCoefficient: 2,
        maximumInterval: '30s',
        maximumAttempts: 4,
        nonRetryableErrorTypes: ['InvalidPayment'],
      }),
    ).toBe('4 attempts · 1s × 2 up to 30s · InvalidPayment does not retry');
    expect(retryPolicySummary(null)).toBeNull();
  });

  it('turns a planner JSON error into a readable workflow failure', () => {
    expect(describeWorkflowFailure(503, { error: 'planner-unavailable' })).toBe(
      'planner unavailable',
    );
  });

  it('explains exhausted OpenAI credits instead of a generic planner failure', () => {
    expect(
      describeWorkflowFailure(503, {
        error: 'planner-unavailable',
        reason: 'credit_balance_exhausted',
      }),
    ).toBe('The OpenAI account has no credits left. Add credits, then try again.');
  });

  it('explains an unavailable check runner instead of a generic 500', () => {
    expect(describeWorkflowFailure(502, { error: 'workflow-sandbox-execution-failed' })).toBe(
      'The check runner was reached, but could not finish executing the checks. Retry checks for this version.',
    );
    expect(
      describeWorkflowFailure(503, {
        error: 'workflow-sandbox-tests-unavailable',
        status: 'unavailable',
      }),
    ).toBe('The check runner could not be reached.');
  });

  it('turns a plain Internal Server Error body into a generic workflow failure', async () => {
    const body = await readWorkflowResponseJson(
      new Response('Internal Server Error', { status: 500 }),
    );
    expect(body).toBeUndefined();
    expect(describeWorkflowFailure(500, body)).toBe('Workflow request failed (500)');
  });
});
