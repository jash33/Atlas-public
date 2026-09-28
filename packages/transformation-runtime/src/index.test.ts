import { describe, expect, it } from 'vitest';

import { TRANSFORMATION_LIMITS, type TransformationExpression } from '@atlas/workflow-ir';

import { evaluateTransformationArguments, TransformationEvaluationError } from './index.js';

describe('transformation evaluator', () => {
  it('renames, nests, converts cents, and uppercases a prior activity result', () => {
    const arguments_: Record<string, TransformationExpression> = {
      invoice: {
        kind: 'object',
        fields: {
          reference: {
            kind: 'call',
            function: 'uppercase',
            arguments: [{ source: 'stepOutput', stepId: 'load-payment', path: ['invoiceId'] }],
          },
          amount: {
            kind: 'object',
            fields: {
              currency: {
                kind: 'call',
                function: 'uppercase',
                arguments: [{ source: 'stepOutput', stepId: 'load-payment', path: ['currency'] }],
              },
              units: {
                kind: 'call',
                function: 'divide',
                arguments: [
                  { source: 'stepOutput', stepId: 'load-payment', path: ['amountCents'] },
                  { source: 'literal', value: 100 },
                ],
              },
            },
          },
        },
      },
    };

    expect(
      evaluateTransformationArguments(arguments_, {
        input: {},
        stepOutputs: {
          'load-payment': { invoiceId: 'inv_1', currency: 'usd', amountCents: 1250 },
        },
      }),
    ).toEqual({
      invoice: { reference: 'INV_1', amount: { currency: 'USD', units: 12.5 } },
    });
  });

  it.each([
    {
      name: 'missing paths',
      expression: { source: 'input', path: ['missing'] } satisfies TransformationExpression,
      code: 'TRANSFORM_MISSING_PATH',
    },
    {
      name: 'division by zero',
      expression: {
        kind: 'call',
        function: 'divide',
        arguments: [
          { source: 'literal', value: 1 },
          { source: 'literal', value: 0 },
        ],
      } satisfies TransformationExpression,
      code: 'TRANSFORM_DIVIDE_BY_ZERO',
    },
    {
      name: 'policy violations',
      expression: {
        kind: 'call',
        function: 'uppercase',
        arguments: [{ source: 'literal', value: 1 }],
      } satisfies TransformationExpression,
      code: 'TRANSFORM_POLICY_VIOLATION',
    },
  ] as const)('returns a stable error for $name', ({ expression, code }) => {
    expect(() => evaluateTransformationArguments({ value: expression }, emptyContext())).toThrow(
      expect.objectContaining<Partial<TransformationEvaluationError>>({ code }),
    );
  });

  it('enforces the materialized activity input limit', () => {
    expect(() =>
      evaluateTransformationArguments(
        {
          value: {
            source: 'literal',
            value: 'x'.repeat(TRANSFORMATION_LIMITS.maxOutputBytes + 1),
          },
        },
        emptyContext(),
      ),
    ).toThrow(
      expect.objectContaining<Partial<TransformationEvaluationError>>({
        code: 'TRANSFORM_OUTPUT_SIZE_LIMIT',
      }),
    );
  });

  it('supports bounded maps, lexical variables, defaults, exists, and lazy conditionals', () => {
    expect(
      evaluateTransformationArguments(
        {
          values: {
            kind: 'map',
            items: { source: 'input', path: ['items'] },
            itemVariable: 'item',
            maxItems: 2,
            body: {
              kind: 'call',
              function: 'default',
              arguments: [
                { kind: 'variable', name: 'item', path: ['name'] },
                { source: 'literal', value: 'UNKNOWN' },
              ],
            },
          },
          hasOptional: {
            kind: 'call',
            function: 'exists',
            arguments: [{ source: 'input', path: ['optional'] }],
          },
          selected: {
            kind: 'conditional',
            condition: { source: 'literal', value: true },
            then: { source: 'literal', value: 'yes' },
            else: { source: 'input', path: ['never-read'] },
          },
        },
        { input: { items: [{ name: 'FIRST' }, {}] }, stepOutputs: {} },
      ),
    ).toEqual({ values: ['FIRST', 'UNKNOWN'], hasOptional: false, selected: 'yes' });
  });
});

function emptyContext() {
  return { input: {}, stepOutputs: {} } as const;
}
