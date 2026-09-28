import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vite-plus/test';

import { createMockServicesApp } from './app.js';
import { executeProviderSandboxCase, type ParsedWorkflowSandboxSuite } from './workflow-sandbox.js';

const knownState = {
  payments: [
    {
      paymentId: 'pay_1',
      invoiceId: 'inv_1',
      status: 'succeeded',
      amount: { value: 5000, currency: 'USD' },
      paidAt: '2026-08-03T18:00:00Z',
    },
  ],
  invoices: [
    {
      invoiceId: 'inv_1',
      version: 1,
      status: 'open',
      outstandingBalance: { value: 5000, currency: 'USD' },
      customerId: 'cust_9',
    },
  ],
};

const knownResources = [
  {
    service: 'payments',
    collection: 'payments',
    id: 'pay_1',
    document: knownState.payments[0],
  },
  {
    service: 'billing',
    collection: 'invoices',
    id: 'inv_1',
    document: knownState.invoices[0],
  },
];

const resourceControlBody = (state: typeof knownState) => ({
  mode: 'replace' as const,
  resources: [
    ...state.payments.map((document) => ({
      service: 'payments',
      collection: 'payments',
      id: document.paymentId,
      document,
    })),
    ...state.invoices.map((document) => ({
      service: 'billing',
      collection: 'invoices',
      id: document.invoiceId,
      document,
    })),
  ],
});

describe('mock service estate HTTP interface', () => {
  let app: ReturnType<typeof createMockServicesApp>;

  beforeEach(() => {
    app = createMockServicesApp();
  });

  it('allows the Vite console to read specs from a fallback port', async () => {
    const response = await app.request('/specs/payment.openapi.json', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5175',
        'Access-Control-Request-Method': 'GET',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5175');
  });

  it('replaces provider resources with generic resource rows', async () => {
    const seedResponse = await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'replace', resources: knownResources }),
    });

    expect(seedResponse.status).toBe(204);

    const paymentResponse = await app.request('/payments/pay_1');
    const invoiceResponse = await app.request('/invoices/inv_1');

    expect(paymentResponse.status).toBe(200);
    await expect(paymentResponse.json()).resolves.toEqual(knownState.payments[0]);
    expect(invoiceResponse.status).toBe(200);
    await expect(invoiceResponse.json()).resolves.toEqual(knownState.invoices[0]);
  });

  it('merges listed resources without deleting resources seeded by hand', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'replace', resources: knownResources }),
    });

    const response = await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'merge',
        resources: [
          {
            service: 'payments',
            collection: 'payments',
            id: 'pay_hand_seeded',
            document: { ...knownState.payments[0], paymentId: 'pay_hand_seeded' },
          },
        ],
      }),
    });

    expect(response.status).toBe(204);
    expect((await app.request('/payments/pay_1')).status).toBe(200);
    expect((await app.request('/payments/pay_hand_seeded')).status).toBe(200);
  });

  it('lists generic resources and filters by service and collection', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'replace', resources: knownResources }),
    });

    const all = await app.request('/__control/resources');
    const invoices = await app.request('/__control/resources?service=billing&collection=invoices');
    const payments = await app.request('/__control/resources?service=payments');

    expect(all.status).toBe(200);
    await expect(all.json()).resolves.toEqual({
      resources: [knownResources[1], knownResources[0]],
    });
    await expect(invoices.json()).resolves.toEqual({ resources: [knownResources[1]] });
    await expect(payments.json()).resolves.toEqual({ resources: [knownResources[0]] });
  });

  it.each([
    ['malformed JSON', '{'],
    ['an invalid mode', JSON.stringify({ mode: 'append', resources: [] })],
    [
      'an invalid resource row',
      JSON.stringify({
        mode: 'replace',
        resources: [{ service: 'payments', collection: 'payments', id: 'pay_missing_document' }],
      }),
    ],
  ])('rejects %s without changing resources', async (_case, body) => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'replace', resources: knownResources }),
    });

    const response = await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(response.status).toBe(400);
    expect((await app.request('/payments/pay_1')).status).toBe(200);
  });

  it('keeps provider authentication and compatibility checks but refuses workflow simulation', async () => {
    const response = await app.request('/__control/workflow-sandbox-tests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowVersionId: 'stripe-flow@1',
        irHash: 'a'.repeat(64),
        workflow: {
          executable: {
            inputSchema: { required: { paymentId: { type: 'string' } } },
            steps: [
              {
                id: 'get-payment',
                kind: 'capabilityCall',
                capabilityVersionId: 'payments.get@v1',
                arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
              },
              {
                id: 'create-intent',
                kind: 'capabilityCall',
                capabilityVersionId: 'stripe.create@v1',
                arguments: {
                  amount: {
                    source: 'stepOutput',
                    stepId: 'get-payment',
                    path: ['amount', 'value'],
                  },
                  currency: {
                    source: 'stepOutput',
                    stepId: 'get-payment',
                    path: ['amount', 'currency'],
                  },
                },
                retryPolicy: { maximumAttempts: 3 },
                idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
                errorRouting: {
                  rules: [
                    {
                      errorTypes: ['SandboxPartialFailure'],
                      action: {
                        kind: 'revalidateFrom',
                        targetStepId: 'get-payment',
                        maxRevalidations: 1,
                        onExhausted: {
                          kind: 'compensateThenLand',
                          outcome: 'repair_required',
                          reasonCode: 'SANDBOX_PARTIAL_FAILURE',
                        },
                      },
                    },
                  ],
                  defaultAction: {
                    kind: 'preserveAndLand',
                    outcome: 'repair_required',
                    reasonCode: 'SANDBOX_PROVIDER_FAILURE',
                  },
                },
              },
              {
                id: 'undo-get-payment',
                kind: 'compensation',
                compensatesStepId: 'get-payment',
                capabilityVersionId: 'payments.get@v1',
                arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
              },
              { id: 'completed', kind: 'terminal', state: 'completed' },
            ],
          },
        },
        providerContracts: [
          {
            capabilityVersionId: 'payments.get@v1',
            serviceId: 'payments',
            operationId: 'getPayment',
            documentHash: 'c'.repeat(64),
            provider: 'Atlas internal',
            mode: 'local',
            method: 'get',
            path: '/payments/{paymentId}',
            requestSchema: { type: 'object', required: ['paymentId'] },
            responseSchema: { type: 'object', required: ['paymentId'] },
          },
          {
            capabilityVersionId: 'stripe.create@v1',
            serviceId: 'stripe',
            operationId: 'PostPaymentIntents',
            documentHash: 'b'.repeat(64),
            provider: 'Stripe',
            mode: 'contract-faithful-rehearsal',
            method: 'post',
            path: '/v1/payment_intents',
            requestSchema: { type: 'object' },
            responseSchema: { type: 'object', required: ['id'] },
          },
          {
            capabilityVersionId: 'events.invoice-paid@v1',
            serviceId: 'events',
            operationId: 'publishInvoicePaid',
            documentHash: 'd'.repeat(64),
            provider: 'Atlas internal',
            mode: 'local',
            method: 'post',
            path: '/events/invoice.paid',
            requestSchema: { type: 'object' },
            responseSchema: { type: 'object' },
          },
        ],
        tests: [
          {
            testId: 'happy-path',
            kind: 'happy-path',
            stepId: null,
            capabilityVersionId: null,
            expectation: 'workflow completes',
            requestSample: null,
            expectedResponseSchema: null,
          },
          {
            testId: 'contract-mapping:create-intent:stripe.create@v1',
            kind: 'contract-mapping',
            stepId: 'create-intent',
            capabilityVersionId: 'stripe.create@v1',
            expectation: 'mapping conforms',
            requestSample: { amount: 100, currency: 'USD' },
            expectedResponseSchema: { type: 'object', required: ['id', 'livemode'] },
          },
          {
            testId: 'authentication:create-intent:stripe.create@v1',
            kind: 'authentication',
            stepId: 'create-intent',
            capabilityVersionId: 'stripe.create@v1',
            expectation: 'credentials are enforced',
            requestSample: { amount: 100, currency: 'USD' },
            expectedResponseSchema: { type: 'object', required: ['id'] },
          },
          ...(['rate-limit', 'timeout', 'duplicate-event', 'compatibility'] as const).map(
            (kind) => ({
              testId: `${kind}:create-intent:stripe.create@v1`,
              kind,
              stepId: 'create-intent',
              capabilityVersionId: 'stripe.create@v1',
              expectation: `${kind} is handled`,
              requestSample: { amount: 100, currency: 'USD' },
              expectedResponseSchema: { type: 'object', required: ['id'] },
            }),
          ),
          {
            testId: 'partial-failure',
            kind: 'partial-failure',
            stepId: null,
            capabilityVersionId: null,
            expectation: 'later failure is isolated',
            requestSample: null,
            expectedResponseSchema: null,
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcomes: Array<{
        testId: string;
        status: string;
        detail: string;
        executionMethods: string[];
      }>;
    };
    expect(body.outcomes).toHaveLength(8);
    expect(
      body.outcomes
        .filter(
          ({ testId }) => testId.startsWith('authentication') || testId.startsWith('compatibility'),
        )
        .every(({ status }) => status === 'passed'),
    ).toBe(true);
    expect(
      body.outcomes.find(({ testId }) => testId.startsWith('happy-path'))?.executionMethods,
    ).toEqual(['static-validation']);
    expect(
      body.outcomes.find(({ testId }) => testId.startsWith('compatibility'))?.executionMethods,
    ).toEqual(['static-validation']);
    expect(
      body.outcomes
        .filter(
          ({ testId }) =>
            !testId.startsWith('authentication') && !testId.startsWith('compatibility'),
        )
        .every(
          ({ status, detail }) =>
            status === 'failed' && detail.includes('customer worker and Temporal'),
        ),
    ).toBe(true);
  });

  it('fails contract mapping when workflow references do not produce the registered request', async () => {
    const response = await app.request('/__control/workflow-sandbox-tests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowVersionId: 'broken-mapping@1',
        irHash: 'd'.repeat(64),
        workflow: {
          executable: {
            inputSchema: { required: { paymentId: { type: 'string' } } },
            steps: [
              {
                id: 'create-intent',
                kind: 'capabilityCall',
                capabilityVersionId: 'stripe.create@v1',
                arguments: {
                  amount: { source: 'input', path: ['missingAmount'] },
                  currency: { source: 'literal', value: 'USD' },
                },
              },
              { id: 'completed', kind: 'terminal', state: 'completed' },
            ],
          },
        },
        providerContracts: [
          {
            capabilityVersionId: 'stripe.create@v1',
            serviceId: 'stripe',
            operationId: 'PostPaymentIntents',
            documentHash: 'b'.repeat(64),
            provider: 'Stripe',
            mode: 'contract-faithful-rehearsal',
            method: 'post',
            path: '/v1/payment_intents',
            requestSchema: {
              type: 'object',
              required: ['amount', 'currency'],
              properties: { amount: { type: 'integer' }, currency: { type: 'string' } },
            },
            responseSchema: { type: 'object', required: ['id'] },
          },
        ],
        tests: [
          {
            testId: 'contract-mapping:create-intent:stripe.create@v1',
            kind: 'contract-mapping',
            stepId: 'create-intent',
            capabilityVersionId: 'stripe.create@v1',
            expectation: 'mapping conforms',
            requestSample: { amount: 100, currency: 'USD' },
            expectedResponseSchema: { type: 'object', required: ['id'] },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcomes: [
        {
          testId: 'contract-mapping:create-intent:stripe.create@v1',
          status: 'failed',
        },
      ],
    });
  });

  it('does not execute workflow mapping checks outside the customer worker', async () => {
    let remoteCalled = false;
    const options = {
      stripeOfficialTest: {
        apiKey: 'sk_test_atlas',
        fetch: async () => {
          remoteCalled = true;
          return new Response(
            JSON.stringify({
              id: 'pi_remote',
              object: 'payment_intent',
              amount: 100,
              currency: 'usd',
              livemode: false,
              status: 'succeeded',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    };
    const testCase = {
      testId: 'contract-mapping:create-intent:stripe.create@v1',
      kind: 'contract-mapping' as const,
      stepId: 'create-intent',
      capabilityVersionId: 'stripe.create@v1',
      expectation: 'mapping conforms',
      requestSample: { amount: 100, currency: 'USD' },
      expectedResponseSchema: { type: 'object', required: ['id'] },
    };
    const suite = {
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowVersionId: 'remote-check@1',
      irHash: 'e'.repeat(64),
      workflow: {
        executable: {
          inputSchema: { required: {} },
          steps: [
            {
              id: 'create-intent',
              kind: 'capabilityCall',
              capabilityVersionId: 'stripe.create@v1',
              arguments: {
                amount: { source: 'literal', value: 100 },
                currency: { source: 'literal', value: 'USD' },
              },
              idempotency: { businessKey: { source: 'literal', value: 'remote-check' } },
            },
            { id: 'completed', kind: 'terminal', state: 'completed' },
          ],
        },
      },
      providerContracts: [
        {
          capabilityVersionId: 'stripe.create@v1',
          serviceId: 'stripe',
          operationId: 'PostPaymentIntents',
          documentHash: 'f'.repeat(64),
          provider: 'Stripe',
          mode: 'official-test' as const,
          method: 'post',
          path: '/v1/payment_intents',
          requestSchema: {
            type: 'object',
            required: ['amount', 'currency'],
            properties: { amount: { type: 'integer' }, currency: { type: 'string' } },
          },
          responseSchema: { type: 'object', required: ['id'] },
        },
      ],
      tests: [testCase],
    } satisfies ParsedWorkflowSandboxSuite;

    const result = await executeProviderSandboxCase(suite, testCase, (onRemoteSandboxRequest) =>
      createMockServicesApp({ ...options, onRemoteSandboxRequest }),
    );

    expect(remoteCalled).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.executionMethods).toEqual(['static-validation']);

    remoteCalled = false;
    const locallyRejectedSuite = {
      ...suite,
      workflowVersionId: 'locally-rejected-check@1',
      workflow: {
        executable: {
          ...suite.workflow.executable,
          steps: [
            {
              ...suite.workflow.executable.steps[0],
              arguments: {
                amount: { source: 'literal', value: 'not-an-amount' },
                currency: { source: 'literal', value: 'USD' },
              },
            },
            suite.workflow.executable.steps[1]!,
          ],
        },
      },
    } satisfies ParsedWorkflowSandboxSuite;
    const locallyRejected = await executeProviderSandboxCase(
      locallyRejectedSuite,
      testCase,
      (onRemoteSandboxRequest) => createMockServicesApp({ ...options, onRemoteSandboxRequest }),
    );

    expect(remoteCalled).toBe(false);
    expect(locallyRejected.passed).toBe(false);
    expect(locallyRejected.executionMethods).toEqual(['static-validation']);
  });

  it('publishes and executes the contract-faithful Stripe rehearsal surface', async () => {
    const documentResponse = await app.request('/specs/stripe.openapi.json');
    expect(documentResponse.status).toBe(200);
    await expect(documentResponse.json()).resolves.toMatchObject({
      info: {
        title: 'Stripe API (contract-faithful rehearsal subset)',
      },
      paths: {
        '/v1/payment_intents': {
          post: { operationId: 'PostPaymentIntents' },
        },
      },
      'x-atlas-connection': {
        provider: 'Stripe',
        mode: 'contract-faithful-rehearsal',
        liveConnectivity: false,
        upstreamRepository: 'https://github.com/stripe/openapi',
        upstreamRevision: '24e4796f5aa12204d7e208ef447a5d11705b9b41',
        upstreamPath: 'latest/openapi.spec3.json',
        officialSandboxUrl: 'https://api.stripe.com',
        officialSandboxActivation: 'STRIPE_DEMO_MODE=official-test',
      },
    });

    const bearerResponse = await app.request('/v1/payment_intents', {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk_test_atlas',
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': 'wrong-auth-scheme',
      },
      body: new URLSearchParams({ amount: '5000', currency: 'usd' }).toString(),
    });
    expect(bearerResponse.status).toBe(401);

    const createResponse = await app.request('/v1/payment_intents', {
      method: 'POST',
      headers: {
        authorization: 'Basic c2tfdGVzdF9hdGxhczo=',
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': 'sample-demo-stripe-1',
      },
      body: new URLSearchParams({ amount: '5000', currency: 'usd' }).toString(),
    });
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toMatchObject({
      id: 'pi_sample-demo-stripe-1',
      object: 'payment_intent',
      amount: 5000,
      currency: 'usd',
      livemode: false,
      status: 'succeeded',
    });
  });

  it('routes the configured Stripe operation to the official test-mode API', async () => {
    let capturedRequest: { url: string; init?: RequestInit } | undefined;
    app = createMockServicesApp({
      stripeOfficialTest: {
        apiKey: testStripeCredential,
        fetch: async (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          capturedRequest = { url, ...(init ? { init } : {}) };
          return Response.json({
            id: 'pi_official',
            object: 'payment_intent',
            amount: 7500,
            currency: 'usd',
            livemode: false,
            status: 'requires_payment_method',
          });
        },
      },
    });

    const document = await (await app.request('/specs/stripe.openapi.json')).json();
    expect(document.servers).toEqual([{ url: 'https://api.stripe.com' }]);
    expect(document['x-atlas-connection']).toMatchObject({
      mode: 'official-test',
      liveConnectivity: true,
      label: 'Official Stripe test mode',
    });

    const response = await app.request('/v1/payment_intents', {
      method: 'POST',
      headers: {
        authorization: 'Basic c2VjcmV0LXJlZmVyZW5jZQ==',
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': 'official-test-1',
      },
      body: new URLSearchParams({ amount: '7500', currency: 'USD' }).toString(),
    });

    expect(response.status).toBe(200);
    expect(capturedRequest?.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(capturedRequest?.init).toMatchObject({
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${testStripeCredential}:`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': 'official-test-1',
      },
    });
    const forwardedBody = capturedRequest?.init?.body;
    expect(forwardedBody).toBeInstanceOf(URLSearchParams);
    if (!(forwardedBody instanceof URLSearchParams)) throw new Error('Expected form body');
    expect(forwardedBody.toString()).toBe('amount=7500&currency=usd');
  });

  it('publishes and executes the contract-faithful Slack rehearsal surface', async () => {
    const documentResponse = await app.request('/specs/slack.openapi.json');
    expect(documentResponse.status).toBe(200);
    const document = await documentResponse.json();
    expect(document).toMatchObject({
      paths: { '/api/chat.postMessage': { post: { operationId: 'chat_postMessage' } } },
      'x-atlas-connection': {
        provider: 'Slack',
        mode: 'contract-faithful-rehearsal',
        liveConnectivity: false,
        upstreamRepository: 'https://github.com/slackapi/slack-api-specs',
        upstreamRevision: 'bc08db49625630e3585bf2f1322128ea04f2a7f3',
        upstreamPath: 'web-api/slack_web_openapi_v2.json',
        officialSandboxUrl: 'https://slack.com/api',
      },
    });
    expect(JSON.stringify(document)).not.toContain('xoxb-');

    const unauthenticated = await app.request('/api/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'C_SAMPLE_DEMO', text: 'Payment completed' }),
    });
    expect(unauthenticated.status).toBe(401);

    const response = await app.request('/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-rehearsal-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        channel: 'C_SAMPLE_DEMO',
        text: 'Payment completed',
        client_msg_id: 'run-1-notification',
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      channel: 'C_SAMPLE_DEMO',
      message: { text: 'Payment completed' },
    });
  });

  it('publishes the official Slack route without receiving the worker credential', async () => {
    app = createMockServicesApp({ slackConnection: { mode: 'official-test' } });

    const document = await (await app.request('/specs/slack.openapi.json')).json();
    expect(document.servers).toEqual([{ url: 'https://slack.com' }]);
    expect(JSON.stringify(document)).not.toContain('xoxb-');
  });

  it('publishes and executes the contract-faithful HubSpot rehearsal surface', async () => {
    const documentResponse = await app.request('/specs/hubspot.openapi.json');
    expect(documentResponse.status).toBe(200);
    const document = await documentResponse.json();
    expect(document).toMatchObject({
      paths: {
        '/crm/v3/objects/contacts': {
          post: {
            operationId: 'createContact',
            responses: { '201': expect.any(Object), default: expect.any(Object) },
          },
        },
      },
      'x-atlas-connection': {
        provider: 'HubSpot',
        mode: 'contract-faithful-rehearsal',
        liveConnectivity: false,
        upstreamRepository: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
        upstreamRevision: 'ab9ffa9c6f456fd8fce017f3d36fe619cbe88315',
        upstreamPath: 'PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json',
        officialSandboxUrl: 'https://api.hubapi.com',
      },
    });
    expect(JSON.stringify(document)).not.toContain('pat-');

    const unauthenticated = await app.request('/crm/v3/objects/contacts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        properties: { email: 'sample@example.com', firstname: 'Ada', lastname: 'Lovelace' },
      }),
    });
    expect(unauthenticated.status).toBe(401);

    const request = {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-rehearsal-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        properties: { email: 'sample@example.com', firstname: 'Ada', lastname: 'Lovelace' },
      }),
    };
    const response = await app.request('/crm/v3/objects/contacts', request);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      id: '100001',
      archived: false,
      properties: { email: 'sample@example.com', firstname: 'Ada', lastname: 'Lovelace' },
    });
    const duplicate = await app.request('/crm/v3/objects/contacts', request);
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({
      status: 'error',
      category: 'CONFLICT',
      message: 'A contact with this email already exists',
    });
  });

  it('publishes the official HubSpot route without receiving the worker credential', async () => {
    app = createMockServicesApp({ hubspotConnection: { mode: 'official-test' } });

    const document = await (await app.request('/specs/hubspot.openapi.json')).json();
    expect(document.servers).toEqual([{ url: 'https://api.hubapi.com' }]);
    expect(document['x-atlas-connection']).toMatchObject({
      mode: 'official-test',
      liveConnectivity: true,
      label: 'Configured HubSpot developer test account',
    });
    expect(JSON.stringify(document)).not.toContain('pat-');
  });

  it('rejects a stale expected invoice version instead of overwriting state', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });

    const beginResponse = await app.request('/invoices/inv_1/settlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 1,
        idempotencyKey: 'step_begin:pay_1',
      }),
    });
    const staleResponse = await app.request('/invoices/inv_1/settlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_2',
        expectedInvoiceVersion: 1,
        idempotencyKey: 'step_begin:pay_2',
      }),
    });

    expect(beginResponse.status).toBe(200);
    await expect(beginResponse.json()).resolves.toMatchObject({ status: 'settling', version: 2 });
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toEqual({
      error: { type: 'InvoiceVersionStale' },
    });
  });

  it('preserves a seeded invoice version for optimistic concurrency', async () => {
    const invoice = { ...knownState.invoices[0], version: 7 };
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'replace',
        resources: [
          {
            service: 'billing',
            collection: 'invoices',
            id: invoice.invoiceId,
            document: invoice,
          },
        ],
      }),
    });

    const response = await app.request('/invoices/inv_1/settlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 7,
        idempotencyKey: 'seeded-version',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'settling', version: 8 });
  });

  it('deduplicates every mutating operation in one global key space', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });

    const beginResponse = await app.request('/invoices/inv_1/settlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 1,
        idempotencyKey: 'shared-key',
      }),
    });
    const collidingMarkPaidResponse = await app.request('/invoices/inv_1/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 2,
        idempotencyKey: 'shared-key',
      }),
    });

    expect(beginResponse.status).toBe(200);
    expect(collidingMarkPaidResponse.status).toBe(200);
    await expect(collidingMarkPaidResponse.json()).resolves.toMatchObject({
      status: 'settling',
      version: 2,
    });

    const invoiceResponse = await app.request('/invoices/inv_1');
    await expect(invoiceResponse.json()).resolves.toMatchObject({
      status: 'settling',
      version: 2,
    });
  });

  it('shares the idempotency key space between Billing and Operations Notification', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });

    await app.request('/invoices/inv_1/settlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 1,
        idempotencyKey: 'shared-key',
      }),
    });
    const collidingNotification = await app.request('/operations/payment-notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        atlasWorkflowRunId: 'run_1',
        invoiceId: 'inv_1',
        paymentId: 'pay_1',
        idempotencyKey: 'shared-key',
      }),
    });

    expect(collidingNotification.status).toBe(200);
    await expect(collidingNotification.json()).resolves.toMatchObject({
      status: 'settling',
      version: 2,
    });
    const observations = await (await app.request('/__control/observations')).json();
    expect(observations.notifications).toEqual([]);
    expect(observations.idempotencyKeys).toEqual(['shared-key']);
  });

  it('can mark a settlement paid or cancel it', async () => {
    const seed = () =>
      app.request('/__control/resources', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(resourceControlBody(knownState)),
      });
    const begin = () =>
      app.request('/invoices/inv_1/settlement', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paymentId: 'pay_1',
          expectedInvoiceVersion: 1,
          idempotencyKey: 'step_begin:pay_1',
        }),
      });

    await seed();
    await begin();
    const paidResponse = await app.request('/invoices/inv_1/payment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 2,
        idempotencyKey: 'step_paid:pay_1',
      }),
    });
    expect(paidResponse.status).toBe(200);
    await expect(paidResponse.json()).resolves.toMatchObject({
      status: 'paid',
      version: 3,
      outstandingBalance: { value: 0, currency: 'USD' },
    });

    await seed();
    await begin();
    const cancelResponse = await app.request('/invoices/inv_1/settlement', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 2,
        idempotencyKey: 'step_cancel:pay_1',
      }),
    });
    expect(cancelResponse.status).toBe(200);
    await expect(cancelResponse.json()).resolves.toMatchObject({ status: 'open', version: 3 });
  });

  it('records a reversible settlement and an idempotent cancellation replay', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });

    const mutateSettlement = (
      method: 'POST' | 'DELETE',
      expectedInvoiceVersion: number,
      idempotencyKey: string,
    ) =>
      app.request('/invoices/inv_1/settlement', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paymentId: 'pay_1', expectedInvoiceVersion, idempotencyKey }),
      });

    const beginResponse = await mutateSettlement('POST', 1, 'begin:pay_1');
    const cancelResponse = await mutateSettlement('DELETE', 2, 'cancel:pay_1');
    await app.request('/__control/faults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'cancelInvoiceSettlement',
        mode: 'permanent',
        errorType: 'CancellationUnavailable',
      }),
    });
    const replayResponse = await mutateSettlement('DELETE', 2, 'cancel:pay_1');

    await expect(beginResponse.json()).resolves.toMatchObject({ status: 'settling', version: 2 });
    await expect(cancelResponse.json()).resolves.toMatchObject({ status: 'open', version: 3 });
    await expect(replayResponse.json()).resolves.toMatchObject({ status: 'open', version: 3 });
    await expect((await app.request('/invoices/inv_1')).json()).resolves.toMatchObject({
      status: 'open',
      version: 3,
    });

    const observations = await (await app.request('/__control/observations')).json();
    expect(observations.billingMutations).toEqual([
      {
        operationId: 'beginInvoiceSettlement',
        requestIdentity: {
          invoiceId: 'inv_1',
          paymentId: 'pay_1',
          expectedInvoiceVersion: 1,
        },
        idempotencyKey: 'begin:pay_1',
        beforeState: knownState.invoices[0],
        afterState: { ...knownState.invoices[0], status: 'settling', version: 2 },
        outcome: { kind: 'applied' },
        replayed: false,
      },
      {
        operationId: 'cancelInvoiceSettlement',
        requestIdentity: {
          invoiceId: 'inv_1',
          paymentId: 'pay_1',
          expectedInvoiceVersion: 2,
        },
        idempotencyKey: 'cancel:pay_1',
        beforeState: { ...knownState.invoices[0], status: 'settling', version: 2 },
        afterState: { ...knownState.invoices[0], status: 'open', version: 3 },
        outcome: { kind: 'applied' },
        replayed: false,
      },
      {
        operationId: 'cancelInvoiceSettlement',
        requestIdentity: {
          invoiceId: 'inv_1',
          paymentId: 'pay_1',
          expectedInvoiceVersion: 2,
        },
        idempotencyKey: 'cancel:pay_1',
        beforeState: { ...knownState.invoices[0], status: 'open', version: 3 },
        afterState: { ...knownState.invoices[0], status: 'open', version: 3 },
        outcome: { kind: 'succeeded' },
        replayed: true,
      },
    ]);
  });

  it('records stale cancellation rejection without changing the invoice', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });
    await app.request('/invoices/inv_1/settlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 1,
        idempotencyKey: 'begin:pay_1',
      }),
    });

    const response = await app.request('/invoices/inv_1/settlement', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 1,
        idempotencyKey: 'cancel-stale:pay_1',
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { type: 'InvoiceVersionStale' } });
    const observations = await (await app.request('/__control/observations')).json();
    expect(observations.billingMutations.at(-1)).toMatchObject({
      operationId: 'cancelInvoiceSettlement',
      idempotencyKey: 'cancel-stale:pay_1',
      beforeState: { status: 'settling', version: 2 },
      afterState: { status: 'settling', version: 2 },
      outcome: { kind: 'rejected', errorType: 'InvoiceVersionStale' },
      replayed: false,
    });
  });

  it('records an injected cancellation failure without changing the invoice', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });
    await app.request('/invoices/inv_1/settlement', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 1,
        idempotencyKey: 'begin:pay_1',
      }),
    });
    await app.request('/__control/faults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'cancelInvoiceSettlement',
        mode: 'permanent',
        errorType: 'CancellationUnavailable',
      }),
    });

    const response = await app.request('/invoices/inv_1/settlement', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 2,
        idempotencyKey: 'cancel:pay_1',
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: { type: 'CancellationUnavailable' } });
    const observations = await (await app.request('/__control/observations')).json();
    expect(observations.billingMutations.at(-1)).toMatchObject({
      operationId: 'cancelInvoiceSettlement',
      idempotencyKey: 'cancel:pay_1',
      beforeState: { status: 'settling', version: 2 },
      afterState: { status: 'settling', version: 2 },
      outcome: { kind: 'failed', errorType: 'CancellationUnavailable' },
      replayed: false,
    });
  });

  it('enforces settlement ordering and never reopens a paid invoice', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });

    const mutation = (path: string, method: 'POST' | 'DELETE', version: number, key: string) =>
      app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          paymentId: 'pay_1',
          expectedInvoiceVersion: version,
          idempotencyKey: key,
        }),
      });

    const paidWithoutSettlement = await mutation(
      '/invoices/inv_1/payment',
      'POST',
      1,
      'step_paid_early:pay_1',
    );
    expect(paidWithoutSettlement.status).toBe(409);
    await expect(paidWithoutSettlement.json()).resolves.toEqual({
      error: { type: 'InvoiceNotSettling' },
    });

    await mutation('/invoices/inv_1/settlement', 'POST', 1, 'step_begin:pay_1');
    await mutation('/invoices/inv_1/payment', 'POST', 2, 'step_paid:pay_1');

    const beginPaidInvoice = await mutation(
      '/invoices/inv_1/settlement',
      'POST',
      3,
      'step_begin_again:pay_1',
    );
    const cancelPaidInvoice = await mutation(
      '/invoices/inv_1/settlement',
      'DELETE',
      3,
      'step_cancel_late:pay_1',
    );
    expect(beginPaidInvoice.status).toBe(409);
    expect(cancelPaidInvoice.status).toBe(409);
    await expect((await app.request('/invoices/inv_1')).json()).resolves.toMatchObject({
      status: 'paid',
      version: 3,
    });
  });

  it('injects transient, permanent, and schema-violating faults per operation', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });
    await app.request('/__control/faults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'beginInvoiceSettlement',
        mode: 'transient',
        failures: 2,
      }),
    });

    const beginRequest = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        paymentId: 'pay_1',
        expectedInvoiceVersion: 1,
        idempotencyKey: 'step_begin:pay_1',
      }),
    };
    const firstAttempt = await app.request('/invoices/inv_1/settlement', beginRequest);
    const secondAttempt = await app.request('/invoices/inv_1/settlement', beginRequest);
    const thirdAttempt = await app.request('/invoices/inv_1/settlement', beginRequest);

    expect(firstAttempt.status).toBe(503);
    expect(secondAttempt.status).toBe(503);
    expect(thirdAttempt.status).toBe(200);

    await app.request('/__control/faults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'getPayment',
        mode: 'permanent',
        errorType: 'AuthenticationFailed',
      }),
    });
    const permanentResponse = await app.request('/payments/pay_1');
    expect(permanentResponse.status).toBe(500);
    await expect(permanentResponse.json()).resolves.toEqual({
      error: { type: 'AuthenticationFailed' },
    });

    await app.request('/__control/faults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'getInvoice', mode: 'schema-violation' }),
    });
    const invalidResponse = await app.request('/invoices/inv_1');
    expect(invalidResponse.status).toBe(200);
    await expect(invalidResponse.json()).resolves.toEqual({ schemaViolation: true });
  });

  it('fails the retry rehearsal payment twice with one stable classification, then recovers', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        resourceControlBody({
          ...knownState,
          payments: [
            ...knownState.payments,
            { ...knownState.payments[0]!, paymentId: 'payment_retry_demo_001' },
          ],
        }),
      ),
    });

    const responses = await Promise.all([
      app.request('/payments/payment_retry_demo_001'),
      app.request('/payments/payment_retry_demo_001'),
      app.request('/payments/payment_retry_demo_001'),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([503, 503, 200]);
    await expect(responses[0]!.json()).resolves.toEqual({
      error: { type: 'TransientDownstream' },
    });
    await expect(responses[1]!.json()).resolves.toEqual({
      error: { type: 'TransientDownstream' },
    });

    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        resourceControlBody({
          ...knownState,
          payments: [
            ...knownState.payments,
            { ...knownState.payments[0]!, paymentId: 'payment_retry_demo_001' },
          ],
        }),
      ),
    });
    expect((await app.request('/payments/payment_retry_demo_001')).status).toBe(503);
  });

  it('parks the repair rehearsal after three publish failures, then allows a repaired retry', async () => {
    const event = {
      eventId: 'evt_repair_demo',
      eventType: 'invoice.paid',
      invoiceId: 'invoice_repair_demo_001',
      paymentId: 'payment_repair_demo_001',
      atlasWorkflowRunId: 'run_repair_demo',
    };
    const publish = () =>
      app.request('/events/invoice.paid', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });

    const exhausted = await Promise.all([publish(), publish(), publish()]);

    expect(exhausted.map(({ status }) => status)).toEqual([503, 503, 503]);
    await expect(exhausted[0]!.json()).resolves.toEqual({
      error: { type: 'TransientDownstream' },
    });

    const unrelatedRepair = await app.request('/__control/provider-conditions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'notifyPaymentOperations',
        repairedCapabilityVersionId: 'unrelated-content-hash',
      }),
    });
    expect(unrelatedRepair.status).toBe(400);
    expect((await publish()).status).toBe(503);

    await app.request('/__control/provider-conditions', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: 'publishInvoicePaid',
        repairedCapabilityVersionId: 'current-catalog-content-hash',
      }),
    });
    expect((await publish()).status).toBe(202);
  });

  it('publishes invoice.paid and notifies operations once per key', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });

    const event = {
      eventId: 'evt_1',
      eventType: 'invoice.paid',
      invoiceId: 'inv_1',
      paymentId: 'pay_1',
      atlasWorkflowRunId: 'run_1',
    };
    const eventResponse = await app.request('/events/invoice.paid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    await app.request('/events/invoice.paid', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });

    const notification = {
      atlasWorkflowRunId: 'run_1',
      invoiceId: 'inv_1',
      paymentId: 'pay_1',
      idempotencyKey: 'step_notify:run_1',
    };
    const notificationResponse = await app.request('/operations/payment-notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notification),
    });
    await app.request('/operations/payment-notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(notification),
    });

    expect(eventResponse.status).toBe(202);
    await expect(eventResponse.json()).resolves.toEqual({ published: true });
    expect(notificationResponse.status).toBe(200);
    await expect(notificationResponse.json()).resolves.toEqual({ notified: true });

    const observationsResponse = await app.request('/__control/observations');
    await expect(observationsResponse.json()).resolves.toMatchObject({
      publishedEvents: [event],
      notifications: [notification],
    });
  });

  it('publishes OpenAPI 3.1 and AsyncAPI 3.0 documents from its runtime contracts', async () => {
    const paymentDocument = await (await app.request('/specs/payment.openapi.json')).json();
    const billingDocument = await (await app.request('/specs/billing.openapi.json')).json();
    const operationsDocument = await (await app.request('/specs/operations.openapi.json')).json();
    const eventsDocument = await (await app.request('/specs/events.asyncapi.json')).json();

    expect(paymentDocument).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/payments/{paymentId}': {
          get: {
            operationId: 'getPayment',
            parameters: [
              {
                name: 'paymentId',
                schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
              },
            ],
          },
        },
        '/mapping-demo/payments/{paymentId}': {
          get: { operationId: 'getMappingDemoPayment' },
        },
      },
    });
    expect(billingDocument).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/invoices/{invoiceId}': { get: { operationId: 'getInvoice' } },
        '/invoices/{invoiceId}/settlement': {
          post: { operationId: 'beginInvoiceSettlement' },
          delete: { operationId: 'cancelInvoiceSettlement' },
        },
        '/invoices/{invoiceId}/payment': { post: { operationId: 'markInvoicePaid' } },
        '/mapping-demo/billing/settlements': {
          post: { operationId: 'settleMappingDemoInvoice' },
        },
      },
    });
    expect(operationsDocument).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/operations/payment-notifications': {
          post: { operationId: 'notifyPaymentOperations' },
        },
      },
    });
    expect(eventsDocument).toMatchObject({
      asyncapi: '3.0.0',
      channels: { invoicePaid: { address: 'invoice.paid' } },
      operations: { publishInvoicePaid: { action: 'send' } },
    });
  });

  it('publishes and serves optional, renamed, removed, and retyped invoice fields', async () => {
    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });

    const activate = (mutation: string) =>
      app.request('/__control/specs/billing', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mutation }),
      });
    const publishedInvoiceSchema = async () => {
      const document = await (await app.request('/specs/billing.openapi.json')).json();
      return document.components.schemas.Invoice;
    };

    await activate('add-optional-field');
    const optionalSchema = await publishedInvoiceSchema();
    expect(optionalSchema.properties).toHaveProperty('purchaseOrderReference');
    expect(optionalSchema.required).not.toContain('purchaseOrderReference');

    await activate('rename-field');
    const renamedSchema = await publishedInvoiceSchema();
    expect(renamedSchema.properties).toHaveProperty('accountId');
    expect(renamedSchema.properties).not.toHaveProperty('customerId');
    await expect((await app.request('/invoices/inv_1')).json()).resolves.toMatchObject({
      accountId: 'cust_9',
    });

    await activate('remove-field');
    const removedSchema = await publishedInvoiceSchema();
    expect(removedSchema.properties).not.toHaveProperty('customerId');

    await activate('retype-field');
    const retypedSchema = await publishedInvoiceSchema();
    expect(retypedSchema.properties.version).toMatchObject({ type: 'string' });
    await expect((await app.request('/invoices/inv_1')).json()).resolves.toMatchObject({
      version: '1',
    });
  });

  it('keeps the active provider contract when sandbox fixtures reset runtime state', async () => {
    await app.request('/__control/specs/billing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mutation: 'remove-field' }),
    });

    await app.request('/__control/resources', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resourceControlBody(knownState)),
    });

    const document = await (await app.request('/specs/billing.openapi.json')).json();
    expect(document.components.schemas.Invoice.properties).not.toHaveProperty('customerId');
  });
});

const testStripeCredential = ['sk', 'test', randomBytes(16).toString('hex')].join('_');
