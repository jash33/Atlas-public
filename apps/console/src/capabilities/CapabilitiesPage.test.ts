import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vite-plus/test';
import { canonicalCapabilityComparisonStates as capabilityComparisonStates } from '@atlas/workflow-ir';

import {
  capabilityComparisonLabels,
  type CatalogCapabilityDetail,
  type ServiceGroup,
} from './catalog.js';
import {
  capabilityNotificationNoticeFromHash,
  CapabilityComparison,
  findNotificationLinkedCapability,
  OperationList,
  toggleExpandedService,
} from './CapabilitiesPage.js';

const services: ServiceGroup[] = [
  {
    serviceId: 'billing',
    kinds: ['openapi'],
    operationCount: 1,
    annotatedCount: 0,
    documents: [
      {
        evidence: {
          kind: 'human-confirmed',
          label: 'Billing API',
          confirmedBy: 'operator',
          confirmedAt: '2026-08-26T00:00:00.000Z',
        },
        operations: [
          {
            capabilityVersionId: 'capability-version-billing',
            identity: {
              kind: 'openapi',
              serviceId: 'billing',
              operationId: 'get-invoice',
            },
            fragment: { method: 'get', path: '/invoices/{invoiceId}' },
            annotation: null,
            provenance: {
              evidence: {
                kind: 'human-confirmed',
                label: 'Billing API',
                confirmedBy: 'operator',
                confirmedAt: '2026-08-26T00:00:00.000Z',
              },
            },
            observation: {
              availability: 'available',
              freshness: 'fresh',
              reason: 'successful-discovery',
              lastObservedAt: '2026-08-26T00:00:00.000Z',
              statusChangedAt: '2026-08-26T00:00:00.000Z',
            },
          },
        ],
      },
    ],
  },
];

describe('capability notification links', () => {
  it('restores the exact risk message and next action from a notification deep link', () => {
    const hash = `#/capabilities?${new URLSearchParams({
      capability: 'capability-invoice-paid',
      noticeTitle: 'Removed capability blocks workflows',
      noticeMessage: 'markInvoicePaid is absent from a successful discovery.',
      noticeSeverity: 'critical',
      noticeNextAction: 'Rediscover the source or migrate affected workflows.',
    })}`;

    expect(capabilityNotificationNoticeFromHash(hash)).toEqual({
      title: 'Removed capability blocks workflows',
      message: 'markInvoicePaid is absent from a successful discovery.',
      severity: 'critical',
      nextAction: 'Rediscover the source or migrate affected workflows.',
    });
  });

  it('falls back to the operation label when a seeded notification has a stale identity id', () => {
    const capability = services[0]!.documents[0]!.operations[0]!;

    expect(
      findNotificationLinkedCapability(
        [capability],
        'obsolete-capability-identity',
        capability.identity.operationId,
      ),
    ).toBe(capability);
  });
});

describe('OperationList', () => {
  it('renders each service group as a collapsed accordion control by default', () => {
    const html = renderToStaticMarkup(
      createElement(OperationList, {
        services,
        selectedService: null,
        selectedVersionId: null,
        search: '',
        onSelectCapability: vi.fn<(capabilityVersionId: string) => void>(),
      }),
    );

    expect(html).toContain('<button');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="capability-service-billing"');
    expect(html).not.toContain('id="capability-service-billing"');
    expect(html).not.toContain('get-invoice');
  });

  it('toggles one service without mutating the other service states', () => {
    const initiallyExpanded = new Set(['payments']);

    const expanded = toggleExpandedService(initiallyExpanded, 'billing');
    const collapsedAgain = toggleExpandedService(expanded, 'billing');

    expect([...expanded]).toEqual(['payments', 'billing']);
    expect([...collapsedAgain]).toEqual(['payments']);
    expect([...initiallyExpanded]).toEqual(['payments']);
  });
});

describe('CapabilityComparison', () => {
  for (const state of capabilityComparisonStates) {
    it(`renders the ${state} state with both contract and metadata columns`, () => {
      const base = services[0]!.documents[0]!.operations[0]!;
      const side = {
        ...base,
        capabilityVersionId: `${state}-version`,
      } satisfies CatalogCapabilityDetail;
      const html = renderToStaticMarkup(
        createElement(CapabilityComparison, {
          capability: {
            ...base,
            comparison: {
              state,
              development: state === 'missing-in-development' ? null : side,
              production: state === 'missing-in-production' ? null : side,
            },
          },
        }),
      );

      expect(html).toContain(capabilityComparisonLabels[state]);
      expect(html).toContain('Development');
      expect(html).toContain('Production');
      const missingSideCount = state.startsWith('missing-') ? 1 : 0;
      expect(html.match(/Declared contract/g) ?? []).toHaveLength(2 - missingSideCount);
      expect(html.match(/Atlas metadata/g) ?? []).toHaveLength(2 - missingSideCount);
      expect(html.match(/No observation in this environment\./g) ?? []).toHaveLength(
        missingSideCount,
      );
    });
  }
});
