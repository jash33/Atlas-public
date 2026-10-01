import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { generateExecutionGrantKeyPair, issueExecutionGrant } from '@atlas/execution-grant';
import { app as mockServicesApp } from '@atlas/mock-services';
import {
  createEncryptedDataConverter,
  createTemporalWorkflowRunStarter,
  createTemporalWorker,
  type StepAttempt,
} from '@atlas/temporal-adapter';
import { createTemporalTestEnvironment } from '@atlas/temporal-adapter/testing';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';

import { createWorkerApp } from './app.js';
import { createBackendInterpreterInputFactory } from './backend-execution.js';
import { createCapabilityStepActivities } from './capability-activities.js';
import { createGenericCapabilityActivityResolver } from './generic-capability-activities.js';

const organizationId = 'org_atlas_demo';
const environmentId = 'env_production';
const taskQueue = 'issue-24-payment-intake';
const backendUrl = 'http://atlas-backend';
const demoCatalog = (hostname: string) => ({
  capabilities: [
    {
      capabilityVersionId: 'cap_get_payment',
      identity: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
      fragment: {
        method: 'get',
        path: '/payments/{paymentId}',
        operation: {
          parameters: [{ name: 'paymentId', in: 'path', required: true }],
        },
        references: {},
      },
      annotation: { idempotencyField: null },
      hostPolicy: { approvedHostnames: [hostname] },
    },
    {
      capabilityVersionId: 'cap_publish_invoice_paid',
      identity: { kind: 'asyncapi', serviceId: 'events', operationId: 'publishInvoicePaid' },
      fragment: {
        operation: { action: 'send' },
        channel: { address: 'invoice.paid' },
        message: {
          payload: {
            type: 'object',
            required: ['eventId', 'eventType', 'invoiceId', 'paymentId', 'atlasWorkflowRunId'],
            properties: {
              eventId: { type: 'string' },
              eventType: { type: 'string', const: 'invoice.paid' },
              invoiceId: { type: 'string' },
              paymentId: { type: 'string' },
              atlasWorkflowRunId: { type: 'string' },
            },
          },
        },
        references: {},
      },
      annotation: { idempotencyField: 'eventId' },
      hostPolicy: { approvedHostnames: [hostname] },
    },
    {
      capabilityVersionId: 'cap_notify_operations',
      identity: {
        kind: 'openapi',
        serviceId: 'operations',
        operationId: 'notifyPaymentOperations',
      },
      fragment: {
        method: 'post',
        path: '/operations/payment-notifications',
        operation: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['paymentId', 'invoiceId', 'atlasWorkflowRunId', 'idempotencyKey'],
                },
              },
            },
          },
        },
        references: {},
      },
      annotation: { idempotencyField: 'idempotencyKey' },
      hostPolicy: { approvedHostnames: [hostname] },
    },
  ],
});

// A planner-shaped IR over catalog capabilities; no workflow-specific code exists in the worker.
function createApprovedWorkflow() {
  return createCompiledWorkflowVersion('payment-events@1', organizationId, {
    irVersion: 1,
    steps: [
      {
        id: 'get-payment',
        kind: 'capabilityCall',
        capabilityVersionId: 'cap_get_payment',
        arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
        retryPolicy: {
          initialInterval: '1 millisecond',
          backoffCoefficient: 1,
          maximumInterval: '1 millisecond',
          maximumAttempts: 1,
          nonRetryableErrorTypes: ['PaymentNotFound'],
          failureBuckets: { PaymentNotFound: 'permanent-validation' },
        },
        responseSchema: {
          required: { paymentId: { type: 'string' }, invoiceId: { type: 'string' } },
        },
      },
      {
        id: 'publish-invoice-paid',
        kind: 'publishEvent',
        capabilityVersionId: 'cap_publish_invoice_paid',
        arguments: {
          paymentId: { source: 'input', path: ['paymentId'] },
          invoiceId: { source: 'stepOutput', stepId: 'get-payment', path: ['invoiceId'] },
          atlasWorkflowRunId: { source: 'input', path: ['atlasWorkflowRunId'] },
        },
        idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
        responseSchema: { required: { published: { type: 'boolean' } } },
      },
      {
        id: 'notify-payment-operations',
        kind: 'notify',
        capabilityVersionId: 'cap_notify_operations',
        arguments: {
          paymentId: { source: 'input', path: ['paymentId'] },
          invoiceId: { source: 'stepOutput', stepId: 'get-payment', path: ['invoiceId'] },
          atlasWorkflowRunId: { source: 'input', path: ['atlasWorkflowRunId'] },
        },
        idempotency: { businessKey: { source: 'input', path: ['atlasWorkflowRunId'] } },
        responseSchema: { required: { notified: { type: 'boolean' } } },
      },
      { id: 'completed', kind: 'terminal', state: 'completed' },
    ],
  });
}
const knownState = {
  payments: [
    {
      paymentId: 'pay_1',
      invoiceId: 'inv_1',
      status: 'succeeded',
      amount: { value: 5_000, currency: 'USD' },
      paidAt: '2026-08-03T18:00:00Z',
    },
    {
      paymentId: 'pay_conflict',
      invoiceId: 'inv_conflict',
      status: 'succeeded',
      amount: { value: 2_500, currency: 'USD' },
      paidAt: '2026-08-03T19:00:00Z',
    },
    {
      paymentId: 'pay_repair',
      invoiceId: 'inv_repair',
      status: 'succeeded',
      amount: { value: 7_500, currency: 'USD' },
      paidAt: '2026-08-03T20:00:00Z',
    },
  ],
  invoices: [
    {
      invoiceId: 'inv_1',
      version: 1,
      status: 'open',
      outstandingBalance: { value: 5_000, currency: 'USD' },
      customerId: 'cust_9',
    },
    {
      invoiceId: 'inv_conflict',
      version: 1,
      status: 'open',
      outstandingBalance: { value: 2_500, currency: 'USD' },
      customerId: 'cust_10',
    },
    {
      invoiceId: 'inv_repair',
      version: 1,
      status: 'open',
      outstandingBalance: { value: 7_500, currency: 'USD' },
      customerId: 'cust_11',
    },
  ],
};

let environment: Awaited<ReturnType<typeof createTemporalTestEnvironment>>;
let server: ReturnType<typeof serve>;
let worker: Awaited<ReturnType<typeof createTemporalWorker>>;
let workerRun: Promise<void>;
let mockServicesUrl: string;
let app: ReturnType<typeof createWorkerApp>;
let approvedWorkflow: Awaited<ReturnType<typeof createApprovedWorkflow>>;
const reportedStepAttempts: StepAttempt[] = [];
const dataConverter = createEncryptedDataConverter(Buffer.alloc(32, 80).toString('base64'));

beforeAll(async () => {
  server = serve({ fetch: mockServicesApp.fetch, port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  mockServicesUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const keyPair = await generateExecutionGrantKeyPair();
  approvedWorkflow = await createApprovedWorkflow();
  environment = await createTemporalTestEnvironment({ dataConverter });
  worker = await createTemporalWorker({
    connection: environment.nativeConnection,
    taskQueue,
    dataConverter,
    activities: createCapabilityStepActivities({
      resolveCapability: createGenericCapabilityActivityResolver({
        backendUrl,
        organizationId,
        environmentId,
        providerBaseUrl: mockServicesUrl,
        async fetch(input, init) {
          const url = requestUrl(input);
          if (url.startsWith(backendUrl)) {
            return Response.json(demoCatalog(new URL(mockServicesUrl).hostname));
          }
          if (url.endsWith('/payments/pay_transport_failure')) {
            throw new Error('Provider transport failed');
          }
          return globalThis.fetch(input, init);
        },
      }),
    }),
    stepAttemptReporter: {
      async recordStepAttempt(attempt) {
        reportedStepAttempts.push(attempt);
      },
    },
  });
  workerRun = worker.run();

  const starter = createTemporalWorkflowRunStarter({
    workflowClient: environment.client.workflow,
    taskQueue,
    async startAuthorized(_input, startTemporal) {
      return await startTemporal(approvedWorkflow);
    },
    createInterpreterInput: createBackendInterpreterInputFactory({
      backendUrl: 'http://atlas-backend',
      workerToken: 'worker-token',
      organizationId,
      environmentId,
      async fetch(_input, init) {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON grant request');
        const request = JSON.parse(init.body) as { runId: string };
        return Response.json({
          grant: await issueExecutionGrant(keyPair.privateKey, {
            organizationId,
            environmentId,
            runId: request.runId,
            workflowVersionId: approvedWorkflow.workflowVersionId,
            irHash: approvedWorkflow.irHash,
            approvedCapabilityVersionIds:
              approvedWorkflow.executionRequirements.requiredCapabilityVersionIds,
            approvedHostnames: [new URL(mockServicesUrl).hostname],
          }),
        });
      },
    }),
  });
  app = createWorkerApp(starter);
}, 60_000);

beforeEach(async () => {
  reportedStepAttempts.length = 0;
  const response = await fetch(`${mockServicesUrl}/__control/resources`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'replace',
      resources: [
        ...knownState.payments.map((document) => ({
          service: 'payments',
          collection: 'payments',
          id: document.paymentId,
          document,
        })),
        ...knownState.invoices.map((document) => ({
          service: 'billing',
          collection: 'invoices',
          id: document.invoiceId,
          document,
        })),
      ],
    }),
  });
  if (response.status !== 204) {
    throw new Error(`Mock estate seed failed with status ${response.status}`);
  }
});

afterAll(async () => {
  worker.shutdown();
  await workerRun.catch(() => undefined);
  await environment.teardown();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input;
}

describe('payment intake identity', () => {
  it('returns one run and produces one set of effects for a redelivered paymentId', async () => {
    const first = await postPaymentRun({ paymentId: 'pay_1' });
    expect(first.status).toBe(202);
    const acceptedBody = (await first.json()) as { workflowRunId: string };
    expect(acceptedBody.workflowRunId).not.toContain('pay_1');
    await environment.client.workflow.getHandle(acceptedBody.workflowRunId).result();
    const redeliveryAfterCompletion = await postPaymentRun({ paymentId: 'pay_1' });
    expect(redeliveryAfterCompletion.status).toBe(202);
    await expect(redeliveryAfterCompletion.json()).resolves.toEqual(acceptedBody);

    const observations = (await (
      await fetch(`${mockServicesUrl}/__control/observations`)
    ).json()) as {
      publishedEvents: unknown[];
      notifications: unknown[];
    };
    expect(observations.publishedEvents).toHaveLength(1);
    expect(observations.notifications).toHaveLength(1);
    expect(reportedStepAttempts).not.toHaveLength(0);
    const exportedTrace = JSON.stringify(
      reportedStepAttempts.map(({ redactedInput, redactedOutput }) => ({
        redactedInput,
        redactedOutput,
      })),
    );
    expect(exportedTrace).not.toContain('pay_1');
    expect(exportedTrace).not.toContain('inv_1');
    expect(exportedTrace).not.toContain('5000');
    expect(exportedTrace).toContain('[REDACTED]');
  });

  it('treats a different payload for an existing paymentId as the same Temporal run', async () => {
    const accepted = await postPaymentRun({ paymentId: 'pay_conflict', source: 'original' });
    expect(accepted.status).toBe(202);
    const acceptedBody = (await accepted.json()) as { workflowRunId: string };
    await environment.client.workflow.getHandle(acceptedBody.workflowRunId).result();
    const retry = await postPaymentRun({ paymentId: 'pay_conflict', source: 'retry' });

    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toEqual(acceptedBody);
  });

  it('reports the provider failure type on the failed step attempt', async () => {
    const accepted = await postPaymentRun({ paymentId: 'pay_missing' });
    expect(accepted.status).toBe(202);
    const { workflowRunId } = (await accepted.json()) as { workflowRunId: string };

    await expect(environment.client.workflow.getHandle(workflowRunId).result()).resolves.toEqual({
      state: 'validation_failed',
      failure: {
        bucket: 'permanent-validation',
        type: 'PaymentNotFound',
        stepId: 'get-payment',
      },
    });
    expect(reportedStepAttempts.length).toBeGreaterThan(0);
    for (const attempt of reportedStepAttempts) {
      expect(attempt).toMatchObject({
        runId: workflowRunId,
        stepId: 'get-payment',
        status: 'failed',
        failureType: 'PaymentNotFound',
        redactedInput: { paymentId: '[REDACTED]' },
      });
    }
  });

  it('reports the generic fallback for an untyped provider exception', async () => {
    const accepted = await postPaymentRun({ paymentId: 'pay_transport_failure' });
    expect(accepted.status).toBe(202);
    const { workflowRunId } = (await accepted.json()) as { workflowRunId: string };

    await environment.client.workflow.getHandle(workflowRunId).result();

    expect(reportedStepAttempts.length).toBeGreaterThan(0);
    for (const attempt of reportedStepAttempts) {
      expect(attempt).toMatchObject({
        runId: workflowRunId,
        stepId: 'get-payment',
        status: 'failed',
        failureType: 'UnknownOperationalFailure',
        redactedInput: { paymentId: '[REDACTED]' },
      });
    }
  });
});

function postPaymentRun(payload: Record<string, unknown>) {
  return app.fetch(
    new Request('http://worker/v1/workflows/payment-to-billing/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );
}
