import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import {
  matchCapabilityReferences,
  plannerCapabilityReferenceIndex,
} from './capability-reference-index.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = 'capability_reference_index_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const app = createApp(pool, undefined, undefined, undefined, undefined, undefined, {
  allowLegacySourceRoutes: true,
});

const paymentDocument = {
  openapi: '3.1.0',
  info: { title: 'Payment API', version: '1.0.0' },
  paths: {
    '/payments/{paymentId}': {
      get: {
        operationId: 'getPayment',
        parameters: [
          {
            name: 'paymentId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Payment',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Payment: {
        type: 'object',
        required: ['paymentId'],
        properties: { paymentId: { type: 'string' } },
      },
    },
  },
};

const getPaymentFragment = {
  method: 'get',
  path: '/payments/{paymentId}',
  pathParameters: [],
  operation: {
    operationId: 'getPayment',
    summary: 'Read the authoritative payment record',
    parameters: [
      {
        name: 'paymentId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    ],
    responses: {
      '200': {
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
        },
      },
    },
  },
  references: {
    '#/components/schemas/Payment': {
      type: 'object',
      required: ['paymentId'],
      properties: { paymentId: { type: 'string' } },
    },
  },
};

const nestedInvoiceFragment = {
  method: 'post',
  path: '/invoices',
  pathParameters: [],
  operation: {
    operationId: 'createInvoice',
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['customer'],
            properties: {
              customer: {
                type: 'object',
                required: ['accountId'],
                properties: {
                  accountId: { type: 'string' },
                  display_name: { type: 'string' },
                },
              },
              'invoice-total': { type: 'number' },
            },
          },
        },
      },
    },
    responses: {
      '200': {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['invoiceId'],
              properties: {
                invoiceId: { type: 'string' },
                customer: {
                  type: 'object',
                  properties: {
                    accountId: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

function ingestionRequest(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: 'org_atlas',
    serviceId: 'payments',
    source: {
      format: 'openapi',
      document: paymentDocument,
      repository: 'https://github.com/acme/payment-api',
      commit: '0123456789abcdef',
      path: 'openapi.json',
    },
    manifest: {
      source: {
        repository: 'https://github.com/acme/payment-api',
        commit: '0123456789abcdef',
        path: 'atlas-manifest.json',
      },
      annotations: [
        {
          capability: { operationId: 'getPayment' },
          owner: 'payments-team',
          secretAlias: 'payment-api-token',
          businessSemantics: { readsAuthoritativePayment: true },
          idempotencyField: null,
          compensatedBy: null,
          irreversibleAfter: false,
        },
      ],
    },
    ...overrides,
  };
}

async function ingest(body: unknown) {
  return app.request('/v1/capability-ingestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function approveCapability(
  organizationId: string,
  capabilityVersionId: string,
  environmentId?: string,
) {
  const stored = await pool.query<{ annotation_id: string; identity_id: string }>(
    `SELECT manifest_annotation_id AS annotation_id, capability_identity_id AS identity_id
     FROM capability_versions
     WHERE organization_id = $1 AND capability_version_id = $2`,
    [organizationId, capabilityVersionId],
  );
  await pool.query(
    `INSERT INTO manifest_annotation_approvals
      (organization_id, manifest_annotation_id, approved_by)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [organizationId, stored.rows[0]!.annotation_id, 'admin@example.com'],
  );
  await pool.query(
    `INSERT INTO capability_approvals
      (organization_id, capability_version_id, approved_by)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [organizationId, capabilityVersionId, 'admin@example.com'],
  );
  await pool.query(
    environmentId
      ? `INSERT INTO capability_host_policies
          (organization_id, capability_identity_id, environment_id, hostname, approved_by)
         VALUES ($1, $2, $3, $4, $5)`
      : `INSERT INTO capability_host_policies
          (organization_id, capability_identity_id, hostname, approved_by)
         VALUES ($1, $2, $3, $4)`,
    environmentId
      ? [
          organizationId,
          stored.rows[0]!.identity_id,
          environmentId,
          'payments.internal',
          'admin@example.com',
        ]
      : [organizationId, stored.rows[0]!.identity_id, 'payments.internal', 'admin@example.com'],
  );
}

describe('plannerCapabilityReferenceIndex', () => {
  it('derives request and response field identities from a projection fragment', () => {
    const index = plannerCapabilityReferenceIndex({
      fingerprint: 'a'.repeat(64),
      capabilities: [
        {
          capabilityVersionId: 'cap-get-payment',
          identity: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
          fragment: getPaymentFragment,
          annotation: {
            owner: 'payments-team',
            businessSemantics: { readsAuthoritativePayment: true },
            idempotencyField: null,
            compensatedBy: null,
            irreversibleAfter: false,
          },
          userAnnotations: ['Use this operation for franchise settlement lookups.'],
        },
      ],
    });

    expect(index).toMatchObject({
      status: 'ok',
      fingerprint: 'a'.repeat(64),
    });
    if (index.status !== 'ok') throw new Error('expected a successful index');
    expect(index.references[0]?.summary).toBe('Read the authoritative payment record');
    expect(index.references[0]?.searchTerms).toEqual(
      expect.arrayContaining(['read', 'authoritative', 'payment', 'record', 'franchise']),
    );
    expect(matchCapabilityReferences(index, 'franchise settlement')).toMatchObject([
      { capabilityVersionId: 'cap-get-payment', label: 'getPayment' },
    ]);
    expect(index.references[0]?.fields).toEqual([
      {
        capabilityVersionId: 'cap-get-payment',
        direction: 'request',
        path: '/paymentId',
        type: 'string',
        required: true,
        label: 'Payment Id',
        searchTerms: expect.arrayContaining(['paymentid', 'payment', 'id']),
      },
      {
        capabilityVersionId: 'cap-get-payment',
        direction: 'response',
        path: '/paymentId',
        type: 'string',
        required: true,
        label: 'Payment Id',
        searchTerms: expect.arrayContaining(['paymentid', 'payment', 'id']),
      },
    ]);
  });

  it('walks nested request and response paths with one JSON Pointer convention', () => {
    const index = plannerCapabilityReferenceIndex({
      fingerprint: 'b'.repeat(64),
      capabilities: [
        {
          capabilityVersionId: 'cap-create-invoice',
          identity: { kind: 'openapi', serviceId: 'billing', operationId: 'createInvoice' },
          fragment: nestedInvoiceFragment,
          annotation: {
            owner: 'billing-team',
            businessSemantics: { recordsInvoice: true },
            idempotencyField: null,
            compensatedBy: null,
            irreversibleAfter: false,
          },
        },
      ],
    });

    if (index.status !== 'ok') throw new Error('expected a successful index');
    expect(index.references[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'request',
          path: '/customer',
          type: 'object',
          required: true,
          label: 'Customer',
        }),
        expect.objectContaining({
          direction: 'request',
          path: '/customer/accountId',
          type: 'string',
          required: true,
          label: 'Account Id',
        }),
        expect.objectContaining({
          direction: 'request',
          path: '/customer/display_name',
          type: 'string',
          required: false,
          label: 'Display Name',
        }),
        expect.objectContaining({
          direction: 'request',
          path: '/invoice-total',
          type: 'number',
          required: false,
          label: 'Invoice Total',
        }),
        expect.objectContaining({
          direction: 'response',
          path: '/invoiceId',
          type: 'string',
          required: true,
          label: 'Invoice Id',
        }),
        expect.objectContaining({
          direction: 'response',
          path: '/customer/accountId',
          type: 'string',
          required: false,
          label: 'Account Id',
        }),
      ]),
    );
  });

  it('uses JSON Pointer array-item segments so nested list fields stay distinct identities', () => {
    const index = plannerCapabilityReferenceIndex({
      fingerprint: 'h'.repeat(64),
      capabilities: [
        {
          capabilityVersionId: 'cap-create-order',
          identity: { kind: 'openapi', serviceId: 'orders', operationId: 'createOrder' },
          fragment: {
            method: 'post',
            path: '/orders',
            operation: {
              operationId: 'createOrder',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['lineItems'],
                      properties: {
                        lineItems: {
                          type: 'array',
                          items: {
                            type: 'object',
                            required: ['sku'],
                            properties: {
                              sku: { type: 'string' },
                              'unit/price': { type: 'number' },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          annotation: {
            owner: 'orders-team',
            businessSemantics: { recordsOrder: true },
            idempotencyField: null,
            compensatedBy: null,
            irreversibleAfter: false,
          },
        },
      ],
    });
    if (index.status !== 'ok') throw new Error('expected a successful index');
    expect(index.references[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: 'request',
          path: '/lineItems',
          type: 'array',
          required: true,
          label: 'Line Items',
        }),
        expect.objectContaining({
          direction: 'request',
          path: '/lineItems/-/sku',
          type: 'string',
          required: true,
          label: 'Sku',
        }),
        expect.objectContaining({
          direction: 'request',
          path: '/lineItems/-/unit~1price',
          type: 'number',
          required: false,
          label: 'Unit/Price',
        }),
      ]),
    );
    expect(index.references[0]?.fields.map((field) => field.path)).not.toContain('/lineItems/sku');
  });

  it('includes trusted tooltip metadata without secret or host-policy fields', () => {
    const index = plannerCapabilityReferenceIndex(
      {
        fingerprint: 'c'.repeat(64),
        capabilities: [
          {
            capabilityVersionId: 'cap-get-payment',
            identity: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
            fragment: getPaymentFragment,
            annotation: {
              owner: 'payments-team',
              businessSemantics: { readsAuthoritativePayment: true },
              idempotencyField: 'idempotencyKey',
              compensatedBy: {
                kind: 'openapi',
                serviceId: 'payments',
                operationId: 'cancelPayment',
                channelAddress: null,
                messageKey: null,
              },
              irreversibleAfter: false,
            },
          },
        ],
      },
      {
        provenanceByCapabilityVersionId: new Map([
          [
            'cap-get-payment',
            {
              evidence: {
                kind: 'repository' as const,
                repository: 'https://github.com/acme/payment-api',
                commit: '0123456789abcdef',
                path: 'openapi.json',
              },
            },
          ],
        ]),
      },
    );

    expect(index).toEqual({
      status: 'ok',
      fingerprint: 'c'.repeat(64),
      references: [
        expect.objectContaining({
          capabilityVersionId: 'cap-get-payment',
          identity: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
          owner: 'payments-team',
          businessSemantics: { readsAuthoritativePayment: true },
          safety: {
            idempotencyField: 'idempotencyKey',
            compensatedBy: {
              kind: 'openapi',
              serviceId: 'payments',
              operationId: 'cancelPayment',
              channelAddress: null,
              messageKey: null,
            },
            irreversibleAfter: false,
          },
          provenance: {
            evidence: {
              kind: 'repository',
              repository: 'https://github.com/acme/payment-api',
              commit: '0123456789abcdef',
              path: 'openapi.json',
            },
          },
        }),
      ],
    });
    expect(JSON.stringify(index)).not.toContain('secretAlias');
    expect(JSON.stringify(index)).not.toContain('payments.internal');
  });

  it('exposes normalized aliases so the matcher can find nested fields without guessing', () => {
    const index = plannerCapabilityReferenceIndex({
      fingerprint: 'g'.repeat(64),
      capabilities: [
        {
          capabilityVersionId: 'cap-create-invoice',
          identity: { kind: 'openapi', serviceId: 'billing-service', operationId: 'createInvoice' },
          fragment: nestedInvoiceFragment,
          annotation: {
            owner: 'billing-team',
            businessSemantics: { recordsInvoice: true },
            idempotencyField: null,
            compensatedBy: null,
            irreversibleAfter: false,
          },
        },
      ],
    });
    if (index.status !== 'ok') throw new Error('expected a successful index');

    expect(matchCapabilityReferences(index, 'billing-ser')).toEqual([
      expect.objectContaining({
        capabilityVersionId: 'cap-create-invoice',
        label: 'createInvoice',
      }),
    ]);
    expect(matchCapabilityReferences(index, 'display_name')).toEqual([
      expect.objectContaining({
        direction: 'request',
        path: '/customer/display_name',
        label: 'Display Name',
      }),
    ]);
    expect(matchCapabilityReferences(index, 'invoice-tot')).toEqual([
      expect.objectContaining({
        direction: 'request',
        path: '/invoice-total',
        label: 'Invoice Total',
      }),
    ]);
    expect(matchCapabilityReferences(index, 'accountId')).toEqual([
      expect.objectContaining({ direction: 'request', path: '/customer/accountId' }),
      expect.objectContaining({ direction: 'response', path: '/customer/accountId' }),
    ]);
  });

  it('treats a missing projection as unavailable and a fingerprint mismatch as stale', () => {
    expect(plannerCapabilityReferenceIndex(null)).toEqual({ status: 'unavailable' });
    expect(
      plannerCapabilityReferenceIndex(
        { fingerprint: 'd'.repeat(64), capabilities: [] },
        { expectedFingerprint: 'e'.repeat(64) },
      ),
    ).toEqual({ status: 'stale', fingerprint: 'd'.repeat(64) });
    expect(
      plannerCapabilityReferenceIndex({ fingerprint: 'd'.repeat(64), capabilities: [] }),
    ).toEqual({
      status: 'ok',
      fingerprint: 'd'.repeat(64),
      references: [],
    });
  });
});

describe('matchCapabilityReferences', () => {
  const index = {
    status: 'ok' as const,
    fingerprint: 'f'.repeat(64),
    references: [
      {
        capabilityVersionId: 'cap-payments',
        identity: { kind: 'openapi' as const, serviceId: 'payments', operationId: 'getPayment' },
        owner: 'payments-team',
        searchTerms: ['payments', 'getpayment', 'get', 'payment', 'payments-team'],
        fields: [
          {
            capabilityVersionId: 'cap-payments',
            direction: 'request' as const,
            path: '/paymentId',
            type: 'string',
            required: true,
            label: 'Payment Id',
            searchTerms: ['paymentid', 'payment', 'id', 'payment id'],
          },
        ],
      },
      {
        capabilityVersionId: 'cap-billing',
        identity: { kind: 'openapi' as const, serviceId: 'billing', operationId: 'getInvoice' },
        owner: 'billing-team',
        searchTerms: ['billing', 'getinvoice', 'get', 'invoice', 'billing-team'],
        fields: [
          {
            capabilityVersionId: 'cap-billing',
            direction: 'request' as const,
            path: '/paymentId',
            type: 'string',
            required: true,
            label: 'Payment Id',
            searchTerms: ['paymentid', 'payment', 'id', 'payment id'],
          },
          {
            capabilityVersionId: 'cap-billing',
            direction: 'request' as const,
            path: '/display_name',
            type: 'string',
            required: false,
            label: 'Display Name',
            searchTerms: ['display_name', 'displayname', 'display', 'name'],
          },
          {
            capabilityVersionId: 'cap-billing',
            direction: 'request' as const,
            path: '/invoice-total',
            type: 'number',
            required: false,
            label: 'Invoice Total',
            searchTerms: ['invoice-total', 'invoicetotal', 'invoice', 'total'],
          },
        ],
      },
    ],
  };

  it('matches tokens and prefixes after normalizing camelCase, snake_case, and kebab-case', () => {
    expect(matchCapabilityReferences(index, 'GET')).toEqual([
      expect.objectContaining({ capabilityVersionId: 'cap-payments', label: 'getPayment' }),
      expect.objectContaining({ capabilityVersionId: 'cap-billing', label: 'getInvoice' }),
    ]);
    expect(matchCapabilityReferences(index, 'pay')).toEqual([
      expect.objectContaining({
        capabilityVersionId: 'cap-payments',
        label: 'getPayment',
      }),
      expect.objectContaining({
        capabilityVersionId: 'cap-payments',
        direction: 'request',
        path: '/paymentId',
      }),
      expect.objectContaining({
        capabilityVersionId: 'cap-billing',
        direction: 'request',
        path: '/paymentId',
      }),
    ]);
    expect(matchCapabilityReferences(index, 'pay')[0]).not.toHaveProperty('path');
    expect(matchCapabilityReferences(index, 'display_name')).toEqual([
      expect.objectContaining({ path: '/display_name' }),
    ]);
    expect(matchCapabilityReferences(index, 'invoice-tot')).toEqual([
      expect.objectContaining({ path: '/invoice-total' }),
    ]);
  });

  it('returns every duplicate field label instead of choosing a winner', () => {
    expect(matchCapabilityReferences(index, 'paymentId')).toEqual([
      {
        capabilityVersionId: 'cap-payments',
        identity: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
        owner: 'payments-team',
        direction: 'request',
        path: '/paymentId',
        label: 'Payment Id',
      },
      {
        capabilityVersionId: 'cap-billing',
        identity: { kind: 'openapi', serviceId: 'billing', operationId: 'getInvoice' },
        owner: 'billing-team',
        direction: 'request',
        path: '/paymentId',
        label: 'Payment Id',
      },
    ]);
  });

  it('does not use semantic guesses when tokens do not match', () => {
    expect(matchCapabilityReferences(index, 'charge')).toEqual([]);
    expect(matchCapabilityReferences(index, '')).toEqual([]);
  });
});

afterAll(async () => {
  await pool.end();
});

describe('GET /v1/planner-capability-references', () => {
  beforeAll(async () => {
    await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 89 });
    await pool.query('TRUNCATE organizations RESTART IDENTITY CASCADE');
  });

  it('returns a fingerprint-bound index containing only the current planner projection', async () => {
    const organizationId = 'org_reference_projection';
    const document = structuredClone(paymentDocument);
    Object.assign(document.paths, {
      '/unsafe': {
        get: {
          operationId: 'unsafeCapability',
          responses: { '204': { description: 'Discovered without annotations' } },
        },
      },
    });
    const ingestionResponse = await ingest(
      ingestionRequest({
        organizationId,
        source: { ...ingestionRequest().source, document },
      }),
    );
    expect(ingestionResponse.status).toBe(201);
    const ingestion = (await ingestionResponse.json()) as {
      capabilities: Array<{
        capabilityVersionId: string;
        identity: { operationId: string };
      }>;
    };
    const approvedVersionId = ingestion.capabilities.find(
      ({ identity }) => identity.operationId === 'getPayment',
    )!.capabilityVersionId;
    const excludedVersionId = ingestion.capabilities.find(
      ({ identity }) => identity.operationId === 'unsafeCapability',
    )!.capabilityVersionId;
    await approveCapability(organizationId, approvedVersionId);

    const projectionResponse = await app.request(
      `/v1/planner-capabilities?organizationId=${organizationId}`,
    );
    expect(projectionResponse.status).toBe(200);
    const projection = (await projectionResponse.json()) as {
      fingerprint: string;
      capabilities: Array<{ capabilityVersionId: string }>;
    };
    expect(projection.capabilities.map(({ capabilityVersionId }) => capabilityVersionId)).toEqual([
      approvedVersionId,
    ]);

    const response = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}`,
    );
    expect(response.status).toBe(200);
    const index = (await response.json()) as {
      status: string;
      fingerprint: string;
      references: Array<{
        capabilityVersionId: string;
        owner: string;
        provenance?: { evidence?: { path?: string } };
        fields: Array<{ direction: string; path: string }>;
      }>;
    };
    expect(index.status).toBe('ok');
    expect(index.fingerprint).toBe(projection.fingerprint);
    expect(index.references.map(({ capabilityVersionId }) => capabilityVersionId)).toEqual([
      approvedVersionId,
    ]);
    expect(index.references.map(({ capabilityVersionId }) => capabilityVersionId)).not.toContain(
      excludedVersionId,
    );
    expect(index.references[0]).toMatchObject({
      owner: 'payments-team',
      identity: { kind: 'openapi', serviceId: 'payments', operationId: 'getPayment' },
      provenance: {
        evidence: {
          kind: 'repository',
          repository: 'https://github.com/acme/payment-api',
          commit: '0123456789abcdef',
          path: 'openapi.json',
        },
      },
    });
    expect(index.references[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capabilityVersionId: approvedVersionId,
          direction: 'request',
          path: '/paymentId',
        }),
        expect.objectContaining({
          capabilityVersionId: approvedVersionId,
          direction: 'response',
          path: '/paymentId',
        }),
      ]),
    );
    expect(JSON.stringify(index)).not.toContain('payment-api-token');
    expect(JSON.stringify(index)).not.toContain('secretAlias');
    expect(JSON.stringify(index)).not.toContain('payments.internal');
  });

  it('keeps another organization and environment from seeing this projection', async () => {
    const organizationId = 'org_reference_isolation';
    const ingestionResponse = await ingest(ingestionRequest({ organizationId }));
    expect(ingestionResponse.status).toBe(201);
    const approvedVersionId = (
      (await ingestionResponse.json()) as { capabilities: Array<{ capabilityVersionId: string }> }
    ).capabilities[0]!.capabilityVersionId;
    await approveCapability(organizationId, approvedVersionId, 'production');

    const production = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}`,
    );
    const development = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}&environmentId=development`,
    );
    const otherOrg = await app.request(
      '/v1/planner-capability-references?organizationId=org_reference_other',
    );
    expect(production.status).toBe(200);
    expect(development.status).toBe(200);
    expect(otherOrg.status).toBe(200);
    await expect(production.json()).resolves.toMatchObject({
      status: 'ok',
      references: [{ capabilityVersionId: approvedVersionId }],
    });
    await expect(development.json()).resolves.toMatchObject({
      status: 'ok',
      references: [],
    });
    await expect(otherOrg.json()).resolves.toMatchObject({
      status: 'ok',
      references: [],
    });
  });

  it('returns an explicit stale result when the supplied fingerprint does not match', async () => {
    const organizationId = 'org_reference_stale';
    const first = await ingest(ingestionRequest({ organizationId }));
    const firstVersionId = (
      (await first.json()) as { capabilities: Array<{ capabilityVersionId: string }> }
    ).capabilities[0]!.capabilityVersionId;
    await approveCapability(organizationId, firstVersionId);

    const currentResponse = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}`,
    );
    const current = (await currentResponse.json()) as { fingerprint: string; status: string };
    const matching = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}&fingerprint=${current.fingerprint}`,
    );
    expect(matching.status).toBe(200);
    await expect(matching.json()).resolves.toMatchObject({
      status: 'ok',
      fingerprint: current.fingerprint,
    });
    const stale = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}&fingerprint=${'0'.repeat(64)}`,
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      status: 'stale',
      fingerprint: current.fingerprint,
    });

    await pool.query(
      `UPDATE capability_approvals SET revoked_at = current_timestamp
       WHERE organization_id = $1 AND capability_version_id = $2`,
      [organizationId, firstVersionId],
    );
    const afterRevoke = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}&fingerprint=${current.fingerprint}`,
    );
    expect(afterRevoke.status).toBe(409);
    const revoked = (await afterRevoke.json()) as { status: string; fingerprint: string };
    expect(revoked.status).toBe('stale');
    expect(revoked.fingerprint).not.toBe(current.fingerprint);

    const empty = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}`,
    );
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({
      status: 'ok',
      fingerprint: revoked.fingerprint,
      references: [],
    });
  });

  it('excludes superseded capability versions from the index', async () => {
    const organizationId = 'org_reference_superseded';
    const first = await ingest(ingestionRequest({ organizationId }));
    const firstVersionId = (
      (await first.json()) as { capabilities: Array<{ capabilityVersionId: string }> }
    ).capabilities[0]!.capabilityVersionId;
    await approveCapability(organizationId, firstVersionId);

    const changedDocument = structuredClone(paymentDocument);
    Object.assign(changedDocument.paths['/payments/{paymentId}'].get.responses, {
      '404': { description: 'Payment not found' },
    });
    const second = await ingest(
      ingestionRequest({
        organizationId,
        source: {
          ...ingestionRequest().source,
          document: changedDocument,
          commit: 'supersede-v2',
        },
        manifest: {
          ...ingestionRequest().manifest,
          source: { ...ingestionRequest().manifest.source, commit: 'supersede-v2' },
        },
      }),
    );
    expect(second.status).toBe(201);
    const secondVersionId = (
      (await second.json()) as { capabilities: Array<{ capabilityVersionId: string }> }
    ).capabilities[0]!.capabilityVersionId;

    const response = await app.request(
      `/v1/planner-capability-references?organizationId=${organizationId}`,
    );
    expect(response.status).toBe(200);
    const index = (await response.json()) as {
      status: string;
      references: Array<{ capabilityVersionId: string }>;
    };
    expect(index.status).toBe('ok');
    expect(index.references.map(({ capabilityVersionId }) => capabilityVersionId)).toEqual([]);
    expect(index.references.map(({ capabilityVersionId }) => capabilityVersionId)).not.toContain(
      firstVersionId,
    );
    expect(index.references.map(({ capabilityVersionId }) => capabilityVersionId)).not.toContain(
      secondVersionId,
    );
  });

  it('requires organizationId and defaults the environment like planner-capabilities', async () => {
    const missing = await app.request('/v1/planner-capability-references');
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: 'organizationId-required' });

    const organizationId = 'org_reference_default_env';
    const ingestionResponse = await ingest(ingestionRequest({ organizationId }));
    const approvedVersionId = (
      (await ingestionResponse.json()) as { capabilities: Array<{ capabilityVersionId: string }> }
    ).capabilities[0]!.capabilityVersionId;
    await approveCapability(organizationId, approvedVersionId);

    const omitted = await (
      await app.request(`/v1/planner-capability-references?organizationId=${organizationId}`)
    ).json();
    const explicit = await (
      await app.request(
        `/v1/planner-capability-references?organizationId=${organizationId}&environmentId=production`,
      )
    ).json();
    expect(omitted).toEqual(explicit);
  });
});
