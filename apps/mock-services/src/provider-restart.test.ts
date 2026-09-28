import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { PostgresProviderResourceStore, uniqueProviderId } from './provider-resource-store.js';

const databaseUrl =
  process.env.ATLAS_TEST_DATABASE_URL ?? 'postgresql://atlas:atlas@localhost:5432/atlas_test';
const providerId = uniqueProviderId('provider-restart');
const unrelatedProviderId = uniqueProviderId('provider-unrelated');
const stores: PostgresProviderResourceStore[] = [];
let providerProcess: ChildProcess | undefined;
let baseUrl = '';
let nextPort = 20_000 + Math.floor(Math.random() * 20_000);

const seed = {
  payments: [
    {
      paymentId: 'pay_restart',
      invoiceId: 'inv_restart',
      status: 'succeeded',
      amount: { value: 1250, currency: 'USD' },
      paidAt: '2026-08-03T18:00:00Z',
    },
  ],
  invoices: [
    {
      invoiceId: 'inv_restart',
      version: 1,
      status: 'open',
      outstandingBalance: { value: 1250, currency: 'USD' },
      customerId: 'cus_restart',
    },
  ],
};
const resources = [
  {
    service: 'payments',
    collection: 'payments',
    id: 'pay_restart',
    document: seed.payments[0],
  },
  {
    service: 'billing',
    collection: 'invoices',
    id: 'inv_restart',
    document: seed.invoices[0],
  },
];

async function startProvider(id: string) {
  const port = nextPort++;
  providerProcess = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(resolve('apps/mock-services/node_modules/tsx/dist/loader.mjs')).href,
      resolve('apps/mock-services/src/index.ts'),
    ],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        MOCK_SERVICES_PORT: String(port),
        MOCK_PROVIDER_DATABASE_URL: databaseUrl,
        MOCK_PROVIDER_ID: id,
        BILLING_FAILURE_RESPONSE_DELAY_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  await new Promise<void>((resolveStart, reject) => {
    let errors = '';
    providerProcess!.stderr?.on('data', (chunk) => (errors += String(chunk)));
    providerProcess!.once('exit', (code) =>
      reject(new Error(`Provider exited ${code}: ${errors}`)),
    );
    providerProcess!.stdout?.on('data', (chunk) => {
      if (String(chunk).includes('Atlas mock-service shell listening')) resolveStart();
    });
  });
  baseUrl = `http://127.0.0.1:${port}`;
}

async function stopProvider() {
  if (!providerProcess) return;
  if (providerProcess.exitCode === null) {
    const exited = new Promise<void>((resolveExit) =>
      providerProcess!.once('exit', () => resolveExit()),
    );
    providerProcess.kill();
    await exited;
  }
  providerProcess = undefined;
}

const request = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);
const json = (
  path: string,
  method: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) =>
  request(path, {
    method,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });

describe('PostgreSQL-backed mock provider restart', () => {
  beforeAll(async () => startProvider(providerId));

  afterAll(async () => {
    await stopProvider();
    await Promise.all(stores.map((store) => store.close()));
  });

  it('keeps every service’s resources, the global ledger, and history across a process restart', async () => {
    expect((await json('/__control/resources', 'PUT', { mode: 'replace', resources })).status).toBe(
      204,
    );
    const unrelated = new PostgresProviderResourceStore(databaseUrl, unrelatedProviderId);
    stores.push(unrelated);
    await unrelated.reset([
      {
        serviceId: 'payments',
        collection: 'payments',
        resourceId: 'pay_unrelated',
        document: { ...seed.payments[0], paymentId: 'pay_unrelated' },
        version: 1,
      },
    ]);

    const beginBody = {
      paymentId: 'pay_restart',
      expectedInvoiceVersion: 1,
      idempotencyKey: 'begin:pay_restart',
    };
    const begin = await json('/invoices/inv_restart/settlement', 'POST', beginBody, {
      authorization: 'Bearer secret-not-stored',
    });
    await expect(begin.json()).resolves.toMatchObject({ status: 'settling', version: 2 });
    await expect(
      (
        await json('/operations/payment-notifications', 'POST', {
          atlasWorkflowRunId: 'run_restart',
          invoiceId: 'inv_restart',
          paymentId: 'pay_restart',
          idempotencyKey: 'notify:run_restart',
        })
      ).json(),
    ).resolves.toEqual({ notified: true });

    await stopProvider();
    await startProvider(providerId);

    // Payments service: a plain resource read survives.
    await expect((await request('/payments/pay_restart')).json()).resolves.toEqual(
      seed.payments[0],
    );
    // Billing service: the mutated invoice and its version survive.
    await expect((await request('/invoices/inv_restart')).json()).resolves.toMatchObject({
      status: 'settling',
      version: 2,
    });
    // The global idempotency ledger survives for both services.
    await expect(
      (await json('/invoices/inv_restart/settlement', 'POST', beginBody)).json(),
    ).resolves.toMatchObject({ status: 'settling', version: 2 });
    await expect(
      (
        await json('/operations/payment-notifications', 'POST', {
          atlasWorkflowRunId: 'run_restart',
          invoiceId: 'inv_restart',
          paymentId: 'pay_restart',
          idempotencyKey: 'notify:run_restart',
        })
      ).json(),
    ).resolves.toEqual({ notified: true });

    const observations = await (await request('/__control/observations')).json();
    expect(observations.payments).toEqual(seed.payments);
    expect(observations.invoices).toMatchObject([{ status: 'settling', version: 2 }]);
    expect(observations.idempotencyKeys).toEqual(['begin:pay_restart', 'notify:run_restart']);
    expect(observations.billingMutations).toEqual([
      expect.objectContaining({ operationId: 'beginInvoiceSettlement', replayed: false }),
      expect.objectContaining({ operationId: 'beginInvoiceSettlement', replayed: true }),
    ]);
    // Notification observations are ephemeral scenario state and reset with the process.
    expect(observations.notifications).toEqual([]);
    expect(JSON.stringify(observations)).not.toContain('secret-not-stored');

    // Resetting this provider never touches another provider's rows.
    expect(
      (await json('/__control/resources', 'PUT', { mode: 'replace', resources: [] })).status,
    ).toBe(204);
    expect((await request('/payments/pay_restart')).status).toBe(404);
    await expect(
      unrelated.read({
        serviceId: 'payments',
        collection: 'payments',
        resourceId: 'pay_unrelated',
      }),
    ).resolves.toMatchObject({ version: 1 });
  });
});
