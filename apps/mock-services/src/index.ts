import { serve } from '@hono/node-server';

import { createMockServicesApp } from './app.js';
import { loadMockServicesConfig } from './config.js';
import { PostgresProviderResourceStore } from './provider-resource-store.js';

const config = loadMockServicesConfig();
const resourceStore =
  config.providerDatabaseUrl && config.providerId
    ? new PostgresProviderResourceStore(config.providerDatabaseUrl, config.providerId)
    : undefined;
const app = createMockServicesApp({
  ...(resourceStore ? { resourceStore } : {}),
  billingFailureResponseDelayMs: config.billingFailureResponseDelayMs,
  ...(config.stripeDemoMode === 'official-test' && config.stripeSecretKey
    ? { stripeOfficialTest: { apiKey: config.stripeSecretKey } }
    : {}),
  slackConnection: { mode: config.slackDemoMode },
  hubspotConnection: { mode: config.hubspotDemoMode },
});

serve({ fetch: app.fetch, port: config.port });

console.log(`Atlas mock-service shell listening on http://localhost:${config.port}`);
