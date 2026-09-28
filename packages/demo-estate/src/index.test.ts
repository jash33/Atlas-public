import { describe, expect, it } from 'vite-plus/test';

import { demoCapabilitySources, demoExecutionHostname, demoProfiles } from './index.js';

describe('demo capability estate', () => {
  it('keeps the visible Burger Town identity with the startup users', () => {
    expect(demoProfiles['burger-town']).toMatchObject({
      organizationName: 'Burger Town',
      displayUser: { name: 'Burger Town Demo', email: 'demo@burgertown.local' },
      users: {
        author: { name: 'Burger Town Demo', email: 'demo@burgertown.local' },
        operator: { email: 'operator@burgertown.local' },
        admin: { email: 'admin@burgertown.local' },
      },
    });
  });

  it('contains every capability needed to compose the payment-to-billing reference workflow', () => {
    expect(
      demoCapabilitySources.map(({ serviceId, annotations }) => ({
        serviceId,
        operations: annotations.map(({ capability }) => capability.operationId),
      })),
    ).toEqual([
      { serviceId: 'payments', operations: ['getPayment'] },
      {
        serviceId: 'billing',
        operations: [
          'getInvoice',
          'beginInvoiceSettlement',
          'cancelInvoiceSettlement',
          'markInvoicePaid',
        ],
      },
      { serviceId: 'operations', operations: ['notifyPaymentOperations'] },
      { serviceId: 'events', operations: ['publishInvoicePaid'] },
      { serviceId: 'stripe', operations: ['PostPaymentIntents'] },
      { serviceId: 'slack', operations: ['chat_postMessage'] },
      { serviceId: 'hubspot', operations: ['createContact'] },
    ]);
  });

  it('identifies an internal contract and a contract-faithful Stripe rehearsal contract', () => {
    const internalSource = demoCapabilitySources.find(
      ({ sourceType, format }) => sourceType === 'internal' && format === 'openapi',
    );
    const stripeSource = demoCapabilitySources.find(({ serviceId }) => serviceId === 'stripe');

    expect(internalSource).toMatchObject({
      serviceId: 'payments',
      sourceType: 'internal',
      defaultConnectionMode: 'local',
    });
    expect(stripeSource).toMatchObject({
      sourceType: 'third-party',
      provider: 'Stripe',
      defaultConnectionMode: 'contract-faithful-rehearsal',
      upstreamRepository: 'https://github.com/stripe/openapi',
      upstreamRevision: '24e4796f5aa12204d7e208ef447a5d11705b9b41',
      upstreamPath: 'latest/openapi.spec3.json',
      officialSandboxUrl: 'https://api.stripe.com',
      annotations: [
        {
          capability: { operationId: 'PostPaymentIntents' },
          secretAlias: 'STRIPE_SECRET_KEY',
        },
      ],
    });
    expect(demoExecutionHostname(stripeSource!, 'contract-faithful-rehearsal')).toBe(
      'mock-services',
    );
    expect(demoExecutionHostname(stripeSource!, 'official-test')).toBe('api.stripe.com');
  });

  it('identifies the governed Slack notification contract without embedding credentials', () => {
    const slackSource = demoCapabilitySources.find(({ serviceId }) => serviceId === 'slack');

    expect(slackSource).toMatchObject({
      sourceType: 'third-party',
      provider: 'Slack',
      defaultConnectionMode: 'contract-faithful-rehearsal',
      upstreamRepository: 'https://github.com/slackapi/slack-api-specs',
      upstreamRevision: 'bc08db49625630e3585bf2f1322128ea04f2a7f3',
      upstreamPath: 'web-api/slack_web_openapi_v2.json',
      officialSandboxUrl: 'https://slack.com/api',
      annotations: [
        {
          capability: { operationId: 'chat_postMessage' },
          owner: 'business-operations',
          secretAlias: 'SLACK_BOT_TOKEN',
        },
      ],
    });
    expect(JSON.stringify(slackSource)).not.toContain('xoxb-');
    expect(demoExecutionHostname(slackSource!, 'contract-faithful-rehearsal')).toBe(
      'mock-services',
    );
    expect(demoExecutionHostname(slackSource!, 'official-test')).toBe('slack.com');
  });

  it('identifies the governed HubSpot CRM contract without embedding credentials', () => {
    const hubspotSource = demoCapabilitySources.find(({ serviceId }) => serviceId === 'hubspot');

    expect(hubspotSource).toMatchObject({
      label: expect.stringContaining('developer test account or rehearsal fallback'),
      provider: 'HubSpot',
      sourceType: 'third-party',
      defaultConnectionMode: 'contract-faithful-rehearsal',
      upstreamRepository: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
      upstreamRevision: 'ab9ffa9c6f456fd8fce017f3d36fe619cbe88315',
      upstreamPath: 'PublicApiSpecs/CRM/Contacts/Rollouts/424/v3/contacts.json',
      officialSandboxUrl: 'https://api.hubapi.com',
      annotations: [
        expect.objectContaining({
          owner: 'revenue-operations',
          secretAlias: 'HUBSPOT_ACCESS_TOKEN',
          idempotencyField: 'email',
          irreversibleAfter: true,
        }),
      ],
    });
    expect(JSON.stringify(hubspotSource)).not.toContain('pat-');
    expect(demoExecutionHostname(hubspotSource!, 'contract-faithful-rehearsal')).toBe(
      'mock-services',
    );
    expect(demoExecutionHostname(hubspotSource!, 'official-test')).toBe('api.hubapi.com');
  });
});
