export const serviceOperations = {
  getPayment: {
    operationId: 'getPayment',
    method: 'get',
    path: '/payments/:paymentId',
  },
  getMappingDemoPayment: {
    operationId: 'getMappingDemoPayment',
    method: 'get',
    path: '/mapping-demo/payments/:paymentId',
  },
  settleMappingDemoInvoice: {
    operationId: 'settleMappingDemoInvoice',
    method: 'post',
    path: '/mapping-demo/billing/settlements',
  },
  getInvoice: {
    operationId: 'getInvoice',
    method: 'get',
    path: '/invoices/:invoiceId',
  },
  beginInvoiceSettlement: {
    operationId: 'beginInvoiceSettlement',
    method: 'post',
    path: '/invoices/:invoiceId/settlement',
  },
  cancelInvoiceSettlement: {
    operationId: 'cancelInvoiceSettlement',
    method: 'delete',
    path: '/invoices/:invoiceId/settlement',
  },
  markInvoicePaid: {
    operationId: 'markInvoicePaid',
    method: 'post',
    path: '/invoices/:invoiceId/payment',
  },
  publishInvoicePaid: {
    operationId: 'publishInvoicePaid',
    method: 'post',
    path: '/events/invoice.paid',
    channelAddress: 'invoice.paid',
  },
  notifyPaymentOperations: {
    operationId: 'notifyPaymentOperations',
    method: 'post',
    path: '/operations/payment-notifications',
  },
  createPaymentIntent: {
    operationId: 'PostPaymentIntents',
    method: 'post',
    path: '/v1/payment_intents',
  },
  postSlackMessage: {
    operationId: 'chat_postMessage',
    method: 'post',
    path: '/api/chat.postMessage',
  },
  createHubSpotContact: {
    operationId: 'createContact',
    method: 'post',
    path: '/crm/v3/objects/contacts',
  },
} as const;

export function openApiPath(runtimePath: string) {
  return runtimePath.replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
}
