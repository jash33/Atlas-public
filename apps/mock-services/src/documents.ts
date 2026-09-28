import { z } from 'zod';

import {
  invoiceContractVariants,
  invoiceMutationSchema,
  invoicePaidEventSchema,
  notifiedAckSchema,
  paymentOperationsNotificationSchema,
  paymentSchema,
  mappingDemoPaymentSchema,
  mappingDemoBillingSettlementSchema,
  mappingDemoBillingAcceptedSchema,
  publishedAckSchema,
  slackChatPostMessageRequestSchema,
  slackChatPostMessageResponseSchema,
  hubSpotCreateContactRequestSchema,
  hubSpotContactSchema,
  hubSpotErrorSchema,
  stripePaymentIntentRequestSchema,
  stripePaymentIntentSchema,
  type BillingSpecMutation,
} from './contracts.js';
import { openApiPath, serviceOperations } from './operations.js';

function jsonSchema(schema: z.ZodType) {
  const result = { ...z.toJSONSchema(schema) };
  delete result.$schema;
  return result;
}

function schemaObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Generated mapping demo schema is not an object');
  }
  return value as Record<string, unknown>;
}

function mappingDemoPaymentJsonSchema() {
  const schema = jsonSchema(mappingDemoPaymentSchema);
  const properties = schemaObject(schema.properties);
  schemaObject(properties.amount_cents)['x-atlas-unit'] = 'cents';
  schemaObject(properties.currency)['x-atlas-case'] = 'lower';
  return schema;
}

function mappingDemoBillingSettlementJsonSchema() {
  const schema = jsonSchema(mappingDemoBillingSettlementSchema);
  const properties = schemaObject(schema.properties);
  const payment = schemaObject(properties.payment);
  const paymentProperties = schemaObject(payment.properties);
  schemaObject(paymentProperties.amount)['x-atlas-unit'] = 'decimal-currency';
  schemaObject(paymentProperties.currency)['x-atlas-case'] = 'upper';
  return schema;
}

const invoiceIdParameter = {
  name: 'invoiceId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
};

const paymentIdParameter = {
  name: 'paymentId',
  in: 'path',
  required: true,
  schema: { type: 'string', 'x-atlas-data-classification': 'internal' },
};

function jsonResponse(
  schemaReference: string,
  description = 'Successful response',
  status = '200',
) {
  return {
    [status]: {
      description,
      content: {
        'application/json': { schema: { $ref: schemaReference } },
      },
    },
  };
}

function jsonRequest(schemaReference: string) {
  return {
    required: true,
    content: {
      'application/json': { schema: { $ref: schemaReference } },
    },
  };
}

export function createServiceDocuments(
  billingMutation: BillingSpecMutation = 'baseline',
  stripeConnection: { mode: 'contract-faithful-rehearsal' } | { mode: 'official-test' } = {
    mode: 'contract-faithful-rehearsal',
  },
  slackConnection: { mode: 'contract-faithful-rehearsal' } | { mode: 'official-test' } = {
    mode: 'contract-faithful-rehearsal',
  },
  hubspotConnection: { mode: 'contract-faithful-rehearsal' } | { mode: 'official-test' } = {
    mode: 'contract-faithful-rehearsal',
  },
) {
  const stripeOfficialTest = stripeConnection.mode === 'official-test';
  const stripeServerUrl = stripeOfficialTest
    ? 'https://api.stripe.com'
    : 'http://mock-services:4100';
  const slackOfficialTest = slackConnection.mode === 'official-test';
  const slackServerUrl = slackOfficialTest ? 'https://slack.com' : 'http://mock-services:4100';
  const hubspotOfficialTest = hubspotConnection.mode === 'official-test';
  const hubspotServerUrl = hubspotOfficialTest
    ? 'https://api.hubapi.com'
    : 'http://mock-services:4100';
  const payment = {
    openapi: '3.1.0',
    info: { title: 'Atlas Mock Payment API', version: '1.0.0' },
    paths: {
      [openApiPath(serviceOperations.getPayment.path)]: {
        [serviceOperations.getPayment.method]: {
          operationId: serviceOperations.getPayment.operationId,
          parameters: [paymentIdParameter],
          responses: jsonResponse('#/components/schemas/Payment'),
        },
      },
      [openApiPath(serviceOperations.getMappingDemoPayment.path)]: {
        [serviceOperations.getMappingDemoPayment.method]: {
          operationId: serviceOperations.getMappingDemoPayment.operationId,
          parameters: [paymentIdParameter],
          responses: jsonResponse('#/components/schemas/MappingDemoPayment'),
        },
      },
    },
    components: {
      schemas: {
        Payment: jsonSchema(paymentSchema),
        MappingDemoPayment: mappingDemoPaymentJsonSchema(),
      },
    },
  };

  const billing = {
    openapi: '3.1.0',
    info: { title: 'Atlas Mock Billing API', version: '1.0.0' },
    paths: {
      [openApiPath(serviceOperations.getInvoice.path)]: {
        [serviceOperations.getInvoice.method]: {
          operationId: serviceOperations.getInvoice.operationId,
          parameters: [invoiceIdParameter],
          responses: jsonResponse('#/components/schemas/Invoice'),
        },
      },
      [openApiPath(serviceOperations.beginInvoiceSettlement.path)]: {
        [serviceOperations.beginInvoiceSettlement.method]: {
          operationId: serviceOperations.beginInvoiceSettlement.operationId,
          parameters: [invoiceIdParameter],
          requestBody: jsonRequest('#/components/schemas/InvoiceMutation'),
          responses: jsonResponse('#/components/schemas/Invoice'),
        },
        [serviceOperations.cancelInvoiceSettlement.method]: {
          operationId: serviceOperations.cancelInvoiceSettlement.operationId,
          parameters: [invoiceIdParameter],
          requestBody: jsonRequest('#/components/schemas/InvoiceMutation'),
          responses: jsonResponse('#/components/schemas/Invoice'),
        },
      },
      [openApiPath(serviceOperations.markInvoicePaid.path)]: {
        [serviceOperations.markInvoicePaid.method]: {
          operationId: serviceOperations.markInvoicePaid.operationId,
          parameters: [invoiceIdParameter],
          requestBody: jsonRequest('#/components/schemas/InvoiceMutation'),
          responses: jsonResponse('#/components/schemas/Invoice'),
        },
      },
      [openApiPath(serviceOperations.settleMappingDemoInvoice.path)]: {
        [serviceOperations.settleMappingDemoInvoice.method]: {
          operationId: serviceOperations.settleMappingDemoInvoice.operationId,
          requestBody: jsonRequest('#/components/schemas/MappingDemoBillingSettlement'),
          responses: jsonResponse(
            '#/components/schemas/MappingDemoBillingAccepted',
            'Settlement accepted',
            '202',
          ),
        },
      },
    },
    components: {
      schemas: {
        Invoice: jsonSchema(invoiceContractVariants[billingMutation].schema),
        InvoiceMutation: jsonSchema(invoiceMutationSchema),
        MappingDemoBillingSettlement: mappingDemoBillingSettlementJsonSchema(),
        MappingDemoBillingAccepted: jsonSchema(mappingDemoBillingAcceptedSchema),
      },
    },
  };

  const operations = {
    openapi: '3.1.0',
    info: { title: 'Atlas Mock Operations Notification API', version: '1.0.0' },
    paths: {
      [openApiPath(serviceOperations.notifyPaymentOperations.path)]: {
        [serviceOperations.notifyPaymentOperations.method]: {
          operationId: serviceOperations.notifyPaymentOperations.operationId,
          requestBody: jsonRequest('#/components/schemas/PaymentOperationsNotification'),
          responses: jsonResponse('#/components/schemas/NotificationAcknowledgement'),
        },
      },
    },
    components: {
      schemas: {
        PaymentOperationsNotification: jsonSchema(paymentOperationsNotificationSchema),
        NotificationAcknowledgement: jsonSchema(notifiedAckSchema),
      },
    },
  };

  const events = {
    asyncapi: '3.0.0',
    info: { title: 'Atlas Mock Domain Events', version: '1.0.0' },
    channels: {
      invoicePaid: {
        address: serviceOperations.publishInvoicePaid.channelAddress,
        messages: {
          invoicePaid: {
            name: 'InvoicePaid',
            payload: jsonSchema(invoicePaidEventSchema),
          },
        },
      },
    },
    operations: {
      [serviceOperations.publishInvoicePaid.operationId]: {
        action: 'send',
        channel: { $ref: '#/channels/invoicePaid' },
        messages: [{ $ref: '#/channels/invoicePaid/messages/invoicePaid' }],
      },
    },
    components: {
      schemas: { PublishAcknowledgement: jsonSchema(publishedAckSchema) },
    },
  };

  const stripe = {
    openapi: '3.1.0',
    info: {
      title: 'Stripe API (contract-faithful rehearsal subset)',
      version: '2026-07-29.dahlia',
      description: stripeOfficialTest
        ? 'A pinned subset of the Stripe OpenAPI contract configured for live Stripe test-mode connectivity.'
        : 'A deterministic local subset of the Stripe OpenAPI contract for rehearsal. It does not prove live Stripe connectivity.',
    },
    servers: [{ url: stripeServerUrl }],
    paths: {
      [openApiPath(serviceOperations.createPaymentIntent.path)]: {
        [serviceOperations.createPaymentIntent.method]: {
          operationId: serviceOperations.createPaymentIntent.operationId,
          security: [{ BasicAuth: [] }],
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: {
                type: 'string',
                minLength: 1,
                'x-atlas-data-classification': 'internal',
              },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/x-www-form-urlencoded': {
                schema: { $ref: '#/components/schemas/PaymentIntentCreateParams' },
              },
            },
          },
          responses: jsonResponse('#/components/schemas/PaymentIntent'),
        },
      },
    },
    components: {
      securitySchemes: { BasicAuth: { type: 'http', scheme: 'basic' } },
      schemas: {
        PaymentIntentCreateParams: jsonSchema(stripePaymentIntentRequestSchema),
        PaymentIntent: jsonSchema(stripePaymentIntentSchema),
      },
    },
    'x-atlas-connection': {
      provider: 'Stripe',
      mode: stripeOfficialTest ? 'official-test' : 'contract-faithful-rehearsal',
      liveConnectivity: stripeOfficialTest,
      label: stripeOfficialTest
        ? 'Official Stripe test mode'
        : 'Contract-faithful local rehearsal fallback',
      upstreamRepository: 'https://github.com/stripe/openapi',
      upstreamRevision: '24e4796f5aa12204d7e208ef447a5d11705b9b41',
      upstreamPath: 'latest/openapi.spec3.json',
      officialSandboxUrl: 'https://api.stripe.com',
      officialSandboxActivation: 'STRIPE_DEMO_MODE=official-test',
    },
  };

  const slack = {
    openapi: '3.1.0',
    info: {
      title: 'Slack Web API (contract-faithful rehearsal subset)',
      version: 'bc08db4',
      description: slackOfficialTest
        ? 'A pinned subset of the Slack Web API contract configured for a Slack test workspace.'
        : 'A deterministic local subset of the Slack Web API contract for rehearsal. It does not prove live Slack connectivity.',
    },
    servers: [{ url: slackServerUrl }],
    paths: {
      [serviceOperations.postSlackMessage.path]: {
        [serviceOperations.postSlackMessage.method]: {
          operationId: serviceOperations.postSlackMessage.operationId,
          description: 'Sends a message to a channel.',
          security: [{ BearerAuth: [] }],
          requestBody: jsonRequest('#/components/schemas/ChatPostMessageRequest'),
          responses: jsonResponse('#/components/schemas/ChatPostMessageResponse'),
        },
      },
    },
    components: {
      securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        ChatPostMessageRequest: jsonSchema(slackChatPostMessageRequestSchema),
        ChatPostMessageResponse: jsonSchema(slackChatPostMessageResponseSchema),
      },
    },
    'x-atlas-connection': {
      provider: 'Slack',
      mode: slackOfficialTest ? 'official-test' : 'contract-faithful-rehearsal',
      liveConnectivity: slackOfficialTest,
      label: slackOfficialTest
        ? 'Configured Slack test workspace'
        : 'Contract-faithful local rehearsal fallback',
      upstreamRepository: 'https://github.com/slackapi/slack-api-specs',
      upstreamRevision: 'bc08db49625630e3585bf2f1322128ea04f2a7f3',
      upstreamPath: 'web-api/slack_web_openapi_v2.json',
      officialSandboxUrl: 'https://slack.com/api',
      officialSandboxActivation: 'SLACK_DEMO_MODE=official-test',
    },
  };

  const hubspot = {
    openapi: '3.1.0',
    info: {
      title: 'HubSpot CRM API (contract-faithful rehearsal subset)',
      version: '424',
      description: hubspotOfficialTest
        ? 'A pinned subset of the HubSpot CRM API configured for a developer test account.'
        : 'A deterministic local subset of the HubSpot CRM API for rehearsal. It does not prove live HubSpot connectivity.',
    },
    servers: [{ url: hubspotServerUrl }],
    paths: {
      [serviceOperations.createHubSpotContact.path]: {
        [serviceOperations.createHubSpotContact.method]: {
          operationId: serviceOperations.createHubSpotContact.operationId,
          description: 'Creates a CRM contact.',
          security: [{ BearerAuth: [] }],
          requestBody: jsonRequest('#/components/schemas/SimplePublicObjectInputForCreate'),
          responses: {
            '201': {
              description: 'Successful operation',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SimplePublicObject' },
                },
              },
            },
            default: {
              description: 'HubSpot API error',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Error' } },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        SimplePublicObjectInputForCreate: jsonSchema(hubSpotCreateContactRequestSchema),
        SimplePublicObject: jsonSchema(hubSpotContactSchema),
        Error: jsonSchema(hubSpotErrorSchema),
      },
    },
    'x-atlas-connection': {
      provider: 'HubSpot',
      mode: hubspotOfficialTest ? 'official-test' : 'contract-faithful-rehearsal',
      liveConnectivity: hubspotOfficialTest,
      label: hubspotOfficialTest
        ? 'Configured HubSpot developer test account'
        : 'Contract-faithful local rehearsal fallback',
      upstreamRepository: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
      upstreamRevision: 'ab9ffa9c6f456fd8fce017f3d36fe619cbe88315',
      upstreamPath: 'PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json',
      officialSandboxUrl: 'https://api.hubapi.com',
      officialSandboxActivation: 'HUBSPOT_DEMO_MODE=official-test',
    },
  };

  return { payment, billing, operations, events, stripe, slack, hubspot };
}
