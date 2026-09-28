import { z } from 'zod';

const mockServicesConfigSchema = z
  .object({
    port: z.coerce.number().int().positive(),
    stripeDemoMode: z.enum(['contract-faithful-rehearsal', 'official-test']),
    stripeSecretKey: z.string().startsWith('sk_test_').nullable(),
    slackDemoMode: z.enum(['contract-faithful-rehearsal', 'official-test']),
    hubspotDemoMode: z.enum(['contract-faithful-rehearsal', 'official-test']),
    providerDatabaseUrl: z.string().url().nullable(),
    providerId: z.string().min(1).nullable(),
    billingFailureResponseDelayMs: z.coerce.number().int().nonnegative(),
  })
  .superRefine((config, context) => {
    if (config.stripeDemoMode === 'official-test' && !config.stripeSecretKey) {
      context.addIssue({
        code: 'custom',
        path: ['stripeSecretKey'],
        message: 'STRIPE_SECRET_KEY must be a Stripe test-mode key in official-test mode',
      });
    }
    if (config.providerDatabaseUrl && !config.providerId) {
      context.addIssue({
        code: 'custom',
        path: ['providerId'],
        message: 'MOCK_PROVIDER_ID is required when MOCK_PROVIDER_DATABASE_URL is set',
      });
    }
  });

export function loadMockServicesConfig(environment: NodeJS.ProcessEnv = process.env) {
  return mockServicesConfigSchema.parse({
    port: environment.MOCK_SERVICES_PORT ?? 4100,
    stripeDemoMode: environment.STRIPE_DEMO_MODE ?? 'contract-faithful-rehearsal',
    stripeSecretKey: environment.STRIPE_SECRET_KEY || null,
    slackDemoMode: environment.SLACK_DEMO_MODE ?? 'contract-faithful-rehearsal',
    hubspotDemoMode: environment.HUBSPOT_DEMO_MODE ?? 'contract-faithful-rehearsal',
    providerDatabaseUrl: environment.MOCK_PROVIDER_DATABASE_URL || null,
    providerId: environment.MOCK_PROVIDER_ID || null,
    billingFailureResponseDelayMs: environment.BILLING_FAILURE_RESPONSE_DELAY_MS ?? 1_500,
  });
}
