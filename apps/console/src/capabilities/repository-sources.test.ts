import { describe, expect, it } from 'vite-plus/test';
import { groupCatalogSources } from './repository-sources.js';
import type { CatalogCapabilityDetail, SourceEvidence } from './catalog.js';

const firstRepository = 'https://github.com/acme/orders';
const secondRepository = 'https://github.com/acme/payments';
function evidence(repository: string): SourceEvidence {
  return { kind: 'repository', repository, commit: 'abc', path: 'api.json' };
}
function capability(id: string, source = evidence(firstRepository)): CatalogCapabilityDetail {
  return {
    capabilityVersionId: id,
    identity: { kind: 'openapi', serviceId: 'billing', operationId: id },
    fragment: { method: 'get', path: `/${id}` },
    annotation: null,
    provenance: { evidence: source },
    observation: {
      availability: 'available',
      freshness: 'fresh',
      reason: 'successful-discovery',
      lastObservedAt: '2026-09-22T12:00:00Z',
      statusChangedAt: '2026-09-22T12:00:00Z',
    },
  };
}

describe('repository source grouping', () => {
  it('keeps same-named service groups separate across repositories and combines their document formats', () => {
    const event = capability('invoicePaid');
    event.identity = {
      kind: 'asyncapi',
      serviceId: 'billing',
      operationId: 'invoicePaid',
      channelAddress: 'invoice.events',
      messageKey: 'paid',
    };
    const sources = groupCatalogSources([
      capability('getInvoice'),
      event,
      capability('chargeCard', evidence(secondRepository)),
    ]);
    expect(sources.map((source) => source.label)).toEqual(['acme/orders', 'acme/payments']);
    expect(sources[0]?.services[0]?.kinds).toEqual(['asyncapi', 'openapi']);
    expect(sources[0]?.capabilities.map((entry) => entry.identity.operationId)).toEqual([
      'getInvoice',
      'invoicePaid',
    ]);
    expect(sources[1]?.capabilities.map((entry) => entry.identity.operationId)).toEqual([
      'chargeCard',
    ]);
  });

  it('joins generated source evidence to a connected repository and keeps empty repositories visible', () => {
    const generated: SourceEvidence = {
      kind: 'atlas-generated',
      repository: 'https://github.com/Acme/Orders.git/',
      commit: 'abc',
      candidateId: 'review',
      label: 'Generated contracts',
      confirmedBy: 'admin',
      confirmedAt: '2026-09-22T12:00:00Z',
    };
    const sources = groupCatalogSources(
      [capability('getInvoice', generated)],
      [
        { id: 'orders', repository: firstRepository, branches: ['main'] },
        { id: 'payments', repository: secondRepository, branches: ['release'] },
      ],
    );
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      connectionId: 'orders',
      branches: ['main'],
      capabilities: [{ capabilityVersionId: 'getInvoice' }],
    });
    expect(sources[1]).toMatchObject({ connectionId: 'payments', capabilities: [], services: [] });
  });

  it('retains repository membership from both environments and conflicting claims without duplicate operations', () => {
    const entry = capability('getInvoice');
    entry.comparison = {
      state: 'different',
      development: capability('dev'),
      production: capability('prod', evidence(secondRepository)),
    };
    entry.sourceResolution = {
      status: 'conflicting',
      authoritativeSourceKey: null,
      claims: [
        {
          sourceKey: 'first',
          capabilityVersionId: 'getInvoice',
          provenance: { evidence: evidence(firstRepository) },
        },
        {
          sourceKey: 'second',
          capabilityVersionId: 'other',
          provenance: { evidence: evidence(secondRepository) },
        },
      ],
    };
    const sources = groupCatalogSources([entry]);
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.capabilities.length)).toEqual([1, 1]);
    expect(sources[1]?.capabilities[0]?.comparison?.state).toBe('different');
  });

  it('keeps imports without repository evidence accessible without assigning them to a repository', () => {
    const imported: SourceEvidence = {
      kind: 'human-confirmed',
      label: 'Billing import',
      confirmedBy: 'admin',
      confirmedAt: '2026-09-22T12:00:00Z',
    };
    const sources = groupCatalogSources(
      [capability('manualInvoice', imported)],
      [{ id: 'orders', repository: firstRepository, branches: ['main'] }],
    );
    expect(sources[0]?.capabilities).toEqual([]);
    expect(sources[1]).toMatchObject({
      label: 'Other sources',
      repository: null,
      services: [{ serviceId: 'billing' }],
    });
  });
});
