import { fileURLToPath } from 'node:url';

import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { createNonProductionLocalEd25519Signer } from '@atlas/workflow-artifact';

import { createApp } from './app.js';
import { startCapabilityRediscoveryTriggers } from './capability-rediscovery.js';
import { registeredSourcePolicy } from './registered-source-policy.js';
import { loadBackendConfig } from './config.js';
import { createCustomerAuth, loadCustomerAuthConfig } from './customer-auth.js';
import { createCustomerAccess } from './customer-access.js';
import { createDemoAuth } from './demo-auth.js';
import { OpenAiPlannerModel } from './openai-planner-model.js';
import { createGithubRepositorySource } from './github-repository-source.js';
import { createRepositoryContractExtractor } from './repository-contract-extraction.js';
import { startGithubRepositoryChecks } from './github-repository-checks.js';
import { PlanningTraceStore } from './planning-trace.js';
import {
  bootstrapMvpAdminSuite,
  createApprovalMembershipAuthorizer,
  createMembershipAuthorizer,
  createPlanningMembershipAuthorizer,
  createRepairMembershipAuthorizer,
} from './admin-suite.js';
import { createHttpProviderConditionRepairer } from './provider-condition-repair.js';
import { createEnvironmentExecutionGrantIssuer } from './execution-grant-issuer.js';
import { createWorkflowWorkerCredentialsAuthorizer } from './workflow-authorization.js';
import { createHttpWorkflowSandboxExecutor } from './http-workflow-sandbox-executor.js';
import { startAutomaticWorkflowSandboxRetests } from './automatic-workflow-retests.js';
import { startWorkflowScheduleDispatcher } from './workflow-schedules.js';
import { createPostgresRuntimeMismatchNotifier, seedDemoNotifications } from './notifications.js';
import { adminSuiteForDemoProfile, usesSampleDemoData } from './demo-profile.js';
import { seedDemoEnvironmentPolicies } from './demo-environment-policy.js';
import { loadBurgerTownPlan } from './burger-town-plan.js';
import { createBurgerTownMonitor } from './burger-town-monitor.js';
import { createPostgresBurgerTownMonitoringStore } from './burger-town-monitor-store.js';
import { fetchPollingHttp, systemPollingClock } from './burger-town-monitor-runtime.js';

const config = loadBackendConfig();
const customerAuthConfig = loadCustomerAuthConfig();
const bundleSigner =
  config.bundleSigningKeyId && config.bundleSigningPrivateKey
    ? createNonProductionLocalEd25519Signer(
        config.bundleSigningKeyId,
        await crypto.subtle.importKey(
          'pkcs8',
          Buffer.from(config.bundleSigningPrivateKey, 'base64'),
          'Ed25519',
          false,
          ['sign'],
        ),
      )
    : undefined;
const pool = new Pool({ connectionString: config.databaseUrl });
const customerAuth = customerAuthConfig ? createCustomerAuth(pool, customerAuthConfig) : undefined;
const demoAuth = customerAuthConfig
  ? undefined
  : createDemoAuth(pool, config.executionOrganizationId ?? 'org_atlas');
const customerAccess = customerAuth ? createCustomerAccess(customerAuth) : undefined;
const sourcePolicy = {
  allowedHosts: config.capabilitySourceAllowedHosts,
  allowedPrivateHosts: config.capabilitySourceAllowedPrivateHosts,
};
const burgerTownSourcePolicy = {
  allowedHosts: config.burgerTownAllowedHosts,
  allowedPrivateHosts: config.burgerTownAllowedPrivateHosts,
};
const plannerModel =
  config.openAiApiKey && config.openAiModel
    ? new OpenAiPlannerModel({ apiKey: config.openAiApiKey, model: config.openAiModel })
    : undefined;
const repositoryAnalysis =
  config.openAiApiKey && config.openAiModel
    ? {
        source: createGithubRepositorySource(
          config.githubToken ? { token: config.githubToken } : {},
        ),
        extractor: createRepositoryContractExtractor({
          apiKey: config.openAiApiKey,
          model: config.openAiModel,
        }),
      }
    : undefined;
const planningTraceStore = new PlanningTraceStore(
  fileURLToPath(new URL('../../../planner-traces', import.meta.url)),
);
const adminSuiteConfigured =
  !customerAuth &&
  config.planningAuthorToken &&
  config.planningAuthorActorId &&
  config.approvalAdminToken &&
  config.approvalAdminActorId &&
  config.repairOperatorToken &&
  config.repairOperatorActorId &&
  config.executionOrganizationId;
if (adminSuiteConfigured) {
  await bootstrapMvpAdminSuite(
    pool,
    adminSuiteForDemoProfile(config.demoProfile, {
      organizationId: config.executionOrganizationId!,
      authorId: config.planningAuthorActorId!,
      adminId: config.approvalAdminActorId!,
      operatorId: config.repairOperatorActorId!,
    }),
  );
  await demoAuth?.passwords.setPassword({
    userId: config.approvalAdminActorId!,
    username: 'admin',
    password: requiredDemoPassword(),
  });
  if (usesSampleDemoData(config.demoProfile)) {
    await seedDemoNotifications(pool, config.executionOrganizationId!);
  } else if (config.demoProfile === 'burger-town') {
    await seedDemoEnvironmentPolicies(pool, config.executionOrganizationId!, [
      'development',
      'production',
    ]);
  }
}
const membershipAuthorizer =
  customerAccess?.membershipAuthorizer ??
  (adminSuiteConfigured
    ? createMembershipAuthorizer(pool, [
        { token: config.planningAuthorToken!, userId: config.planningAuthorActorId! },
        { token: config.repairOperatorToken!, userId: config.repairOperatorActorId! },
        { token: config.approvalAdminToken!, userId: config.approvalAdminActorId! },
      ])
    : undefined);
const planningAuthorizer = membershipAuthorizer
  ? createPlanningMembershipAuthorizer(membershipAuthorizer)
  : undefined;
const workflowExecutionServices =
  membershipAuthorizer &&
  (customerAuth || adminSuiteConfigured) &&
  bundleSigner &&
  config.workerCredentials.length > 0
    ? {
        approvalAuthorizer: createApprovalMembershipAuthorizer(membershipAuthorizer),
        workerAuthorizer: createWorkflowWorkerCredentialsAuthorizer(config.workerCredentials),
        repairAuthorizer: createRepairMembershipAuthorizer(membershipAuthorizer),
        executionGrantIssuer: createEnvironmentExecutionGrantIssuer(
          config.executionGrantPrivateKeys,
        ),
        bundleSigner,
      }
    : undefined;
const workflowSandboxExecutor = createHttpWorkflowSandboxExecutor(config.workflowSandboxRunnerUrls);
const burgerTownPlan = !customerAuth ? loadBurgerTownPlan() : undefined;
const burgerTownMonitor = createBurgerTownMonitor(
  createPostgresBurgerTownMonitoringStore(pool, burgerTownPlan),
  fetchPollingHttp,
  systemPollingClock,
  { runtimeMismatchNotifier: createPostgresRuntimeMismatchNotifier(pool) },
);
const app = createApp(
  pool,
  sourcePolicy,
  plannerModel,
  planningAuthorizer,
  workflowExecutionServices,
  membershipAuthorizer,
  {
    ...(customerAuth && customerAccess
      ? {
          customerAuth: {
            routes: customerAuth.routes,
            middleware: customerAccess.middleware,
            currentActor: customerAccess.currentActor,
          },
        }
      : {}),
    ...(demoAuth ? { demoAuth: { routes: demoAuth.routes } } : {}),
    ...(burgerTownPlan
      ? {
          burgerTownAllowedApplicationUrls: config.burgerTownApplicationUrls,
          burgerTownAllowedOpenApiUrls: config.burgerTownOpenApiUrls,
          burgerTownPlan,
          burgerTownSourcePolicy,
        }
      : {}),
    planningTraceStore,
    repositoryAnalysisConfigured: Boolean(repositoryAnalysis),
    ...(!customerAuth
      ? {
          burgerTownMonitor,
          providerConditionRepairer: createHttpProviderConditionRepairer(
            process.env.ATLAS_DEMO_PROVIDER_URL ?? 'http://localhost:4100',
          ),
        }
      : {}),
    workflowSandboxExecutor,
  },
);
startCapabilityRediscoveryTriggers(
  pool,
  registeredSourcePolicy(sourcePolicy, {
    serviceId: burgerTownPlan?.serviceId,
    urls: config.burgerTownOpenApiUrls,
    policy: burgerTownPlan ? burgerTownSourcePolicy : undefined,
  }),
  { plannerModel },
);
startAutomaticWorkflowSandboxRetests(pool, workflowSandboxExecutor);
if (repositoryAnalysis) startGithubRepositoryChecks(pool, repositoryAnalysis);
startWorkflowScheduleDispatcher(pool);

serve({
  fetch: app.fetch,
  port: config.port,
});

console.log(`Atlas backend shell listening on http://localhost:${config.port}`);

function requiredDemoPassword(): string {
  const password = process.env.ATLAS_DEMO_ADMIN_PASSWORD;
  if (!password) throw new Error('ATLAS_DEMO_ADMIN_PASSWORD is required; run pnpm setup:local.');
  return password;
}
