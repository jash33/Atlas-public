import { describe, expect, it } from 'vite-plus/test';

import {
  formatRelativeTime,
  summarizeCapabilityHealth,
  summarizeDrift,
  summarizeReviewAttention,
  summarizeRunAttention,
  type CapabilityDiscoveryDetail,
  type CatalogCapability,
} from './summaries.js';

function capability(overrides: Partial<CatalogCapability> = {}): CatalogCapability {
  return {
    capabilityVersionId: 'cv_1',
    identity: { kind: 'openapi', serviceId: 'payment-service', operationId: 'getPayment' },
    annotation: { owner: 'payments-team' },
    provenance: {
      repository: 'https://example.test/payment',
      commit: 'abc',
      sourceDocument: 'openapi.yaml',
    },
    ...overrides,
  };
}

describe('summarizeCapabilityHealth', () => {
  it('counts capabilities and annotation coverage per service', () => {
    const summary = summarizeCapabilityHealth(
      [
        capability({ capabilityVersionId: 'cv_1' }),
        capability({
          capabilityVersionId: 'cv_2',
          identity: { kind: 'openapi', serviceId: 'payment-service', operationId: 'refund' },
          annotation: null,
        }),
        capability({
          capabilityVersionId: 'cv_3',
          identity: { kind: 'asyncapi', serviceId: 'billing-events', operationId: 'invoicePaid' },
        }),
      ],
      [
        {
          discoveryId: 'd1',
          serviceId: 'payment-service',
          trigger: 'daily-poll',
          discoveredAt: '2026-08-15T10:00:00Z',
        },
        {
          discoveryId: 'd2',
          serviceId: 'billing-events',
          trigger: 'repository-push',
          discoveredAt: '2026-08-15T12:00:00Z',
        },
      ],
    );
    expect(summary.totalCapabilities).toBe(3);
    expect(summary.annotatedCapabilities).toBe(2);
    expect(summary.missingAnnotation).toBe(1);
    expect(summary.services).toEqual([
      { serviceId: 'billing-events', capabilityCount: 1, annotatedCount: 1 },
      { serviceId: 'payment-service', capabilityCount: 2, annotatedCount: 1 },
    ]);
    expect(summary.latestDiscovery).toEqual({
      serviceId: 'billing-events',
      trigger: 'repository-push',
      discoveredAt: '2026-08-15T12:00:00Z',
    });
  });

  it('handles an empty catalog', () => {
    const summary = summarizeCapabilityHealth([], []);
    expect(summary.totalCapabilities).toBe(0);
    expect(summary.services).toEqual([]);
    expect(summary.latestDiscovery).toBeNull();
  });
});

function discovery(overrides: Partial<CapabilityDiscoveryDetail>): CapabilityDiscoveryDetail {
  return {
    discoveryId: 'd1',
    serviceId: 'billing-service',
    trigger: 'repository-push',
    discoveredAt: '2026-08-15T12:00:00Z',
    changes: [],
    ...overrides,
  };
}

describe('summarizeDrift', () => {
  it('reports unknown when no discovery evidence exists', () => {
    const summary = summarizeDrift([]);
    expect(summary.severity).toBe('unknown');
    expect(summary.counts).toEqual({ breaking: 0, conditional: 0, metadata: 0, compatible: 0 });
    expect(summary.affectedWorkflowVersionCount).toBe(0);
  });

  it('reports compatible when discoveries found no changes', () => {
    expect(summarizeDrift([discovery({})]).severity).toBe('compatible');
  });

  it('ranks breaking above conditional and counts distinct affected workflow versions', () => {
    const summary = summarizeDrift([
      discovery({
        discoveryId: 'd1',
        changes: [
          {
            fromCapabilityVersionId: 'cv_1',
            toCapabilityVersionId: 'cv_2',
            classification: 'conditional',
            affectedWorkflows: [{ workflowVersionId: 'wfv_1', stepId: 's1' }],
          },
        ],
      }),
      discovery({
        discoveryId: 'd2',
        serviceId: 'payment-service',
        discoveredAt: '2026-08-15T13:00:00Z',
        changes: [
          {
            fromCapabilityVersionId: 'cv_3',
            toCapabilityVersionId: 'cv_4',
            classification: 'breaking',
            affectedWorkflows: [
              { workflowVersionId: 'wfv_1', stepId: 's2' },
              { workflowVersionId: 'wfv_2', stepId: 's1' },
            ],
          },
        ],
      }),
    ]);
    expect(summary.severity).toBe('breaking');
    expect(summary.counts).toEqual({ breaking: 1, conditional: 1, metadata: 0, compatible: 0 });
    expect(summary.affectedWorkflowVersionCount).toBe(2);
    expect(summary.latestChange).toEqual({
      serviceId: 'payment-service',
      classification: 'breaking',
      discoveredAt: '2026-08-15T13:00:00Z',
    });
  });
});

describe('summarizeRunAttention', () => {
  it('counts attention states and keeps the most recent run', () => {
    const summary = summarizeRunAttention([
      {
        runId: 'r1',
        workflowVersionId: 'wfv_1',
        paymentId: 'pay_1',
        state: 'repair_required',
        startedAt: '2026-08-15T10:00:00Z',
      },
      {
        runId: 'r2',
        workflowVersionId: 'wfv_1',
        paymentId: 'pay_2',
        state: 'manual_review',
        startedAt: '2026-08-15T11:00:00Z',
      },
      {
        runId: 'r3',
        workflowVersionId: 'wfv_1',
        paymentId: 'pay_3',
        state: 'repair_required',
        startedAt: '2026-08-15T09:00:00Z',
      },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.counts).toEqual({ repair_required: 2, manual_review: 1, validation_failed: 0 });
    expect(summary.mostRecent?.runId).toBe('r2');
  });

  it('handles no runs needing attention', () => {
    const summary = summarizeRunAttention([]);
    expect(summary.total).toBe(0);
    expect(summary.mostRecent).toBeNull();
  });
});

describe('summarizeReviewAttention', () => {
  it('surfaces the current version and capabilities awaiting safety annotation', () => {
    const summary = summarizeReviewAttention(
      [
        {
          workflowVersionId: 'wfv_2',
          irHash: 'hash2',
          status: 'current',
          approvedBy: 'admin@example.test',
          approvedAt: '2026-08-15T12:00:00Z',
          runs: [{ runId: 'r1' }, { runId: 'r2' }],
        },
        {
          workflowVersionId: 'wfv_1',
          irHash: 'hash1',
          status: 'superseded',
          approvedBy: 'admin@example.test',
          approvedAt: '2026-08-14T12:00:00Z',
          runs: [],
        },
      ],
      [capability(), capability({ capabilityVersionId: 'cv_2', annotation: null })],
    );
    expect(summary.currentVersion).toEqual({
      workflowVersionId: 'wfv_2',
      approvedBy: 'admin@example.test',
      approvedAt: '2026-08-15T12:00:00Z',
      runCount: 2,
    });
    expect(summary.totalVersions).toBe(2);
    expect(summary.capabilitiesAwaitingAnnotation).toBe(1);
  });

  it('reports no current version when nothing is approved', () => {
    const summary = summarizeReviewAttention([], []);
    expect(summary.currentVersion).toBeNull();
    expect(summary.totalVersions).toBe(0);
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  it('describes recent moments and longer gaps', () => {
    expect(formatRelativeTime('2026-08-15T11:59:40Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-08-15T11:52:00Z', now)).toBe('8 min ago');
    expect(formatRelativeTime('2026-08-15T09:00:00Z', now)).toBe('3 h ago');
    expect(formatRelativeTime('2026-08-13T12:00:00Z', now)).toBe('2 d ago');
  });
  it('falls back to a date for older timestamps', () => {
    expect(formatRelativeTime('2026-06-01T12:00:00Z', now)).toBe(
      new Date('2026-06-01T12:00:00Z').toLocaleDateString(),
    );
  });
});
