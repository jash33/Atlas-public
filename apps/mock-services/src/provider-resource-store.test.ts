import { afterAll, beforeEach, describe, expect, it } from 'vite-plus/test';

import {
  MemoryProviderResourceStore,
  PostgresProviderResourceStore,
  uniqueProviderId,
  type ProviderResourceStore,
} from './provider-resource-store.js';

const databaseUrl =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgresql://atlas:atlas@localhost:5432/atlas_test';

const payment = { paymentId: 'pay_1', amount: 5000 };
const invoice = { invoiceId: 'inv_1', status: 'open', version: 1 };
const seed = [
  {
    serviceId: 'payments',
    collection: 'payments',
    resourceId: 'pay_1',
    document: payment,
    version: 1,
  },
  {
    serviceId: 'billing',
    collection: 'invoices',
    resourceId: 'inv_1',
    document: invoice,
    version: 1,
  },
];
const invoiceKey = { serviceId: 'billing', collection: 'invoices', resourceId: 'inv_1' };

const openStores: PostgresProviderResourceStore[] = [];
const implementations: Array<[string, () => ProviderResourceStore]> = [
  ['in-memory', () => new MemoryProviderResourceStore()],
  [
    'PostgreSQL',
    () => {
      const store = new PostgresProviderResourceStore(databaseUrl, uniqueProviderId('store'));
      openStores.push(store);
      return store;
    },
  ],
];

afterAll(async () => {
  await Promise.all(openStores.map((store) => store.close()));
});

describe.each(implementations)('%s provider resource store', (_name, createStore) => {
  let store: ProviderResourceStore;

  beforeEach(async () => {
    store = createStore();
    await store.reset(seed);
  });

  it('reads and lists seeded resources by service and collection without knowing their shape', async () => {
    await expect(
      store.read({ serviceId: 'payments', collection: 'payments', resourceId: 'pay_1' }),
    ).resolves.toEqual({ document: payment, version: 1 });
    await expect(store.read(invoiceKey)).resolves.toEqual({ document: invoice, version: 1 });
    await expect(
      store.read({ serviceId: 'payments', collection: 'payments', resourceId: 'inv_1' }),
    ).resolves.toBeUndefined();
    await expect(store.list('billing', 'invoices')).resolves.toEqual([
      { document: invoice, version: 1 },
    ]);
    await expect(store.list('billing', 'payments')).resolves.toEqual([]);
  });

  it('lists resources and idempotency keys in the same order on every implementation', async () => {
    await store.reset([
      { ...seed[1]!, resourceId: 'inv_b', document: { ...invoice, invoiceId: 'inv_b' } },
      { ...seed[1]!, resourceId: 'inv_a', document: { ...invoice, invoiceId: 'inv_a' } },
      { ...seed[1]!, resourceId: 'inv_C', document: { ...invoice, invoiceId: 'inv_C' } },
    ]);
    await store.claimIdempotent('notify:run_1', { notified: true });
    await store.claimIdempotent('begin:pay_1', { notified: true });
    await store.claimIdempotent('Zed', { notified: true });

    const listed = await store.list<typeof invoice>('billing', 'invoices');
    expect(listed.map(({ document }) => document.invoiceId)).toEqual(['inv_C', 'inv_a', 'inv_b']);
    await expect(store.idempotencyKeys()).resolves.toEqual(['Zed', 'begin:pay_1', 'notify:run_1']);
  });

  it('applies a transition only when the expected version matches', async () => {
    const applied = await store.mutate<typeof invoice>({
      ...invoiceKey,
      operationId: 'beginInvoiceSettlement',
      expectedVersion: 1,
      idempotencyKey: null,
      transition: ({ document }) => ({
        kind: 'apply',
        document: { ...document, status: 'settling', version: 2 },
      }),
    });
    expect(applied).toEqual({
      kind: 'applied',
      before: { document: invoice, version: 1 },
      after: { document: { ...invoice, status: 'settling', version: 2 }, version: 2 },
    });

    const stale = await store.mutate<typeof invoice>({
      ...invoiceKey,
      operationId: 'beginInvoiceSettlement',
      expectedVersion: 1,
      idempotencyKey: null,
      transition: ({ document }) => ({ kind: 'apply', document: { ...document, status: 'paid' } }),
    });
    expect(stale).toEqual({
      kind: 'version-conflict',
      current: { document: { ...invoice, status: 'settling', version: 2 }, version: 2 },
    });
    await expect(store.read(invoiceKey)).resolves.toMatchObject({ version: 2 });
  });

  it('reports missing resources and transition rejections without writing', async () => {
    await expect(
      store.mutate({
        ...invoiceKey,
        resourceId: 'inv_missing',
        operationId: 'markInvoicePaid',
        expectedVersion: 1,
        idempotencyKey: null,
        transition: ({ document }) => ({ kind: 'apply', document }),
      }),
    ).resolves.toEqual({ kind: 'not-found' });

    await expect(
      store.mutate({
        ...invoiceKey,
        operationId: 'markInvoicePaid',
        expectedVersion: 1,
        idempotencyKey: 'paid:pay_1',
        transition: () => ({ kind: 'reject', errorType: 'InvoiceNotSettling' }),
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      errorType: 'InvoiceNotSettling',
      current: { document: invoice, version: 1 },
    });
    await expect(store.read(invoiceKey)).resolves.toEqual({ document: invoice, version: 1 });
    await expect(store.idempotencyKeys()).resolves.toEqual([]);
  });

  it('replays an applied mutation from one provider-wide idempotency ledger', async () => {
    const request = {
      ...invoiceKey,
      operationId: 'beginInvoiceSettlement',
      expectedVersion: 1,
      idempotencyKey: 'shared-key',
      transition: ({ document }: { document: typeof invoice }) => ({
        kind: 'apply' as const,
        document: { ...document, status: 'settling', version: 2 },
      }),
    };
    await store.mutate(request);
    const replayed = await store.mutate({ ...request, expectedVersion: 2 });
    expect(replayed).toEqual({
      kind: 'replayed',
      result: { ...invoice, status: 'settling', version: 2 },
      current: { document: { ...invoice, status: 'settling', version: 2 }, version: 2 },
    });
    await expect(store.read(invoiceKey)).resolves.toMatchObject({ version: 2 });

    await expect(store.findIdempotent('shared-key')).resolves.toEqual({
      result: { ...invoice, status: 'settling', version: 2 },
    });
    await expect(store.findIdempotent('unknown')).resolves.toBeUndefined();
    await expect(store.claimIdempotent('shared-key', { notified: true })).resolves.toEqual({
      replayed: true,
      result: { ...invoice, status: 'settling', version: 2 },
    });
    await expect(store.claimIdempotent('notify:run_1', { notified: true })).resolves.toEqual({
      replayed: false,
      result: { notified: true },
    });
    await expect(store.idempotencyKeys()).resolves.toEqual(['notify:run_1', 'shared-key']);
  });

  it('records service-tagged operation history in order, including observations made during mutate', async () => {
    await store.mutate<typeof invoice>({
      ...invoiceKey,
      operationId: 'beginInvoiceSettlement',
      expectedVersion: 1,
      idempotencyKey: 'begin:pay_1',
      transition: ({ document }) => ({
        kind: 'apply',
        document: { ...document, status: 'settling', version: 2 },
      }),
      observe: (outcome) => ({ outcome: outcome.kind, paymentId: 'pay_1' }),
    });
    await store.recordOperation({
      serviceId: 'payments',
      operationId: 'getPayment',
      observation: { outcome: 'failed' },
    });

    await expect(store.operationHistory()).resolves.toEqual([
      {
        serviceId: 'billing',
        operationId: 'beginInvoiceSettlement',
        observation: { outcome: 'applied', paymentId: 'pay_1' },
      },
      { serviceId: 'payments', operationId: 'getPayment', observation: { outcome: 'failed' } },
    ]);
    await expect(store.operationHistory('billing')).resolves.toHaveLength(1);
  });

  it('clears resources, ledger, and history on reset', async () => {
    await store.claimIdempotent('notify:run_1', { notified: true });
    await store.recordOperation({ serviceId: 'billing', operationId: 'x', observation: {} });

    await store.reset([]);

    await expect(store.read(invoiceKey)).resolves.toBeUndefined();
    await expect(store.idempotencyKeys()).resolves.toEqual([]);
    await expect(store.operationHistory()).resolves.toEqual([]);
  });
});

describe('PostgreSQL provider isolation', () => {
  it('resets only the configured provider and survives a new store instance', async () => {
    const first = new PostgresProviderResourceStore(databaseUrl, uniqueProviderId('isolation'));
    const otherProviderId = uniqueProviderId('other');
    const other = new PostgresProviderResourceStore(databaseUrl, otherProviderId);
    openStores.push(first);
    await first.reset(seed);
    await other.reset([{ ...seed[1]!, resourceId: 'inv_other' }]);

    await first.reset([]);
    await expect(first.list('billing', 'invoices')).resolves.toEqual([]);
    await expect(other.read({ ...invoiceKey, resourceId: 'inv_other' })).resolves.toEqual({
      document: invoice,
      version: 1,
    });

    await other.close();
    const reopened = new PostgresProviderResourceStore(databaseUrl, otherProviderId);
    openStores.push(reopened);
    await expect(reopened.list('billing', 'invoices')).resolves.toEqual([
      { document: invoice, version: 1 },
    ]);
  });

  it('requires an explicit provider ID', () => {
    expect(() => new PostgresProviderResourceStore(databaseUrl, ' ')).toThrow(/provider/i);
  });
});
