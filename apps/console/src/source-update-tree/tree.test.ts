import { describe, expect, it } from 'vite-plus/test';

import { buildSourceUpdateTree, type SourceUpdateChangeInput } from './tree.js';

function change(
  overrides: Partial<SourceUpdateChangeInput> &
    Pick<SourceUpdateChangeInput, 'fromCapabilityVersionId' | 'classification'>,
): SourceUpdateChangeInput {
  return {
    affectedWorkflows: [],
    ...overrides,
  };
}

describe('buildSourceUpdateTree', () => {
  it('returns no tree when every change is compatible', () => {
    expect(
      buildSourceUpdateTree({
        serviceId: 'billing',
        changes: [
          change({
            fromCapabilityVersionId: 'cap-old',
            classification: 'compatible',
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          }),
        ],
      }),
    ).toBeNull();
  });

  it('returns no tree when there are no non-compatible changes', () => {
    expect(buildSourceUpdateTree({ serviceId: 'billing', changes: [] })).toBeNull();
  });

  it('opens a tree when a change is breaking', () => {
    expect(
      buildSourceUpdateTree({
        serviceId: 'billing',
        changes: [
          change({
            fromCapabilityVersionId: 'cap-old',
            classification: 'breaking',
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          }),
        ],
      }),
    ).toEqual({
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
    });
  });

  it('opens a tree when a change is conditional', () => {
    expect(
      buildSourceUpdateTree({
        serviceId: 'billing',
        changes: [
          change({
            fromCapabilityVersionId: 'cap-old',
            classification: 'conditional',
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          }),
        ],
      }),
    ).toEqual({
      serviceId: 'billing',
      coverage: 'mapped',
      capabilityVersions: [
        {
          capabilityVersionId: 'cap-old',
          coverage: 'mapped',
          workflowVersions: [{ workflowVersionId: 'pay@1', coverage: 'mapped', steps: ['charge'] }],
        },
      ],
    });
  });

  it('marks a conditional annotated remap as mapped', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-old',
          toCapabilityVersionId: 'cap-renamed',
          classification: 'conditional',
          fieldChanges: [
            {
              kind: 'renamed',
              path: '/request/amountCents',
              fromPath: '/request/amount',
              classification: 'conditional',
            },
          ],
          affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
        }),
      ],
    });

    expect(tree?.coverage).toBe('mapped');
    expect(tree?.capabilityVersions[0]?.coverage).toBe('mapped');
    expect(tree?.capabilityVersions[0]?.workflowVersions[0]?.coverage).toBe('mapped');
  });

  it('marks a gone operation as unmapped', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-gone',
          toCapabilityVersionId: null,
          classification: 'breaking',
          fieldChanges: [],
          affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
        }),
      ],
    });

    expect(tree?.coverage).toBe('unmapped');
    expect(tree?.capabilityVersions[0]?.coverage).toBe('unmapped');
    expect(tree?.capabilityVersions[0]?.workflowVersions[0]?.coverage).toBe('unmapped');
  });

  it('marks required-field mapping loss as unmapped', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-old',
          toCapabilityVersionId: 'cap-new',
          classification: 'breaking',
          fieldChanges: [
            { kind: 'removed', path: '/request/currency', classification: 'breaking' },
            { kind: 'added-required', path: '/request/currencyCode', classification: 'breaking' },
            { kind: 'retyped', path: '/request/amount', classification: 'breaking' },
          ],
          affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
        }),
      ],
    });

    expect(tree?.capabilityVersions[0]?.coverage).toBe('unmapped');
    expect(tree?.capabilityVersions[0]?.workflowVersions[0]?.coverage).toBe('unmapped');
  });

  it('keeps optional additions mapped when required fields still map', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-optional',
          toCapabilityVersionId: 'cap-optional-new',
          classification: 'compatible',
          fieldChanges: [
            { kind: 'added-optional', path: '/request/receiptUrl', classification: 'compatible' },
          ],
          affectedWorkflows: [{ workflowVersionId: 'refund@2', stepId: 'credit' }],
        }),
        change({
          fromCapabilityVersionId: 'cap-breaking',
          toCapabilityVersionId: 'cap-breaking-new',
          classification: 'breaking',
          fieldChanges: [
            { kind: 'removed', path: '/request/currency', classification: 'breaking' },
          ],
          affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
        }),
      ],
    });

    expect(
      tree?.capabilityVersions.find((node) => node.capabilityVersionId === 'cap-optional'),
    ).toMatchObject({ coverage: 'mapped' });
    expect(
      tree?.capabilityVersions.find((node) => node.capabilityVersionId === 'cap-breaking'),
    ).toMatchObject({ coverage: 'unmapped' });
    expect(tree?.coverage).toBe('unmapped');
  });

  it('rolls source coverage up from capability children and inherits onto workflows and steps', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-breaking',
          toCapabilityVersionId: 'cap-new',
          classification: 'breaking',
          fieldChanges: [{ kind: 'removed', path: '/request/id', classification: 'breaking' }],
          affectedWorkflows: [
            { workflowVersionId: 'pay@1', stepId: 'authorize' },
            { workflowVersionId: 'pay@1', stepId: 'capture' },
          ],
        }),
        change({
          fromCapabilityVersionId: 'cap-conditional',
          toCapabilityVersionId: 'cap-renamed',
          classification: 'conditional',
          fieldChanges: [
            { kind: 'renamed', path: '/request/amountCents', classification: 'conditional' },
          ],
          affectedWorkflows: [{ workflowVersionId: 'invoice@3', stepId: 'issue' }],
        }),
      ],
    });

    expect(tree?.coverage).toBe('unmapped');
    expect(tree?.capabilityVersions).toEqual([
      {
        capabilityVersionId: 'cap-breaking',
        coverage: 'unmapped',
        workflowVersions: [
          { workflowVersionId: 'pay@1', coverage: 'unmapped', steps: ['authorize', 'capture'] },
        ],
      },
      {
        capabilityVersionId: 'cap-conditional',
        coverage: 'mapped',
        workflowVersions: [
          { workflowVersionId: 'invoice@3', coverage: 'mapped', steps: ['issue'] },
        ],
      },
    ]);
  });

  it('includes every pinned capability version from a mixed discovery', () => {
    expect(
      buildSourceUpdateTree({
        serviceId: 'billing',
        changes: [
          change({
            fromCapabilityVersionId: 'cap-breaking',
            classification: 'breaking',
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          }),
          change({
            fromCapabilityVersionId: 'cap-compatible',
            classification: 'compatible',
            affectedWorkflows: [{ workflowVersionId: 'refund@2', stepId: 'credit' }],
          }),
          change({
            fromCapabilityVersionId: 'cap-conditional',
            classification: 'conditional',
            affectedWorkflows: [{ workflowVersionId: 'invoice@3', stepId: 'issue' }],
          }),
        ],
      }),
    ).toEqual({
      serviceId: 'billing',
      coverage: 'unmapped',
      capabilityVersions: [
        {
          capabilityVersionId: 'cap-breaking',
          coverage: 'unmapped',
          workflowVersions: [
            { workflowVersionId: 'pay@1', coverage: 'unmapped', steps: ['charge'] },
          ],
        },
        {
          capabilityVersionId: 'cap-compatible',
          coverage: 'mapped',
          workflowVersions: [
            { workflowVersionId: 'refund@2', coverage: 'mapped', steps: ['credit'] },
          ],
        },
        {
          capabilityVersionId: 'cap-conditional',
          coverage: 'mapped',
          workflowVersions: [
            { workflowVersionId: 'invoice@3', coverage: 'mapped', steps: ['issue'] },
          ],
        },
      ],
    });
  });

  it('omits capability versions that have no blast-radius pins', () => {
    expect(
      buildSourceUpdateTree({
        serviceId: 'billing',
        changes: [
          change({
            fromCapabilityVersionId: 'cap-pinned',
            classification: 'breaking',
            affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          }),
          change({
            fromCapabilityVersionId: 'cap-unpinned',
            classification: 'breaking',
            affectedWorkflows: [],
          }),
        ],
      }),
    ).toEqual({
      serviceId: 'billing',
      coverage: 'unmapped',
      capabilityVersions: [
        {
          capabilityVersionId: 'cap-pinned',
          coverage: 'unmapped',
          workflowVersions: [
            { workflowVersionId: 'pay@1', coverage: 'unmapped', steps: ['charge'] },
          ],
        },
      ],
    });
  });

  it('upgrades an unmapped capability to potential when a verified hint is present', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-old',
          toCapabilityVersionId: 'cap-new',
          classification: 'breaking',
          fieldChanges: [
            { kind: 'removed', path: '/request/currency', classification: 'breaking' },
          ],
          affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          potentialCoverage: { operationId: 'chargeV2', fieldPath: '/request/currencyCode' },
        }),
      ],
    });

    expect(tree).toEqual({
      serviceId: 'billing',
      coverage: 'potential',
      capabilityVersions: [
        {
          capabilityVersionId: 'cap-old',
          coverage: 'potential',
          workflowVersions: [
            { workflowVersionId: 'pay@1', coverage: 'potential', steps: ['charge'] },
          ],
        },
      ],
    });
  });

  it('keeps an unmapped capability unmapped when no verified hint is present', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-old',
          classification: 'breaking',
          affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
        }),
      ],
    });

    expect(tree?.coverage).toBe('unmapped');
    expect(tree?.capabilityVersions[0]?.coverage).toBe('unmapped');
  });

  it('does not downgrade a mapped capability when a hint is also present', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-hold',
          toCapabilityVersionId: 'cap-renamed',
          classification: 'conditional',
          fieldChanges: [
            { kind: 'renamed', path: '/request/amountCents', classification: 'conditional' },
          ],
          affectedWorkflows: [{ workflowVersionId: 'invoice@3', stepId: 'issue' }],
          potentialCoverage: { operationId: 'issueInvoiceV2' },
        }),
      ],
    });

    expect(tree?.coverage).toBe('mapped');
    expect(tree?.capabilityVersions[0]?.coverage).toBe('mapped');
  });

  it('rolls source coverage to potential when children are mapped or potential and none are unmapped', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-breaking',
          classification: 'breaking',
          affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          potentialCoverage: { operationId: 'chargeV2' },
        }),
        change({
          fromCapabilityVersionId: 'cap-conditional',
          classification: 'conditional',
          affectedWorkflows: [{ workflowVersionId: 'invoice@3', stepId: 'issue' }],
        }),
      ],
    });

    expect(tree?.coverage).toBe('potential');
    expect(
      tree?.capabilityVersions.find((node) => node.capabilityVersionId === 'cap-breaking'),
    ).toMatchObject({ coverage: 'potential' });
    expect(
      tree?.capabilityVersions.find((node) => node.capabilityVersionId === 'cap-conditional'),
    ).toMatchObject({ coverage: 'mapped' });
  });

  it('keeps source unmapped when any child remains unmapped beside a potential sibling', () => {
    const tree = buildSourceUpdateTree({
      serviceId: 'billing',
      changes: [
        change({
          fromCapabilityVersionId: 'cap-hinted',
          classification: 'breaking',
          affectedWorkflows: [{ workflowVersionId: 'pay@1', stepId: 'charge' }],
          potentialCoverage: { operationId: 'chargeV2' },
        }),
        change({
          fromCapabilityVersionId: 'cap-lost',
          classification: 'breaking',
          affectedWorkflows: [{ workflowVersionId: 'refund@2', stepId: 'credit' }],
        }),
      ],
    });

    expect(tree?.coverage).toBe('unmapped');
    expect(
      tree?.capabilityVersions.find((node) => node.capabilityVersionId === 'cap-hinted'),
    ).toMatchObject({ coverage: 'potential' });
    expect(
      tree?.capabilityVersions.find((node) => node.capabilityVersionId === 'cap-lost'),
    ).toMatchObject({ coverage: 'unmapped' });
  });

  it('groups pinning steps under their workflow version', () => {
    expect(
      buildSourceUpdateTree({
        serviceId: 'billing',
        changes: [
          change({
            fromCapabilityVersionId: 'cap-old',
            classification: 'breaking',
            affectedWorkflows: [
              { workflowVersionId: 'pay@1', stepId: 'authorize' },
              { workflowVersionId: 'pay@1', stepId: 'capture' },
              { workflowVersionId: 'refund@2', stepId: 'credit' },
            ],
          }),
        ],
      }),
    ).toEqual({
      serviceId: 'billing',
      coverage: 'unmapped',
      capabilityVersions: [
        {
          capabilityVersionId: 'cap-old',
          coverage: 'unmapped',
          workflowVersions: [
            { workflowVersionId: 'pay@1', coverage: 'unmapped', steps: ['authorize', 'capture'] },
            { workflowVersionId: 'refund@2', coverage: 'unmapped', steps: ['credit'] },
          ],
        },
      ],
    });
  });
});
