import { serve } from '@hono/node-server';
import { createMockServicesApp } from '@atlas/mock-services';
import { createEncryptedDataConverter } from '@atlas/temporal-adapter';
import { createTemporalTestEnvironment } from '@atlas/temporal-adapter/testing';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import {
  createWorkflowSandboxRunner,
  createWorkflowSandboxTemporalRuntime,
} from './workflow-sandbox.js';
import { invokeSandboxProvider, matchesPinnedSchema } from './workflow-sandbox-provider.js';

const dataConverter = createEncryptedDataConverter(Buffer.alloc(32, 101).toString('base64'));
let environment: Awaited<ReturnType<typeof createTemporalTestEnvironment>>;

beforeAll(async () => {
  environment = await createTemporalTestEnvironment({ dataConverter });
}, 60_000);

afterAll(async () => environment.teardown());

describe('customer-worker workflow sandbox', () => {
  it('checks a connected contract after a transient control connection timeout without sample mocks', async () => {
    const workflow = await createCompiledWorkflowVersion('connected-static@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: {} },
      steps: [
        { id: 'add', kind: 'capabilityCall', capabilityVersionId: 'burger.add@1', arguments: {} },
        { id: 'done', kind: 'terminal', state: 'completed' },
      ],
    });
    let controlRequests = 0;
    const runner = createWorkflowSandboxRunner({
      organizationId: 'org_atlas',
      environmentId: 'development',
      fallbackRunnerBaseUrl: 'http://sample-mocks',
      fetch: async (url) => {
        const requestedUrl = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
        if (requestedUrl.startsWith('http://sample-mocks'))
          throw new Error('Connected static checks must not use sample contracts');
        // Health and seeding succeed; the first observations connection fails.
        if (++controlRequests === 3) {
          throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
        }
        return Response.json({ setup: { ready: true } });
      },
      temporalRuntime: {
        execute: async () => {
          throw new Error('Static checks must not execute workflow');
        },
      },
    });
    const result = await runner.execute({
      organizationId: 'org_atlas',
      environmentId: 'development',
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      workflow,
      providerContracts: [
        {
          capabilityVersionId: 'burger.add@1',
          serviceId: 'burger-town',
          operationId: 'addItem',
          documentHash: 'a'.repeat(64),
          provider: 'burger-town',
          mode: 'local',
          method: 'post',
          path: '/items',
          requestSchema: {
            type: 'object',
            required: ['quantity'],
            properties: { quantity: { type: 'integer' } },
          },
          responseSchema: null,
        },
      ],
      targetBindings: [
        {
          capabilityVersionId: 'burger.add@1',
          targetKey: 'connected-source',
          targetRevision: 1,
          baseUrl: 'http://burger.local:43123',
          hostname: 'burger.local',
          healthPath: '/health',
          controlPaths: {
            resources: '/resources',
            faults: '/faults',
            observations: '/observations',
          },
          secretAlias: null,
          testDataProfileKey: 'connected-source',
          testDataVersion: 1,
          inputs: {},
          targetState: { mode: 'replace', resources: [] },
          setupAssumptions: [{ path: ['setup', 'ready'], equals: true }],
        },
      ],
      tests: [1, 1.5, 2].map((quantity) => ({
        testId: `quantity-${quantity}`,
        kind: 'compatibility',
        stepId: 'add',
        capabilityVersionId: 'burger.add@1',
        expectation: 'Validate pinned schema',
        requestSample: { quantity },
        expectedResponseSchema: quantity === 2 ? { type: 'string' } : null,
      })),
    });
    expect(result.outcomes.map(({ status }) => status)).toEqual(['passed', 'failed', 'failed']);
    expect(controlRequests).toBe(4);
  });

  it('serializes derived idempotency using the connected capability body field', async () => {
    const observations: Parameters<typeof invokeSandboxProvider>[4] = [];
    const request: typeof fetch = async (_url, init) => {
      expect(await new Response(init?.body).json()).toEqual({
        quantity: 1,
        idempotency_key: 'per-step-key',
      });
      return Response.json({ id: 'item-added' });
    };
    await expect(
      invokeSandboxProvider(
        request,
        'http://host.docker.internal:43123',
        {
          capabilityVersionId: 'burger.addItem@v1',
          serviceId: 'burger-town',
          operationId: 'addItem',
          documentHash: 'a'.repeat(64),
          provider: 'burger-town',
          mode: 'local',
          method: 'post',
          path: '/v1/checks/{check_id}/items',
          requestSchema: null,
          responseSchema: null,
          idempotencyField: 'idempotency_key',
        },
        {
          stepId: 'add-item',
          capabilityVersionId: 'burger.addItem@v1',
          input: { check_id: 'chk_ok', quantity: 1, idempotencyKey: 'per-step-key' },
        },
        observations,
      ),
    ).resolves.toEqual({ id: 'item-added' });
  });

  it('honors pinned JSON Schema constraints beyond shape checks', () => {
    expect(
      matchesPinnedSchema(
        { count: 1.5, code: 'lowercase' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'code'],
          properties: {
            count: { type: 'integer', minimum: 2 },
            code: { type: 'string', pattern: '^[A-Z]+$' },
          },
        },
      ),
    ).toBe(false);
  });

  it('publishes invoice.paid when the sandbox contract uses the AsyncAPI channel address', async () => {
    const providerServer = serve({ fetch: createMockServicesApp().fetch, port: 0 });
    try {
      const address = providerServer.address();
      if (!address || typeof address === 'string') throw new Error('Provider did not bind a port');
      const providerBaseUrl = `http://127.0.0.1:${address.port}`;
      const observations: Parameters<typeof invokeSandboxProvider>[4] = [];
      await expect(
        invokeSandboxProvider(
          fetch,
          providerBaseUrl,
          {
            capabilityVersionId: 'events.invoice-paid@v1',
            serviceId: 'events',
            operationId: 'publishInvoicePaid',
            documentHash: 'd'.repeat(64),
            provider: 'Atlas internal',
            mode: 'local',
            method: 'post',
            path: 'invoice.paid',
            requestSchema: null,
            responseSchema: null,
          },
          {
            stepId: 'publish_invoice_paid',
            capabilityVersionId: 'events.invoice-paid@v1',
            input: {
              eventId: 'sandbox-run',
              eventType: 'invoice.paid',
              invoiceId: 'inv_sandbox',
              paymentId: 'pay_sandbox',
              atlasWorkflowRunId: 'sandbox-run',
              idempotencyKey: 'derived-key',
            },
          },
          observations,
        ),
      ).resolves.toEqual({ published: true });
      expect(observations).toEqual([
        expect.objectContaining({ stepId: 'publish_invoice_paid', status: 202 }),
      ]);
    } finally {
      providerServer.close();
    }
  });

  it(
    'completes a payment-to-Stripe-to-invoice-paid happy path through Temporal',
    { timeout: 30_000 },
    async () => {
      const providerServer = serve({ fetch: createMockServicesApp().fetch, port: 0 });
      try {
        const address = providerServer.address();
        if (!address || typeof address === 'string')
          throw new Error('Provider did not bind a port');
        const providerBaseUrl = `http://127.0.0.1:${address.port}`;
        const temporal = await createWorkflowSandboxTemporalRuntime({
          connection: environment.nativeConnection,
          workflowClient: environment.client.workflow,
          namespace: 'default',
          taskQueue: 'sandbox-invoice-paid-happy-path',
          dataConverter,
          providerBaseUrl,
        });
        const runner = createWorkflowSandboxRunner({
          organizationId: 'org_atlas',
          environmentId: 'production',
          fallbackRunnerBaseUrl: providerBaseUrl,
          temporalRuntime: temporal.runtime,
        });
        const retryPolicy = {
          initialInterval: '1 millisecond',
          backoffCoefficient: 1,
          maximumInterval: '1 millisecond',
          maximumAttempts: 3,
          nonRetryableErrorTypes: [] as string[],
        };
        const workflow = await createCompiledWorkflowVersion(
          'sandbox-invoice-paid@1',
          'org_atlas',
          {
            irVersion: 1,
            inputSchema: {
              required: {
                paymentId: { type: 'string' },
                atlasWorkflowRunId: { type: 'string' },
              },
            },
            steps: [
              {
                id: 'read_payment',
                kind: 'capabilityCall',
                capabilityVersionId: 'payments.get@v1',
                arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
                retryPolicy,
              },
              {
                id: 'create_stripe_payment_intent',
                kind: 'capabilityCall',
                capabilityVersionId: 'stripe.create@v1',
                arguments: {
                  amount: {
                    source: 'stepOutput',
                    stepId: 'read_payment',
                    path: ['amount', 'value'],
                  },
                  currency: {
                    source: 'stepOutput',
                    stepId: 'read_payment',
                    path: ['amount', 'currency'],
                  },
                },
                retryPolicy,
                idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
              },
              {
                id: 'publish_invoice_paid',
                kind: 'capabilityCall',
                capabilityVersionId: 'events.invoice-paid@v1',
                arguments: {
                  eventId: { source: 'input', path: ['atlasWorkflowRunId'] },
                  eventType: { source: 'literal', value: 'invoice.paid' },
                  invoiceId: { source: 'stepOutput', stepId: 'read_payment', path: ['invoiceId'] },
                  paymentId: { source: 'stepOutput', stepId: 'read_payment', path: ['paymentId'] },
                  atlasWorkflowRunId: { source: 'input', path: ['atlasWorkflowRunId'] },
                },
                retryPolicy,
                idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
              },
              { id: 'completed', kind: 'terminal', state: 'completed' },
            ],
          },
        );
        const workerRun = temporal.worker.run();
        try {
          const { outcomes } = await runner.execute({
            organizationId: 'org_atlas',
            environmentId: 'production',
            workflowVersionId: workflow.workflowVersionId,
            irHash: workflow.irHash,
            workflow,
            providerContracts: [
              {
                capabilityVersionId: 'payments.get@v1',
                serviceId: 'payments',
                operationId: 'getPayment',
                documentHash: 'a'.repeat(64),
                provider: 'Atlas internal',
                mode: 'local' as const,
                method: 'get',
                path: '/payments/{paymentId}',
                requestSchema: null,
                responseSchema: null,
              },
              {
                capabilityVersionId: 'stripe.create@v1',
                serviceId: 'stripe',
                operationId: 'PostPaymentIntents',
                documentHash: 'b'.repeat(64),
                provider: 'Stripe',
                mode: 'contract-faithful-rehearsal' as const,
                method: 'post',
                path: '/v1/payment_intents',
                requestSchema: null,
                responseSchema: null,
              },
              {
                capabilityVersionId: 'events.invoice-paid@v1',
                serviceId: 'events',
                operationId: 'publishInvoicePaid',
                documentHash: 'd'.repeat(64),
                provider: 'Atlas internal',
                mode: 'local' as const,
                method: 'post',
                path: 'invoice.paid',
                requestSchema: null,
                responseSchema: null,
              },
            ],
            tests: [
              {
                testId: 'happy-path',
                kind: 'happy-path' as const,
                stepId: null,
                capabilityVersionId: null,
                expectation: 'workflow completes',
                requestSample: null,
                expectedResponseSchema: null,
              },
            ],
          });
          expect(outcomes).toEqual([
            expect.objectContaining({
              testId: 'happy-path',
              status: 'passed',
              terminalOutcome: 'completed',
              attempts: [
                { stepId: 'read_payment', attempt: 1, status: 200 },
                { stepId: 'create_stripe_payment_intent', attempt: 1, status: 200 },
                { stepId: 'publish_invoice_paid', attempt: 1, status: 202 },
              ],
              detail: expect.stringContaining(
                'read_payment -> create_stripe_payment_intent -> publish_invoice_paid',
              ),
            }),
          ]);
        } finally {
          temporal.worker.shutdown();
          await workerRun;
        }
      } finally {
        providerServer.close();
      }
    },
  );

  it('does not fail the happy path when Temporal retries a completed step', async () => {
    const providerServer = serve({ fetch: createMockServicesApp().fetch, port: 0 });
    try {
      const address = providerServer.address();
      if (!address || typeof address === 'string') throw new Error('Provider did not bind a port');
      const providerBaseUrl = `http://127.0.0.1:${address.port}`;
      const workflow = await createCompiledWorkflowVersion('sandbox-retry-order@1', 'org_atlas', {
        irVersion: 1,
        inputSchema: { required: { paymentId: { type: 'string' } } },
        steps: [
          {
            id: 'get_payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payments.get@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          {
            id: 'create_stripe_payment_intent',
            kind: 'capabilityCall',
            capabilityVersionId: 'stripe.create@v1',
            arguments: {
              amount: { source: 'literal', value: 100 },
              currency: { source: 'literal', value: 'USD' },
            },
          },
          {
            id: 'publish_invoice_paid',
            kind: 'capabilityCall',
            capabilityVersionId: 'events.invoice-paid@v1',
            arguments: {
              invoiceId: { source: 'literal', value: 'inv_sandbox' },
              paymentId: { source: 'input', path: ['paymentId'] },
            },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      });
      const observation = (
        stepId: string,
        capabilityVersionId: string,
        status: number,
      ): Parameters<typeof invokeSandboxProvider>[4][number] => ({
        stepId,
        capabilityVersionId,
        serializedRequest: {},
        response: {},
        status,
      });
      const runner = createWorkflowSandboxRunner({
        organizationId: 'org_atlas',
        environmentId: 'production',
        fallbackRunnerBaseUrl: providerBaseUrl,
        temporalRuntime: {
          async execute() {
            return {
              temporalWorkflowId: 'atlas:sandbox:retry-order',
              temporalRunId: 'retry-order-run',
              result: { state: 'completed' as const },
              observations: [
                observation('get_payment', 'payments.get@v1', 200),
                observation('create_stripe_payment_intent', 'stripe.create@v1', 200),
                observation('publish_invoice_paid', 'events.invoice-paid@v1', 500),
                observation('publish_invoice_paid', 'events.invoice-paid@v1', 500),
                observation('publish_invoice_paid', 'events.invoice-paid@v1', 202),
              ],
              stepAttempts: [],
              temporalHistory: {
                scheduledActivities: 3,
                completedActivities: 3,
                failedActivities: 2,
                timedOutActivities: 0,
              },
            };
          },
        },
      });
      const { outcomes } = await runner.execute({
        organizationId: 'org_atlas',
        environmentId: 'production',
        workflowVersionId: workflow.workflowVersionId,
        irHash: workflow.irHash,
        workflow,
        providerContracts: [
          {
            capabilityVersionId: 'payments.get@v1',
            serviceId: 'payments',
            operationId: 'getPayment',
            documentHash: 'a'.repeat(64),
            provider: 'Atlas internal',
            mode: 'local' as const,
            method: 'get',
            path: '/payments/{paymentId}',
            requestSchema: null,
            responseSchema: null,
          },
          {
            capabilityVersionId: 'stripe.create@v1',
            serviceId: 'stripe',
            operationId: 'PostPaymentIntents',
            documentHash: 'b'.repeat(64),
            provider: 'Stripe',
            mode: 'contract-faithful-rehearsal' as const,
            method: 'post',
            path: '/v1/payment_intents',
            requestSchema: null,
            responseSchema: null,
          },
          {
            capabilityVersionId: 'events.invoice-paid@v1',
            serviceId: 'events',
            operationId: 'publishInvoicePaid',
            documentHash: 'd'.repeat(64),
            provider: 'Atlas internal',
            mode: 'local' as const,
            method: 'post',
            path: 'invoice.paid',
            requestSchema: null,
            responseSchema: null,
          },
        ],
        tests: [
          {
            testId: 'happy-path',
            kind: 'happy-path' as const,
            stepId: null,
            capabilityVersionId: null,
            expectation: 'workflow completes',
            requestSample: null,
            expectedResponseSchema: null,
          },
        ],
      });
      expect(outcomes).toEqual([
        expect.objectContaining({
          testId: 'happy-path',
          status: 'passed',
          terminalOutcome: 'completed',
        }),
      ]);
      expect(outcomes[0]?.detail ?? '').not.toMatch(/declared step order/i);
    } finally {
      providerServer.close();
    }
  });

  it('explains when Atlas used an event channel as a URL', async () => {
    const providerServer = serve({ fetch: createMockServicesApp().fetch, port: 0 });
    try {
      const address = providerServer.address();
      if (!address || typeof address === 'string') throw new Error('Provider did not bind a port');
      const providerBaseUrl = `http://127.0.0.1:${address.port}`;
      const workflow = await createCompiledWorkflowVersion('sandbox-channel-url@1', 'org_atlas', {
        irVersion: 1,
        inputSchema: { required: { paymentId: { type: 'string' } } },
        steps: [
          {
            id: 'get_payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payments.get@v1',
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          {
            id: 'publish_invoice_paid',
            kind: 'capabilityCall',
            capabilityVersionId: 'events.invoice-paid@v1',
            arguments: {
              invoiceId: { source: 'literal', value: 'inv_sandbox' },
              paymentId: { source: 'input', path: ['paymentId'] },
            },
          },
          { id: 'completed', kind: 'terminal', state: 'completed' },
        ],
      });
      const observation = (
        stepId: string,
        capabilityVersionId: string,
        status: number,
      ): Parameters<typeof invokeSandboxProvider>[4][number] => ({
        stepId,
        capabilityVersionId,
        serializedRequest: {},
        response: {},
        status,
      });
      const runner = createWorkflowSandboxRunner({
        organizationId: 'org_atlas',
        environmentId: 'production',
        fallbackRunnerBaseUrl: providerBaseUrl,
        temporalRuntime: {
          async execute() {
            return {
              temporalWorkflowId: 'atlas:sandbox:channel-url',
              temporalRunId: 'channel-url-run',
              result: {
                state: 'repair_required' as const,
                failure: {
                  bucket: 'retryable-transient' as const,
                  type: 'DownstreamRequestFailed',
                  stepId: 'publish_invoice_paid',
                },
              },
              observations: [
                observation('get_payment', 'payments.get@v1', 200),
                observation('publish_invoice_paid', 'events.invoice-paid@v1', 404),
                observation('publish_invoice_paid', 'events.invoice-paid@v1', 404),
                observation('publish_invoice_paid', 'events.invoice-paid@v1', 404),
              ],
              stepAttempts: [],
              temporalHistory: {
                scheduledActivities: 2,
                completedActivities: 1,
                failedActivities: 1,
                timedOutActivities: 0,
              },
            };
          },
        },
      });
      const { outcomes } = await runner.execute({
        organizationId: 'org_atlas',
        environmentId: 'production',
        workflowVersionId: workflow.workflowVersionId,
        irHash: workflow.irHash,
        workflow,
        providerContracts: [
          {
            capabilityVersionId: 'payments.get@v1',
            serviceId: 'payments',
            operationId: 'getPayment',
            documentHash: 'a'.repeat(64),
            provider: 'Atlas internal',
            mode: 'local' as const,
            method: 'get',
            path: '/payments/{paymentId}',
            requestSchema: null,
            responseSchema: null,
          },
          {
            capabilityVersionId: 'events.invoice-paid@v1',
            serviceId: 'events',
            operationId: 'publishInvoicePaid',
            documentHash: 'd'.repeat(64),
            provider: 'Atlas internal',
            mode: 'local' as const,
            method: 'post',
            path: 'invoice.paid',
            requestSchema: null,
            responseSchema: null,
          },
        ],
        tests: [
          {
            testId: 'happy-path',
            kind: 'happy-path' as const,
            stepId: null,
            capabilityVersionId: null,
            expectation: 'workflow completes',
            requestSample: null,
            expectedResponseSchema: null,
          },
        ],
      });
      expect(outcomes).toEqual([
        expect.objectContaining({
          testId: 'happy-path',
          status: 'failed',
          detail:
            'Atlas used the event channel invoice.paid as a URL instead of calling /events/invoice.paid.',
        }),
      ]);
    } finally {
      providerServer.close();
    }
  });

  it('verifies and executes generated runtime checks through Temporal and a separate HTTP service', async () => {
    const providerServer = serve({ fetch: createMockServicesApp().fetch, port: 0 });
    const address = providerServer.address();
    if (!address || typeof address === 'string') throw new Error('Provider did not bind a port');
    const providerBaseUrl = `http://127.0.0.1:${address.port}`;
    const targetServer = serve({ fetch: createMockServicesApp().fetch, port: 0 });
    const targetAddress = targetServer.address();
    if (!targetAddress || typeof targetAddress === 'string') {
      throw new Error('Customer target did not bind a port');
    }
    const targetBaseUrl = `http://127.0.0.1:${targetAddress.port}`;
    for (const provider of [
      {
        serviceId: 'slack',
        operationId: 'chat_postMessage',
        capabilityVersionId: 'slack.post@v1',
        path: '/api/chat.postMessage',
      },
      {
        serviceId: 'hubspot',
        operationId: 'createContact',
        capabilityVersionId: 'hubspot.create@v1',
        path: '/crm/v3/objects/contacts',
      },
    ]) {
      const stepId = `${provider.serviceId}-fault`;
      await fetch(`${providerBaseUrl}/__control/faults`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationId: provider.operationId,
          stepId,
          mode: 'rate-limit',
        }),
      });
      await expect(
        invokeSandboxProvider(
          fetch,
          providerBaseUrl,
          {
            ...provider,
            documentHash: 'a'.repeat(64),
            provider: 'Atlas mock',
            mode: 'local',
            method: 'post',
            requestSchema: null,
            responseSchema: null,
          },
          { stepId, capabilityVersionId: provider.capabilityVersionId, input: {} },
          [],
        ),
      ).rejects.toMatchObject({ type: 'RateLimited' });
    }
    const resolvedSecretAliases: string[] = [];
    const secretProvider = {
      async getSecret(alias: string) {
        resolvedSecretAliases.push(alias);
        return 'customer-owned-secret';
      },
    };
    const temporal = await createWorkflowSandboxTemporalRuntime({
      connection: environment.nativeConnection,
      workflowClient: environment.client.workflow,
      namespace: 'default',
      taskQueue: 'issue-102-failure-semantics',
      dataConverter,
      providerBaseUrl,
      secretProvider,
    });
    const customerControlRequests: Array<{ path: string; redirect: RequestRedirect | undefined }> =
      [];
    const sandboxFetch: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      );
      if (url.origin === targetBaseUrl && url.pathname.startsWith('/__control/')) {
        customerControlRequests.push({ path: url.pathname, redirect: init?.redirect });
      }
      return fetch(input, init);
    };
    const runner = createWorkflowSandboxRunner({
      organizationId: 'org_atlas',
      environmentId: 'production',
      fallbackRunnerBaseUrl: providerBaseUrl,
      temporalRuntime: temporal.runtime,
      secretProvider,
      fetch: sandboxFetch,
    });
    const workflow = await createCompiledWorkflowVersion('sandbox-payment@1', 'org_atlas', {
      irVersion: 1,
      inputSchema: { required: { paymentId: { type: 'string' } } },
      steps: [
        {
          id: 'get-payment',
          kind: 'capabilityCall',
          capabilityVersionId: 'payments.get@v1',
          arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          retryPolicy: {
            initialInterval: '1 millisecond',
            backoffCoefficient: 1,
            maximumInterval: '1 millisecond',
            maximumAttempts: 2,
            nonRetryableErrorTypes: [],
          },
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });
    const suite = {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      workflow,
      providerContracts: [
        {
          capabilityVersionId: 'payments.get@v1',
          serviceId: 'payments',
          operationId: 'getPayment',
          documentHash: 'a'.repeat(64),
          provider: 'Atlas internal',
          mode: 'local' as const,
          method: 'get',
          path: '/payments/{paymentId}',
          requestSchema: {
            type: 'object',
            required: ['paymentId'],
            properties: { paymentId: { type: 'string' } },
          },
          responseSchema: { type: 'object', required: ['paymentId'] },
        },
      ],
      tests: [
        {
          testId: 'happy-path',
          kind: 'happy-path' as const,
          stepId: null,
          capabilityVersionId: null,
          expectation: 'workflow completes',
          requestSample: null,
          expectedResponseSchema: null,
        },
        {
          testId: 'contract-mapping:get-payment:payments.get@v1',
          kind: 'contract-mapping' as const,
          stepId: 'get-payment',
          capabilityVersionId: 'payments.get@v1',
          expectation: 'request and response match',
          requestSample: { paymentId: 'pay_sandbox' },
          expectedResponseSchema: {
            type: 'object',
            required: ['paymentId', 'amount'],
          },
        },
        {
          testId: 'retry:get-payment:payments.get@v1',
          kind: 'retry' as const,
          stepId: 'get-payment',
          capabilityVersionId: 'payments.get@v1',
          expectation: 'transient provider failure recovers',
          requestSample: { paymentId: 'pay_sandbox' },
          expectedResponseSchema: null,
        },
        {
          testId: 'rate-limit:get-payment:payments.get@v1',
          kind: 'rate-limit' as const,
          stepId: 'get-payment',
          capabilityVersionId: 'payments.get@v1',
          expectation: 'bounded provider retries',
          requestSample: { paymentId: 'pay_sandbox' },
          expectedResponseSchema: null,
        },
        {
          testId: 'timeout:get-payment:payments.get@v1',
          kind: 'timeout' as const,
          stepId: 'get-payment',
          capabilityVersionId: 'payments.get@v1',
          expectation: 'bounded provider timeout retries',
          requestSample: { paymentId: 'pay_sandbox' },
          expectedResponseSchema: null,
        },
        {
          testId: 'duplicate-event:get-payment:payments.get@v1',
          kind: 'duplicate-event' as const,
          stepId: 'get-payment',
          capabilityVersionId: 'payments.get@v1',
          expectation: 'same event has no additional effect',
          requestSample: { paymentId: 'pay_sandbox' },
          expectedResponseSchema: null,
        },
      ],
    };

    const workerRun = temporal.worker.run();
    try {
      const outcomes = await runner.execute(suite);
      expect(outcomes.outcomes).toEqual([
        expect.objectContaining({
          testId: 'happy-path',
          status: 'passed',
          executionMethods: ['local-test-service'],
          temporalWorkflowId: expect.stringContaining('atlas:sandbox:sandbox-payment@1:'),
          temporalRunId: expect.any(String),
          terminalOutcome: 'completed',
          attempts: [{ stepId: 'get-payment', attempt: 1, status: 200 }],
          temporalHistory: expect.objectContaining({ completedActivities: 2 }),
          providerObservations: expect.objectContaining({ sideEffectCount: 0 }),
          detail: expect.stringContaining('get-payment'),
        }),
        expect.objectContaining({
          testId: 'contract-mapping:get-payment:payments.get@v1',
          status: 'passed',
          temporalWorkflowId: expect.any(String),
          temporalRunId: expect.any(String),
          terminalOutcome: 'completed',
          attempts: [{ stepId: 'get-payment', attempt: 1, status: 200 }],
          temporalHistory: expect.objectContaining({ completedActivities: 2 }),
          providerObservations: expect.objectContaining({ sideEffectCount: 0 }),
        }),
        expect.objectContaining({
          testId: 'retry:get-payment:payments.get@v1',
          status: 'passed',
          terminalOutcome: 'completed',
          attempts: [
            { stepId: 'get-payment', attempt: 1, status: 503 },
            { stepId: 'get-payment', attempt: 2, status: 200 },
          ],
        }),
        expect.objectContaining({
          testId: 'rate-limit:get-payment:payments.get@v1',
          status: 'passed',
          temporalWorkflowId: expect.any(String),
          temporalRunId: expect.any(String),
          terminalOutcome: 'repair_required',
          attempts: [
            { stepId: 'get-payment', attempt: 1, status: 429 },
            { stepId: 'get-payment', attempt: 2, status: 429 },
          ],
        }),
        expect.objectContaining({
          testId: 'timeout:get-payment:payments.get@v1',
          status: 'passed',
          terminalOutcome: 'repair_required',
          attempts: [
            { stepId: 'get-payment', attempt: 1, status: 408 },
            { stepId: 'get-payment', attempt: 2, status: 408 },
          ],
        }),
        expect.objectContaining({
          testId: 'duplicate-event:get-payment:payments.get@v1',
          status: 'passed',
          temporalWorkflowId: expect.any(String),
          temporalRunId: expect.any(String),
          providerObservations: expect.objectContaining({ sideEffectCount: 0 }),
        }),
      ]);

      const remoteBinding = {
        capabilityVersionId: 'payments.get@v1',
        targetKey: 'payments-staging',
        targetRevision: 2,
        baseUrl: targetBaseUrl,
        hostname: '127.0.0.1',
        healthPath: '/health',
        controlPaths: {
          resources: '/__control/resources',
          faults: '/__control/faults',
          observations: '/__control/observations',
        },
        secretAlias: 'PAYMENTS_STAGING_TOKEN',
        testDataProfileKey: 'settled-payment',
        testDataVersion: 3,
        inputs: { paymentId: 'pay_sandbox' },
        targetState: {
          mode: 'replace',
          resources: [
            {
              service: 'payments',
              collection: 'payments',
              id: 'pay_sandbox',
              document: {
                paymentId: 'pay_sandbox',
                invoiceId: 'inv_sandbox',
                status: 'succeeded',
                amount: { value: 100, currency: 'USD' },
                paidAt: '2026-08-16T12:00:00.000Z',
              },
            },
          ],
        },
        setupAssumptions: [
          { path: ['payments', 0, 'paymentId'], equals: 'pay_sandbox' },
          { path: ['payments', 0, 'status'], equals: 'succeeded' },
        ],
      };
      const remote = await runner.execute({
        ...suite,
        targetBindings: [remoteBinding],
        tests: suite.tests,
      });
      expect(remote.outcomes).toHaveLength(suite.tests.length);
      expect(
        remote.outcomes.every(
          ({ status, executionMethods, targetEvidence }) =>
            status === 'passed' &&
            executionMethods.includes('remote-sandbox') &&
            targetEvidence?.[0]?.targetRevision === 2,
        ),
      ).toBe(true);
      expect(remote.outcomes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            testId: 'happy-path',
            status: 'passed',
            executionMethods: ['remote-sandbox'],
            temporalWorkflowId: expect.any(String),
            temporalRunId: expect.any(String),
            targetEvidence: [
              {
                capabilityVersionId: 'payments.get@v1',
                targetKey: 'payments-staging',
                targetRevision: 2,
                testDataProfileKey: 'settled-payment',
                testDataVersion: 3,
              },
            ],
          }),
          expect.objectContaining({
            testId: 'contract-mapping:get-payment:payments.get@v1',
            status: 'passed',
            executionMethods: ['remote-sandbox'],
          }),
          expect.objectContaining({
            testId: 'retry:get-payment:payments.get@v1',
            status: 'passed',
            executionMethods: ['remote-sandbox'],
          }),
          expect.objectContaining({
            testId: 'duplicate-event:get-payment:payments.get@v1',
            status: 'passed',
            executionMethods: ['remote-sandbox'],
          }),
        ]),
      );
      expect(resolvedSecretAliases.length).toBeGreaterThan(suite.tests.length);
      expect(new Set(resolvedSecretAliases)).toEqual(new Set(['PAYMENTS_STAGING_TOKEN']));
      expect(customerControlRequests.length).toBeGreaterThan(0);
      expect(customerControlRequests.every(({ redirect }) => redirect === 'manual')).toBe(true);

      const unmetProfile = await runner.execute({
        ...suite,
        targetBindings: [
          {
            ...remoteBinding,
            setupAssumptions: [{ path: ['payments', 0, 'status'], equals: 'refunded' }],
          },
        ],
        tests: [suite.tests[0]!],
      });
      expect(unmetProfile.outcomes).toEqual([
        expect.objectContaining({
          status: 'failed',
          detail: expect.stringContaining(
            "does not satisfy test-data profile 'settled-payment' version 3 at 'payments.0.status'",
          ),
        }),
      ]);
      expect(unmetProfile.outcomes[0]).not.toHaveProperty('temporalWorkflowId');

      const redirectRunner = createWorkflowSandboxRunner({
        organizationId: 'org_atlas',
        environmentId: 'production',
        fallbackRunnerBaseUrl: providerBaseUrl,
        temporalRuntime: temporal.runtime,
        secretProvider,
        fetch: (async (input, init) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input : input.url,
          );
          if (url.pathname === '/health') return new Response(null, { status: 204 });
          expect(init?.redirect).toBe('manual');
          return new Response(null, {
            status: 302,
            headers: { location: 'https://outside-policy.example.test/control' },
          });
        }) as typeof fetch,
      });
      const redirectedSetup = await redirectRunner.execute({
        ...suite,
        targetBindings: [remoteBinding],
        tests: [suite.tests[0]!],
      });
      expect(redirectedSetup.outcomes).toEqual([
        expect.objectContaining({
          status: 'failed',
          detail: expect.stringContaining(
            'Sandbox target setup redirect denied (https://outside-policy.example.test/control)',
          ),
        }),
      ]);
      expect(redirectedSetup.outcomes[0]).not.toHaveProperty('temporalWorkflowId');

      const missingSecretRunner = createWorkflowSandboxRunner({
        organizationId: 'org_atlas',
        environmentId: 'production',
        fallbackRunnerBaseUrl: providerBaseUrl,
        temporalRuntime: temporal.runtime,
        secretProvider: {
          async getSecret() {
            throw new Error('not found');
          },
        },
      });
      const missingSecret = await missingSecretRunner.execute({
        ...suite,
        targetBindings: [remoteBinding],
        tests: [suite.tests[0]!],
      });
      expect(missingSecret.outcomes).toEqual([
        expect.objectContaining({
          status: 'failed',
          executionMethods: ['remote-sandbox'],
          detail:
            "Sandbox target 'payments-staging' is missing worker secret alias 'PAYMENTS_STAGING_TOKEN'.",
        }),
      ]);
      expect(missingSecret.outcomes[0]).not.toHaveProperty('temporalWorkflowId');

      const unreachable = await runner.execute({
        ...suite,
        targetBindings: [
          {
            ...remoteBinding,
            targetRevision: 4,
            baseUrl: 'http://127.0.0.1:1',
          },
        ],
        tests: [suite.tests[0]!],
      });
      expect(unreachable.outcomes).toEqual([
        expect.objectContaining({
          status: 'failed',
          executionMethods: ['remote-sandbox'],
          detail: "Sandbox target 'payments-staging' is unreachable from the customer worker.",
          targetEvidence: [expect.objectContaining({ targetRevision: 4, testDataVersion: 3 })],
        }),
      ]);

      const nonRetryableWorkflow = await createCompiledWorkflowVersion(
        'sandbox-non-retryable@1',
        'org_atlas',
        {
          ...workflow.executable,
          steps: workflow.executable.steps.map((step) =>
            step.id === 'get-payment' && step.kind !== 'terminal'
              ? {
                  ...step,
                  retryPolicy: {
                    ...step.retryPolicy!,
                    nonRetryableErrorTypes: ['RateLimited'],
                  },
                }
              : step,
          ),
        },
      );
      const nonRetryable = await runner.execute({
        ...suite,
        workflowVersionId: nonRetryableWorkflow.workflowVersionId,
        irHash: nonRetryableWorkflow.irHash,
        workflow: nonRetryableWorkflow,
        tests: [suite.tests[3]!],
      });
      expect(nonRetryable.outcomes).toEqual([
        expect.objectContaining({
          status: 'passed',
          attempts: [{ stepId: 'get-payment', attempt: 1, status: 429 }],
        }),
      ]);

      const repeatedOperationWorkflow = await createCompiledWorkflowVersion(
        'sandbox-repeated-operation@1',
        'org_atlas',
        {
          ...workflow.executable,
          steps: [
            { ...workflow.executable.steps[0]!, id: 'first-get-payment' },
            { ...workflow.executable.steps[0]!, id: 'target-get-payment' },
            { id: 'completed', kind: 'terminal', state: 'completed' },
          ],
        },
      );
      const repeatedOperation = await runner.execute({
        ...suite,
        workflowVersionId: repeatedOperationWorkflow.workflowVersionId,
        irHash: repeatedOperationWorkflow.irHash,
        workflow: repeatedOperationWorkflow,
        tests: [
          {
            ...suite.tests[3]!,
            testId: 'rate-limit:target-get-payment:payments.get@v1',
            stepId: 'target-get-payment',
          },
        ],
      });
      expect(repeatedOperation.outcomes).toEqual([
        expect.objectContaining({
          status: 'passed',
          attempts: [
            { stepId: 'target-get-payment', attempt: 1, status: 429 },
            { stepId: 'target-get-payment', attempt: 2, status: 429 },
          ],
        }),
      ]);
      // Finishing a fault case must remove only that injected fault, retaining provider data.
      const afterFaultCheck = await fetch(`${providerBaseUrl}/payments/pay_sandbox`, {
        headers: { 'x-atlas-sandbox-step-id': 'target-get-payment' },
      });
      expect(afterFaultCheck.status).toBe(200);
      await expect(afterFaultCheck.json()).resolves.toMatchObject({ paymentId: 'pay_sandbox' });

      const invalidResultRunner = createWorkflowSandboxRunner({
        organizationId: 'org_atlas',
        environmentId: 'production',
        fallbackRunnerBaseUrl: providerBaseUrl,
        temporalRuntime: {
          async execute() {
            return {
              temporalWorkflowId: 'invalid-result-workflow',
              temporalRunId: 'invalid-result-run',
              result: { state: 'repair_required' as const },
              executionError: true as const,
              observations: [],
              stepAttempts: [],
              temporalHistory: {
                scheduledActivities: 0,
                completedActivities: 0,
                failedActivities: 0,
                timedOutActivities: 0,
              },
            };
          },
        },
      });
      const invalidResult = await invalidResultRunner.execute({
        ...suite,
        tests: [suite.tests[0]!],
      });
      expect(invalidResult.outcomes).toEqual([
        expect.objectContaining({
          status: 'failed',
          detail: 'Temporal failed before producing a valid interpreter result.',
        }),
      ]);

      const retryingPartialFailureWorkflow = await createCompiledWorkflowVersion(
        'sandbox-retrying-partial-failure@1',
        'org_atlas',
        {
          irVersion: 1,
          inputSchema: { required: { paymentId: { type: 'string' } } },
          steps: [
            {
              id: 'get-payment',
              kind: 'capabilityCall',
              capabilityVersionId: 'payments.get@v1',
              arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
              result: 'payment',
            },
            {
              id: 'get-invoice',
              kind: 'capabilityCall',
              capabilityVersionId: 'billing.get@v1',
              retryPolicy: {
                initialInterval: '1 millisecond',
                maximumInterval: '1 millisecond',
                backoffCoefficient: 1,
                maximumAttempts: 3,
                nonRetryableErrorTypes: [],
              },
              arguments: {
                invoiceId: {
                  source: 'stepOutput',
                  stepId: 'get-payment',
                  path: ['invoiceId'],
                },
              },
            },
            { id: 'completed', kind: 'terminal', state: 'completed' },
          ],
        },
      );
      const retryingPartialFailure = await runner.execute({
        ...suite,
        workflowVersionId: retryingPartialFailureWorkflow.workflowVersionId,
        irHash: retryingPartialFailureWorkflow.irHash,
        workflow: retryingPartialFailureWorkflow,
        providerContracts: [
          suite.providerContracts[0]!,
          {
            capabilityVersionId: 'billing.get@v1',
            serviceId: 'billing',
            operationId: 'getInvoice',
            documentHash: 'b'.repeat(64),
            provider: 'Atlas internal',
            mode: 'local' as const,
            method: 'get',
            path: '/invoices/{invoiceId}',
            requestSchema: null,
            responseSchema: null,
          },
        ],
        tests: [
          {
            testId: 'partial-failure:get-invoice:billing.get@v1:SandboxPartialFailure',
            kind: 'partial-failure' as const,
            stepId: 'get-invoice',
            capabilityVersionId: 'billing.get@v1',
            expectation: 'preserve completed reads after retry exhaustion',
            requestSample: { invoiceId: 'inv_sandbox' },
            expectedResponseSchema: null,
            failureErrorType: 'SandboxPartialFailure',
          },
        ],
      });
      expect(retryingPartialFailure.outcomes).toEqual([
        expect.objectContaining({
          status: 'passed',
          terminalOutcome: 'repair_required',
          attempts: [
            { stepId: 'get-payment', attempt: 1, status: 200 },
            { stepId: 'get-invoice', attempt: 1, status: 500 },
            { stepId: 'get-invoice', attempt: 2, status: 500 },
            { stepId: 'get-invoice', attempt: 3, status: 500 },
          ],
          temporalHistory: expect.objectContaining({ scheduledActivities: 4 }),
        }),
      ]);

      const mutationRetryPolicy = {
        initialInterval: '1 millisecond',
        backoffCoefficient: 1,
        maximumInterval: '1 millisecond',
        maximumAttempts: 2,
        nonRetryableErrorTypes: ['SandboxPartialFailure'],
        failureBuckets: { SandboxPartialFailure: 'permanent-operational' as const },
      };
      const compensatedWorkflow = await createCompiledWorkflowVersion(
        'sandbox-compensation@1',
        'org_atlas',
        {
          irVersion: 1,
          inputSchema: {
            required: {
              paymentId: { type: 'string' },
              invoiceId: { type: 'string' },
              expectedInvoiceVersion: { type: 'number' },
            },
          },
          steps: [
            {
              id: 'begin-settlement',
              kind: 'capabilityCall',
              capabilityVersionId: 'billing.begin@v1',
              arguments: {
                paymentId: { source: 'input', path: ['paymentId'] },
                invoiceId: { source: 'input', path: ['invoiceId'] },
                expectedInvoiceVersion: { source: 'input', path: ['expectedInvoiceVersion'] },
              },
              retryPolicy: mutationRetryPolicy,
              idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
            },
            {
              id: 'cancel-settlement',
              kind: 'compensation',
              compensatesStepId: 'begin-settlement',
              capabilityVersionId: 'billing.cancel@v1',
              arguments: {
                paymentId: { source: 'input', path: ['paymentId'] },
                invoiceId: {
                  source: 'stepOutput',
                  stepId: 'begin-settlement',
                  path: ['invoiceId'],
                },
                expectedInvoiceVersion: {
                  source: 'stepOutput',
                  stepId: 'begin-settlement',
                  path: ['version'],
                },
              },
              retryPolicy: mutationRetryPolicy,
              idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
            },
            {
              id: 'mark-paid',
              kind: 'capabilityCall',
              capabilityVersionId: 'billing.mark@v1',
              arguments: {
                paymentId: { source: 'input', path: ['paymentId'] },
                invoiceId: {
                  source: 'stepOutput',
                  stepId: 'begin-settlement',
                  path: ['invoiceId'],
                },
                expectedInvoiceVersion: {
                  source: 'stepOutput',
                  stepId: 'begin-settlement',
                  path: ['version'],
                },
              },
              retryPolicy: mutationRetryPolicy,
              idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
              errorRouting: {
                rules: [
                  {
                    errorTypes: ['SandboxPartialFailure'],
                    action: {
                      kind: 'compensateThenLand',
                      outcome: 'repair_required',
                      reasonCode: 'sandbox-partial-failure',
                    },
                  },
                ],
                defaultAction: {
                  kind: 'preserveAndLand',
                  outcome: 'repair_required',
                  reasonCode: 'sandbox-provider-failure',
                },
              },
            },
            { id: 'completed', kind: 'terminal', state: 'completed' },
          ],
        },
      );
      const billingContracts = [
        ['billing.begin@v1', 'beginInvoiceSettlement', 'post', '/invoices/{invoiceId}/settlement'],
        [
          'billing.cancel@v1',
          'cancelInvoiceSettlement',
          'delete',
          '/invoices/{invoiceId}/settlement',
        ],
        ['billing.mark@v1', 'markInvoicePaid', 'post', '/invoices/{invoiceId}/payment'],
      ].map(([capabilityVersionId, operationId, method, path]) => ({
        capabilityVersionId: capabilityVersionId!,
        serviceId: 'billing',
        operationId: operationId!,
        documentHash: 'b'.repeat(64),
        provider: 'Atlas internal',
        mode: 'local' as const,
        method: method!,
        path: path!,
        requestSchema: null,
        responseSchema: null,
      }));
      const failureSuite = {
        ...suite,
        workflowVersionId: compensatedWorkflow.workflowVersionId,
        irHash: compensatedWorkflow.irHash,
        workflow: compensatedWorkflow,
        providerContracts: billingContracts,
        tests: [
          {
            testId: 'partial-failure',
            kind: 'partial-failure' as const,
            stepId: 'mark-paid',
            capabilityVersionId: 'billing.mark@v1',
            expectation: 'compensate completed effects',
            requestSample: null,
            expectedResponseSchema: null,
          },
          {
            testId: 'duplicate-event:begin-settlement:billing.begin@v1',
            kind: 'duplicate-event' as const,
            stepId: 'begin-settlement',
            capabilityVersionId: 'billing.begin@v1',
            expectation: 'mutations are not repeated',
            requestSample: null,
            expectedResponseSchema: null,
          },
        ],
      };
      const failureOutcomes = await runner.execute(failureSuite);
      expect(failureOutcomes.outcomes).toEqual([
        expect.objectContaining({
          testId: 'partial-failure',
          status: 'passed',
          terminalOutcome: 'repair_required',
          providerObservations: expect.objectContaining({
            compensationOrder: ['cancel-settlement'],
            invoiceStates: [{ status: 'open', version: 3 }],
          }),
        }),
        expect.objectContaining({
          testId: 'duplicate-event:begin-settlement:billing.begin@v1',
          status: 'passed',
          terminalOutcome: 'completed',
          providerObservations: expect.objectContaining({ sideEffectCount: 2 }),
        }),
      ]);

      const irreversibleWorkflow = await createCompiledWorkflowVersion(
        'sandbox-uncertain-irreversible@1',
        'org_atlas',
        {
          ...compensatedWorkflow.executable,
          steps: compensatedWorkflow.executable.steps.map((step) =>
            step.id === 'mark-paid' && step.kind === 'capabilityCall'
              ? { ...step, irreversibleAfter: true }
              : step,
          ),
        },
      );
      const uncertainIrreversible = await runner.execute({
        ...failureSuite,
        workflowVersionId: irreversibleWorkflow.workflowVersionId,
        irHash: irreversibleWorkflow.irHash,
        workflow: irreversibleWorkflow,
        tests: [failureSuite.tests[0]],
      });
      expect(uncertainIrreversible.outcomes).toEqual([
        expect.objectContaining({
          status: 'passed',
          terminalOutcome: 'repair_required',
          providerObservations: expect.objectContaining({
            compensationOrder: [],
            invoiceStates: [{ status: 'settling', version: 2 }],
          }),
        }),
      ]);

      const preserveWorkflow = await createCompiledWorkflowVersion(
        'sandbox-preserve@1',
        'org_atlas',
        {
          ...compensatedWorkflow.executable,
          steps: compensatedWorkflow.executable.steps.map((step) =>
            step.id === 'mark-paid' && step.kind !== 'terminal'
              ? {
                  ...step,
                  errorRouting: {
                    rules: [
                      {
                        errorTypes: ['SandboxPartialFailure'],
                        action: {
                          kind: 'preserveAndLand' as const,
                          outcome: 'repair_required' as const,
                          reasonCode: 'preserve-provider-state',
                        },
                      },
                    ],
                    defaultAction: {
                      kind: 'preserveAndLand' as const,
                      outcome: 'repair_required' as const,
                      reasonCode: 'preserve-provider-state',
                    },
                  },
                }
              : step,
          ),
        },
      );
      const preserved = await runner.execute({
        ...failureSuite,
        workflowVersionId: preserveWorkflow.workflowVersionId,
        irHash: preserveWorkflow.irHash,
        workflow: preserveWorkflow,
        tests: [failureSuite.tests[0]],
      });
      expect(preserved.outcomes).toEqual([
        expect.objectContaining({
          status: 'passed',
          terminalOutcome: 'repair_required',
          detail: expect.stringContaining('preserveAndLand'),
          providerObservations: expect.objectContaining({
            compensationOrder: [],
            invoiceStates: [{ status: 'settling', version: 2 }],
          }),
        }),
      ]);

      const revalidateWorkflow = await createCompiledWorkflowVersion(
        'sandbox-revalidate@1',
        'org_atlas',
        {
          ...compensatedWorkflow.executable,
          steps: compensatedWorkflow.executable.steps.map((step) =>
            step.id === 'mark-paid' && step.kind !== 'terminal'
              ? {
                  ...step,
                  errorRouting: {
                    rules: [
                      {
                        errorTypes: ['SandboxPartialFailure'],
                        action: {
                          kind: 'revalidateFrom' as const,
                          targetStepId: 'begin-settlement',
                          maxRevalidations: 2,
                          onExhausted: {
                            kind: 'preserveAndLand' as const,
                            outcome: 'manual_review' as const,
                            reasonCode: 'revalidation-exhausted',
                          },
                        },
                      },
                    ],
                    defaultAction: {
                      kind: 'land' as const,
                      outcome: 'repair_required' as const,
                      reasonCode: 'unexpected-failure',
                    },
                  },
                }
              : step,
          ),
        },
      );
      const revalidated = await runner.execute({
        ...failureSuite,
        workflowVersionId: revalidateWorkflow.workflowVersionId,
        irHash: revalidateWorkflow.irHash,
        workflow: revalidateWorkflow,
        tests: [failureSuite.tests[0]],
      });
      expect(revalidated.outcomes).toEqual([
        expect.objectContaining({
          status: 'passed',
          terminalOutcome: 'manual_review',
          detail: expect.stringContaining('revalidateFrom'),
          attempts: [
            { stepId: 'begin-settlement', attempt: 1, status: 200 },
            { stepId: 'mark-paid', attempt: 1, status: 500 },
            { stepId: 'begin-settlement', attempt: 2, status: 200 },
            { stepId: 'mark-paid', attempt: 2, status: 500 },
            { stepId: 'begin-settlement', attempt: 3, status: 200 },
            { stepId: 'mark-paid', attempt: 3, status: 500 },
          ],
          providerObservations: expect.objectContaining({ compensationOrder: [] }),
        }),
      ]);
      const landed = await runner.execute({
        ...failureSuite,
        workflowVersionId: revalidateWorkflow.workflowVersionId,
        irHash: revalidateWorkflow.irHash,
        workflow: revalidateWorkflow,
        tests: [
          {
            ...failureSuite.tests[0],
            testId: 'partial-failure:mark-paid:billing.mark@v1:SandboxUnmatchedFailure',
            failureErrorType: 'SandboxUnmatchedFailure',
          },
        ],
      });
      expect(landed.outcomes).toEqual([
        expect.objectContaining({
          status: 'passed',
          terminalOutcome: 'repair_required',
          detail: expect.stringContaining('land'),
          providerObservations: expect.objectContaining({ compensationOrder: [] }),
        }),
      ]);

      const incompatible = {
        ...suite,
        tests: [
          {
            ...suite.tests[1]!,
            expectedResponseSchema: {
              type: 'object',
              required: ['field-the-provider-does-not-return'],
            },
          },
        ],
      };
      const failed = await runner.execute(incompatible);
      expect(failed.outcomes).toEqual([
        expect.objectContaining({ status: 'failed', executionMethods: ['local-test-service'] }),
      ]);

      const incompatibleMappingWorkflow = await createCompiledWorkflowVersion(
        'sandbox-payment-bad-mapping@1',
        'org_atlas',
        {
          irVersion: 1,
          inputSchema: { required: {} },
          steps: [
            {
              id: 'get-payment',
              kind: 'capabilityCall',
              capabilityVersionId: 'payments.get@v1',
              arguments: { paymentId: { source: 'literal', value: 'pay_sandbox' } },
            },
            { id: 'completed', kind: 'terminal', state: 'completed' },
          ],
        },
      );
      const incompatibleMapping = await runner.execute({
        ...suite,
        workflowVersionId: incompatibleMappingWorkflow.workflowVersionId,
        irHash: incompatibleMappingWorkflow.irHash,
        workflow: incompatibleMappingWorkflow,
        providerContracts: [
          {
            ...suite.providerContracts[0]!,
            requestSchema: {
              type: 'object',
              required: ['paymentId'],
              properties: { paymentId: { type: 'string', pattern: '^pay_expected$' } },
            },
          },
        ],
        tests: [suite.tests[1]],
      });
      expect(incompatibleMapping.outcomes).toEqual([
        expect.objectContaining({ status: 'failed', executionMethods: ['local-test-service'] }),
      ]);
    } finally {
      temporal.worker.shutdown();
      await workerRun;
      providerServer.close();
      targetServer.close();
    }
  }, 60_000);
});
