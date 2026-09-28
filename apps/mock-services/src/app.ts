import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  billingSpecMutationSchema,
  faultPlanSchema,
  invoiceContractVariants,
  invoiceMutationSchema,
  invoicePaidEventSchema,
  invoiceSchema,
  mappingDemoBillingSettlementSchema,
  notifiedAckSchema,
  paymentOperationsNotificationSchema,
  paymentSchema,
  publishedAckSchema,
  slackChatPostMessageRequestSchema,
  slackChatPostMessageResponseSchema,
  hubSpotCreateContactRequestSchema,
  hubSpotContactSchema,
  stripePaymentIntentRequestSchema,
  stripePaymentIntentSchema,
  type BillingSpecMutation,
  type FaultPlan,
  type Invoice,
  type InvoicePaidEvent,
  type OperationId,
  type PaymentOperationsNotification,
} from './contracts.js';
import { createServiceDocuments } from './documents.js';
import { serviceOperations } from './operations.js';
import { executeProviderSandboxCase, runWorkflowSandboxSuite } from './workflow-sandbox.js';
import {
  MemoryProviderResourceStore,
  type ProviderResourceStore,
} from './provider-resource-store.js';
import { createBillingModule, type BillingMutationOperationId } from './billing.js';

const healthResponseSchema = z.object({
  service: z.literal('mock-services'),
  status: z.literal('ok'),
});

const resourceControlSchema = z
  .object({
    mode: z.enum(['replace', 'merge']),
    resources: z.array(
      z
        .object({
          service: z.string().min(1),
          collection: z.string().min(1),
          id: z.string().min(1),
          document: z.unknown(),
        })
        .strict(),
    ),
  })
  .strict();

export interface MockServicesOptions {
  /** Resource-shaped provider state; defaults to isolated in-memory state for unit tests. */
  resourceStore?: ProviderResourceStore;
  billingFailureResponseDelayMs?: number;
  stripeOfficialTest?: {
    apiKey: string;
    fetch?: typeof globalThis.fetch;
  };
  slackConnection?: { mode: 'contract-faithful-rehearsal' | 'official-test' };
  hubspotConnection?: { mode: 'contract-faithful-rehearsal' | 'official-test' };
  onRemoteSandboxRequest?: (serviceId: string) => void;
}

export function createMockServicesApp(options: MockServicesOptions = {}): Hono {
  // Resource-shaped state (payments, invoices, the global idempotency ledger, operation history)
  // lives in the provider resource store and survives restarts when PostgreSQL is configured.
  const store = options.resourceStore ?? new MemoryProviderResourceStore();
  const billing = createBillingModule(store);
  // Everything below is ephemeral scenario state: fault plans, deterministic retry counters,
  // provider-condition repairs, published-event and notification observations, and third-party
  // rehearsal records. It is reset with the process on purpose.
  const faultPlans = new Map<OperationId, { plan: FaultPlan; attempts: number }>();
  const deterministicRetryAttempts = new Map<string, number>();
  const repairedProviderConditions = new Map<OperationId, string>();
  const publishedEvents = new Map<string, InvoicePaidEvent>();
  const notifications: PaymentOperationsNotification[] = [];
  const stripePaymentIntents = new Map<string, z.infer<typeof stripePaymentIntentSchema>>();
  const slackMessages = new Map<string, z.infer<typeof slackChatPostMessageResponseSchema>>();
  const hubspotContacts = new Map<string, z.infer<typeof hubSpotContactSchema>>();
  const mappingDemoBillingRequests: Array<{ request: unknown; providerDurationMs: number }> = [];
  let billingSpecMutation: BillingSpecMutation = 'baseline';

  const serializeInvoice = (invoice: Invoice) =>
    invoiceContractVariants[billingSpecMutation].serialize(invoice);
  const serviceDocuments = () =>
    createServiceDocuments(
      billingSpecMutation,
      options.stripeOfficialTest ? { mode: 'official-test' } : undefined,
      options.slackConnection,
      options.hubspotConnection,
    );
  const serializeIdempotentResult = (result: unknown) => {
    const invoice = invoiceSchema.safeParse(result);
    return invoice.success ? serializeInvoice(invoice.data) : result;
  };

  function takeFault(operationId: OperationId, stepId?: string) {
    const configured = faultPlans.get(operationId);
    if (!configured || (configured.plan.stepId && configured.plan.stepId !== stepId)) {
      return undefined;
    }

    configured.attempts += 1;
    switch (configured.plan.mode) {
      case 'transient':
        return configured.attempts <= configured.plan.failures
          ? { kind: 'error' as const, status: 503 as const, errorType: 'TransientDownstream' }
          : undefined;
      case 'permanent':
        return {
          kind: 'error' as const,
          status: 500 as const,
          errorType: configured.plan.errorType,
        };
      case 'schema-violation':
        return { kind: 'schema-violation' as const };
      case 'stale-version':
        return configured.attempts <= configured.plan.failures
          ? { kind: 'stale-version' as const }
          : undefined;
      case 'rate-limit':
        return { kind: 'error' as const, status: 429 as const, errorType: 'RateLimited' };
      case 'timeout':
        return { kind: 'error' as const, status: 504 as const, errorType: 'ProviderTimeout' };
      case 'none':
        return undefined;
    }
  }

  async function waitForInjectedTimeout(errorType: string) {
    if (errorType !== 'ProviderTimeout') return;
    await new Promise((resolve) =>
      setTimeout(resolve, options.billingFailureResponseDelayMs ?? 100),
    );
  }

  async function executeBillingMutation(
    operationId: BillingMutationOperationId,
    stepId: string | undefined,
    invoiceId: string,
    input: z.infer<typeof invoiceMutationSchema>,
    requiredStatus: 'open' | 'settling',
    transition: (invoice: Invoice) => Invoice,
  ): Promise<Response> {
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=UTF-8' },
      });

    const replay = await billing.replay({ operationId, invoiceId, ...input });
    if (replay) return respond(serializeInvoice(replay));

    const fault = takeFault(operationId, stepId);
    if (fault?.kind === 'error') {
      await billing.recordFailure(
        { operationId, invoiceId, ...input },
        { kind: 'failed', errorType: fault.errorType },
      );
      await waitForInjectedTimeout(fault.errorType);
      return respond({ error: { type: fault.errorType } }, fault.status);
    }
    if (fault?.kind === 'schema-violation') {
      await billing.recordFailure(
        { operationId, invoiceId, ...input },
        { kind: 'schema-violation' },
      );
      return respond({ schemaViolation: true });
    }
    if (fault?.kind === 'stale-version') {
      const stale = await billing.recordStaleVersion({ operationId, invoiceId, ...input });
      const errorType = stale ? 'InvoiceVersionStale' : 'InvoiceNotFound';
      return respond({ error: { type: errorType } }, stale ? 409 : 404);
    }
    const result = await billing.mutate({
      operationId,
      invoiceId,
      ...input,
      requiredStatus,
      transition,
    });
    if (result.kind === 'rejected') {
      return respond(
        { error: { type: result.errorType } },
        result.errorType === 'InvoiceNotFound' ? 404 : 409,
      );
    }
    return respond(serializeInvoice(result.invoice));
  }

  return new Hono()
    .use(
      '/specs/*',
      cors({
        origin: (origin) =>
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : undefined,
      }),
    )
    .get('/health', (context) =>
      context.json(
        healthResponseSchema.parse({
          service: 'mock-services',
          status: 'ok',
        }),
      ),
    )
    .put('/__control/resources', async (context) => {
      const parsed = resourceControlSchema.safeParse(await context.req.json().catch(() => null));
      if (!parsed.success) return context.json({ error: 'invalid-resource-control' }, 400);
      const input = parsed.data;
      const resources = input.resources.map(({ service, collection, id, document }) => {
        const seededInvoice =
          service === 'billing' && collection === 'invoices'
            ? invoiceSchema.safeParse(document)
            : undefined;
        return {
          serviceId: service,
          collection,
          resourceId: id,
          document,
          version: seededInvoice?.success ? seededInvoice.data.version : 1,
        };
      });

      if (input.mode === 'replace') {
        faultPlans.clear();
        deterministicRetryAttempts.clear();
        repairedProviderConditions.clear();
        publishedEvents.clear();
        notifications.length = 0;
        stripePaymentIntents.clear();
        slackMessages.clear();
        hubspotContacts.clear();
        mappingDemoBillingRequests.length = 0;
        await store.reset(resources);
      } else {
        await store.merge(resources);
      }

      return context.body(null, 204);
    })
    .get('/__control/resources', async (context) => {
      const resources = await store.listResources(
        context.req.query('service') || undefined,
        context.req.query('collection') || undefined,
      );
      return context.json({
        resources: resources.map(({ serviceId, collection, resourceId, document }) => ({
          service: serviceId,
          collection,
          id: resourceId,
          document,
        })),
      });
    })
    .put('/__control/faults', async (context) => {
      const plan = faultPlanSchema.parse(await context.req.json());
      if (plan.mode === 'none') faultPlans.delete(plan.operationId);
      else faultPlans.set(plan.operationId, { plan, attempts: 0 });
      return context.body(null, 204);
    })
    .put('/__control/provider-conditions', async (context) => {
      const repair = z
        .object({
          operationId: z.enum(['publishInvoicePaid']),
          repairedCapabilityVersionId: z.string().min(1),
        })
        .strict()
        .safeParse(await context.req.json().catch(() => null));
      if (!repair.success) return context.json({ error: 'invalid-provider-condition-repair' }, 400);
      repairedProviderConditions.set(
        repair.data.operationId,
        repair.data.repairedCapabilityVersionId,
      );
      return context.body(null, 204);
    })
    .put('/__control/specs/billing', async (context) => {
      billingSpecMutation = billingSpecMutationSchema.parse(await context.req.json()).mutation;
      return context.body(null, 204);
    })
    .post('/__control/workflow-sandbox-tests', async (context) => {
      const availableDocuments = serviceDocuments();
      const documents: Record<string, unknown> = {
        ...availableDocuments,
        payments: availableDocuments.payment,
      };
      return context.json(
        await runWorkflowSandboxSuite(await context.req.json(), documents, (suite, test) =>
          executeProviderSandboxCase(suite, test, (onRemoteSandboxRequest) =>
            createMockServicesApp({ ...options, onRemoteSandboxRequest }),
          ),
        ),
      );
    })
    .get('/specs/payment.openapi.json', (context) => context.json(serviceDocuments().payment))
    .get('/specs/billing.openapi.json', (context) => context.json(serviceDocuments().billing))
    .get('/specs/operations.openapi.json', (context) => context.json(serviceDocuments().operations))
    .get('/specs/events.asyncapi.json', (context) => context.json(serviceDocuments().events))
    .get('/specs/stripe.openapi.json', (context) => context.json(serviceDocuments().stripe))
    .get('/specs/slack.openapi.json', (context) => context.json(serviceDocuments().slack))
    .get('/specs/hubspot.openapi.json', (context) => context.json(serviceDocuments().hubspot))
    .get(serviceOperations.getMappingDemoPayment.path, (context) =>
      context.json({
        payment_id: context.req.param('paymentId'),
        invoice_id: 'inv_456',
        amount_cents: 1250,
        currency: 'usd',
        customer: { notification_email: 'ops@example.test' },
      }),
    )
    .post(serviceOperations.settleMappingDemoInvoice.path, async (context) => {
      const startedAt = Date.now();
      const request = mappingDemoBillingSettlementSchema.parse(await context.req.json());
      await new Promise((resolve) => setTimeout(resolve, 20));
      const { idempotencyKey: _idempotencyKey, ...businessRequest } = request;
      mappingDemoBillingRequests.push({
        request: businessRequest,
        providerDurationMs: Date.now() - startedAt,
      });
      return context.json({ accepted: true }, 202);
    })
    .on(
      serviceOperations.createPaymentIntent.method,
      serviceOperations.createPaymentIntent.path,
      async (context) => {
        if (!context.req.header('authorization')?.startsWith('Basic ')) {
          return context.json({ error: { type: 'StripeAuthenticationError' } }, 401);
        }
        const fault = takeFault(
          'PostPaymentIntents',
          context.req.header('x-atlas-sandbox-step-id'),
        );
        if (fault?.kind === 'error') {
          await waitForInjectedTimeout(fault.errorType);
          return context.json({ error: { type: fault.errorType } }, fault.status);
        }
        const idempotencyKey = context.req.header('idempotency-key');
        if (!idempotencyKey) {
          return context.json({ error: { type: 'StripeIdempotencyKeyRequired' } }, 400);
        }
        const previous = stripePaymentIntents.get(idempotencyKey);
        if (previous) return context.json(previous);

        const input = stripePaymentIntentRequestSchema.parse(await context.req.parseBody());
        if (options.stripeOfficialTest) {
          options.onRemoteSandboxRequest?.('stripe');
          const response = await (options.stripeOfficialTest.fetch ?? globalThis.fetch)(
            'https://api.stripe.com/v1/payment_intents',
            {
              method: 'POST',
              headers: {
                authorization: `Basic ${Buffer.from(`${options.stripeOfficialTest.apiKey}:`).toString('base64')}`,
                'content-type': 'application/x-www-form-urlencoded',
                'idempotency-key': idempotencyKey,
              },
              body: new URLSearchParams({
                amount: String(input.amount),
                currency: input.currency.toLowerCase(),
              }),
            },
          );
          return new Response(response.body, {
            status: response.status,
            headers: {
              'content-type': response.headers.get('content-type') ?? 'application/json',
            },
          });
        }
        const paymentIntent = stripePaymentIntentSchema.parse({
          id: `pi_${idempotencyKey}`,
          object: 'payment_intent',
          amount: input.amount,
          currency: input.currency.toLowerCase(),
          livemode: false,
          status: 'succeeded',
        });
        stripePaymentIntents.set(idempotencyKey, paymentIntent);
        return context.json(paymentIntent);
      },
    )
    .on(
      serviceOperations.postSlackMessage.method,
      serviceOperations.postSlackMessage.path,
      async (context) => {
        if (!context.req.header('authorization')?.startsWith('Bearer ')) {
          return context.json({ ok: false, error: 'not_authed' }, 401);
        }
        const fault = takeFault('chat_postMessage', context.req.header('x-atlas-sandbox-step-id'));
        if (fault?.kind === 'error') {
          await waitForInjectedTimeout(fault.errorType);
          return context.json({ ok: false, error: fault.errorType }, fault.status);
        }
        const input = slackChatPostMessageRequestSchema.parse(await context.req.json());
        const messageKey = input.client_msg_id ?? `${input.channel}:${input.text}`;
        const previous = slackMessages.get(messageKey);
        if (previous) return context.json(previous);
        const result = slackChatPostMessageResponseSchema.parse({
          ok: true,
          channel: input.channel,
          ts: `1710000000.${String(slackMessages.size + 1).padStart(6, '0')}`,
          message: { text: input.text },
        });
        slackMessages.set(messageKey, result);
        return context.json(result);
      },
    )
    .on(
      serviceOperations.createHubSpotContact.method,
      serviceOperations.createHubSpotContact.path,
      async (context) => {
        if (!context.req.header('authorization')?.startsWith('Bearer ')) {
          return context.json(
            {
              status: 'error',
              category: 'INVALID_AUTHENTICATION',
              message: 'Authentication required',
            },
            401,
          );
        }
        const fault = takeFault('createContact', context.req.header('x-atlas-sandbox-step-id'));
        if (fault?.kind === 'error') {
          await waitForInjectedTimeout(fault.errorType);
          return context.json(
            { status: 'error', category: fault.errorType, message: fault.errorType },
            fault.status,
          );
        }
        const input = hubSpotCreateContactRequestSchema.parse(await context.req.json());
        const idempotencyKey = input.properties.email;
        const previous = hubspotContacts.get(idempotencyKey);
        if (previous) {
          return context.json(
            {
              status: 'error',
              category: 'CONFLICT',
              message: 'A contact with this email already exists',
            },
            409,
          );
        }
        const timestamp = '2026-08-16T12:00:00.000Z';
        const result = hubSpotContactSchema.parse({
          id: String(100_001 + hubspotContacts.size),
          properties: input.properties,
          createdAt: timestamp,
          updatedAt: timestamp,
          archived: false,
        });
        hubspotContacts.set(idempotencyKey, result);
        return context.json(result, 201);
      },
    )
    .on(serviceOperations.getPayment.method, serviceOperations.getPayment.path, async (context) => {
      const paymentId = context.req.param('paymentId');
      if (paymentId === 'payment_retry_demo_001') {
        const attempt = (deterministicRetryAttempts.get(paymentId) ?? 0) + 1;
        deterministicRetryAttempts.set(paymentId, attempt);
        if (attempt <= 2) {
          return context.json({ error: { type: 'TransientDownstream' } }, 503);
        }
      }
      const fault = takeFault('getPayment', context.req.header('x-atlas-sandbox-step-id'));
      if (fault?.kind === 'error') {
        await waitForInjectedTimeout(fault.errorType);
        return context.json({ error: { type: fault.errorType } }, fault.status);
      }
      if (fault?.kind === 'schema-violation') return context.json({ schemaViolation: true });

      const payment = await store.read({
        serviceId: 'payments',
        collection: 'payments',
        resourceId: paymentId,
      });
      return payment
        ? context.json(paymentSchema.parse(payment.document))
        : context.json({ error: { type: 'PaymentNotFound' } }, 404);
    })
    .on(
      serviceOperations.beginInvoiceSettlement.method,
      serviceOperations.beginInvoiceSettlement.path,
      async (context) => {
        const input = invoiceMutationSchema.parse(await context.req.json());
        return executeBillingMutation(
          'beginInvoiceSettlement',
          context.req.header('x-atlas-sandbox-step-id'),
          context.req.param('invoiceId'),
          input,
          'open',
          (invoice) => ({ ...invoice, status: 'settling', version: invoice.version + 1 }),
        );
      },
    )
    .on(
      serviceOperations.markInvoicePaid.method,
      serviceOperations.markInvoicePaid.path,
      async (context) => {
        const input = invoiceMutationSchema.parse(await context.req.json());
        return executeBillingMutation(
          'markInvoicePaid',
          context.req.header('x-atlas-sandbox-step-id'),
          context.req.param('invoiceId'),
          input,
          'settling',
          (invoice) => ({
            ...invoice,
            status: 'paid',
            version: invoice.version + 1,
            outstandingBalance: { ...invoice.outstandingBalance, value: 0 },
          }),
        );
      },
    )
    .on(
      serviceOperations.cancelInvoiceSettlement.method,
      serviceOperations.cancelInvoiceSettlement.path,
      async (context) => {
        const input = invoiceMutationSchema.parse(await context.req.json());
        return executeBillingMutation(
          'cancelInvoiceSettlement',
          context.req.header('x-atlas-sandbox-step-id'),
          context.req.param('invoiceId'),
          input,
          'settling',
          (invoice) => ({ ...invoice, status: 'open', version: invoice.version + 1 }),
        );
      },
    )
    .on(
      serviceOperations.publishInvoicePaid.method,
      serviceOperations.publishInvoicePaid.path,
      async (context) => {
        const fault = takeFault(
          'publishInvoicePaid',
          context.req.header('x-atlas-sandbox-step-id'),
        );
        if (fault?.kind === 'error') {
          await waitForInjectedTimeout(fault.errorType);
          return context.json({ error: { type: fault.errorType } }, fault.status);
        }
        if (fault?.kind === 'schema-violation') return context.json({ schemaViolation: true });

        const event = invoicePaidEventSchema.parse(await context.req.json());
        if (
          event.paymentId === 'payment_repair_demo_001' &&
          !repairedProviderConditions.has('publishInvoicePaid')
        ) {
          return context.json({ error: { type: 'TransientDownstream' } }, 503);
        }
        if (!publishedEvents.has(event.eventId)) publishedEvents.set(event.eventId, event);
        return context.json(publishedAckSchema.parse({ published: true }), 202);
      },
    )
    .on(
      serviceOperations.notifyPaymentOperations.method,
      serviceOperations.notifyPaymentOperations.path,
      async (context) => {
        const fault = takeFault(
          'notifyPaymentOperations',
          context.req.header('x-atlas-sandbox-step-id'),
        );
        if (fault?.kind === 'error') {
          await waitForInjectedTimeout(fault.errorType);
          return context.json({ error: { type: fault.errorType } }, fault.status);
        }
        if (fault?.kind === 'schema-violation') return context.json({ schemaViolation: true });

        const notification = paymentOperationsNotificationSchema.parse(await context.req.json());
        const claim = await store.claimIdempotent(
          notification.idempotencyKey,
          notifiedAckSchema.parse({ notified: true }),
        );
        if (claim.replayed) return context.json(serializeIdempotentResult(claim.result));

        notifications.push(notification);
        return context.json(claim.result);
      },
    )
    .get('/__control/observations', async (context) => {
      const [idempotencyKeys, payments, billingObservations] = await Promise.all([
        store.idempotencyKeys(),
        store.list('payments', 'payments'),
        billing.observations(),
      ]);
      return context.json({
        idempotencyKeys,
        payments: payments.map(({ document }) => paymentSchema.parse(document)),
        invoices: billingObservations.invoices,
        publishedEvents: [...publishedEvents.values()],
        notifications,
        stripePaymentIntents: [...stripePaymentIntents.values()],
        slackMessages: [...slackMessages.values()],
        hubspotContacts: [...hubspotContacts.values()],
        mappingDemoBillingRequests,
        billingMutations: billingObservations.billingMutations,
      });
    })
    .on(serviceOperations.getInvoice.method, serviceOperations.getInvoice.path, async (context) => {
      const fault = takeFault('getInvoice', context.req.header('x-atlas-sandbox-step-id'));
      if (fault?.kind === 'error') {
        await waitForInjectedTimeout(fault.errorType);
        return context.json({ error: { type: fault.errorType } }, fault.status);
      }
      if (fault?.kind === 'schema-violation') return context.json({ schemaViolation: true });

      const invoice = await billing.readInvoice(context.req.param('invoiceId'));
      return invoice
        ? context.json(serializeInvoice(invoice))
        : context.json({ error: { type: 'InvoiceNotFound' } }, 404);
    });
}

export const app = createMockServicesApp();
