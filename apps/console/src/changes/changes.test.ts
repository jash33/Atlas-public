import { describe, expect, it } from 'vite-plus/test';

import {
  buildChangeItems,
  changeClassificationCopy,
  contractClassificationScope,
  capabilityDetailHash,
  countChangeItemsByClassification,
  presentFieldChange,
  migrationReviewHash,
  workflowDetailHash,
  type ChangeDiscoveryDetail,
} from './changes.js';

describe('honest contract classification copy', () => {
  it('presents exactly the four bounded declared-contract outcomes', () => {
    expect(Object.values(changeClassificationCopy).map(({ label }) => label)).toEqual([
      'Incompatible contract',
      'Needs review',
      'Compatible contract',
      'Metadata changed',
    ]);
    expect(contractClassificationScope).toContain('OpenAPI or AsyncAPI operation fragment');
    expect(contractClassificationScope).toContain('do not inspect service source code');
    expect(contractClassificationScope).toContain('prove runtime behavior');
    expect(contractClassificationScope).toContain('deployment matches its declared contract');
    expect(contractClassificationScope).toContain('Runtime-only evidence needs review');
  });
});

const discoveredAt = '2026-08-15T18:00:00.000Z';

describe('buildChangeItems', () => {
  it('keeps discovered version changes distinct from runtime schema-drift rejections', () => {
    const details: ChangeDiscoveryDetail[] = [
      {
        discoveryId: 'discovery-version',
        serviceId: 'billing',
        trigger: 'repository-push',
        discoveredAt,
        changes: [
          {
            fromCapabilityVersionId: 'capability-old',
            toCapabilityVersionId: 'capability-new',
            classification: 'breaking',
            fieldChanges: [
              {
                kind: 'added-required',
                path: '/request/currency',
                classification: 'breaking',
              },
            ],
            affectedWorkflows: [{ workflowVersionId: 'payment-flow@1', stepId: 'settle-invoice' }],
          },
        ],
      },
      {
        discoveryId: 'discovery-runtime',
        serviceId: 'payments',
        trigger: 'run-drift',
        discoveredAt: '2026-08-15T19:00:00.000Z',
        changes: [],
        runtimeSignals: [
          {
            environmentId: 'production',
            capabilityVersionId: 'runtime-pin',
            stepId: 'read-payment',
            affectedWorkflows: [{ workflowVersionId: 'payment-flow@1', stepId: 'read-payment' }],
          },
        ],
      },
    ];

    expect(buildChangeItems(details)).toEqual([
      expect.objectContaining({
        id: 'discovery-runtime:runtime-signal:production:runtime-pin:read-payment',
        evidenceKind: 'runtime-rejection',
        classification: 'conditional',
        fromCapabilityVersionId: 'runtime-pin',
        runtimeStepId: 'read-payment',
        fieldChanges: [],
        affectedWorkflows: [{ workflowVersionId: 'payment-flow@1', stepId: 'read-payment' }],
      }),
      expect.objectContaining({
        id: 'discovery-version:capability-old:capability-new',
        evidenceKind: 'discovered-version',
        classification: 'breaking',
        intakeBehavior: 'quarantined',
        environmentAffected: true,
        fieldChanges: [expect.objectContaining({ path: '/request/currency' })],
        affectedWorkflows: [{ workflowVersionId: 'payment-flow@1', stepId: 'settle-invoice' }],
      }),
    ]);
  });

  it('keeps compatible and conditional intake on the approved old pin', () => {
    const details: ChangeDiscoveryDetail[] = ['compatible', 'conditional'].map(
      (classification, index) => ({
        discoveryId: `discovery-${index}`,
        serviceId: 'billing',
        trigger: 'daily-poll',
        discoveredAt,
        changes: [
          {
            fromCapabilityVersionId: `old-${index}`,
            toCapabilityVersionId: `new-${index}`,
            classification: classification as 'compatible' | 'conditional',
            fieldChanges: [],
            affectedWorkflows: [],
          },
        ],
      }),
    );

    expect(buildChangeItems(details).map(({ intakeBehavior }) => intakeBehavior)).toEqual([
      'old-pin-open',
      'old-pin-open',
    ]);
  });

  it('does not claim quarantine or old-pin behavior for another environment', () => {
    const items = buildChangeItems([
      {
        discoveryId: 'discovery-other-environment',
        serviceId: 'billing',
        trigger: 'repository-push',
        discoveredAt,
        changes: [
          {
            fromCapabilityVersionId: 'old',
            toCapabilityVersionId: 'new',
            classification: 'breaking',
            fieldChanges: [],
            organizationAffectedWorkflowCount: 1,
            affectedWorkflows: [],
          },
        ],
      },
    ]);

    expect(items[0]).toMatchObject({
      classification: 'breaking',
      environmentAffected: false,
      intakeBehavior: 'unaffected',
      affectedWorkflows: [],
    });
    expect(countChangeItemsByClassification(items)).toMatchObject({ breaking: 1 });
  });
});

describe('change detail links', () => {
  it('links capability, workflow, and migration evidence to production surfaces', () => {
    expect(capabilityDetailHash('capability/new')).toBe(
      '#/capabilities?capabilityVersionId=capability%2Fnew',
    );
    expect(workflowDetailHash('payment flow@1')).toBe(
      '#/workflows?workflowVersionId=payment+flow%401',
    );
    expect(migrationReviewHash('42')).toBe('#/workflows?migrationCandidateId=42');
  });
});

describe('presentFieldChange', () => {
  it('turns an encoded schema pointer into a readable before-and-after diff', () => {
    expect(
      presentFieldChange({
        kind: 'removed',
        path: '/references/#~1components~1schemas~1Invoice/properties/customerId',
        classification: 'breaking',
      }),
    ).toEqual({
      title: 'Removed field',
      field: 'Invoice.customerId',
      before: 'Present',
      after: 'Absent',
    });
  });

  it('shows both readable field names for a rename', () => {
    expect(
      presentFieldChange({
        kind: 'renamed',
        fromPath: '/references/#~1components~1schemas~1Invoice/properties/customerId',
        path: '/references/#~1components~1schemas~1Invoice/properties/customerReference',
        classification: 'conditional',
      }),
    ).toEqual({
      title: 'Renamed field',
      field: 'Invoice.customerReference',
      before: 'Invoice.customerId',
      after: 'Invoice.customerReference',
    });
  });
});
