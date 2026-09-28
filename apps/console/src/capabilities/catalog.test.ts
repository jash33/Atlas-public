import { describe, expect, it } from 'vite-plus/test';
import { canonicalCapabilityComparisonStates as capabilityComparisonStates } from '@atlas/workflow-ir';

import {
  capabilityComparisonLabels,
  describeRequestFailure,
  describeSelectionDenial,
  extractOperationSchemas,
  groupCatalog,
  isCapabilityDifference,
  latestDiscoveryByService,
  operationRoute,
  summarizeDiscoveryOutcome,
  type CatalogCapabilityDetail,
} from './catalog.js';

function capability(overrides: Partial<CatalogCapabilityDetail> = {}): CatalogCapabilityDetail {
  return {
    capabilityVersionId: 'version-a',
    identity: { kind: 'openapi', serviceId: 'billing', operationId: 'getInvoice' },
    fragment: { method: 'get', path: '/invoices/{invoiceId}' },
    annotation: {
      owner: 'billing-team',
      secretAlias: null,
      businessSemantics: {},
      idempotencyField: null,
      compensatedBy: null,
      irreversibleAfter: false,
    },
    provenance: {
      evidence: {
        kind: 'repository',
        repository: 'https://github.com/acme/estate',
        commit: 'c1',
        path: 'specs/billing.openapi.json',
      },
    },
    observation: {
      availability: 'available',
      freshness: 'fresh',
      reason: 'successful-discovery',
      lastObservedAt: '2026-08-26T00:00:00.000Z',
      statusChangedAt: '2026-08-26T00:00:00.000Z',
    },
    ...overrides,
  };
}

describe('capability comparison presentation', () => {
  it('provides compact copy for every backend comparison state', () => {
    expect(capabilityComparisonStates.map((state) => capabilityComparisonLabels[state])).toEqual([
      'Matching',
      'Development ahead',
      'Different',
      'Missing in Production',
      'Missing in Development',
      'Removed in Development',
      'Removed in Production',
      'Stale in Development',
      'Stale in Production',
      'Conflicting in Development',
      'Conflicting in Production',
    ]);
  });

  it('keeps only non-matching observations in the difference filter', () => {
    expect(
      capabilityComparisonStates.filter((state) =>
        isCapabilityDifference(
          capability({ comparison: { state, development: null, production: null } }),
        ),
      ),
    ).toEqual(capabilityComparisonStates.filter((state) => state !== 'matching'));
  });
});

describe('groupCatalog', () => {
  it('keeps human confirmation distinct from repository evidence', () => {
    const services = groupCatalog([
      capability({
        provenance: {
          evidence: {
            kind: 'human-confirmed',
            label: 'Private billing API',
            confirmedBy: 'developer@acme.test',
            confirmedAt: '2026-08-16T18:00:00.000Z',
          },
        },
      }),
    ]);

    expect(services[0]!.documents[0]).toMatchObject({
      evidence: {
        kind: 'human-confirmed',
        label: 'Private billing API',
        confirmedBy: 'developer@acme.test',
        confirmedAt: '2026-08-16T18:00:00.000Z',
      },
    });
  });

  it('groups operations under their service and source document', () => {
    const catalog = [
      capability(),
      capability({
        capabilityVersionId: 'version-b',
        identity: { kind: 'openapi', serviceId: 'billing', operationId: 'markInvoicePaid' },
        fragment: { method: 'post', path: '/invoices/{invoiceId}/paid' },
        annotation: null,
      }),
      capability({
        capabilityVersionId: 'version-c',
        identity: {
          kind: 'asyncapi',
          serviceId: 'events',
          operationId: 'invoicePaid',
          channelAddress: 'invoice.events',
          messageKey: 'invoicePaid',
        },
        fragment: {},
        provenance: {
          evidence: {
            kind: 'repository',
            repository: 'https://github.com/acme/estate',
            commit: 'c1',
            path: 'specs/events.asyncapi.json',
          },
        },
      }),
    ];

    const services = groupCatalog(catalog);
    expect(services.map((service) => service.serviceId)).toEqual(['billing', 'events']);
    const billing = services[0]!;
    expect(billing.operationCount).toBe(2);
    expect(billing.annotatedCount).toBe(1);
    expect(billing.kinds).toEqual(['openapi']);
    expect(billing.documents).toHaveLength(1);
    expect(billing.documents[0]?.evidence).toEqual({
      kind: 'repository',
      repository: 'https://github.com/acme/estate',
      commit: 'c1',
      path: 'specs/billing.openapi.json',
    });
    expect(
      billing.documents[0]!.operations.map((operation) => operation.identity.operationId),
    ).toEqual(['getInvoice', 'markInvoicePaid']);
    expect(services[1]!.kinds).toEqual(['asyncapi']);
  });

  it('keeps distinct source documents of one service separate', () => {
    const services = groupCatalog([
      capability(),
      capability({
        capabilityVersionId: 'version-d',
        identity: { kind: 'openapi', serviceId: 'billing', operationId: 'refundInvoice' },
        provenance: {
          evidence: {
            kind: 'repository',
            repository: 'https://github.com/acme/estate',
            commit: 'c2',
            path: 'specs/billing.openapi.json',
          },
        },
      }),
    ]);
    expect(services).toHaveLength(1);
    expect(services[0]!.documents).toHaveLength(2);
  });
});

describe('operationRoute', () => {
  it('renders an OpenAPI operation as method and path', () => {
    expect(operationRoute(capability())).toBe('GET /invoices/{invoiceId}');
  });

  it('renders an AsyncAPI operation as channel and message', () => {
    expect(
      operationRoute(
        capability({
          identity: {
            kind: 'asyncapi',
            serviceId: 'events',
            operationId: 'invoicePaid',
            channelAddress: 'invoice.events',
            messageKey: 'invoicePaid',
          },
          fragment: {},
        }),
      ),
    ).toBe('invoice.events · invoicePaid');
  });

  it('falls back to the operation id when the fragment has no route', () => {
    expect(operationRoute(capability({ fragment: {} }))).toBe('getInvoice');
  });
});

describe('latestDiscoveryByService', () => {
  it('keeps only the most recent discovery per service', () => {
    const map = latestDiscoveryByService([
      {
        discoveryId: '1',
        serviceId: 'billing',
        trigger: 'repository-push',
        discoveredAt: '2026-08-15T10:00:00.000Z',
      },
      {
        discoveryId: '2',
        serviceId: 'billing',
        trigger: 'daily-poll',
        discoveredAt: '2026-08-15T11:00:00.000Z',
      },
      {
        discoveryId: '3',
        serviceId: 'events',
        trigger: 'run-drift',
        discoveredAt: '2026-08-15T09:00:00.000Z',
      },
    ]);
    expect(map.get('billing')?.discoveryId).toBe('2');
    expect(map.get('events')?.discoveryId).toBe('3');
  });
});

describe('summarizeDiscoveryOutcome', () => {
  it('reports capability and change counts', () => {
    expect(
      summarizeDiscoveryOutcome({
        discoveryId: '9',
        trigger: 'repository-push',
        capabilities: [{ capabilityVersionId: 'a' }, { capabilityVersionId: 'b' }],
        changes: [{ classification: 'breaking' }],
      }),
    ).toBe('2 capabilities discovered · 1 change (1 breaking)');
  });

  it('reports a quiet discovery without changes', () => {
    expect(
      summarizeDiscoveryOutcome({
        discoveryId: '9',
        trigger: 'daily-poll',
        capabilities: [{ capabilityVersionId: 'a' }],
        changes: [],
      }),
    ).toBe('1 capability discovered · no changes');
  });
});

describe('extractOperationSchemas', () => {
  it('lists parameter, request-body, and response schemas for an OpenAPI fragment', () => {
    const schemas = extractOperationSchemas('openapi', {
      method: 'post',
      path: '/payments',
      pathParameters: [
        { name: 'tenantId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      operation: {
        parameters: [{ name: 'expand', in: 'query', schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/PaymentRequest' } },
          },
        },
        responses: {
          '201': {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          '204': { description: 'empty' },
        },
      },
      references: {
        '#/components/schemas/PaymentRequest': {
          type: 'object',
          required: ['amount'],
          properties: { amount: { type: 'number' } },
        },
      },
    });

    expect(schemas).toEqual([
      {
        label: 'Parameter tenantId · path · required',
        schema: { type: 'string' },
      },
      {
        label: 'Parameter expand · query',
        schema: { type: 'string' },
      },
      {
        label: 'Request body · application/json',
        reference: '#/components/schemas/PaymentRequest',
        schema: {
          type: 'object',
          required: ['amount'],
          properties: { amount: { type: 'number' } },
        },
      },
      {
        label: 'Response 201 · application/json',
        schema: { type: 'object' },
      },
    ]);
  });

  it('lists the message payload and headers for an AsyncAPI fragment', () => {
    const schemas = extractOperationSchemas('asyncapi', {
      operation: { action: 'send' },
      channel: { address: 'invoice.events' },
      message: {
        payload: { $ref: '#/components/schemas/InvoicePaid' },
        headers: { type: 'object' },
      },
      references: {
        '#/components/schemas/InvoicePaid': { type: 'object' },
      },
    });

    expect(schemas).toEqual([
      {
        label: 'Message payload',
        reference: '#/components/schemas/InvoicePaid',
        schema: { type: 'object' },
      },
      { label: 'Message headers', schema: { type: 'object' } },
    ]);
  });

  it('returns nothing for a fragment without typed schemas', () => {
    expect(
      extractOperationSchemas('openapi', { method: 'get', path: '/x', operation: {} }),
    ).toEqual([]);
  });
});

describe('describeSelectionDenial', () => {
  it('explains every backend denial code in plain language', () => {
    expect(describeSelectionDenial('annotation-not-approved')).toMatch(/approv/i);
    expect(describeSelectionDenial('superseded-version')).toMatch(/superseded/i);
    expect(describeSelectionDenial('missing-current-annotation')).toMatch(/annotation/i);
  });

  it('falls back to the raw code for unknown denials', () => {
    expect(describeSelectionDenial('some-new-denial')).toBe('some-new-denial');
  });
});

describe('describeRequestFailure', () => {
  it('surfaces zod issues from the backend', () => {
    expect(
      describeRequestFailure(422, {
        error: 'invalid-discovery',
        issues: [{ path: ['source', 'document'], message: 'Invalid OpenAPI document: bad' }],
      }),
    ).toBe('invalid-discovery: source.document — Invalid OpenAPI document: bad');
  });

  it('surfaces bare error codes', () => {
    expect(describeRequestFailure(400, { error: 'source-host-not-allowlisted' })).toBe(
      'Atlas blocked this source because its host is not in the source allowlist',
    );
  });

  it('explains source routing failures in product language', () => {
    expect(describeRequestFailure(400, { error: 'source-redirect-denied' })).toBe(
      'Atlas blocked a source redirect; register the final allowlisted URL directly',
    );
    expect(describeRequestFailure(400, { error: 'source-protocol-denied' })).toBe(
      'Atlas only fetches capability sources over HTTP or HTTPS',
    );
  });

  it('falls back to the HTTP status', () => {
    expect(describeRequestFailure(500, undefined)).toBe('Request failed (500)');
  });
});
