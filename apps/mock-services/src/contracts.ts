import { z } from 'zod';

export const moneySchema = z.object({
  value: z.number().int().nonnegative(),
  currency: z.string().length(3),
});

export const paymentSchema = z.object({
  paymentId: z.string().min(1),
  invoiceId: z.string().min(1),
  status: z.enum(['succeeded', 'failed']),
  amount: moneySchema,
  paidAt: z.string().datetime(),
});

export const mappingDemoPaymentSchema = z
  .object({
    payment_id: z.string().min(1),
    invoice_id: z.string().min(1),
    amount_cents: z.number().int().nonnegative(),
    currency: z.string().regex(/^[a-z]{3}$/),
    customer: z.object({ notification_email: z.string().email() }).strict(),
  })
  .strict();

export const mappingDemoBillingSettlementSchema = z
  .object({
    invoiceId: z.string().min(1),
    payment: z
      .object({ amount: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
      .strict(),
    notification: z.object({ address: z.string().email() }).strict(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();

export const mappingDemoBillingAcceptedSchema = z.object({ accepted: z.literal(true) }).strict();

export const invoiceSchema = z.object({
  invoiceId: z.string().min(1),
  version: z.number().int().positive(),
  status: z.enum(['open', 'settling', 'paid']),
  outstandingBalance: moneySchema,
  customerId: z.string().min(1),
});

export const invoiceMutationSchema = z.object({
  paymentId: z.string().min(1),
  expectedInvoiceVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
});

export const invoicePaidEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal('invoice.paid'),
  invoiceId: z.string().min(1),
  paymentId: z.string().min(1),
  atlasWorkflowRunId: z.string().min(1),
});

export const paymentOperationsNotificationSchema = z.object({
  atlasWorkflowRunId: z.string().min(1),
  invoiceId: z.string().min(1),
  paymentId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});

export const publishedAckSchema = z.object({ published: z.literal(true) });
export const notifiedAckSchema = z.object({ notified: z.literal(true) });

export const stripePaymentIntentRequestSchema = z.object({
  amount: z.coerce.number().int().positive(),
  currency: z.string().length(3),
});

export const stripePaymentIntentSchema = z.object({
  id: z.string().startsWith('pi_'),
  object: z.literal('payment_intent'),
  amount: z.number().int().positive(),
  currency: z.string().regex(/^[a-z]{3}$/),
  livemode: z.literal(false),
  status: z.enum([
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
    'canceled',
    'succeeded',
  ]),
});

export const slackChatPostMessageRequestSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  client_msg_id: z.string().min(1).optional(),
});

export const slackChatPostMessageResponseSchema = z.object({
  ok: z.literal(true),
  channel: z.string().min(1),
  ts: z.string().regex(/^\d+\.\d+$/),
  message: z.object({ text: z.string() }),
});

export const hubSpotCreateContactRequestSchema = z.object({
  properties: z.object({
    email: z.string().email(),
    firstname: z.string().min(1),
    lastname: z.string().min(1),
  }),
});

export const hubSpotContactSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    email: z.string().email(),
    firstname: z.string().min(1),
    lastname: z.string().min(1),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archived: z.literal(false),
});

export const hubSpotErrorSchema = z.object({
  status: z.literal('error'),
  category: z.string().min(1),
  message: z.string().min(1),
});

export const operationIdSchema = z.enum([
  'getPayment',
  'getInvoice',
  'beginInvoiceSettlement',
  'markInvoicePaid',
  'cancelInvoiceSettlement',
  'publishInvoicePaid',
  'notifyPaymentOperations',
  'PostPaymentIntents',
  'chat_postMessage',
  'createContact',
  'getMappingDemoPayment',
  'settleMappingDemoInvoice',
]);

export const faultPlanSchema = z.discriminatedUnion('mode', [
  z.object({
    operationId: operationIdSchema,
    stepId: z.string().min(1).optional(),
    mode: z.literal('transient'),
    failures: z.number().int().positive(),
  }),
  z.object({
    operationId: operationIdSchema,
    stepId: z.string().min(1).optional(),
    mode: z.literal('permanent'),
    errorType: z.string().min(1),
  }),
  z.object({
    operationId: operationIdSchema,
    stepId: z.string().min(1).optional(),
    mode: z.literal('schema-violation'),
  }),
  z.object({
    operationId: operationIdSchema,
    stepId: z.string().min(1).optional(),
    mode: z.literal('stale-version'),
    failures: z.number().int().positive(),
  }),
  z.object({
    operationId: operationIdSchema,
    stepId: z.string().min(1).optional(),
    mode: z.literal('rate-limit'),
  }),
  z.object({
    operationId: operationIdSchema,
    stepId: z.string().min(1).optional(),
    mode: z.literal('timeout'),
  }),
  z.object({
    operationId: operationIdSchema,
    stepId: z.string().min(1).optional(),
    mode: z.literal('none'),
  }),
]);

export const billingSpecMutationSchema = z.object({
  mutation: z.enum([
    'baseline',
    'add-optional-field',
    'rename-field',
    'remove-field',
    'retype-field',
  ]),
});

export type Payment = z.infer<typeof paymentSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type FaultPlan = z.infer<typeof faultPlanSchema>;
export type InvoicePaidEvent = z.infer<typeof invoicePaidEventSchema>;
export type PaymentOperationsNotification = z.infer<typeof paymentOperationsNotificationSchema>;
export type BillingSpecMutation = z.infer<typeof billingSpecMutationSchema>['mutation'];

const invoiceWithOptionalFieldSchema = invoiceSchema.extend({
  purchaseOrderReference: z.string().optional(),
});
const invoiceWithRenamedFieldSchema = invoiceSchema.omit({ customerId: true }).extend({
  accountId: z.string().min(1),
});
const invoiceWithRemovedFieldSchema = invoiceSchema.omit({ customerId: true });
const invoiceWithRetypedFieldSchema = invoiceSchema.omit({ version: true }).extend({
  version: z.string(),
});

export const invoiceContractVariants = {
  baseline: {
    schema: invoiceSchema,
    serialize: (invoice: Invoice) => invoiceSchema.parse(invoice),
  },
  'add-optional-field': {
    schema: invoiceWithOptionalFieldSchema,
    serialize: (invoice: Invoice) =>
      invoiceWithOptionalFieldSchema.parse({
        ...invoice,
        purchaseOrderReference: `po_${invoice.invoiceId}`,
      }),
  },
  'rename-field': {
    schema: invoiceWithRenamedFieldSchema,
    serialize: (invoice: Invoice) => {
      const { customerId, ...unchangedInvoice } = invoice;
      return invoiceWithRenamedFieldSchema.parse({ ...unchangedInvoice, accountId: customerId });
    },
  },
  'remove-field': {
    schema: invoiceWithRemovedFieldSchema,
    serialize: (invoice: Invoice) => invoiceWithRemovedFieldSchema.parse(invoice),
  },
  'retype-field': {
    schema: invoiceWithRetypedFieldSchema,
    serialize: (invoice: Invoice) =>
      invoiceWithRetypedFieldSchema.parse({ ...invoice, version: String(invoice.version) }),
  },
} satisfies Record<
  BillingSpecMutation,
  { schema: z.ZodType; serialize: (invoice: Invoice) => Record<string, unknown> }
>;
