import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vite-plus/test';

import {
  projectDiscoveredSource,
  suggestPotentialCoverage,
  type PotentialCoveragePlanner,
} from './potential-coverage.js';

const unmapped = {
  fromCapabilityVersionId: 'cap-old',
  fieldChanges: [{ kind: 'removed', path: '/request/currency' }],
};

const discoveredSource = [
  {
    operationId: 'chargeV2',
    fieldPaths: ['/request/amountCents', '/request/currencyCode'],
  },
  {
    operationId: 'refund',
    fieldPaths: ['/request/invoiceId'],
  },
];

function planner(
  impl: NonNullable<PotentialCoveragePlanner['suggestPotentialCoverage']>,
): PotentialCoveragePlanner {
  return { suggestPotentialCoverage: impl };
}

describe('suggestPotentialCoverage', () => {
  it('returns no suggestions when the planner model is unavailable', async () => {
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
      }),
    ).resolves.toEqual([]);
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
        plannerModel: {},
      }),
    ).resolves.toEqual([]);
  });

  it('returns no suggestions when the model refuses or returns empty', async () => {
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
        plannerModel: planner(async () => ({ kind: 'refusal', suggestions: [] })),
      }),
    ).resolves.toEqual([]);
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
        plannerModel: planner(async () => ({ kind: 'suggestion', suggestions: [] })),
      }),
    ).resolves.toEqual([]);
  });

  it('returns no suggestions when the model throws', async () => {
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
        plannerModel: planner(async () => {
          throw new Error('model unavailable');
        }),
      }),
    ).resolves.toEqual([]);
  });

  it('accepts a suggestion that names a real discovered operation and field', async () => {
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
        plannerModel: planner(async () => ({
          kind: 'suggestion',
          suggestions: [
            {
              fromCapabilityVersionId: 'cap-old',
              operationId: 'chargeV2',
              fieldPath: '/request/currencyCode',
            },
          ],
        })),
      }),
    ).resolves.toEqual([
      {
        fromCapabilityVersionId: 'cap-old',
        operationId: 'chargeV2',
        fieldPath: '/request/currencyCode',
      },
    ]);
  });

  it('accepts an operation-only suggestion when that operation exists in the source', async () => {
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
        plannerModel: planner(async () => ({
          kind: 'suggestion',
          suggestions: [
            {
              fromCapabilityVersionId: 'cap-old',
              operationId: 'refund',
              fieldPath: null,
            },
          ],
        })),
      }),
    ).resolves.toEqual([{ fromCapabilityVersionId: 'cap-old', operationId: 'refund' }]);
  });

  it('drops invented operation ids and field paths', async () => {
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
        plannerModel: planner(async () => ({
          kind: 'suggestion',
          suggestions: [
            {
              fromCapabilityVersionId: 'cap-old',
              operationId: 'inventedCharge',
              fieldPath: '/request/currencyCode',
            },
            {
              fromCapabilityVersionId: 'cap-old',
              operationId: 'chargeV2',
              fieldPath: '/request/inventedField',
            },
          ],
        })),
      }),
    ).resolves.toEqual([]);
  });

  it('drops suggestions for contracts that were not supplied as unmapped', async () => {
    await expect(
      suggestPotentialCoverage({
        unmappedContracts: [unmapped],
        discoveredSource,
        plannerModel: planner(async () => ({
          kind: 'suggestion',
          suggestions: [
            {
              fromCapabilityVersionId: 'cap-mapped',
              operationId: 'chargeV2',
              fieldPath: '/request/currencyCode',
            },
          ],
        })),
      }),
    ).resolves.toEqual([]);
  });

  it('scopes the model to the supplied discovered-source projection', async () => {
    let planningInput: unknown;
    await suggestPotentialCoverage({
      unmappedContracts: [unmapped],
      discoveredSource,
      plannerModel: planner(async (input) => {
        planningInput = input;
        return { kind: 'refusal', suggestions: [] };
      }),
    });

    expect(planningInput).toEqual({
      unmappedContracts: [unmapped],
      discoveredSource,
    });
  });
});

describe('suggestion module isolation', () => {
  it('does not import quarantine, pin, or approval writers', async () => {
    const source = await readFile(new URL('./potential-coverage.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/quarantine|workflow-approval|workflow-quarantine|approved bundle/i);
  });
});

describe('projectDiscoveredSource', () => {
  it('lists exact operation ids and request field paths from discovered fragments', () => {
    expect(
      projectDiscoveredSource([
        {
          identity: { operationId: 'chargeV2' },
          fragment: {
            operation: {
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        amountCents: { type: 'number' },
                        currencyCode: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ]),
    ).toEqual([
      {
        operationId: 'chargeV2',
        fieldPaths: [
          '/amountCents',
          '/request/amountCents',
          '/currencyCode',
          '/request/currencyCode',
        ],
      },
    ]);
  });
});
