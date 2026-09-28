import { describe, expect, it } from 'vite-plus/test';

import type { ChangeDiscoveryDetail } from './changes.js';
import { presentChangeDiscoveries, treeMatchesFilter } from './presentation.js';

const discoveredAt = '2026-08-15T18:00:00.000Z';

function discovered(
  overrides: Partial<ChangeDiscoveryDetail> &
    Pick<ChangeDiscoveryDetail, 'discoveryId' | 'serviceId' | 'changes'>,
): ChangeDiscoveryDetail {
  return {
    trigger: 'repository-push',
    discoveredAt,
    ...overrides,
  };
}

describe('presentChangeDiscoveries', () => {
  it('keeps compatible-only discoveries on the change card list', () => {
    const details = [
      discovered({
        discoveryId: 'd-compatible',
        serviceId: 'billing',
        changes: [
          {
            fromCapabilityVersionId: 'cap-old',
            toCapabilityVersionId: 'cap-new',
            classification: 'compatible',
            fieldChanges: [],
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          },
        ],
      }),
    ];

    const presented = presentChangeDiscoveries(details);

    expect(presented.trees).toEqual([]);
    expect(presented.listItems).toEqual([
      expect.objectContaining({
        discoveryId: 'd-compatible',
        evidenceKind: 'discovered-version',
        classification: 'compatible',
      }),
    ]);
  });

  it('replaces a not-fully-compatible rediscovery with its blast-radius tree', () => {
    const details = [
      discovered({
        discoveryId: 'd-breaking',
        serviceId: 'billing',
        changes: [
          {
            fromCapabilityVersionId: 'cap-old',
            toCapabilityVersionId: 'cap-new',
            classification: 'breaking',
            fieldChanges: [],
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          },
        ],
      }),
    ];

    const presented = presentChangeDiscoveries(details);

    expect(presented.trees).toEqual([
      {
        discoveryId: 'd-breaking',
        trigger: 'repository-push',
        discoveredAt,
        classifications: ['breaking'],
        tree: {
          serviceId: 'billing',
          coverage: 'unmapped',
          capabilityVersions: [
            {
              capabilityVersionId: 'cap-old',
              coverage: 'unmapped',
              workflowVersions: [
                { workflowVersionId: 'pay@1', coverage: 'unmapped', steps: ['charge'] },
              ],
            },
          ],
        },
      },
    ]);
    expect(presented.listItems).toEqual([]);
  });

  it('colors mixed version-diff evidence as mapped and unmapped coverage', () => {
    const presented = presentChangeDiscoveries([
      discovered({
        discoveryId: 'd-mixed-coverage',
        serviceId: 'billing',
        changes: [
          {
            fromCapabilityVersionId: 'cap-hold',
            toCapabilityVersionId: 'cap-hold-new',
            classification: 'conditional',
            fieldChanges: [
              { kind: 'renamed', path: '/request/amountCents', classification: 'conditional' },
            ],
            affectedWorkflows: [{ workflowVersionId: 'invoice@3', stepId: 'issue' }],
          },
          {
            fromCapabilityVersionId: 'cap-lost',
            toCapabilityVersionId: 'cap-lost-new',
            classification: 'breaking',
            fieldChanges: [
              { kind: 'added-required', path: '/request/currency', classification: 'breaking' },
            ],
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          },
        ],
      }),
    ]);

    expect(presented.trees[0]?.tree).toEqual({
      serviceId: 'billing',
      coverage: 'unmapped',
      capabilityVersions: [
        {
          capabilityVersionId: 'cap-hold',
          coverage: 'mapped',
          workflowVersions: [
            { workflowVersionId: 'invoice@3', coverage: 'mapped', steps: ['issue'] },
          ],
        },
        {
          capabilityVersionId: 'cap-lost',
          coverage: 'unmapped',
          workflowVersions: [
            { workflowVersionId: 'pay@1', coverage: 'unmapped', steps: ['charge'] },
          ],
        },
      ],
    });
  });

  it('keeps runtime-rejection items as list cards beside a source-update tree', () => {
    const details = [
      discovered({
        discoveryId: 'd-mixed',
        serviceId: 'billing',
        changes: [
          {
            fromCapabilityVersionId: 'cap-old',
            toCapabilityVersionId: 'cap-new',
            classification: 'conditional',
            fieldChanges: [],
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          },
        ],
        runtimeSignals: [
          {
            environmentId: 'production',
            capabilityVersionId: 'runtime-pin',
            stepId: 'read-payment',
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'read-payment' }],
          },
        ],
      }),
    ];

    const presented = presentChangeDiscoveries(details);

    expect(presented.trees).toHaveLength(1);
    expect(presented.trees[0]?.tree.serviceId).toBe('billing');
    expect(presented.listItems).toEqual([
      expect.objectContaining({
        evidenceKind: 'runtime-rejection',
        classification: 'conditional',
        runtimeStepId: 'read-payment',
      }),
    ]);
  });

  it('does not open a tree for runtime-only discoveries', () => {
    const presented = presentChangeDiscoveries([
      discovered({
        discoveryId: 'd-runtime',
        serviceId: 'payments',
        trigger: 'run-drift',
        changes: [],
        runtimeSignals: [
          {
            environmentId: 'production',
            capabilityVersionId: 'runtime-pin',
            stepId: 'read-payment',
            affectedWorkflows: [],
          },
        ],
      }),
    ]);

    expect(presented.trees).toEqual([]);
    expect(presented.listItems).toEqual([
      expect.objectContaining({
        evidenceKind: 'runtime-rejection',
        classification: 'conditional',
      }),
    ]);
  });

  it('paints a verified potential-coverage hint as orange on the change tree', () => {
    const presented = presentChangeDiscoveries([
      discovered({
        discoveryId: 'd-potential',
        serviceId: 'billing',
        changes: [
          {
            fromCapabilityVersionId: 'cap-old',
            toCapabilityVersionId: 'cap-new',
            classification: 'breaking',
            fieldChanges: [
              { kind: 'removed', path: '/request/currency', classification: 'breaking' },
            ],
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
            potentialCoverage: { operationId: 'chargeV2', fieldPath: '/request/currencyCode' },
          },
        ],
      }),
    ]);

    expect(presented.trees[0]?.tree.coverage).toBe('potential');
    expect(presented.trees[0]?.tree.capabilityVersions[0]?.coverage).toBe('potential');
  });

  it('keeps a breaking change red when the payload has no verified hint', () => {
    const presented = presentChangeDiscoveries([
      discovered({
        discoveryId: 'd-unmapped',
        serviceId: 'billing',
        changes: [
          {
            fromCapabilityVersionId: 'cap-old',
            toCapabilityVersionId: 'cap-new',
            classification: 'breaking',
            fieldChanges: [],
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          },
        ],
      }),
    ]);

    expect(presented.trees[0]?.tree.coverage).toBe('unmapped');
  });

  it('hides blast-radius trees when their declared-contract classification does not match', () => {
    const { trees } = presentChangeDiscoveries([
      discovered({
        discoveryId: 'd-breaking',
        serviceId: 'billing',
        changes: [
          {
            fromCapabilityVersionId: 'cap-old',
            toCapabilityVersionId: 'cap-new',
            classification: 'breaking',
            fieldChanges: [],
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          },
        ],
      }),
    ]);

    expect(treeMatchesFilter(trees[0]!, 'all')).toBe(true);
    expect(treeMatchesFilter(trees[0]!, 'breaking')).toBe(true);
    expect(treeMatchesFilter(trees[0]!, 'metadata')).toBe(false);
  });
});
