import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';

import { loadMockServicesConfig } from './config.js';

describe('mock service configuration', () => {
  it('uses the deterministic Stripe rehearsal fallback by default', () => {
    expect(loadMockServicesConfig({})).toMatchObject({
      stripeDemoMode: 'contract-faithful-rehearsal',
      stripeSecretKey: null,
      slackDemoMode: 'contract-faithful-rehearsal',
      hubspotDemoMode: 'contract-faithful-rehearsal',
      billingFailureResponseDelayMs: 1_500,
    });
  });

  it('keeps provider state in memory unless a provider database and ID are configured', () => {
    expect(loadMockServicesConfig({})).toMatchObject({
      providerDatabaseUrl: null,
      providerId: null,
    });
    expect(() =>
      loadMockServicesConfig({
        MOCK_PROVIDER_DATABASE_URL: 'postgresql://atlas:atlas@localhost:5432/atlas',
      }),
    ).toThrow(/MOCK_PROVIDER_ID is required when MOCK_PROVIDER_DATABASE_URL is set/);
    expect(
      loadMockServicesConfig({
        MOCK_PROVIDER_DATABASE_URL: 'postgresql://atlas:atlas@localhost:5432/atlas',
        MOCK_PROVIDER_ID: 'mock-services',
      }),
    ).toMatchObject({
      providerDatabaseUrl: 'postgresql://atlas:atlas@localhost:5432/atlas',
      providerId: 'mock-services',
    });
  });

  it('requires a Stripe test-mode credential for official-test execution', () => {
    expect(() => loadMockServicesConfig({ STRIPE_DEMO_MODE: 'official-test' })).toThrow(
      /STRIPE_SECRET_KEY/,
    );
    expect(
      loadMockServicesConfig({
        STRIPE_DEMO_MODE: 'official-test',
        STRIPE_SECRET_KEY: testStripeCredential,
      }),
    ).toMatchObject({
      stripeDemoMode: 'official-test',
      stripeSecretKey: testStripeCredential,
    });
  });

  it('publishes official Slack routing without receiving the worker credential', () => {
    expect(loadMockServicesConfig({ SLACK_DEMO_MODE: 'official-test' })).toMatchObject({
      slackDemoMode: 'official-test',
    });
  });

  it('publishes official HubSpot routing without receiving the worker credential', () => {
    expect(loadMockServicesConfig({ HUBSPOT_DEMO_MODE: 'official-test' })).toMatchObject({
      hubspotDemoMode: 'official-test',
    });
  });
});

const testStripeCredential = ['sk', 'test', randomBytes(16).toString('hex')].join('_');
