import { describe, expect, it } from 'vite-plus/test';

import { validateTransformation, type TransformationSchema } from './transformation-validation.js';

const string = (classification?: TransformationSchema['classification']): TransformationSchema => ({
  type: 'string',
  ...(classification ? { classification } : {}),
});

const context = {
  workflowInput: {
    type: 'object' as const,
    required: {
      customer: {
        type: 'object' as const,
        required: { name: string(), nickname: string() },
        optional: { middleName: string() },
      },
      amounts: { type: 'array' as const, items: { type: 'number' as const } },
      token: string('secret'),
    },
  },
  stepOutputs: new Map([
    [
      'lookup',
      {
        type: 'object' as const,
        required: {
          invoice: {
            type: 'object' as const,
            required: { id: string('confidential') },
          },
        },
      },
    ],
  ]),
};

describe('validateTransformation', () => {
  it('resolves nested paths and reports missing paths with a stable code', () => {
    expect(
      validateTransformation(
        { source: 'stepOutput', stepId: 'lookup', path: ['invoice', 'missingId'] },
        string(),
        context,
        'steps.send.arguments.invoiceId',
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'TRANSFORM_SOURCE_PATH_NOT_FOUND',
        path: 'steps.send.arguments.invoiceId',
      }),
    ]);
  });

  it('checks constructed nested objects, arrays, and destination required fields', () => {
    const destination: TransformationSchema = {
      type: 'object',
      required: {
        renamed: string(),
        tags: { type: 'array', items: string() },
        requiredButMissing: string(),
      },
    };
    const diagnostics = validateTransformation(
      {
        kind: 'object',
        fields: {
          renamed: { source: 'input', path: ['customer', 'name'] },
          tags: { kind: 'array', items: [{ source: 'literal', value: 42 }] },
        },
      },
      destination,
      context,
      'steps.send.arguments.payload',
    );

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'TRANSFORM_REQUIRED_FIELD_MISSING',
          path: 'steps.send.arguments.payload.requiredButMissing',
        }),
        expect.objectContaining({
          code: 'TRANSFORM_TYPE_MISMATCH',
          path: 'steps.send.arguments.payload.tags[]',
        }),
      ]),
    );

    expect(
      validateTransformation(
        {
          kind: 'object',
          fields: { optionalCount: { source: 'literal', value: 'not-a-number' } },
        },
        {
          type: 'object',
          required: {},
          optional: { optionalCount: { type: 'number' } },
        },
        context,
        'steps.send.arguments.payload',
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'TRANSFORM_TYPE_MISMATCH',
        path: 'steps.send.arguments.payload.optionalCount',
      }),
    ]);
  });

  it('types maps, numeric transforms, string transforms, and conditionals without coercion', () => {
    const valid = validateTransformation(
      {
        kind: 'map',
        items: { source: 'input', path: ['amounts'] },
        itemVariable: 'amount',
        maxItems: 20,
        body: {
          kind: 'call',
          function: 'multiply',
          arguments: [
            { kind: 'variable', name: 'amount', path: [] },
            { source: 'literal', value: 100 },
          ],
        },
      },
      { type: 'array', items: { type: 'number' } },
      context,
      'steps.send.arguments.cents',
    );
    expect(valid).toEqual([]);

    expect(
      validateTransformation(
        {
          kind: 'call',
          function: 'uppercase',
          arguments: [{ source: 'input', path: ['amounts'] }],
        },
        string(),
        context,
        'steps.send.arguments.label',
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'TRANSFORM_BUILTIN_ARGUMENT_TYPE',
        sourceType: 'array',
        destinationType: 'string',
      }),
    ]);

    expect(
      validateTransformation(
        {
          kind: 'conditional',
          condition: { source: 'literal', value: true },
          then: {
            kind: 'object',
            fields: { id: { source: 'literal', value: 'present' } },
          },
          else: { kind: 'object', fields: {} },
        },
        { type: 'object', required: { id: string() } },
        context,
        'steps.send.arguments.payload',
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'TRANSFORM_REQUIRED_FIELD_MISSING',
        path: 'steps.send.arguments.payload.id',
      }),
    ]);

    expect(
      validateTransformation(
        {
          kind: 'conditional',
          condition: { source: 'literal', value: true },
          then: { kind: 'array', items: [{ source: 'literal', value: 1 }] },
          else: { kind: 'array', items: [{ source: 'literal', value: 'one' }] },
        },
        { type: 'array', items: { type: 'number' } },
        context,
        'steps.send.arguments.values',
      ),
    ).toEqual([expect.objectContaining({ code: 'TRANSFORM_BRANCH_TYPE_MISMATCH' })]);

    expect(
      validateTransformation(
        {
          kind: 'conditional',
          condition: { source: 'literal', value: true },
          then: { source: 'literal', value: 1 },
          else: { source: 'literal', value: 1.5 },
        },
        { type: 'integer' },
        context,
        'steps.send.arguments.count',
      ),
    ).toEqual([expect.objectContaining({ code: 'TRANSFORM_TYPE_MISMATCH' })]);
  });

  it('does not silently materialize optional, missing, or nullable values', () => {
    expect(
      validateTransformation(
        { source: 'input', path: ['customer', 'middleName'] },
        string(),
        context,
        'steps.send.arguments.middleName',
      ),
    ).toEqual([expect.objectContaining({ code: 'TRANSFORM_OPTIONAL_VALUE_NOT_MATERIALIZED' })]);

    expect(
      validateTransformation(
        {
          kind: 'call',
          function: 'default',
          arguments: [
            { source: 'input', path: ['customer', 'middleName'] },
            { source: 'literal', value: '' },
          ],
        },
        string(),
        context,
        'steps.send.arguments.middleName',
      ),
    ).toEqual([]);

    expect(
      validateTransformation(
        { source: 'literal', value: null },
        string(),
        context,
        'steps.send.arguments.name',
      ),
    ).toEqual([expect.objectContaining({ code: 'TRANSFORM_NULLABILITY_MISMATCH' })]);

    expect(
      validateTransformation(
        { source: 'input', path: ['maybeName'] },
        string(),
        {
          ...context,
          workflowInput: {
            type: 'object',
            required: { maybeName: { type: 'string', nullable: true } },
          },
        },
        'steps.send.arguments.name',
      ),
    ).toEqual([expect.objectContaining({ code: 'TRANSFORM_NULLABILITY_MISMATCH' })]);

    expect(
      validateTransformation(
        { source: 'literal', value: null },
        { type: 'string', nullable: true },
        context,
        'steps.send.arguments.name',
      ),
    ).toEqual([]);
  });

  it('propagates classification and fails secret exposure and classification downgrade closed', () => {
    expect(
      validateTransformation(
        {
          kind: 'call',
          function: 'concat',
          arguments: [
            { source: 'literal', value: 'Bearer ' },
            { source: 'input', path: ['token'] },
          ],
        },
        string('internal'),
        context,
        'steps.call.arguments.authorization',
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'TRANSFORM_CLASSIFICATION_DOWNGRADE',
        sourceClassification: 'secret',
        destinationClassification: 'internal',
      }),
    ]);

    expect(
      validateTransformation(
        { source: 'input', path: ['token'] },
        string('secret'),
        { ...context, destinationKind: 'notify' },
        'steps.log.arguments.message',
      ),
    ).toEqual([expect.objectContaining({ code: 'TRANSFORM_SECRET_EXPOSURE' })]);

    expect(
      validateTransformation(
        { source: 'input', path: ['securePayload'] },
        {
          type: 'object',
          required: { publicLabel: string(), credential: string('internal') },
        },
        {
          ...context,
          workflowInput: {
            type: 'object',
            required: {
              securePayload: {
                type: 'object',
                required: {
                  publicLabel: string(),
                  credential: string('secret'),
                },
              },
            },
          },
        },
        'steps.call.arguments.payload',
      ),
    ).toEqual([
      expect.objectContaining({
        code: 'TRANSFORM_CLASSIFICATION_DOWNGRADE',
        path: 'steps.call.arguments.payload.credential',
      }),
    ]);

    expect(
      validateTransformation(
        {
          kind: 'call',
          function: 'exists',
          arguments: [{ source: 'input', path: ['token'] }],
        },
        { type: 'boolean', classification: 'internal' },
        context,
        'steps.call.arguments.hasToken',
      ),
    ).toEqual([expect.objectContaining({ code: 'TRANSFORM_CLASSIFICATION_DOWNGRADE' })]);
  });
});
