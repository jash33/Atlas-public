import {
  createCompiledWorkflowVersion,
  createTransformationCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'workflow_console_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const repairedProviderConditions: string[] = [];
const app = createApp(
  pool,
  { allowedHosts: [] },
  undefined,
  undefined,
  {
    approvalAuthorizer: {
      async authorize() {
        return null;
      },
    },
    workerAuthorizer: {
      async authorize({ authorizationHeader }) {
        return authorizationHeader === 'Bearer worker-token';
      },
    },
    repairAuthorizer: {
      async authorize({ authorizationHeader }) {
        return authorizationHeader === 'Bearer operator-token'
          ? { actorId: 'operator@example.com', role: 'operator' as const }
          : null;
      },
    },
    executionGrantIssuer: {
      async issueForRun() {
        throw new Error('Not used by console API tests');
      },
    },
  },
  undefined,
  {
    providerConditionRepairer: {
      async repair(repairedCapabilityVersionId) {
        repairedProviderConditions.push(repairedCapabilityVersionId);
        return true;
      },
    },
  },
);

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 32 });
  await pool.query(`
    TRUNCATE organizations, workflow_versions RESTART IDENTITY CASCADE;
    INSERT INTO organizations (id) VALUES ('org_atlas');
    INSERT INTO organization_environment_policies
      (organization_id, environment_id, policy_version, approved_by)
    VALUES ('org_atlas', 'production', 'mvp-validation-v1', 'admin@example.com');
    WITH identity AS (
      INSERT INTO capability_identities
        (organization_id, kind, service_id, operation_id, channel_address, message_key)
      VALUES ('org_atlas', 'openapi', 'billing', 'markInvoicePaid', NULL, NULL)
      RETURNING id
    )
    INSERT INTO compatibility_diffs
      (organization_id, capability_identity_id, from_capability_version_id,
       to_capability_version_id, classification, diff)
    SELECT 'org_atlas', id, 'previous-capability-version', 'missing-capability-version',
      'compatible', '[]'::jsonb
    FROM identity;
  `);
});

afterAll(async () => {
  await pool.end();
});

describe('workflow console API', () => {
  it('creates a new immutable artifact from an edited workflow and revalidates it', async () => {
    const source = await createCompiledWorkflowVersion('editable-workflow@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'missing-capability-version',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    const editedExecutable = {
      ...source.executable,
      steps: source.executable.steps.map((step) =>
        step.id === 'load-payment'
          ? {
              ...step,
              retryPolicy: {
                initialInterval: '2s',
                backoffCoefficient: 2,
                maximumInterval: '20s',
                maximumAttempts: 3,
                nonRetryableErrorTypes: ['PaymentNotFound'],
              },
            }
          : step,
      ),
    };

    const edit = () =>
      app.request('/v1/workflow-edits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          projectionFingerprint: '0'.repeat(64),
          sourceWorkflowVersionId: source.workflowVersionId,
          executable: editedExecutable,
        }),
      });
    const firstResponse = await edit();
    const secondResponse = await edit();

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const first = await firstResponse.json();
    const second = await secondResponse.json();
    expect(first.draft.workflowVersionId).not.toBe(source.workflowVersionId);
    expect(first.draft.irHash).not.toBe(source.irHash);
    expect(first.draft).toEqual(second.draft);
    expect(first.review).toMatchObject({
      workflowVersionId: first.draft.workflowVersionId,
      artifact: first.draft,
      graph: {
        nodes: expect.arrayContaining([
          expect.objectContaining({
            stepId: 'load-payment',
            retryPolicy: expect.objectContaining({ maximumAttempts: 3 }),
          }),
        ]),
      },
      approval: {
        enabled: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND_IN_PROJECTION' }),
        ]),
      },
    });
  });

  it('rejects a structurally invalid workflow edit before it can be reviewed', async () => {
    const response = await app.request('/v1/workflow-edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        projectionFingerprint: '0'.repeat(64),
        sourceWorkflowVersionId: 'editable-workflow@1',
        executable: { irVersion: 1, steps: [] },
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid-workflow-edit' });
  });

  it('projects a compact review with expandable trust details and blocking diagnostics', async () => {
    const draft = await createCompiledWorkflowVersion('payment-to-billing@2', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'missing-capability-version',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          responseSchema: { required: { invoiceId: { type: 'string' } } },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        projectionFingerprint: '0'.repeat(64),
        draft,
        migration: {
          fromCapabilityVersionId: 'previous-capability-version',
          toCapabilityVersionId: 'missing-capability-version',
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      workflowVersionId: 'payment-to-billing@2',
      artifact: draft,
      binding: {
        irHash: draft.irHash,
        policyVersion: 'mvp-validation-v1',
        projectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      migration: {
        classification: 'compatible',
        capabilityDiff: [],
        fromCapabilityVersionId: 'previous-capability-version',
        toCapabilityVersionId: 'missing-capability-version',
      },
      approval: {
        enabled: false,
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'CAPABILITY_NOT_FOUND_IN_PROJECTION' }),
        ]),
      },
      steps: [
        {
          stepId: 'load-payment',
          capabilityVersionId: 'missing-capability-version',
          verified: false,
          inputMappings: { paymentId: { source: 'input', path: ['paymentId'] } },
          outputSchema: { required: { invoiceId: { type: 'string' } } },
          timeout: { startToClose: '30 seconds', source: 'runtime-default' },
          compensation: null,
          irreversible: false,
        },
      ],
      graph: {
        nodes: [
          expect.objectContaining({ stepId: 'load-payment', kind: 'capabilityCall' }),
          expect.objectContaining({ stepId: 'completed', kind: 'terminal' }),
        ],
        edges: [{ fromStepId: 'load-payment', toStepId: 'completed', kind: 'next' }],
      },
    });
    expect(body.binding.projectionFingerprint).not.toBe('0'.repeat(64));
  });

  it('projects only supported control-flow, mapping, retry, compensation, and revalidation edges', async () => {
    const draft = await createCompiledWorkflowVersion('graph-evidence@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'load-version',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          responseSchema: { required: { invoiceId: { type: 'string' } } },
          retryPolicy: {
            initialInterval: '1s',
            backoffCoefficient: 2,
            maximumInterval: '30s',
            maximumAttempts: 4,
            nonRetryableErrorTypes: ['PaymentNotFound'],
          },
        },
        {
          id: 'settle-invoice',
          kind: 'capabilityCall',
          capabilityVersionId: 'settle-version',
          arguments: {
            invoiceId: { source: 'stepOutput', stepId: 'load-payment', path: ['invoiceId'] },
          },
          irreversibleAfter: true,
          errorRouting: {
            rules: [],
            defaultAction: {
              kind: 'revalidateFrom',
              targetStepId: 'load-payment',
              maxRevalidations: 1,
              onExhausted: {
                kind: 'land',
                outcome: 'repair_required',
                reasonCode: 'REVALIDATION_EXHAUSTED',
              },
            },
          },
        },
        {
          id: 'cancel-settlement',
          kind: 'compensation',
          capabilityVersionId: 'cancel-version',
          compensatesStepId: 'settle-invoice',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });

    const response = await app.request('/v1/workflow-reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        projectionFingerprint: '0'.repeat(64),
        draft,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      steps: expect.arrayContaining([
        expect.objectContaining({
          stepId: 'cancel-settlement',
          capabilityVersionId: 'cancel-version',
          timeout: { startToClose: '30 seconds', source: 'runtime-default' },
        }),
      ]),
      graph: {
        nodes: [
          expect.objectContaining({
            stepId: 'load-payment',
            retryPolicy: expect.objectContaining({ maximumAttempts: 4 }),
          }),
          expect.objectContaining({ stepId: 'settle-invoice', irreversible: true }),
          expect.objectContaining({ stepId: 'cancel-settlement', kind: 'compensation' }),
          expect.objectContaining({ stepId: 'completed', terminalState: 'completed' }),
        ],
        edges: expect.arrayContaining([
          { fromStepId: 'load-payment', toStepId: 'settle-invoice', kind: 'next' },
          { fromStepId: 'settle-invoice', toStepId: 'completed', kind: 'next' },
          {
            fromStepId: 'load-payment',
            toStepId: 'settle-invoice',
            kind: 'mapping',
            label: 'invoiceId',
          },
          {
            fromStepId: 'settle-invoice',
            toStepId: 'cancel-settlement',
            kind: 'compensation',
          },
          {
            fromStepId: 'settle-invoice',
            toStepId: 'load-payment',
            kind: 'revalidation',
            maxRevalidations: 1,
          },
        ]),
      },
    });
  });

  it('keeps requested and inferred mapping origins on review graph edges', async () => {
    const compiled = await createCompiledWorkflowVersion('mapping-origins@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'load-version',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          responseSchema: {
            required: { invoiceId: { type: 'string' }, amount: { type: 'number' } },
          },
        },
        {
          id: 'create-intent',
          kind: 'capabilityCall',
          capabilityVersionId: 'intent-version',
          arguments: {
            amount: { source: 'stepOutput', stepId: 'load-payment', path: ['amount'] },
            invoiceId: { source: 'stepOutput', stepId: 'load-payment', path: ['invoiceId'] },
            'Idempotency-Key': { source: 'input', path: ['paymentId'] },
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    const draft = {
      ...compiled,
      mappingOrigins: [
        { stepId: 'create-intent', destinationPath: ['amount'], origin: 'requested' as const },
        { stepId: 'create-intent', destinationPath: ['invoiceId'], origin: 'inferred' as const },
        {
          stepId: 'create-intent',
          destinationPath: ['Idempotency-Key'],
          origin: 'inferred' as const,
        },
      ],
    };

    const response = await app.request('/v1/workflow-reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        projectionFingerprint: '0'.repeat(64),
        draft,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      artifact: { mappingOrigins?: unknown };
      graph: { edges: Array<{ kind: string; label?: string; origin?: string }> };
    };
    expect(body.artifact.mappingOrigins).toEqual(draft.mappingOrigins);
    expect(body.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'mapping',
          label: 'amount',
          origin: 'requested',
        }),
        expect.objectContaining({
          kind: 'mapping',
          label: 'invoiceId',
          origin: 'inferred',
        }),
      ]),
    );
    expect(body.graph.edges.find((edge) => edge.label === 'Idempotency-Key')).toBeUndefined();
  });

  it('filters and searches runs newest first while defaulting to runs needing attention', async () => {
    await pool.query(`
      INSERT INTO workflow_versions (organization_id, workflow_version_id)
      VALUES ('org_atlas', 'payment-to-billing@1');
      INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state,
         started_at, updated_at)
      VALUES
        ('org_atlas', 'production', 'run_old', 'payment-to-billing@1', 'pay_old',
         'validation_failed', '2026-08-14T10:00:00Z', '2026-08-14T10:01:00Z'),
        ('org_atlas', 'production', 'run_new', 'payment-to-billing@1', 'pay_target',
         'running', '2026-08-14T12:00:00Z', '2026-08-14T12:01:00Z'),
        ('org_atlas', 'production', 'run_ok', 'payment-to-billing@1', 'pay_target_done',
         'completed', '2026-08-14T13:00:00Z', '2026-08-14T13:01:00Z');
    `);

    const parked = await app.request('/v1/runs/run_new/state', {
      method: 'PATCH',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        state: 'repair_required',
      }),
    });
    expect(parked.status).toBe(204);

    const attention = await app.request(
      '/v1/runs?organizationId=org_atlas&environmentId=production',
    );
    expect(attention.status).toBe(200);
    await expect(attention.json()).resolves.toMatchObject({
      filter: 'attention',
      runs: [
        { runId: 'run_new', intakeReference: 'pay_target', state: 'repair_required' },
        { runId: 'run_old', intakeReference: 'pay_old', state: 'validation_failed' },
      ],
    });

    const completed = await app.request(
      '/v1/runs?organizationId=org_atlas&environmentId=production&state=completed&intakeReference=target',
    );
    await expect(completed.json()).resolves.toMatchObject({
      filter: 'completed',
      runs: [{ runId: 'run_ok', intakeReference: 'pay_target_done', state: 'completed' }],
    });
  });

  it('reads a persisted provider failure type consistently on the run and attempt', async () => {
    const workflow = await createCompiledWorkflowVersion(
      'provider-failure-attempt@1',
      'org_atlas',
      {
        irVersion: 1,
        steps: [
          {
            id: 'get-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payments.get@provider-failure',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
            retryPolicy: {
              initialInterval: '1 millisecond',
              backoffCoefficient: 1,
              maximumInterval: '1 millisecond',
              maximumAttempts: 1,
              nonRetryableErrorTypes: ['PaymentNotFound'],
              failureBuckets: { PaymentNotFound: 'permanent-validation' },
            },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      },
    );
    await pool.query(
      `INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
       VALUES ($1, $2, $3, $4)`,
      ['org_atlas', workflow.workflowVersionId, workflow.irHash, workflow],
    );
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state)
       VALUES ('org_atlas', 'production', 'run_provider_failure', $1, 'pay_missing', 'running')`,
      [workflow.workflowVersionId],
    );

    const attemptResponse = await app.request('/v1/runs/run_provider_failure/attempts', {
      method: 'POST',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        stepId: 'get-payment',
        capabilityVersionId: 'payments.get@provider-failure',
        attempt: 1,
        durationMs: 5,
        status: 'failed',
        redactedInput: { paymentId: '[REDACTED]' },
        failureType: 'PaymentNotFound',
      }),
    });
    expect(attemptResponse.status).toBe(204);
    const outcomeResponse = await app.request('/v1/runs/run_provider_failure/state', {
      method: 'PATCH',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        state: 'validation_failed',
        failure: {
          bucket: 'permanent-validation',
          type: 'PaymentNotFound',
          stepId: 'get-payment',
        },
      }),
    });
    expect(outcomeResponse.status).toBe(204);

    const detailResponse = await app.request(
      '/v1/runs/run_provider_failure?organizationId=org_atlas&environmentId=production',
    );
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      failure: {
        bucket: 'permanent-validation',
        type: 'PaymentNotFound',
        stepId: 'get-payment',
      },
      steps: [
        {
          stepId: 'get-payment',
          attempts: [
            {
              status: 'failed',
              failureType: 'PaymentNotFound',
              redactedInput: { paymentId: '[REDACTED]' },
            },
          ],
        },
      ],
      traceHistory: expect.arrayContaining([
        expect.objectContaining({
          type: 'step.attempt',
          normalizedError: 'PaymentNotFound',
        }),
      ]),
    });
  });

  it('shows worker-redacted attempts, failure bucket, saga state, and safe repair warnings', async () => {
    const workflow = await createCompiledWorkflowVersion(
      'payment-to-billing@timeline',
      'org_atlas',
      {
        irVersion: 1,
        steps: [
          {
            id: 'get-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payments.get@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          {
            id: 'begin-invoice-settlement',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.begin@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          {
            id: 'cancel-invoice-settlement',
            kind: 'compensation',
            compensatesStepId: 'begin-invoice-settlement',
            capabilityVersionId: 'billing.cancel@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          {
            id: 'mark-invoice-paid',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.mark-paid@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
            irreversibleAfter: true,
          },
          {
            id: 'publish-invoice-paid',
            kind: 'publishEvent',
            capabilityVersionId: 'events.invoice-paid@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
            retryPolicy: {
              initialInterval: '10 milliseconds',
              backoffCoefficient: 2,
              maximumInterval: '100 milliseconds',
              maximumAttempts: 3,
              nonRetryableErrorTypes: [],
            },
            idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      },
    );
    await pool.query(
      `INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
       VALUES ($1, $2, $3, $4)`,
      ['org_atlas', workflow.workflowVersionId, workflow.irHash, workflow],
    );
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, artifact_id, intake_key,
         state, trigger_type, trigger_delivery_id)
       VALUES ('org_atlas', 'production', 'run_timeline', $1, $2, 'pay_secret', 'running',
         'webhook', 'stripe-event-100')`,
      [workflow.workflowVersionId, 'd'.repeat(64)],
    );

    for (const attempt of [
      {
        stepId: 'get-payment',
        capabilityVersionId: 'payments.get@v1',
        attempt: 1,
        durationMs: 12,
        status: 'succeeded',
        redactedInput: { paymentId: '[REDACTED]' },
        redactedOutput: { invoiceId: '[REDACTED]' },
      },
      {
        stepId: 'begin-invoice-settlement',
        capabilityVersionId: 'billing.begin@v1',
        attempt: 1,
        durationMs: 18,
        status: 'succeeded',
        redactedInput: { paymentId: '[REDACTED]' },
        redactedOutput: { status: '[REDACTED]' },
      },
      {
        stepId: 'mark-invoice-paid',
        capabilityVersionId: 'billing.mark-paid@v1',
        attempt: 1,
        durationMs: 21,
        status: 'succeeded',
        redactedInput: { paymentId: '[REDACTED]' },
        redactedOutput: { status: '[REDACTED]' },
      },
      {
        stepId: 'publish-invoice-paid',
        capabilityVersionId: 'events.invoice-paid@v1',
        attempt: 1,
        durationMs: 9,
        status: 'failed',
        redactedInput: { paymentId: '[REDACTED]' },
        failureType: 'TransientDownstream',
      },
      {
        stepId: 'publish-invoice-paid',
        capabilityVersionId: 'events.invoice-paid@v1',
        attempt: 2,
        durationMs: 9,
        status: 'failed',
        redactedInput: { paymentId: '[REDACTED]' },
        failureType: 'TransientDownstream',
      },
      {
        stepId: 'publish-invoice-paid',
        capabilityVersionId: 'events.invoice-paid@v1',
        attempt: 3,
        durationMs: 9,
        status: 'failed',
        redactedInput: { paymentId: '[REDACTED]' },
        failureType: 'TransientDownstream',
      },
    ]) {
      const response = await app.request('/v1/runs/run_timeline/attempts', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          ...attempt,
        }),
      });
      expect(response.status).toBe(204);
    }
    const parked = await app.request('/v1/runs/run_timeline/state', {
      method: 'PATCH',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        state: 'repair_required',
        failure: {
          bucket: 'retryable-transient',
          type: 'TransientDownstream',
          stepId: 'publish-invoice-paid',
        },
      }),
    });
    expect(parked.status).toBe(204);

    const timeline = await app.request(
      '/v1/runs/run_timeline?organizationId=org_atlas&environmentId=production',
    );
    expect(timeline.status).toBe(200);
    await expect(timeline.json()).resolves.toMatchObject({
      runId: 'run_timeline',
      temporalWorkflowId: 'run_timeline',
      artifactId: 'd'.repeat(64),
      trigger: { type: 'webhook', deliveryId: 'stripe-event-100' },
      state: 'repair_required',
      failure: {
        bucket: 'retryable-transient',
        type: 'TransientDownstream',
        stepId: 'publish-invoice-paid',
      },
      steps: [
        {
          stepId: 'get-payment',
          idempotency: { protected: false },
          attempts: [
            {
              attempt: 1,
              durationMs: 12,
              status: 'succeeded',
              redactedInput: { paymentId: '[REDACTED]' },
              redactedOutput: { invoiceId: '[REDACTED]' },
            },
          ],
        },
        { stepId: 'begin-invoice-settlement', attempts: [{ status: 'succeeded' }] },
        { stepId: 'mark-invoice-paid', irreversible: true, attempts: [{ status: 'succeeded' }] },
        {
          stepId: 'publish-invoice-paid',
          retry: {
            safety: { allowed: true, basis: 'stable-idempotency-key' },
            maximumAttempts: 3,
            backoff: {
              initialInterval: '10 milliseconds',
              coefficient: 2,
              maximumInterval: '100 milliseconds',
            },
          },
          attempts: [
            {
              attempt: 1,
              status: 'failed',
              failureType: 'TransientDownstream',
              failureClassification: 'retryable-transient',
              retryDecision: 'scheduled',
            },
            { attempt: 2, retryDecision: 'scheduled' },
            { attempt: 3, retryDecision: 'stopped-exhausted' },
          ],
        },
      ],
      saga: [
        {
          stepId: 'cancel-invoice-settlement',
          compensatesStepId: 'begin-invoice-settlement',
          state: 'frozen',
        },
      ],
      controls: {
        retryStep: {
          enabled: true,
          stepId: 'publish-invoice-paid',
          repairedCapabilityVersionId: 'events.invoice-paid@v1',
          safetyBasis: 'stable-idempotency-key',
          priorStepsNotRerun: ['get-payment', 'begin-invoice-settlement', 'mark-invoice-paid'],
          committedIrreversibleEffects: ['mark-invoice-paid'],
        },
        resumeRun: {
          enabled: false,
          priorStepsNotRerun: ['get-payment', 'begin-invoice-settlement', 'mark-invoice-paid'],
          committedIrreversibleEffects: ['mark-invoice-paid'],
        },
        abandonRun: { enabled: true },
      },
      traceHistory: expect.arrayContaining([
        expect.objectContaining({ type: 'workflow.started', artifactId: 'd'.repeat(64) }),
        expect.objectContaining({
          type: 'step.attempt',
          stepId: 'publish-invoice-paid',
          normalizedError: 'TransientDownstream',
          failureClassification: 'retryable-transient',
          retryDecision: 'scheduled',
        }),
        expect.objectContaining({ type: 'workflow.finished', state: 'repair_required' }),
      ]),
      effects: expect.arrayContaining([
        expect.objectContaining({
          stepId: 'mark-invoice-paid',
          status: 'confirmed',
        }),
      ]),
      privacy: { payloadsRedactedAt: 'customer-worker', plaintextStoredByAtlas: false },
    });

    for (const attempt of [
      {
        stepId: 'cancel-invoice-settlement',
        capabilityVersionId: 'billing.cancel@v1',
        attempt: 1,
        durationMs: 7,
        status: 'succeeded',
        redactedInput: { paymentId: '[REDACTED]' },
        redactedOutput: { status: '[REDACTED]' },
      },
      {
        stepId: 'begin-invoice-settlement',
        capabilityVersionId: 'billing.begin@v1',
        attempt: 1,
        durationMs: 11,
        status: 'succeeded',
        redactedInput: { paymentId: '[REDACTED]' },
        redactedOutput: { status: '[REDACTED]' },
      },
    ]) {
      const response = await app.request('/v1/runs/run_timeline/attempts', {
        method: 'POST',
        headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          ...attempt,
        }),
      });
      expect(response.status).toBe(204);
    }

    const repairedTimeline = await app.request(
      '/v1/runs/run_timeline?organizationId=org_atlas&environmentId=production',
    );
    await expect(repairedTimeline.json()).resolves.toMatchObject({
      saga: [
        {
          stepId: 'cancel-invoice-settlement',
          compensatesStepId: 'begin-invoice-settlement',
          state: 'frozen',
        },
      ],
      controls: {
        resumeRun: {
          priorStepsNotRerun: ['get-payment', 'begin-invoice-settlement', 'mark-invoice-paid'],
        },
      },
    });
  });

  it('queues only guarded repair actions and records the operator and abandon reason', async () => {
    const unconfirmedRetry = await app.request('/v1/runs/run_timeline/repairs', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        action: 'retry_step',
        stepId: 'publish-invoice-paid',
        repairedCapabilityVersionId: 'events.invoice-paid@v1',
      }),
    });
    expect(unconfirmedRetry.status).toBe(409);

    const providerRepair = await app.request('/v1/runs/run_timeline/provider-condition-repair', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        repairedCapabilityVersionId: 'events.invoice-paid@v1',
      }),
    });
    expect(providerRepair.status).toBe(204);
    expect(repairedProviderConditions).toContain('events.invoice-paid@v1');

    const retry = await app.request('/v1/runs/run_timeline/repairs', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        action: 'retry_step',
        stepId: 'publish-invoice-paid',
        repairedCapabilityVersionId: 'events.invoice-paid@v1',
      }),
    });
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      action: 'retry_step',
      stepId: 'publish-invoice-paid',
      repairedCapabilityVersionId: 'events.invoice-paid@v1',
      safetyBasis: 'stable-idempotency-key',
      operatorId: 'operator@example.com',
      status: 'queued',
    });
    const claimedRetry = await app.request(
      '/v1/repair-commands/next?organizationId=org_atlas&environmentId=production',
      { headers: { authorization: 'Bearer worker-token' } },
    );
    expect(claimedRetry.status).toBe(200);
    const retryCommand = (await claimedRetry.json()) as { repairId: string };
    expect(retryCommand).toMatchObject({
      runId: 'run_timeline',
      action: 'retry_step',
      stepId: 'publish-invoice-paid',
    });
    const completedRetry = await app.request(`/v1/repair-commands/${retryCommand.repairId}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        status: 'completed',
      }),
    });
    expect(completedRetry.status).toBe(204);

    const repairedAttempt = await app.request('/v1/runs/run_timeline/attempts', {
      method: 'POST',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        stepId: 'publish-invoice-paid',
        capabilityVersionId: 'events.invoice-paid@v1',
        attempt: 4,
        durationMs: 8,
        status: 'succeeded',
        redactedInput: { paymentId: '[REDACTED]' },
        redactedOutput: { published: '[REDACTED]' },
      }),
    });
    expect(repairedAttempt.status).toBe(204);

    const unrelatedExternalReference = await app.request('/v1/runs/run_timeline/repairs', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        action: 'retry_step',
        stepId: 'publish-invoice-paid',
        repairedCapabilityVersionId: 'billing.mark-paid@v1',
      }),
    });
    expect(unrelatedExternalReference.status).toBe(409);

    const repairTimeline = await app.request(
      '/v1/runs/run_timeline?organizationId=org_atlas&environmentId=production',
    );
    await expect(repairTimeline.json()).resolves.toMatchObject({
      repairHistory: [
        {
          repairId: retryCommand.repairId,
          action: 'retry_step',
          stepId: 'publish-invoice-paid',
          repairedCapabilityVersionId: 'events.invoice-paid@v1',
          operatorId: 'operator@example.com',
          status: 'completed',
        },
      ],
    });

    const repairAudit = await app.request(
      '/v1/audit-entries?organizationId=org_atlas&environmentId=production',
    );
    const repairAuditBody = (await repairAudit.json()) as {
      entries: Array<{ eventType: string; subjectId: string; details: Record<string, unknown> }>;
    };
    expect(repairAuditBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'repair',
          subjectId: 'run_timeline',
          details: expect.objectContaining({
            operation: 'provider-condition-repaired',
            repairedCapabilityVersionId: 'events.invoice-paid@v1',
          }),
        }),
        expect.objectContaining({
          eventType: 'repair',
          subjectId: 'run_timeline',
          details: expect.objectContaining({
            repairId: retryCommand.repairId,
            action: 'retry_step',
            status: 'queued',
            warning: expect.objectContaining({
              repairedCapabilityVersionId: 'events.invoice-paid@v1',
            }),
          }),
        }),
        expect.objectContaining({
          eventType: 'repair',
          subjectId: 'run_timeline',
          details: expect.objectContaining({
            repairId: retryCommand.repairId,
            action: 'retry_step',
            status: 'completed',
          }),
        }),
      ]),
    );

    const concurrentResumes = await Promise.all(
      [1, 2].map(() =>
        Promise.resolve().then(() =>
          app.request('/v1/runs/run_timeline/repairs', {
            method: 'POST',
            headers: {
              authorization: 'Bearer operator-token',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              organizationId: 'org_atlas',
              environmentId: 'production',
              action: 'resume_run',
            }),
          }),
        ),
      ),
    );
    expect(
      concurrentResumes.map(({ status }) => status).sort((left, right) => left - right),
    ).toEqual([202, 409]);
    const claimedResume = await app.request(
      '/v1/repair-commands/next?organizationId=org_atlas&environmentId=production',
      { headers: { authorization: 'Bearer worker-token' } },
    );
    const resumeCommand = (await claimedResume.json()) as { repairId: string };
    await app.request(`/v1/repair-commands/${resumeCommand.repairId}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        status: 'completed',
      }),
    });

    const arbitraryRestart = await app.request('/v1/runs/run_timeline/repairs', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        action: 'resume_run',
        restartAtStepId: 'mark-invoice-paid',
      }),
    });
    expect(arbitraryRestart.status).toBe(400);

    const missingReason = await app.request('/v1/runs/run_timeline/repairs', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        action: 'abandon_run',
      }),
    });
    expect(missingReason.status).toBe(400);

    const abandon = await app.request('/v1/runs/run_timeline/repairs', {
      method: 'POST',
      headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        action: 'abandon_run',
        reason: 'The downstream account was permanently retired.',
      }),
    });
    expect(abandon.status).toBe(202);
    await expect(abandon.json()).resolves.toMatchObject({
      action: 'abandon_run',
      operatorId: 'operator@example.com',
      reason: 'The downstream account was permanently retired.',
      status: 'queued',
    });
    const audit = await app.request(
      '/v1/audit-entries?organizationId=org_atlas&environmentId=production',
    );
    const auditBody = (await audit.json()) as {
      entries: Array<{
        eventType: string;
        actorId: string;
        subjectId: string;
        details: Record<string, unknown>;
      }>;
    };
    expect(auditBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'abandonment',
          actorId: 'operator@example.com',
          subjectId: 'run_timeline',
          details: expect.objectContaining({
            reason: 'The downstream account was permanently retired.',
          }),
        }),
      ]),
    );
    const claimedAbandon = await app.request(
      '/v1/repair-commands/next?organizationId=org_atlas&environmentId=production',
      { headers: { authorization: 'Bearer worker-token' } },
    );
    const abandonCommand = (await claimedAbandon.json()) as { repairId: string };
    expect(abandonCommand).toMatchObject({ runId: 'run_timeline', action: 'abandon_run' });
    await app.request(`/v1/repair-commands/${abandonCommand.repairId}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer worker-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        organizationId: 'org_atlas',
        environmentId: 'production',
        status: 'completed',
      }),
    });
    const timeline = await app.request(
      '/v1/runs/run_timeline?organizationId=org_atlas&environmentId=production',
    );
    await expect(timeline.json()).resolves.toMatchObject({
      disposition: 'abandoned',
      controls: {
        retryStep: { enabled: false },
        resumeRun: { enabled: false },
        abandonRun: { enabled: false },
      },
    });
  });

  it('rejects retry and resume when the failed write has no duplicate-safety policy', async () => {
    const workflow = await createCompiledWorkflowVersion('unsafe-repair@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'unsafe-write',
          kind: 'capabilityCall',
          capabilityVersionId: 'unsafe.write@v1',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    await pool.query(
      `INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
       VALUES ($1, $2, $3, $4)`,
      ['org_atlas', workflow.workflowVersionId, workflow.irHash, workflow],
    );
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state,
         failure_bucket, failure_type, failed_step_id)
       VALUES ('org_atlas', 'production', 'run_unsafe_repair', $1, 'unsafe-intake',
         'repair_required', 'retryable-transient', 'ResponseLost', 'unsafe-write')`,
      [workflow.workflowVersionId],
    );

    const detail = await app.request(
      '/v1/runs/run_unsafe_repair?organizationId=org_atlas&environmentId=production',
    );
    await expect(detail.json()).resolves.toMatchObject({
      steps: [{ retry: null, idempotency: { protected: false } }],
      controls: {
        retryStep: { enabled: false },
        resumeRun: { enabled: false },
        abandonRun: { enabled: true },
      },
    });

    for (const request of [
      {
        action: 'retry_step',
        stepId: 'unsafe-write',
        repairedCapabilityVersionId: 'unsafe.write@v1',
      },
      { action: 'resume_run' },
    ]) {
      const response = await app.request('/v1/runs/run_unsafe_repair/repairs', {
        method: 'POST',
        headers: { authorization: 'Bearer operator-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production',
          ...request,
        }),
      });
      expect(response.status).toBe(409);
    }
  });

  it('inspects runs of irVersion 2 workflows', async () => {
    const workflow = await createTransformationCompiledWorkflowVersion(
      'transformation-run@1',
      'org_atlas',
      {
        irVersion: 2,
        inputSchema: { required: { paymentId: { type: 'string' } } },
        steps: [
          {
            id: 'get-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payment.get@v1',
            inputSchema: { required: { paymentId: { type: 'string' } } },
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      },
    );
    await pool.query(
      `INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
       VALUES ($1, $2, $3, $4)`,
      ['org_atlas', workflow.workflowVersionId, workflow.irHash, workflow],
    );
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state)
       VALUES ('org_atlas', 'production', 'run_transformation', $1, 'transformation-intake',
         'completed')`,
      [workflow.workflowVersionId],
    );

    const detail = await app.request(
      '/v1/runs/run_transformation?organizationId=org_atlas&environmentId=production',
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      runId: 'run_transformation',
      workflowVersionId: 'transformation-run@1',
      steps: [{ stepId: 'get-payment', capabilityVersionId: 'payment.get@v1' }],
    });
  });

  it('reports only the caller query as invalid-run-query', async () => {
    const missingScope = await app.request('/v1/runs/run_transformation?organizationId=org_atlas');
    expect(missingScope.status).toBe(400);
    await expect(missingScope.json()).resolves.toMatchObject({ error: 'invalid-run-query' });

    await pool.query(
      `INSERT INTO workflow_versions
        (organization_id, workflow_version_id, ir_hash, compiled_workflow)
       VALUES ('org_atlas', 'corrupt-workflow@1', $1, $2)`,
      ['0'.repeat(64), { irVersion: 99 }],
    );
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state)
       VALUES ('org_atlas', 'production', 'run_corrupt', 'corrupt-workflow@1', 'corrupt-intake',
         'completed')`,
    );
    const corrupt = await app.request(
      '/v1/runs/run_corrupt?organizationId=org_atlas&environmentId=production',
    );
    expect(corrupt.status).toBe(500);
  });

  it('lists immutable versions with lifecycle, approval attribution, and linked runs', async () => {
    const versions = await Promise.all(
      [1, 2, 3].map((version) =>
        createCompiledWorkflowVersion(`history-workflow@${version}`, 'org_atlas', {
          irVersion: 1,
          steps: [{ id: 'completed', kind: 'terminal', state: 'completed' }],
        }),
      ),
    );
    for (const workflow of versions) {
      await pool.query(
        `INSERT INTO workflow_versions
          (organization_id, workflow_version_id, ir_hash, compiled_workflow)
         VALUES ($1, $2, $3, $4)`,
        ['org_atlas', workflow.workflowVersionId, workflow.irHash, workflow],
      );
    }
    await pool.query(
      `INSERT INTO workflow_approvals
        (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
         projection_fingerprint, approved_by, approved_at, lifecycle_status)
       VALUES
        ('org_atlas', 'production', 'history-workflow@1', $1, 'policy-v1', $4,
         'ada@example.com', '2026-08-12T10:00:00Z', 'superseded'),
        ('org_atlas', 'production', 'history-workflow@2', $2, 'policy-v1', $4,
         'grace@example.com', '2026-08-13T10:00:00Z', 'current'),
        ('org_atlas', 'production', 'history-workflow@3', $3, 'policy-v1', $4,
         'lin@example.com', '2026-08-14T10:00:00Z', 'approved')`,
      [versions[0]!.irHash, versions[1]!.irHash, versions[2]!.irHash, '1'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO workflow_runs
        (organization_id, environment_id, run_id, workflow_version_id, intake_key, state,
         started_at)
       VALUES
        ('org_atlas', 'production', 'run_history_old', 'history-workflow@1', 'pay_old',
         'completed', '2026-08-12T11:00:00Z'),
        ('org_atlas', 'production', 'run_history_current', 'history-workflow@2',
         'pay_current', 'completed', '2026-08-13T11:00:00Z')`,
    );

    const response = await app.request(
      '/v1/workflow-versions?organizationId=org_atlas&environmentId=production',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      versions: [
        {
          workflowVersionId: 'history-workflow@3',
          irHash: versions[2]!.irHash,
          status: 'approved',
          approvedBy: 'lin@example.com',
          approvedAt: '2026-08-14T10:00:00.000Z',
          runs: [],
        },
        {
          workflowVersionId: 'history-workflow@2',
          irHash: versions[1]!.irHash,
          status: 'current',
          approvedBy: 'grace@example.com',
          approvedAt: '2026-08-13T10:00:00.000Z',
          runs: [
            {
              runId: 'run_history_current',
              paymentId: 'pay_current',
              state: 'completed',
              startedAt: '2026-08-13T11:00:00.000Z',
            },
          ],
        },
        {
          workflowVersionId: 'history-workflow@1',
          irHash: versions[0]!.irHash,
          status: 'superseded',
          approvedBy: 'ada@example.com',
          approvedAt: '2026-08-12T10:00:00.000Z',
          runs: [
            {
              runId: 'run_history_old',
              paymentId: 'pay_old',
              state: 'completed',
              startedAt: '2026-08-12T11:00:00.000Z',
            },
          ],
        },
      ],
    });
  });

  it('compares any two versions by added, removed, changed, and capability-bumped steps', async () => {
    const from = await createCompiledWorkflowVersion('diff-workflow@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'payments.get@v1',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        {
          id: 'settle-invoice',
          kind: 'capabilityCall',
          capabilityVersionId: 'billing.settle@v1',
          arguments: { invoiceId: { source: 'input', path: ['invoiceId'] } },
        },
        {
          id: 'notify-operations',
          kind: 'notify',
          capabilityVersionId: 'operations.notify@v1',
          arguments: {},
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    const to = await createCompiledWorkflowVersion('diff-workflow@2', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'payments.get@v2',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        },
        {
          id: 'settle-invoice',
          kind: 'capabilityCall',
          capabilityVersionId: 'billing.settle@v1',
          arguments: { invoiceId: { source: 'input', path: ['invoice', 'id'] } },
        },
        {
          id: 'publish-invoice-paid',
          kind: 'publishEvent',
          capabilityVersionId: 'events.invoice-paid@v1',
          arguments: {},
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    for (const workflow of [from, to]) {
      await pool.query(
        `INSERT INTO workflow_versions
          (organization_id, workflow_version_id, ir_hash, compiled_workflow)
         VALUES ($1, $2, $3, $4)`,
        ['org_atlas', workflow.workflowVersionId, workflow.irHash, workflow],
      );
      await pool.query(
        `INSERT INTO workflow_approvals
          (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
           projection_fingerprint, approved_by)
         VALUES ('org_atlas', 'production', $1, $2, 'policy-v1', $3, 'admin@example.com')`,
        [workflow.workflowVersionId, workflow.irHash, '2'.repeat(64)],
      );
    }

    const response = await app.request(
      '/v1/workflow-version-diffs?organizationId=org_atlas&environmentId=production&fromVersionId=diff-workflow%401&toVersionId=diff-workflow%402',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      fromVersionId: 'diff-workflow@1',
      toVersionId: 'diff-workflow@2',
      addedSteps: [{ stepId: 'publish-invoice-paid', toIndex: 2 }],
      removedSteps: [{ stepId: 'notify-operations', fromIndex: 2 }],
      changedSteps: [
        {
          stepId: 'settle-invoice',
          fromIndex: 1,
          toIndex: 1,
          before: { arguments: { invoiceId: { source: 'input', path: ['invoiceId'] } } },
          after: { arguments: { invoiceId: { source: 'input', path: ['invoice', 'id'] } } },
        },
      ],
      capabilityVersionBumps: [
        {
          stepId: 'load-payment',
          fromCapabilityVersionId: 'payments.get@v1',
          toCapabilityVersionId: 'payments.get@v2',
        },
      ],
    });
  });

  it('reports reordered steps separately from definition changes', async () => {
    const makeWorkflow = (workflowVersionId: string, stepIds: readonly string[]) =>
      createCompiledWorkflowVersion(workflowVersionId, 'org_atlas', {
        irVersion: 1,
        steps: [
          ...stepIds.map((id) => ({
            id,
            kind: 'capabilityCall' as const,
            capabilityVersionId: `${id}@v1`,
            arguments: {},
          })),
          { id: 'completed', kind: 'terminal' as const, state: 'completed' as const },
        ],
      });
    const from = await makeWorkflow('reordered-workflow@1', ['first', 'second']);
    const to = await makeWorkflow('reordered-workflow@2', ['second', 'first']);
    for (const workflow of [from, to]) {
      await pool.query(
        `INSERT INTO workflow_versions
          (organization_id, workflow_version_id, ir_hash, compiled_workflow)
         VALUES ($1, $2, $3, $4)`,
        ['org_atlas', workflow.workflowVersionId, workflow.irHash, workflow],
      );
      await pool.query(
        `INSERT INTO workflow_approvals
          (organization_id, environment_id, workflow_version_id, ir_hash, policy_version,
           projection_fingerprint, approved_by)
         VALUES ('org_atlas', 'production', $1, $2, 'policy-v1', $3, 'admin@example.com')`,
        [workflow.workflowVersionId, workflow.irHash, '3'.repeat(64)],
      );
    }

    const response = await app.request(
      '/v1/workflow-version-diffs?organizationId=org_atlas&environmentId=production&fromVersionId=reordered-workflow%401&toVersionId=reordered-workflow%402',
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      changedSteps: [],
      reorderedSteps: [
        { stepId: 'first', fromIndex: 0, toIndex: 1 },
        { stepId: 'second', fromIndex: 1, toIndex: 0 },
      ],
    });
  });
});
