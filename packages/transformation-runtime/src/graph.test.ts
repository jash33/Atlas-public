import { describe, expect, it } from 'vitest';

import { evaluateGraphCondition, evaluateTransformationExpression } from './index.js';

const context = { input: { count: 3 }, stepOutputs: {} };

describe('graph expressions', () => {
  it('treats a missing optional path as false for exists', () => {
    expect(
      evaluateGraphCondition(
        { left: { source: 'input', path: ['missing'] }, operator: 'exists' },
        context,
      ),
    ).toBe(false);
    expect(
      evaluateGraphCondition(
        { left: { source: 'literal', value: null }, operator: 'exists' },
        context,
      ),
    ).toBe(true);
  });

  it('compares objects without depending on key order', () => {
    expect(
      evaluateGraphCondition(
        {
          left: { source: 'literal', value: { a: 1, b: [2] } },
          operator: 'equals',
          right: { source: 'literal', value: { b: [2], a: 1 } },
        },
        context,
      ),
    ).toBe(true);
  });

  it('uses strict finite numeric comparisons', () => {
    expect(
      evaluateGraphCondition(
        {
          left: { source: 'input', path: ['count'] },
          operator: 'greaterThan',
          right: { source: 'literal', value: 2 },
        },
        context,
      ),
    ).toBe(true);
    expect(() =>
      evaluateGraphCondition(
        {
          left: { source: 'literal', value: '3' },
          operator: 'lessThan',
          right: { source: 'literal', value: 4 },
        },
        context,
      ),
    ).toThrow('finite number');
  });

  it('uses the existing bounded evaluator for explicit Finish output', () => {
    expect(
      evaluateTransformationExpression(
        { kind: 'object', fields: { result: { source: 'input', path: ['count'] } } },
        context,
      ),
    ).toEqual({ result: 3 });
    expect(() =>
      evaluateTransformationExpression({ source: 'input', path: ['missing'] }, context),
    ).toThrow('no value');
  });
});
