import { describe, expect, it } from 'vite-plus/test';
import { reviseRepositoryContractDraft } from './repository-contract-draft.js';

describe('corrections to a generated contract draft', () => {
  it('handles escaped HTTP paths and array moves without losing neighboring entries', () => {
    const source = { paths: { '/things/{id}': { get: { summary: 'Before' } } }, values: [1, 2, 3] };
    const revised = reviseRepositoryContractDraft(source, {
      changes: [
        { op: 'set', path: '/paths/~1things~1{id}/get/summary', value: 'After' },
        { op: 'move', from: '/values/0', path: '/values/2' },
        { op: 'set', path: '/values/-', value: 4 },
      ],
    });
    expect(revised).toEqual({
      paths: { '/things/{id}': { get: { summary: 'After' } } },
      values: [2, 3, 1, 4],
    });
    expect(source.values).toEqual([1, 2, 3]);
    expect(source.paths['/things/{id}'].get.summary).toBe('Before');
  });

  it('keeps the previous draft when a later edit fails', () => {
    const source = { name: 'Original', values: [1] };
    expect(() =>
      reviseRepositoryContractDraft(source, {
        changes: [
          { op: 'set', path: '/name', value: 'Changed' },
          { op: 'set', path: '/values/50', value: 2 },
        ],
      }),
    ).toThrow('cannot leave gaps');
    expect(source).toEqual({ name: 'Original', values: [1] });
  });

  it('does not follow object prototypes or change global object properties', () => {
    expect(() =>
      reviseRepositoryContractDraft(
        {},
        {
          changes: [{ op: 'set', path: '/__proto__/polluted', value: true }],
        },
      ),
    ).toThrow('path does not exist');
    const revised = reviseRepositoryContractDraft(
      {},
      {
        changes: [{ op: 'set', path: '/__proto__', value: { polluted: true } }],
      },
    );
    expect(Object.hasOwn(revised as object, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
