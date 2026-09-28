const payment = (document) => ({
  service: 'payments',
  collection: 'payments',
  id: document.paymentId,
  document,
});

const invoice = (document) => ({
  service: 'billing',
  collection: 'invoices',
  id: document.invoiceId,
  document,
});

export const demoProviderBaseline = [
  payment({
    paymentId: 'payment_demo_001',
    invoiceId: 'invoice_demo_001',
    status: 'succeeded',
    amount: { value: 12500, currency: 'USD' },
    paidAt: '2026-08-14T15:00:00.000Z',
  }),
  payment({
    paymentId: 'payment_drift_migrated_demo_001',
    invoiceId: 'invoice_drift_migrated_demo_001',
    status: 'succeeded',
    amount: { value: 12500, currency: 'USD' },
    paidAt: '2026-08-14T15:00:00.000Z',
  }),
  payment({
    paymentId: 'payment_retry_demo_001',
    invoiceId: 'invoice_retry_demo_001',
    status: 'succeeded',
    amount: { value: 12500, currency: 'USD' },
    paidAt: '2026-08-14T15:00:00.000Z',
  }),
  payment({
    paymentId: 'payment_repair_demo_001',
    invoiceId: 'invoice_repair_demo_001',
    status: 'succeeded',
    amount: { value: 12500, currency: 'USD' },
    paidAt: '2026-08-14T15:00:00.000Z',
  }),
  invoice({
    invoiceId: 'invoice_demo_001',
    version: 1,
    status: 'open',
    outstandingBalance: { value: 12500, currency: 'USD' },
    customerId: 'customer_demo_001',
  }),
  invoice({
    invoiceId: 'invoice_drift_migrated_demo_001',
    version: 1,
    status: 'open',
    outstandingBalance: { value: 12500, currency: 'USD' },
    customerId: 'customer_drift_migrated_demo_001',
  }),
  invoice({
    invoiceId: 'invoice_retry_demo_001',
    version: 1,
    status: 'open',
    outstandingBalance: { value: 12500, currency: 'USD' },
    customerId: 'customer_retry_demo_001',
  }),
  invoice({
    invoiceId: 'invoice_repair_demo_001',
    version: 1,
    status: 'open',
    outstandingBalance: { value: 12500, currency: 'USD' },
    customerId: 'customer_repair_demo_001',
  }),
];

export function demoProviderResetScript(mode = 'replace') {
  if (mode !== 'replace' && mode !== 'merge')
    throw new Error(`Invalid resource seed mode: ${mode}`);
  const baseline = JSON.stringify(demoProviderBaseline);
  const cleanBaselineCheck =
    mode === 'replace'
      ? `const evidence=await observations.json();if(evidence.idempotencyKeys.length||evidence.publishedEvents.length||evidence.notifications.length)throw new Error('provider observations were not reset');`
      : '';
  return `const baseline=${baseline};const put=async(path,body)=>{const response=await fetch('http://localhost:4100'+path,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw new Error(path+' seed failed with '+response.status)};await put('/__control/resources',{mode:'${mode}',resources:baseline});await put('/__control/specs/billing',{mutation:'baseline'});const [payment,invoice,observations,billingSpec]=await Promise.all([fetch('http://localhost:4100/payments/payment_demo_001'),fetch('http://localhost:4100/invoices/invoice_demo_001'),fetch('http://localhost:4100/__control/observations'),fetch('http://localhost:4100/specs/billing.openapi.json')]);if(!payment.ok||!invoice.ok)throw new Error('provider baseline fixtures are unavailable');${cleanBaselineCheck}const schema=(await billingSpec.json()).components.schemas.Invoice;if(!schema.required.includes('customerId')||schema.properties.version.type!=='integer')throw new Error('billing drift fixture was not reset to baseline')`;
}
