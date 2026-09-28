import { StepActivityError } from '@atlas/runtime-ports';
import type { JsonValue } from '@atlas/workflow-ir';

// The sandbox contract runner still needs provider-specific wire formats for the pinned
// third-party contracts. Production workflow activities use the generic fragment binding.
export function createPublishInvoicePaidHttpRequest(
  providerBaseUrl: string,
  input: Readonly<Record<string, JsonValue>>,
): [URL, RequestInit] {
  const eventId = input.eventId ?? input.idempotencyKey;
  const invoiceId = input.invoiceId;
  const paymentId = input.paymentId;
  const atlasWorkflowRunId = input.atlasWorkflowRunId ?? eventId;
  const eventType = input.eventType ?? 'invoice.paid';
  if (
    typeof eventId !== 'string' ||
    typeof invoiceId !== 'string' ||
    typeof paymentId !== 'string' ||
    typeof atlasWorkflowRunId !== 'string' ||
    typeof eventType !== 'string'
  ) {
    throw new StepActivityError('InvalidStepInput');
  }
  return [
    new URL('events/invoice.paid', `${providerBaseUrl.replace(/\/$/, '')}/`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventId,
        eventType,
        invoiceId,
        paymentId,
        atlasWorkflowRunId,
      }),
    },
  ];
}

export function createStripePaymentIntentHttpRequest(
  providerBaseUrl: string,
  input: Readonly<Record<string, JsonValue>>,
): [URL, RequestInit] {
  const amount = input.amount;
  const currency = input.currency;
  const idempotencyKey = input.idempotencyKey ?? input['Idempotency-Key'];
  if (typeof amount !== 'number' || typeof currency !== 'string') {
    throw new StepActivityError('InvalidStepInput');
  }
  if (typeof idempotencyKey !== 'string') throw new StepActivityError('InvalidStepInput');
  return [
    new URL('v1/payment_intents', `${providerBaseUrl.replace(/\/$/, '')}/`),
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('atlas-local-rehearsal-token:').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': idempotencyKey,
      },
      body: new URLSearchParams({ amount: String(amount), currency: currency.toLowerCase() }),
    },
  ];
}
