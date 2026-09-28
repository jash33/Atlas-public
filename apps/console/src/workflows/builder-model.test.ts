import { describe, expect, it } from 'vite-plus/test';

import {
  BUILDER_START_ID,
  addBuilderBlock,
  arrangeBuilder,
  builderBlockWidth,
  builderCapabilitiesFromProjection,
  builderConnectionAllowed,
  builderConnections,
  builderIssues,
  builderObject,
  builderReadOnlyReason,
  builderStepLabel,
  builderSteps,
  builderValueOptions,
  connectBuilder,
  createBuilderDocument,
  duplicateBuilderBlock,
  removeBuilderBlocks,
  updateBuilderStep,
  type BuilderCapability,
  type BuilderDocument,
} from './builder-model.js';

function branchedWorkflow(): BuilderDocument {
  return createBuilderDocument({
    irVersion: 3,
    startStepId: 'read',
    inputSchema: { required: { orderId: { type: 'string' } } },
    steps: [
      {
        id: 'read',
        kind: 'capabilityCall',
        capabilityVersionId: 'cap-read',
        inputSchema: { required: {} },
        arguments: {},
        responseSchema: {
          required: {
            amount: { type: 'number' },
            account: { type: 'object', required: { id: { type: 'string' } } },
          },
        },
        next: 'decide',
      },
      {
        id: 'decide',
        kind: 'condition',
        condition: {
          left: { source: 'stepOutput', stepId: 'read', path: ['amount'] },
          operator: 'greaterThan',
          right: { source: 'literal', value: 10 },
        },
        whenTrue: 'left',
        whenFalse: 'right',
      },
      {
        id: 'left',
        kind: 'transform',
        arguments: {},
        responseSchema: { required: { leftOnly: { type: 'string' } } },
        next: 'finish',
      },
      { id: 'right', kind: 'sleep', durationMs: 1000, next: 'finish' },
      { id: 'finish', kind: 'terminal', state: 'completed' },
    ],
  });
}

describe('workflow builder document', () => {
  it('uses catalog names consistently for references and copies while honoring custom names', () => {
    const document = branchedWorkflow();
    const capabilities: BuilderCapability[] = [
      {
        capabilityVersionId: 'cap-read',
        label: 'Read order',
        description: 'Read an order',
        kind: 'capabilityCall',
        inputSchema: { required: {} },
        responseSchema: { required: {} },
      },
    ];
    const read = builderSteps(document).find(({ id }) => id === 'read')!;
    expect(builderStepLabel(document, read, capabilities)).toBe('Read order');
    expect(
      builderValueOptions(document, 'decide', capabilities).some(({ label }) =>
        label.startsWith('Read order'),
      ),
    ).toBe(true);
    const copy = duplicateBuilderBlock(document, 'read', capabilities)!;
    expect(copy.document.labels[copy.id]).toBe('Read order copy');
    document.labels.read = 'Load the latest order';
    expect(builderStepLabel(document, read, capabilities)).toBe('Load the latest order');
    document.labels.read = '   ';
    expect(builderStepLabel(document, read, capabilities)).toBe('Read order');
    expect(builderStepLabel(document, read, [])).toBe('read');
  });

  it('imports legacy order, compensation, and final output without losing advanced settings', () => {
    const legacy = {
      irVersion: 1,
      inputSchema: { required: { id: { type: 'string' } } },
      steps: [
        {
          id: 'charge',
          kind: 'capabilityCall',
          capabilityVersionId: 'charge-v1',
          arguments: { id: { source: 'input', path: ['id'] } },
          responseSchema: { required: { chargeId: { type: 'string' } } },
          retryPolicy: { maximumAttempts: 3 },
          idempotency: { businessKey: { source: 'input', path: ['id'] } },
          errorRouting: { 'payment-failed': { terminalState: 'manual_review' } },
        },
        {
          id: 'refund',
          kind: 'compensation',
          capabilityVersionId: 'refund-v1',
          compensatesStepId: 'charge',
          arguments: { chargeId: { source: 'stepOutput', stepId: 'charge', path: ['chargeId'] } },
        },
        { id: 'finish', kind: 'terminal', state: 'completed' },
      ],
    };
    const imported = createBuilderDocument(legacy);
    expect(builderObject(imported.executable)).toMatchObject({
      irVersion: 3,
      startStepId: 'charge',
    });
    expect(builderSteps(imported)[0]).toMatchObject({
      ...legacy.steps[0],
      inputSchema: { required: { id: { type: 'string' } } },
      next: 'finish',
    });
    expect(builderSteps(imported)[1]).toMatchObject({
      ...legacy.steps[1],
      inputSchema: { required: { chargeId: { type: 'string' } } },
    });
    expect(builderSteps(imported)[1]).not.toHaveProperty('next');
    expect(builderSteps(imported)[2]).toMatchObject({
      output: { source: 'stepOutput', stepId: 'charge', path: [] },
    });
    expect(legacy.irVersion).toBe(1);
    expect(legacy.steps[0]).not.toHaveProperty('next');
  });

  it('imports v2 expressions and preserves their declared types', () => {
    const expression = {
      kind: 'call',
      function: 'multiply',
      arguments: [
        { source: 'literal', value: 2 },
        { source: 'literal', value: 5 },
      ],
    };
    const document = createBuilderDocument({
      irVersion: 2,
      steps: [
        {
          id: 'call',
          kind: 'capabilityCall',
          capabilityVersionId: 'v1',
          arguments: { amount: expression },
          inputSchema: { required: { amount: { type: 'number', classification: 'confidential' } } },
        },
      ],
    });
    expect(builderSteps(document)[0]).toMatchObject({
      arguments: { amount: expression },
      inputSchema: { required: { amount: { type: 'number', classification: 'confidential' } } },
      next: 'finish',
    });
  });

  it('preserves unsupported versions and unreachable legacy content intact', () => {
    for (const executable of [
      { irVersion: 9, steps: [{ id: 'one', kind: 'future' }] },
      {
        irVersion: 1,
        steps: [
          { id: 'end', kind: 'terminal', state: 'completed' },
          { id: 'later', kind: 'capabilityCall', capabilityVersionId: 'v1', arguments: {} },
        ],
      },
      {
        irVersion: 3,
        startStepId: 'one',
        steps: [{ id: 'one', kind: 'future', special: { untouched: true } }],
      },
    ]) {
      const document = createBuilderDocument(executable);
      expect(document.executable).toEqual(executable);
      expect(builderReadOnlyReason(document)).toBeDefined();
    }
  });

  it('inserts a sleep into a chosen branch without changing the other route', () => {
    const original = branchedWorkflow();
    const inserted = addBuilderBlock(original, 'sleep', {
      source: 'decide',
      target: 'left',
      port: 'whenTrue',
    });
    expect(builderSteps(inserted.document).find(({ id }) => id === 'decide')).toMatchObject({
      whenTrue: inserted.id,
      whenFalse: 'right',
    });
    expect(builderSteps(inserted.document).find(({ id }) => id === inserted.id)).toMatchObject({
      next: 'left',
    });
    expect(builderSteps(original).find(({ id }) => id === 'decide')).toMatchObject({
      whenTrue: 'left',
    });
  });

  it('rejects cycles, invalid ports, and links into compensation or out of Finish', () => {
    const document = branchedWorkflow();
    for (const edge of [
      { source: 'left', target: 'read', port: 'next' },
      { source: 'finish', target: 'read', port: 'next' },
      { source: 'decide', target: 'left', port: 'next' },
      { source: 'left', target: BUILDER_START_ID, port: 'next' },
    ]) {
      expect(builderConnectionAllowed(document, edge)).toBe(false);
      expect(connectBuilder(document, edge)).toBe(document);
    }
    expect(
      builderConnectionAllowed(document, { source: 'left', target: 'right', port: 'next' }),
    ).toBe(true);
  });

  it('offers only guaranteed upstream fields at a branch join', () => {
    const options = builderValueOptions(branchedWorkflow(), 'finish');
    expect(options.map(({ value }) => value)).toContainEqual({
      source: 'input',
      path: ['orderId'],
    });
    expect(options.map(({ value }) => value)).toContainEqual({
      source: 'stepOutput',
      stepId: 'read',
      path: ['account', 'id'],
    });
    expect(options.map(({ value }) => value)).not.toContainEqual({
      source: 'stepOutput',
      stepId: 'left',
      path: ['leftOnly'],
    });
  });

  it('preserves saved input references after deleting their source for later checks', () => {
    const document = removeBuilderBlocks(branchedWorkflow(), ['read']);
    expect(builderSteps(document).find(({ id }) => id === 'decide')?.condition).toMatchObject({
      left: { source: 'stepOutput', stepId: 'read', path: ['amount'] },
    });
    expect(builderObject(document.executable).startStepId).toBe('');
    expect(builderIssues(document)).toContainEqual({
      stepId: BUILDER_START_ID,
      message: 'Connect Start to a step.',
    });
  });

  it('leaves room for the wider capability cards when arranging connected steps', () => {
    const document = createBuilderDocument({
      irVersion: 3,
      startStepId: 'first',
      steps: [
        { id: 'first', kind: 'capabilityCall', next: 'second' },
        { id: 'second', kind: 'capabilityCall', next: 'done' },
        { id: 'done', kind: 'terminal', state: 'completed' },
      ],
    });
    expect(document.layout.second!.x - document.layout.first!.x).toBeGreaterThan(
      builderBlockWidth({ kind: 'capabilityCall' }),
    );
    expect(document.layout.done!.x - document.layout.second!.x).toBeGreaterThan(
      builderBlockWidth({ kind: 'capabilityCall' }),
    );
  });

  it('keeps layout and notes out of the executable definition', () => {
    const document = branchedWorkflow();
    const annotated = addBuilderBlock(document, 'note').document;
    const arranged = arrangeBuilder(annotated);
    expect(arranged.executable).toBe(document.executable);
    expect(arranged.notes).toHaveLength(1);
    expect(builderConnections(arranged)).toEqual(builderConnections(document));
  });

  it('duplicates settings with a new id and leaves the copy disconnected', () => {
    const original = updateBuilderStep(branchedWorkflow(), 'read', {
      retryPolicy: { maximumAttempts: 5 },
    });
    const duplicate = duplicateBuilderBlock(original, 'read');
    expect(duplicate).toBeDefined();
    expect(builderSteps(duplicate!.document).find(({ id }) => id === duplicate!.id)).toMatchObject({
      id: duplicate!.id,
      next: '',
      retryPolicy: { maximumAttempts: 5 },
    });
    expect(duplicate!.id).not.toBe('read');
    expect(builderSteps(original)).toHaveLength(5);
  });

  it('uses exact schema names from authorized capability projections, including references', () => {
    const capabilities = builderCapabilitiesFromProjection({
      capabilities: [
        {
          capabilityVersionId: 'read-v1',
          identity: { kind: 'openapi', serviceId: 'payments', operationId: 'readPayment' },
          fragment: {
            pathParameters: [{ name: 'payment_id', required: true, schema: { type: 'string' } }],
            operation: {
              summary: 'Read a payment',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['amount_cents'],
                      properties: { amount_cents: { type: 'integer' }, unused: { type: 'string' } },
                    },
                  },
                },
              },
              responses: {
                '200': { content: { 'application/json': { schema: { $ref: '#/Payment' } } } },
              },
            },
            references: {
              '#/Payment': {
                type: 'object',
                required: ['receipt'],
                properties: {
                  receipt: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      ],
    });
    expect(capabilities[0]).toMatchObject({
      label: 'payments / readPayment',
      inputSchema: {
        required: { payment_id: { type: 'string' }, amount_cents: { type: 'integer' } },
      },
      responseSchema: {
        required: { receipt: { type: 'object', required: { id: { type: 'string' } } } },
      },
    });
    expect(capabilities[0]?.inputSchema.required).not.toHaveProperty('unused');
  });
});
