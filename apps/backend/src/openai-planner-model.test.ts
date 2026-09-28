import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vite-plus/test';

import { OpenAiPlannerModel, PlannerUnavailableError } from './openai-planner-model.js';
import {
  PlanningTraceStore,
  runWithPlanningTrace,
  runWithPlanningTraceListener,
} from './planning-trace.js';

it('requests live structured output and reasoning summaries for drafting logs', async () => {
  const events: unknown[] = [];
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'gpt-5' },
    async (_url, options) => {
      if (typeof options?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(options.body)).toMatchObject({
        stream: true,
        reasoning: { summary: 'auto' },
      });
      return new Response(
        [
          { type: 'response.output_text.delta', delta: '{"supported":true}' },
          {
            type: 'response.completed',
            response: {
              output: [
                { type: 'message', content: [{ type: 'output_text', text: '{"supported":true}' }] },
              ],
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  );
  await expect(
    runWithPlanningTraceListener(
      async (kind, data) => {
        events.push({ kind, ...data });
      },
      () =>
        model.extractIntent({
          developerRequest: 'Read a payment',
          capabilityIndex: { projectionFingerprint: 'a'.repeat(64), capabilities: [] },
        }),
    ),
  ).resolves.toEqual({ supported: true });
  expect(JSON.stringify(events)).toContain('model.stream.started');
});

function openAiResponse(output: unknown) {
  return new Response(
    JSON.stringify({
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(output) }],
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

it('passes cancellation to the provider without putting the signal in its prompt', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'test-model' },
    async (_url, options) => {
      expect(options?.signal).toBe(controller.signal);
      expect(options?.body).not.toContain('"signal"');
      entered.resolve();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      });
    },
  );
  const pending = model.extractIntent({
    developerRequest: 'Read a payment',
    capabilityIndex: { projectionFingerprint: 'a'.repeat(64), capabilities: [] },
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort();
  await expect(pending).rejects.toThrow('aborted');
});

it('uses separate closed-schema model calls for raw intent and fingerprint-bound planning', async () => {
  const intentFingerprint = 'a'.repeat(64);
  const projectionFingerprint = 'b'.repeat(64);
  const intent = {
    version: 1 as const,
    summary: 'Read a payment',
    requestedEffects: ['readRecord' as const],
    mentionedSystems: ['payments'],
    requiredInputs: ['paymentId'],
    constraints: [],
    ambiguities: [],
    supported: true,
    unsupportedReason: null,
  };
  const requests: RequestInit[] = [];
  const responses = [
    openAiResponse(intent),
    openAiResponse({
      result: {
        kind: 'clarification',
        intentFingerprint,
        projectionFingerprint,
        question: 'Which payment state should start the workflow?',
        suggestedAnswers: ['Succeeded', 'Authorized', 'Captured'],
      },
    }),
    openAiResponse({
      result: {
        kind: 'clarification',
        intentFingerprint,
        projectionFingerprint,
        question: 'Which payment state should start the workflow?',
        suggestedAnswers: ['Succeeded', 'Authorized', 'Captured'],
      },
    }),
  ];
  const fakeFetch: typeof fetch = async (_input, init) => {
    requests.push(init ?? {});
    const response = responses.shift();
    if (!response) throw new Error('Unexpected model request');
    return response;
  };
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'configured-model' },
    fakeFetch,
  );

  await expect(
    model.extractIntent({
      developerRequest: 'When a payment succeeds, read its record.',
      capabilityIndex: {
        projectionFingerprint,
        capabilities: [
          {
            capabilityVersionId: 'cap-get-payment',
            identity: {
              kind: 'openapi',
              serviceId: 'payments',
              operationId: 'getPayment',
            },
            owner: 'payments-team',
            businessSemantics: { readsAuthoritativePayment: true },
            fields: [
              {
                direction: 'request',
                path: '/paymentId',
                type: 'string',
                required: true,
                label: 'Payment ID',
              },
            ],
          },
        ],
      },
    }),
  ).resolves.toEqual(intent);
  await expect(
    model.draftWorkflow({
      intent,
      intentFingerprint,
      projection: {
        fingerprint: projectionFingerprint,
        capabilities: [],
      },
    }),
  ).resolves.toMatchObject({
    kind: 'clarification',
    question: 'Which payment state should start the workflow?',
  });
  await model.repairWorkflow({
    intent,
    intentFingerprint,
    projection: {
      fingerprint: projectionFingerprint,
      capabilities: [],
    },
    attempt: 1,
    previousDraft: {},
    validation: {
      diagnostics: [],
      decision: {
        approvable: false,
        compileErrorCount: 1,
        policyDenialCount: 0,
        warningCount: 0,
        blockingWarningCount: 0,
        approvalRequirementCount: 0,
        recomputedIrHash: null,
        policyVersion: 'test',
        projectionFingerprint,
      },
    },
  });

  const intentRequest = JSON.stringify(requests[0]);
  const planningRequest = JSON.stringify(requests[1]);
  const repairRequest = JSON.stringify(requests[2]);
  expect(intentRequest).toContain('When a payment succeeds, read its record.');
  expect(intentRequest).toContain('cap-get-payment');
  expect(intentRequest).toContain('getPayment');
  expect(intentRequest).toContain('/paymentId');
  expect(intentRequest).toContain('readsAuthoritativePayment');
  expect(intentRequest).toContain(
    'Do not ask the developer for endpoint, authentication, schema, or request-format details',
  );
  expect(intentRequest).toContain(
    'Do not treat event or notification payload fields as unresolved business facts',
  );
  expect(intentRequest).toContain(
    'Never ask for organization, environment, workflow, artifact, hash, fingerprint, or IR-version metadata',
  );
  expect(intentRequest).toContain(
    'Do not ask how capability failures should be retried, timed out, deduplicated, or terminated',
  );
  expect(intentRequest).toContain(
    'Treat a named notification audience such as operations as a sufficient capability target',
  );
  expect(intentRequest).toContain('Provide exactly three concise suggested answers');
  expect(intentRequest).toContain(
    'A short operational request is complete when the capabilityIndex can satisfy it',
  );
  expect(intentRequest).toContain('Unnamed required destination fields');
  expect(intentRequest).toContain('Work backwards from the required inputs');
  expect(intentRequest).toContain('even when the request already names other inputs');
  expect(intentRequest).toContain('when someone');
  expect(intentRequest).toContain('recipeHints');
  expect(intentRequest).toContain(
    'Stale observations and discovery-failed reasons do not make a request unsupported',
  );
  expect(planningRequest).not.toContain('When a payment succeeds, read its record.');
  expect(planningRequest).toContain(projectionFingerprint);
  expect(planningRequest).toContain(
    'Treat the capability projection as authoritative for implementation details',
  );
  expect(planningRequest).toContain('recipeHints');
  expect(planningRequest).toContain('do not copy every recipe step');
  expect(planningRequest).toContain('provide exactly three concise suggested answers');
  expect(planningRequest).not.toContain('[\\"amount\\",\\"value\\"]');
  for (const request of [planningRequest, repairRequest]) {
    expect(request).toContain('remain valid for drafting from their last known definitions');
    expect(request).toContain('Select the smallest set of projected capabilities');
    expect(request).toContain('Wire a prior step');
    expect(request).toContain('Declare the workflow inputs in executable.inputSchema');
    expect(request).toContain('Work backwards from each selected capability');
    expect(request).not.toContain('If the request names no inputs');
    expect(request).toContain('declare every leftover required request field across all steps');
    expect(request).toContain(
      'Input references may only use paths declared in executable.inputSchema',
    );
    expect(request).not.toContain('workflowStartInputSchema');
    expect(request).toContain(
      "arguments is a flat object keyed by the destination capability's input field names",
    );
    expect(request).toContain("Object schemas use Atlas's required field map");
    expect(request).toContain(
      'Use irVersion 3 when a request needs conditions, sleep, data transformation blocks',
    );
    expect(request).toContain(
      'map idempotencyKey from input paymentId and set idempotency.businessKey to that same reference',
    );
    expect(request).toContain('even when the field is optional and the step has no retryPolicy');
    expect(request).toContain('Otherwise use input path atlasWorkflowRunId');
    expect(request).toContain(
      'never infer event identity from an item, server, or location identifier',
    );
    expect(request).toContain(
      'Required atlasWorkflowRunId fields always map from input path atlasWorkflowRunId',
    );
    expect(request).toContain(
      'Never ask for idempotency keys, event identifiers, or provider idempotency headers',
    );
    expect(request).toContain(
      'When mappingResolutions are present, they are answers the developer already gave',
    );
    expect(request).toContain('Name the exact operationId and field');
    expect(request).toContain('Never ask about, or return clarification for, backend-owned fields');
    expect(request).toContain('Write durations as Temporal strings such as');
    expect(request).toContain(
      'Only retry a step that writes if its capability declares an idempotencyField and the step declares idempotency.businessKey',
    );
    expect(request).toContain(
      'Copy irreversibleAfter and other safety annotations exactly from the selected capability',
    );
    expect(request).toContain('For AsyncAPI send operations omit responseSchema');
    expect(request).toContain('PROVIDER_CONTRACT_MISMATCH');
    expect(request).toContain(
      'map every required provider field from a grounded input or prior step output',
    );
  }
  expect(planningRequest).toContain('json_schema');
  expect(JSON.parse(requests[0]!.body as string)).toMatchObject({
    store: false,
    text: { format: { strict: true } },
  });
  expect(JSON.parse(requests[1]!.body as string)).toMatchObject({
    store: false,
    text: { format: { strict: false } },
  });
  expect(planningRequest).toContain('clarifiedRequest');
});

it('returns malformed fingerprint-bound drafts to deterministic repair instead of throwing', async () => {
  const intentFingerprint = 'a'.repeat(64);
  const projectionFingerprint = 'b'.repeat(64);
  const fakeFetch: typeof fetch = async () =>
    openAiResponse({
      result: {
        kind: 'workflowDraft',
        intentFingerprint,
        projectionFingerprint,
        draft: {},
      },
    });
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'configured-model' },
    fakeFetch,
  );

  await expect(
    model.draftWorkflow({
      intent: {
        version: 1,
        summary: 'Read a payment',
        requestedEffects: ['readRecord'],
        mentionedSystems: ['payments'],
        requiredInputs: ['paymentId'],
        constraints: [],
        ambiguities: [],
        supported: true,
        unsupportedReason: null,
      },
      intentFingerprint,
      projection: {
        fingerprint: projectionFingerprint,
        capabilities: [],
      },
    }),
  ).resolves.toMatchObject({ kind: 'workflowDraft', draft: {} });
});

it('uses a closed schema for advisory potential coverage and may refuse', async () => {
  const requests: RequestInit[] = [];
  const fakeFetch: typeof fetch = async (_input, init) => {
    requests.push(init ?? {});
    return openAiResponse({
      kind: 'suggestion',
      suggestions: [
        {
          fromCapabilityVersionId: 'cap-old',
          operationId: 'chargeV2',
          fieldPath: '/request/currencyCode',
        },
      ],
    });
  };
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'configured-model' },
    fakeFetch,
  );

  await expect(
    model.suggestPotentialCoverage({
      unmappedContracts: [
        {
          fromCapabilityVersionId: 'cap-old',
          fieldChanges: [{ kind: 'removed', path: '/request/currency' }],
        },
      ],
      discoveredSource: [
        { operationId: 'chargeV2', fieldPaths: ['/request/amountCents', '/request/currencyCode'] },
      ],
    }),
  ).resolves.toEqual({
    kind: 'suggestion',
    suggestions: [
      {
        fromCapabilityVersionId: 'cap-old',
        operationId: 'chargeV2',
        fieldPath: '/request/currencyCode',
      },
    ],
  });

  const body = JSON.parse(requests[0]!.body as string) as {
    text: { format: { name: string; strict: boolean; schema: unknown } };
    input: Array<{ role: string; content: string }>;
  };
  expect(body.text.format).toMatchObject({
    type: 'json_schema',
    name: 'atlas_potential_coverage',
    strict: true,
  });
  expect(JSON.stringify(body.text.format.schema)).toContain('refusal');
  expect(body.input[0]?.content).toContain(
    'Only point at operations and fields listed in the supplied discovered-source projection',
  );
  expect(body.input[0]?.content).toContain('Never invent an operationId or fieldPath');
  expect(body.input[0]?.content).toContain('Never claim a mapping is approved');
  expect(body.input[0]?.content).toContain('advisory potential coverage only');
  expect(body.input[1]?.content).toContain('chargeV2');
  expect(body.input[1]?.content).toContain('/request/currencyCode');
});

function intentExtractionInput() {
  return {
    developerRequest: 'When a payment succeeds, read its record.',
    capabilityIndex: {
      projectionFingerprint: 'b'.repeat(64),
      capabilities: [
        {
          capabilityVersionId: 'cap-get-payment',
          identity: {
            kind: 'openapi' as const,
            serviceId: 'payments',
            operationId: 'getPayment',
          },
          owner: 'payments-team',
          businessSemantics: { readsAuthoritativePayment: true },
          fields: [
            {
              direction: 'request' as const,
              path: '/paymentId',
              type: 'string',
              required: true,
              label: 'Payment ID',
            },
          ],
        },
      ],
    },
  };
}

it('retries a transient OpenAI 503 and then returns structured intent', async () => {
  const intent = {
    version: 1 as const,
    summary: 'Read a payment',
    requestedEffects: ['readRecord' as const],
    mentionedSystems: ['payments'],
    requiredInputs: ['paymentId'],
    constraints: [],
    ambiguities: [],
    supported: true,
    unsupportedReason: null,
  };
  const responses = [
    new Response(JSON.stringify({ error: { type: 'server_error', message: 'overloaded' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }),
    openAiResponse(intent),
  ];
  const fakeFetch: typeof fetch = async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected model request');
    return response;
  };
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'configured-model' },
    fakeFetch,
    { retryDelayMs: 0 },
  );

  await expect(model.extractIntent(intentExtractionInput())).resolves.toEqual(intent);
});

it('does not retry a non-transient OpenAI failure', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad schema' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  };
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'configured-model' },
    fakeFetch,
    { retryDelayMs: 0 },
  );

  await expect(model.extractIntent(intentExtractionInput())).rejects.toMatchObject({
    name: 'PlannerUnavailableError',
    status: 400,
    message: 'OpenAI planning request failed with status 400: invalid_request_error: bad schema',
  });
  expect(calls).toBe(1);
});

it('does not retry when OpenAI reports no remaining credits', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        error: {
          type: 'insufficient_quota',
          code: 'credit_balance_exhausted',
          message: 'You have no credits remaining.',
        },
      }),
      { status: 429, headers: { 'content-type': 'application/json' } },
    );
  };
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'configured-model' },
    fakeFetch,
    { retryDelayMs: 0 },
  );

  await expect(model.extractIntent(intentExtractionInput())).rejects.toMatchObject({
    name: 'PlannerUnavailableError',
    status: 429,
    code: 'credit_balance_exhausted',
  });
  expect(calls).toBe(1);
});

it('throws PlannerUnavailableError after retrying exhausted 503s', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ error: { type: 'server_error', message: 'overloaded' } }),
      {
        status: 503,
        headers: { 'content-type': 'application/json' },
      },
    );
  };
  const model = new OpenAiPlannerModel(
    { apiKey: 'test-key', model: 'configured-model' },
    fakeFetch,
    { retryDelayMs: 0 },
  );

  await expect(model.extractIntent(intentExtractionInput())).rejects.toBeInstanceOf(
    PlannerUnavailableError,
  );
  expect(calls).toBe(3);
});

it('traces exact OpenAI requests, responses, headers, and retries without the API key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-openai-trace-'));
  const apiKey = 'test-key-that-must-not-be-written';
  const intent = {
    version: 1 as const,
    summary: 'Read a payment',
    requestedEffects: ['readRecord' as const],
    mentionedSystems: ['payments'],
    requiredInputs: ['paymentId'],
    constraints: [],
    ambiguities: [],
    supported: true,
    unsupportedReason: null,
  };
  const responses = [
    new Response(JSON.stringify({ error: { type: 'server_error', message: 'overloaded' } }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'retry-after': '1',
        'x-request-id': 'request-failed',
        'x-ratelimit-remaining-requests': '0',
      },
    }),
    openAiResponse(intent),
  ];
  const fakeFetch: typeof fetch = async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected model request');
    return response;
  };

  try {
    const trace = await new PlanningTraceStore(directory).start({
      request: { request: 'When a payment succeeds, read its record.' },
      actorId: 'actor-1',
    });
    const model = new OpenAiPlannerModel({ apiKey, model: 'configured-model' }, fakeFetch, {
      retryDelayMs: 0,
    });
    await runWithPlanningTrace(trace, async () => {
      await expect(model.extractIntent(intentExtractionInput())).resolves.toEqual(intent);
    });
    await trace.close();

    const [file] = await readdir(directory);
    const contents = await readFile(join(directory, file!), 'utf8');
    const records = contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(contents).not.toContain(apiKey);
    expect(records.map(({ kind }) => kind)).toEqual([
      'planning.started',
      'model.call.started',
      'model.attempt.started',
      'model.attempt.response',
      'model.retry.scheduled',
      'model.attempt.started',
      'model.attempt.response',
      'model.call.completed',
    ]);
    expect(records[1]).toMatchObject({
      name: 'atlas_intent_frame',
      model: 'configured-model',
      request: {
        headers: {
          'content-type': 'application/json',
          authorizationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        body: {
          model: 'configured-model',
          store: false,
        },
      },
    });
    expect(JSON.stringify(records[1])).toContain('When a payment succeeds, read its record.');
    expect(records[3]).toMatchObject({
      status: 503,
      headers: {
        'retry-after': '1',
        'x-request-id': 'request-failed',
        'x-ratelimit-remaining-requests': '0',
      },
      rawBody: JSON.stringify({
        error: { type: 'server_error', message: 'overloaded' },
      }),
    });
    expect(records[7]).toMatchObject({ output: intent });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
