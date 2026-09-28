import { invoiceSchema, type Invoice } from './contracts.js';
import type {
  MutationOutcome,
  ProviderResourceStore,
  SeedResource,
  StoredResource,
} from './provider-resource-store.js';

/**
 * Billing's domain rules (issue #21) expressed over the generic {@link ProviderResourceStore}.
 *
 * Invoices live at `('billing', 'invoices', invoiceId)`. The stored resource version is seeded from
 * `invoice.version` and every transition advances both by one, so `expectedInvoiceVersion` maps
 * directly onto the store's optimistic-concurrency guard. Idempotency keys go to the provider-wide
 * ledger, which is what makes the key space global across services.
 */
export type BillingMutationOperationId =
  | 'beginInvoiceSettlement'
  | 'markInvoicePaid'
  | 'cancelInvoiceSettlement';

export type BillingMutationOutcome =
  | { kind: 'applied' | 'succeeded' | 'schema-violation' }
  | { kind: 'rejected' | 'failed'; errorType: string };

export interface BillingMutationObservation {
  operationId: BillingMutationOperationId;
  requestIdentity: { invoiceId: string; paymentId: string; expectedInvoiceVersion: number };
  idempotencyKey: string;
  beforeState: Invoice | null;
  afterState: Invoice | null;
  outcome: BillingMutationOutcome;
  replayed: boolean;
}

export interface BillingMutationIdentity {
  operationId: BillingMutationOperationId;
  invoiceId: string;
  paymentId: string;
  expectedInvoiceVersion: number;
  idempotencyKey: string;
}

export interface BillingMutationRequest extends BillingMutationIdentity {
  requiredStatus: 'open' | 'settling';
  transition: (invoice: Invoice) => Invoice;
}

export type BillingMutationResult =
  | { kind: 'applied' | 'replayed'; invoice: Invoice }
  | { kind: 'rejected'; errorType: string };

const SERVICE_ID = 'billing';
const COLLECTION = 'invoices';

export const invoiceResource = (invoice: Invoice): SeedResource => ({
  serviceId: SERVICE_ID,
  collection: COLLECTION,
  resourceId: invoice.invoiceId,
  document: invoice,
  version: invoice.version,
});

const invoiceKey = (invoiceId: string) => ({
  serviceId: SERVICE_ID,
  collection: COLLECTION,
  resourceId: invoiceId,
});

const parseInvoice = (resource: StoredResource | undefined) =>
  resource ? invoiceSchema.parse(resource.document) : undefined;

const observationFor = (
  request: BillingMutationIdentity,
  beforeState: Invoice | undefined,
  afterState: Invoice | undefined,
  outcome: BillingMutationOutcome,
  replayed = false,
): BillingMutationObservation => ({
  operationId: request.operationId,
  requestIdentity: {
    invoiceId: request.invoiceId,
    paymentId: request.paymentId,
    expectedInvoiceVersion: request.expectedInvoiceVersion,
  },
  idempotencyKey: request.idempotencyKey,
  beforeState: beforeState ?? null,
  afterState: afterState ?? null,
  outcome,
  replayed,
});

function observeMutation(
  request: BillingMutationIdentity,
  outcome: MutationOutcome<Invoice>,
): BillingMutationObservation {
  switch (outcome.kind) {
    case 'applied':
      return observationFor(request, outcome.before.document, outcome.after.document, {
        kind: 'applied',
      });
    case 'replayed': {
      const current = outcome.current?.document;
      return observationFor(request, current, current, { kind: 'succeeded' }, true);
    }
    case 'not-found':
      return observationFor(request, undefined, undefined, {
        kind: 'rejected',
        errorType: 'InvoiceNotFound',
      });
    case 'version-conflict':
      return observationFor(request, outcome.current.document, outcome.current.document, {
        kind: 'rejected',
        errorType: 'InvoiceVersionStale',
      });
    case 'rejected':
      return observationFor(request, outcome.current.document, outcome.current.document, {
        kind: 'rejected',
        errorType: outcome.errorType,
      });
  }
}

export function createBillingModule(store: ProviderResourceStore) {
  const record = (
    operationId: BillingMutationOperationId,
    observation: BillingMutationObservation,
  ) => store.recordOperation({ serviceId: SERVICE_ID, operationId, observation });

  const readInvoice = async (invoiceId: string) =>
    parseInvoice(await store.read(invoiceKey(invoiceId)));

  return {
    readInvoice,

    /** Returns the prior result for an already-applied key and records the replay. */
    async replay(request: BillingMutationIdentity): Promise<Invoice | undefined> {
      const prior = await store.findIdempotent(request.idempotencyKey);
      if (!prior) return undefined;
      const invoice = await readInvoice(request.invoiceId);
      await record(
        request.operationId,
        observationFor(request, invoice, invoice, { kind: 'succeeded' }, true),
      );
      return invoiceSchema.parse(prior.result);
    },

    /** Records an injected fault against the current invoice state without changing it. */
    async recordFailure(request: BillingMutationIdentity, outcome: BillingMutationOutcome) {
      const invoice = await readInvoice(request.invoiceId);
      await record(request.operationId, observationFor(request, invoice, invoice, outcome));
    },

    /** Injected stale-version fault: advances the invoice so the caller's version is stale. */
    async recordStaleVersion(request: BillingMutationIdentity): Promise<boolean> {
      const outcome = await store.mutate<Invoice>({
        ...invoiceKey(request.invoiceId),
        operationId: request.operationId,
        expectedVersion: null,
        idempotencyKey: null,
        transition: ({ document }) => {
          const invoice = invoiceSchema.parse(document);
          return { kind: 'apply', document: { ...invoice, version: invoice.version + 1 } };
        },
        observe: (result) =>
          result.kind === 'applied'
            ? observationFor(request, result.before.document, result.after.document, {
                kind: 'rejected',
                errorType: 'InvoiceVersionStale',
              })
            : observeMutation(request, result),
      });
      return outcome.kind === 'applied';
    },

    async mutate(request: BillingMutationRequest): Promise<BillingMutationResult> {
      const outcome = await store.mutate<Invoice>({
        ...invoiceKey(request.invoiceId),
        operationId: request.operationId,
        expectedVersion: request.expectedInvoiceVersion,
        idempotencyKey: request.idempotencyKey,
        transition: ({ document }) => {
          const invoice = invoiceSchema.parse(document);
          if (invoice.status !== request.requiredStatus) {
            return {
              kind: 'reject',
              errorType:
                request.requiredStatus === 'open' ? 'InvoiceNotOpen' : 'InvoiceNotSettling',
            };
          }
          return { kind: 'apply', document: request.transition(invoice) };
        },
        observe: (result) => observeMutation(request, result),
      });
      switch (outcome.kind) {
        case 'applied':
          return { kind: 'applied', invoice: outcome.after.document };
        case 'replayed':
          return { kind: 'replayed', invoice: invoiceSchema.parse(outcome.result) };
        case 'not-found':
          return { kind: 'rejected', errorType: 'InvoiceNotFound' };
        case 'version-conflict':
          return { kind: 'rejected', errorType: 'InvoiceVersionStale' };
        case 'rejected':
          return { kind: 'rejected', errorType: outcome.errorType };
      }
    },

    async observations() {
      const [invoices, history] = await Promise.all([
        store.list(SERVICE_ID, COLLECTION),
        store.operationHistory(SERVICE_ID),
      ]);
      return {
        invoices: invoices.map((resource) => invoiceSchema.parse(resource.document)),
        billingMutations: history.map(
          ({ observation }) => observation as BillingMutationObservation,
        ),
      };
    },
  };
}

export type BillingModule = ReturnType<typeof createBillingModule>;
