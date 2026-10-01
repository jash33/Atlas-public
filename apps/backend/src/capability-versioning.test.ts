import { describe, expect, it } from 'vitest';

import type { JsonObject } from './capability-documents.js';
import { capabilitySafetyChanges, compatibilityDiff } from './capability-versioning.js';

function fragment(): JsonObject {
  return {
    method: 'post',
    path: '/payments',
    operation: {
      operationId: 'createPayment',
      requestBody: { schema: { $ref: '#/components/schemas/Payment' } },
    },
    references: {
      '#/components/schemas/Payment': {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  };
}

function paymentSchema(value: JsonObject): JsonObject {
  return (value.references as JsonObject)['#/components/schemas/Payment'] as JsonObject;
}

describe('declared-contract compatibility', () => {
  it.each([
    [
      'removed field',
      (next: JsonObject) =>
        Reflect.deleteProperty(paymentSchema(next).properties as JsonObject, 'id'),
    ],
    [
      'retyped field',
      (next: JsonObject) =>
        ((paymentSchema(next).properties as JsonObject).id = { type: 'number' }),
    ],
    [
      'new required field',
      (next: JsonObject) => {
        (paymentSchema(next).properties as JsonObject).currency = { type: 'string' };
        paymentSchema(next).required = ['id', 'currency'];
      },
    ],
  ])('classifies a %s as an incompatible declared contract', (_name, mutate) => {
    const previous = fragment();
    const next = structuredClone(previous);
    mutate(next);
    expect(compatibilityDiff(previous, next).classification).toBe('breaking');
  });

  it('classifies an optional field addition as a compatible declared contract', () => {
    const previous = fragment();
    const next = structuredClone(previous);
    (paymentSchema(next).properties as JsonObject).receiptUrl = { type: 'string' };
    expect(compatibilityDiff(previous, next).classification).toBe('compatible');
  });

  it('lets structure determine the result when compatible additions include metadata edits', () => {
    const previous = fragment();
    const next = structuredClone(previous);
    (previous.operation as JsonObject).summary = 'Old summary';
    (next.operation as JsonObject).summary = 'New summary';
    (paymentSchema(next).properties as JsonObject).receiptUrl = { type: 'string' };
    expect(compatibilityDiff(previous, next).classification).toBe('compatible');
  });

  it('distinguishes annotation-only edits as metadata', () => {
    const previous = fragment();
    const next = structuredClone(previous);
    (next.operation as JsonObject).summary = 'Create a payment';
    paymentSchema(next).description = 'A declared payment payload';
    expect(compatibilityDiff(previous, next).classification).toBe('metadata');
  });

  it.each(['title', 'description', 'summary', 'tags'])(
    'does not mistake a removed field named %s for an annotation',
    (fieldName) => {
      const previous = fragment();
      const next = structuredClone(previous);
      (paymentSchema(previous).properties as JsonObject)[fieldName] = { type: 'string' };
      expect(compatibilityDiff(previous, next).classification).toBe('breaking');
    },
  );

  it.each(['const', 'enum'] as const)(
    'treats changed literal object data under %s as breaking',
    (keyword) => {
      const previous = fragment();
      const literal = { description: 'old', nested: { title: 'old', tags: ['old'] } };
      (paymentSchema(previous).properties as JsonObject).payload = {
        type: 'object',
        [keyword]: keyword === 'enum' ? [literal] : literal,
      };
      const next = structuredClone(previous);
      const changed = { description: 'new', nested: { title: 'new', tags: ['new'] } };
      ((paymentSchema(next).properties as JsonObject).payload as JsonObject)[keyword] =
        keyword === 'enum' ? [changed] : changed;
      const diff = compatibilityDiff(previous, next);
      expect(diff.classification).toBe('breaking');
      expect(diff.changes.some((path) => path.includes(`/${keyword}`))).toBe(true);
    },
  );

  it('preserves literal default data for structural review', () => {
    const previous = fragment();
    paymentSchema(previous).default = { description: 'old' };
    const next = structuredClone(previous);
    paymentSchema(next).default = { description: 'new' };
    expect(compatibilityDiff(previous, next).classification).toBe('conditional');
  });

  it.each(['const', 'enum', 'default', 'properties'])(
    'still strips schema annotations for a property named %s',
    (name) => {
      const previous = fragment();
      (paymentSchema(previous).properties as JsonObject)[name] = {
        type: 'string',
        description: 'old',
      };
      const next = structuredClone(previous);
      ((paymentSchema(next).properties as JsonObject)[name] as JsonObject).description = 'new';
      expect(compatibilityDiff(previous, next).classification).toBe('metadata');
    },
  );

  it('compares object enum values by content when another optional field is added', () => {
    const previous = fragment();
    (paymentSchema(previous).properties as JsonObject).payload = {
      enum: [{ description: 'unchanged', title: 'same' }],
    };
    const next = structuredClone(previous);
    ((paymentSchema(next).properties as JsonObject).payload as JsonObject).enum = [
      { title: 'same', description: 'unchanged' },
    ];
    (paymentSchema(next).properties as JsonObject).optional = { type: 'string' };
    expect(compatibilityDiff(previous, next).classification).toBe('compatible');
  });

  it('leaves ambiguous structural additions for review', () => {
    const previous = fragment();
    const next = structuredClone(previous);
    (next.operation as JsonObject).security = [{ oauth: ['payments:write'] }];
    expect(compatibilityDiff(previous, next).classification).toBe('conditional');
  });

  it('leaves an unrecognized referenced-schema constraint for review', () => {
    const previous = fragment();
    const next = structuredClone(previous);
    ((paymentSchema(next).properties as JsonObject).id as JsonObject).minLength = 1;
    expect(compatibilityDiff(previous, next).classification).toBe('conditional');
  });

  it('returns structural evidence only and makes no source-code, deployment, or runtime claim', () => {
    const result = compatibilityDiff(fragment(), fragment());
    expect(Object.keys(result)).toEqual(['classification', 'changes', 'fieldChanges']);
  });
});

describe('capability safety compatibility', () => {
  const previous = {
    idempotencyField: 'idempotencyKey',
    compensatedByIdentityId: 'cancel-payment',
    irreversibleAfter: false,
  };

  it('treats removed safety promises and new irreversible behavior as breaking', () => {
    expect(
      capabilitySafetyChanges(previous, {
        idempotencyField: null,
        compensatedByIdentityId: null,
        irreversibleAfter: true,
      }),
    ).toEqual([
      expect.objectContaining({ kind: 'idempotency-changed', classification: 'breaking' }),
      expect.objectContaining({ kind: 'compensation-changed', classification: 'breaking' }),
      expect.objectContaining({ kind: 'irreversibility-changed', classification: 'breaking' }),
    ]);
  });

  it('treats added safety promises and reversible behavior as compatible', () => {
    expect(
      capabilitySafetyChanges(
        {
          idempotencyField: null,
          compensatedByIdentityId: null,
          irreversibleAfter: true,
        },
        previous,
      ).every((change) => change.classification === 'compatible'),
    ).toBe(true);
  });
});
