import type { AddressInfo } from 'node:net';

import { serve } from '@hono/node-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { app as mockServicesApp } from '@atlas/mock-services';
import {
  createEncryptedDataConverter,
  createTemporalWorker,
  INTERPRETER_WORKFLOW,
} from '@atlas/temporal-adapter';
import { createTemporalTestEnvironment } from '@atlas/temporal-adapter/testing';
import {
  createCompiledWorkflowVersion,
  type CompiledWorkflowVersion,
  type JsonValue,
} from '@atlas/workflow-ir';

import { createCapabilityStepActivities } from './capability-activities.js';
import { createGenericCapabilityActivityResolver } from './generic-capability-activities.js';
import { createHubSpotCapabilityActivity } from './hubspot-connector.js';
import { createSlackCapabilityActivity } from './slack-connector.js';

const taskQueue = 'worker-capability-activities';
const organizationId = 'org_atlas_demo';
const backendUrl = 'http://atlas-backend';
const demoCatalog = {
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
      hostPolicy: { approvedHostnames: ['127.0.0.1'] },
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
              eventType: { type: 'string', const: 'invoice.paid' },
            },
          },
        },
        references: {},
      },
      annotation: { idempotencyField: 'eventId' },
      hostPolicy: { approvedHostnames: ['127.0.0.1'] },
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
      hostPolicy: { approvedHostnames: ['127.0.0.1'] },
    },
  ],
};
const knownState = {
  payments: [
    {
      paymentId: 'pay_1',
      invoiceId: 'inv_1',
      status: 'succeeded',
      amount: { value: 5_000, currency: 'USD' },
      paidAt: '2026-08-03T18:00:00Z',
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
  ],
};

let environment: Awaited<ReturnType<typeof createTemporalTestEnvironment>>;
let server: ReturnType<typeof serve>;
let worker: Awaited<ReturnType<typeof createTemporalWorker>>;
let workerRun: Promise<void>;
let mockServicesUrl: string;
const providerRequests: string[] = [];
const dataConverter = createEncryptedDataConverter(Buffer.alloc(32, 80).toString('base64'));

beforeAll(async () => {
  server = serve({ fetch: mockServicesApp.fetch, port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  mockServicesUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  environment = await createTemporalTestEnvironment({ dataConverter });
  const secretProvider = {
    async getSecret() {
      return 'local-worker-held-token';
    },
  };
  worker = await createTemporalWorker({
    connection: environment.nativeConnection,
    taskQueue,
    dataConverter,
    activities: createCapabilityStepActivities({
      capabilities: [
        createSlackCapabilityActivity({
          binding: {
            capabilityVersionId: 'slack-generated-version',
            secretAlias: 'SLACK_BOT_TOKEN',
            approvedHostnames: [new URL(mockServicesUrl).hostname],
          },
          baseUrl: mockServicesUrl,
          secretProvider,
        }),
        createHubSpotCapabilityActivity({
          binding: {
            capabilityVersionId: 'hubspot-generated-version',
            secretAlias: 'HUBSPOT_ACCESS_TOKEN',
            approvedHostnames: [new URL(mockServicesUrl).hostname],
          },
          baseUrl: mockServicesUrl,
          secretProvider,
        }),
      ],
      resolveCapability: createGenericCapabilityActivityResolver({
        backendUrl,
        organizationId,
        environmentId: 'development',
        providerBaseUrl: mockServicesUrl,
        async fetch(input, init) {
          const url = requestUrl(input);
          if (url.startsWith(backendUrl)) return Response.json(demoCatalog);
          providerRequests.push(url);
          return globalThis.fetch(input, init);
        },
      }),
    }),
  });
  workerRun = worker.run();
}, 60_000);

beforeEach(async () => {
  providerRequests.length = 0;
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

function interpreterArgs(
  workflow: CompiledWorkflowVersion,
  input: Readonly<Record<string, JsonValue>>,
) {
  return [{ workflow, input, approvedHostnames: ['127.0.0.1'] }] as const;
}

describe('capability step activities', () => {
  it('executes an approved HubSpot contact creation through the generic interpreter', async () => {
    const workflow = await createCompiledWorkflowVersion('hubspot-contact@1', organizationId, {
      irVersion: 1,
      steps: [
        {
          id: 'create-contact',
          kind: 'capabilityCall',
          capabilityVersionId: 'hubspot-generated-version',
          arguments: {
            email: { source: 'input', path: ['email'] },
            firstName: { source: 'input', path: ['firstName'] },
            lastName: { source: 'input', path: ['lastName'] },
          },
          responseSchema: {
            required: { id: { type: 'string' }, archived: { type: 'boolean' } },
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });

    const result = await environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
      workflowId: 'hubspot-contact-standard-runtime',
      taskQueue,
      args: interpreterArgs(workflow, {
        email: 'sample@example.com',
        firstName: 'Ada',
        lastName: 'Lovelace',
      }),
    });

    expect(result).toEqual({ state: 'completed' });
  });

  it('executes an approved Slack notification through the generic interpreter', async () => {
    const workflow = await createCompiledWorkflowVersion('slack-notification@1', organizationId, {
      irVersion: 1,
      steps: [
        {
          id: 'notify-team',
          kind: 'notify',
          capabilityVersionId: 'slack-generated-version',
          arguments: {
            channel: { source: 'input', path: ['channel'] },
            text: { source: 'input', path: ['text'] },
          },
          idempotency: { businessKey: { source: 'input', path: ['notificationId'] } },
          responseSchema: {
            required: { ok: { type: 'boolean' }, channel: { type: 'string' } },
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });

    const result = await environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
      workflowId: 'slack-notification-standard-runtime',
      taskQueue,
      args: interpreterArgs(workflow, {
        channel: 'C_SAMPLE_DEMO',
        text: 'Payment completed',
        notificationId: 'notification-1',
      }),
    });

    expect(result).toEqual({ state: 'completed' });
  });

  it('runs a catalog-resolved payment, invoice.paid, and notification chain', async () => {
    const workflow = await createCompiledWorkflowVersion('payment-events@1', organizationId, {
      irVersion: 1,
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'cap_get_payment',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
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

    const result = await environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
      workflowId: 'payment-events-pay_1',
      taskQueue,
      args: interpreterArgs(workflow, { paymentId: 'pay_1', atlasWorkflowRunId: 'run_events' }),
    });

    expect(result).toEqual({ state: 'completed' });
    const observations = (await (
      await fetch(`${mockServicesUrl}/__control/observations`)
    ).json()) as {
      publishedEvents: Array<Record<string, unknown>>;
      notifications: Array<Record<string, unknown>>;
    };
    expect(observations.publishedEvents).toEqual([
      expect.objectContaining({
        eventType: 'invoice.paid',
        paymentId: 'pay_1',
        invoiceId: 'inv_1',
      }),
    ]);
    expect(observations.notifications).toEqual([
      expect.objectContaining({ atlasWorkflowRunId: 'run_events', paymentId: 'pay_1' }),
    ]);
  });

  it('retries a generic provider request after a typed transient JSON error', async () => {
    await fetch(`${mockServicesUrl}/__control/faults`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'getPayment', mode: 'transient', failures: 1 }),
    });
    const workflow = await createCompiledWorkflowVersion('payment-retry@1', organizationId, {
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
            maximumAttempts: 2,
            nonRetryableErrorTypes: [],
          },
          responseSchema: { required: { paymentId: { type: 'string' } } },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });

    await expect(
      environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
        workflowId: 'payment-retry-pay_1',
        taskQueue,
        args: interpreterArgs(workflow, { paymentId: 'pay_1' }),
      }),
    ).resolves.toEqual({ state: 'completed' });
    expect(providerRequests.filter((url) => url.endsWith('/payments/pay_1'))).toHaveLength(2);
  });

  it('lands a step whose capability has no binding as an operational failure', async () => {
    const workflow = await createCompiledWorkflowVersion('unbound@1', organizationId, {
      irVersion: 1,
      steps: [
        {
          id: 'unbound-step',
          kind: 'capabilityCall',
          capabilityVersionId: 'cap_missing',
          arguments: {},
          retryPolicy: {
            initialInterval: '1 millisecond',
            backoffCoefficient: 1,
            maximumInterval: '1 millisecond',
            maximumAttempts: 1,
            nonRetryableErrorTypes: [],
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });

    const result = await environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
      workflowId: 'unbound-step-run',
      taskQueue,
      args: interpreterArgs(workflow, {}),
    });

    expect(result).toEqual({
      state: 'repair_required',
      failure: {
        bucket: 'permanent-operational',
        type: 'UnknownCapabilityVersion',
        stepId: 'unbound-step',
      },
    });
  });
});

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input;
}
