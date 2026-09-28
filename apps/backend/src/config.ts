import { readFileSync } from 'node:fs';

import { demoProfileIds } from '@atlas/demo-estate';
import { z } from 'zod';

const backendConfigSchema = z
  .object({
    authMode: z.enum(['demo', 'customer']),
    databaseUrl: z.string().min(1),
    executionGrantPrivateKey: z.string().min(1),
    executionGrantPrivateKeys: z.record(z.string().min(1), z.string().min(1)),
    bundleSigningKeyId: z.string().min(1).nullable(),
    bundleSigningPrivateKey: z.string().min(1).nullable(),
    port: z.coerce.number().int().positive(),
    capabilitySourceAllowedHosts: z.array(z.string().min(1)),
    capabilitySourceAllowedPrivateHosts: z.array(z.string().min(1)),
    burgerTownAllowedHosts: z.array(z.string().min(1)),
    burgerTownAllowedPrivateHosts: z.array(z.string().min(1)),
    burgerTownApplicationUrls: z.array(z.string().url()),
    burgerTownOpenApiUrls: z.array(z.string().url()),
    openAiApiKey: z.string().min(1).nullable(),
    openAiModel: z.string().min(1).nullable(),
    githubToken: z.string().min(1).nullable(),
    stripeDemoMode: z.enum(['contract-faithful-rehearsal', 'official-test']),
    slackDemoMode: z.enum(['contract-faithful-rehearsal', 'official-test']),
    hubspotDemoMode: z.enum(['contract-faithful-rehearsal', 'official-test']),
    demoProfile: z.enum(demoProfileIds),
    planningAuthorToken: z.string().min(1).nullable(),
    planningAuthorActorId: z.string().min(1).nullable(),
    planningOrganizationId: z.string().min(1).nullable(),
    approvalAdminToken: z.string().min(1).nullable(),
    approvalAdminActorId: z.string().min(1).nullable(),
    repairOperatorToken: z.string().min(1).nullable(),
    repairOperatorActorId: z.string().min(1).nullable(),
    executionOrganizationId: z.string().min(1).nullable(),
    executionEnvironmentId: z.string().min(1).nullable(),
    workerToken: z.string().min(1).nullable(),
    workerCredentials: z.array(
      z.object({
        organizationId: z.string().min(1),
        environmentId: z.string().min(1),
        token: z.string().min(1),
      }),
    ),
    temporalAddress: z.string().min(1),
    temporalNamespace: z.string().min(1),
    temporalTaskQueue: z.string().min(1),
    workflowSandboxRunnerUrls: z.union([
      z.string().url(),
      z.record(z.string().min(1), z.string().url()),
    ]),
  })
  .superRefine((config, context) => {
    if (Boolean(config.bundleSigningKeyId) !== Boolean(config.bundleSigningPrivateKey)) {
      context.addIssue({
        code: 'custom',
        message: 'Atlas bundle signing key id and private key must be configured together',
        path: ['bundleSigningKeyId'],
      });
    }
    if (Boolean(config.openAiApiKey) !== Boolean(config.openAiModel)) {
      context.addIssue({
        code: 'custom',
        message: 'OPENAI_API_KEY and OPENAI_MODEL must be configured together',
        path: ['openAiApiKey'],
      });
    }
    const planningValues = [
      config.planningAuthorToken,
      config.planningAuthorActorId,
      config.planningOrganizationId,
    ];
    if (planningValues.some(Boolean) && !planningValues.every(Boolean)) {
      context.addIssue({
        code: 'custom',
        message: 'Planning author token, actor, and organization must be configured together',
        path: ['planningAuthorToken'],
      });
    }
    const executionAuthorityValues = [
      config.approvalAdminToken,
      config.approvalAdminActorId,
      config.repairOperatorToken,
      config.repairOperatorActorId,
      config.executionOrganizationId,
    ];
    if (
      config.authMode === 'demo' &&
      executionAuthorityValues.some(Boolean) &&
      !executionAuthorityValues.every(Boolean)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow approval and execution settings must be configured together',
        path: ['approvalAdminToken'],
      });
    }
    if (Boolean(config.executionEnvironmentId) !== Boolean(config.workerToken)) {
      context.addIssue({
        code: 'custom',
        message: 'Legacy execution environment and worker token must be configured together',
        path: ['executionEnvironmentId'],
      });
    }
    for (const credential of config.workerCredentials) {
      if (!config.executionGrantPrivateKeys[credential.environmentId]) {
        context.addIssue({
          code: 'custom',
          message: `No signing key is configured for '${credential.environmentId}'`,
          path: ['executionGrantPrivateKeys'],
        });
      }
    }
    if (
      config.planningOrganizationId &&
      config.executionOrganizationId &&
      config.planningOrganizationId !== config.executionOrganizationId
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The MVP has one organization for planning and execution',
        path: ['planningOrganizationId'],
      });
    }
  });

export type BackendConfig = z.infer<typeof backendConfigSchema>;

const localBurgerTownHost = 'host.docker.internal';
const localBurgerTownApplicationUrl = 'http://host.docker.internal:43123';
const localBurgerTownOpenApiUrl = `${localBurgerTownApplicationUrl}/openapi.json`;

function readOptionalSecret(environmentValue: string | undefined, filePath: string | undefined) {
  if (environmentValue) return environmentValue;
  if (!filePath) return null;
  return readFileSync(filePath, 'utf8').trim() || null;
}

function parseCommaSeparatedList(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function loadBackendConfig(environment: NodeJS.ProcessEnv = process.env): BackendConfig {
  if (environment.ATLAS_AUTH_MODE === 'customer') {
    const demoCredentials = [
      'ATLAS_PLANNING_AUTHOR_TOKEN',
      'ATLAS_APPROVAL_ADMIN_TOKEN',
      'ATLAS_REPAIR_OPERATOR_TOKEN',
      'VITE_ATLAS_PLANNING_AUTHOR_TOKEN',
      'VITE_ATLAS_APPROVAL_ADMIN_TOKEN',
      'VITE_ATLAS_REPAIR_OPERATOR_TOKEN',
    ];
    if (demoCredentials.some((name) => Boolean(environment[name]))) {
      throw new Error('Remove shared human demo tokens before starting Atlas in customer mode');
    }
  }
  const executionEnvironmentId = environment.ATLAS_EXECUTION_ENVIRONMENT_ID || null;
  const workerToken = environment.ATLAS_WORKER_TOKEN || null;
  const executionOrganizationId = environment.ATLAS_EXECUTION_ORGANIZATION_ID || null;
  const workerCredentials = environment.ATLAS_WORKER_CREDENTIALS
    ? JSON.parse(environment.ATLAS_WORKER_CREDENTIALS)
    : executionOrganizationId && executionEnvironmentId && workerToken
      ? [
          {
            organizationId: executionOrganizationId,
            environmentId: executionEnvironmentId,
            token: workerToken,
          },
        ]
      : [];
  const executionGrantPrivateKey = environment.EXECUTION_GRANT_PRIVATE_KEY ?? 'replace-locally';
  const executionGrantPrivateKeys = environment.EXECUTION_GRANT_PRIVATE_KEYS
    ? JSON.parse(environment.EXECUTION_GRANT_PRIVATE_KEYS)
    : executionEnvironmentId
      ? { [executionEnvironmentId]: executionGrantPrivateKey }
      : {};
  return backendConfigSchema.parse({
    authMode: environment.ATLAS_AUTH_MODE ?? 'demo',
    databaseUrl: environment.DATABASE_URL ?? 'postgresql://atlas@localhost:5432/atlas',
    executionGrantPrivateKey,
    executionGrantPrivateKeys,
    bundleSigningKeyId: environment.ATLAS_BUNDLE_SIGNING_KEY_ID || null,
    bundleSigningPrivateKey: environment.ATLAS_BUNDLE_SIGNING_PRIVATE_KEY || null,
    port: environment.ATLAS_BACKEND_PORT ?? 4000,
    capabilitySourceAllowedHosts: parseCommaSeparatedList(
      environment.CAPABILITY_SOURCE_ALLOWED_HOSTS,
    ),
    capabilitySourceAllowedPrivateHosts: parseCommaSeparatedList(
      environment.CAPABILITY_SOURCE_ALLOWED_PRIVATE_HOSTS,
    ),
    burgerTownAllowedHosts: parseCommaSeparatedList(
      environment.ATLAS_BURGER_TOWN_ALLOWED_HOSTS ?? localBurgerTownHost,
    ),
    burgerTownAllowedPrivateHosts: parseCommaSeparatedList(
      environment.ATLAS_BURGER_TOWN_ALLOWED_PRIVATE_HOSTS ?? localBurgerTownHost,
    ),
    burgerTownApplicationUrls: parseCommaSeparatedList(
      environment.ATLAS_BURGER_TOWN_APPLICATION_URLS ?? localBurgerTownApplicationUrl,
    ),
    burgerTownOpenApiUrls: parseCommaSeparatedList(
      environment.ATLAS_BURGER_TOWN_OPENAPI_URLS ?? localBurgerTownOpenApiUrl,
    ),
    openAiApiKey: readOptionalSecret(environment.OPENAI_API_KEY, environment.OPENAI_API_KEY_FILE),
    openAiModel: environment.OPENAI_MODEL || null,
    githubToken: readOptionalSecret(environment.GITHUB_TOKEN, environment.GITHUB_TOKEN_FILE),
    stripeDemoMode: environment.STRIPE_DEMO_MODE ?? 'contract-faithful-rehearsal',
    slackDemoMode: environment.SLACK_DEMO_MODE ?? 'contract-faithful-rehearsal',
    hubspotDemoMode: environment.HUBSPOT_DEMO_MODE ?? 'contract-faithful-rehearsal',
    demoProfile: environment.ATLAS_DEMO_PROFILE ?? 'sample',
    planningAuthorToken: environment.ATLAS_PLANNING_AUTHOR_TOKEN || null,
    planningAuthorActorId: environment.ATLAS_PLANNING_AUTHOR_ACTOR_ID || null,
    planningOrganizationId: environment.ATLAS_PLANNING_ORGANIZATION_ID || null,
    approvalAdminToken: environment.ATLAS_APPROVAL_ADMIN_TOKEN || null,
    approvalAdminActorId: environment.ATLAS_APPROVAL_ADMIN_ACTOR_ID || null,
    repairOperatorToken: environment.ATLAS_REPAIR_OPERATOR_TOKEN || null,
    repairOperatorActorId: environment.ATLAS_REPAIR_OPERATOR_ACTOR_ID || null,
    executionOrganizationId,
    executionEnvironmentId,
    workerToken,
    workerCredentials,
    temporalAddress: environment.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: environment.TEMPORAL_NAMESPACE ?? 'atlas-development',
    temporalTaskQueue: environment.TEMPORAL_TASK_QUEUE ?? 'atlas-development',
    workflowSandboxRunnerUrls: environment.ATLAS_SANDBOX_RUNNER_URLS
      ? JSON.parse(environment.ATLAS_SANDBOX_RUNNER_URLS)
      : (environment.ATLAS_SANDBOX_RUNNER_URL ?? 'http://localhost:4200'),
  });
}
