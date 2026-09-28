import { serve } from '@hono/node-server';

import {
  connectTemporalRuntime,
  createEncryptedDataConverter,
  createRunRepairExecutor,
  createTemporalWorker,
  createTemporalWorkflowRunStarter,
  createWorkflowResultReader,
} from '@atlas/temporal-adapter';

import { createWorkerApp } from './app.js';
import { createBackendAtlasBundleRunGate } from './backend-bundle-run-gate.js';
import {
  createBackendDriftSignalReporter,
  createBackendRunReporter,
  createBackendRepairCommandProcessor,
  createBackendRunCommandProcessor,
  createBackendInterpreterInputFactory,
  declareBackendEnvironmentWorker,
  type BackendExecutionScope,
} from './backend-execution.js';
import { loadWorkerConfig } from './config.js';
import { createCapabilityStepActivities } from './capability-activities.js';
import { createGenericCapabilityActivityResolver } from './generic-capability-activities.js';
import { createConfigFileSecretProvider } from './secret-provider.js';
import {
  decryptRunCommandPayload,
  ensureRunCommandEncryptionKeyPair,
} from './run-command-payload.js';
import { createSlackCapabilityActivity, loadSlackCapabilityBinding } from './slack-connector.js';
import {
  createHubSpotCapabilityActivity,
  loadHubSpotCapabilityBinding,
} from './hubspot-connector.js';
import {
  createWorkflowSandboxRunner,
  createWorkflowSandboxTemporalRuntime,
} from './workflow-sandbox.js';

const config = loadWorkerConfig();
const runCommandEncryption = await ensureRunCommandEncryptionKeyPair(config.secretConfigPath);
const secretProvider = createConfigFileSecretProvider(config.secretConfigPath);
await assertOutboundServiceHealth(config.mockServicesUrl, 'Mock services');
const dataConverter = createEncryptedDataConverter(
  await secretProvider.getSecret(config.temporalPayloadEncryptionKeyAlias),
);
const temporalRuntime = await connectTemporalRuntime({
  address: config.temporalAddress,
  namespace: config.temporalNamespace,
  dataConverter,
});
const backendExecutionScope: BackendExecutionScope = {
  backendUrl: config.backendUrl,
  workerToken: config.workerToken,
  organizationId: config.organizationId,
  environmentId: config.environmentId,
};
const bundleRunGate = await createBackendAtlasBundleRunGate({
  ...backendExecutionScope,
  grantPublicKey: config.executionGrantPublicKey,
  trustConfigJson: config.bundleTrustConfigJson,
});
await declareBackendEnvironmentWorker({
  ...backendExecutionScope,
  workerId: `${config.temporalNamespace}/${config.temporalTaskQueue}`,
  runCommandPublicKey: runCommandEncryption.publicKey,
});
const runReporter = createBackendRunReporter(backendExecutionScope);
const driftSignalReporter = createBackendDriftSignalReporter(backendExecutionScope);
// Explicit connectors are reserved for official-test modes that require real worker-held
// credentials. Contract-faithful local rehearsal uses the generic fragment binding below.
const officialTestCapabilities = [];
if (config.slackApiUrl !== config.mockServicesUrl) {
  const loadBinding = () =>
    loadSlackCapabilityBinding({
      backendUrl: config.backendUrl,
      organizationId: config.organizationId,
      environmentId: config.environmentId,
    });
  officialTestCapabilities.push(
    createSlackCapabilityActivity({
      binding: await loadBinding(),
      refreshBinding: loadBinding,
      baseUrl: config.slackApiUrl,
      secretProvider,
    }),
  );
}
if (config.hubspotApiUrl !== config.mockServicesUrl) {
  const loadBinding = () =>
    loadHubSpotCapabilityBinding({
      backendUrl: config.backendUrl,
      organizationId: config.organizationId,
      environmentId: config.environmentId,
    });
  officialTestCapabilities.push(
    createHubSpotCapabilityActivity({
      binding: await loadBinding(),
      refreshBinding: loadBinding,
      baseUrl: config.hubspotApiUrl,
      secretProvider,
    }),
  );
}
const resolveGenericCapability = createGenericCapabilityActivityResolver({
  backendUrl: config.backendUrl,
  organizationId: config.organizationId,
  environmentId: config.environmentId,
  providerBaseUrl: config.mockServicesUrl,
  secretProvider,
});
const worker = await createTemporalWorker({
  connection: temporalRuntime.workerConnection,
  taskQueue: config.temporalTaskQueue,
  namespace: config.temporalNamespace,
  activities: createCapabilityStepActivities({
    capabilities: officialTestCapabilities,
    resolveCapability: resolveGenericCapability,
    onDriftSignal: (signal) => driftSignalReporter.emitDriftSignal(signal),
  }),
  stepAttemptReporter: runReporter,
  runReporter,
  dataConverter,
});
const starter = createTemporalWorkflowRunStarter({
  workflowClient: temporalRuntime.workflowClient,
  taskQueue: config.temporalTaskQueue,
  async startAuthorized(input, startTemporal) {
    if (!input.artifactId) throw new Error('Signed Atlas bundle artifact is required for new runs');
    if (!input.grant) throw new Error('Execution grant is required for new runs');
    return await bundleRunGate.startVerifiedTemporalRun(
      { artifactId: input.artifactId, runId: input.grant.runId, grant: input.grant },
      async (verifiedWorkflow) => await startTemporal(verifiedWorkflow),
    );
  },
  createInterpreterInput: createBackendInterpreterInputFactory({
    ...backendExecutionScope,
  }),
  reportLifecycle: true,
});
const sandboxTaskQueue = `${config.temporalTaskQueue}-sandbox`;
const sandbox = await createWorkflowSandboxTemporalRuntime({
  connection: temporalRuntime.workerConnection,
  workflowClient: temporalRuntime.workflowClient,
  namespace: config.temporalNamespace,
  taskQueue: sandboxTaskQueue,
  dataConverter,
  providerBaseUrl: config.mockServicesUrl,
  secretProvider,
});
const sandboxRunner = createWorkflowSandboxRunner({
  organizationId: config.organizationId,
  environmentId: config.environmentId,
  fallbackRunnerBaseUrl: config.mockServicesUrl,
  temporalRuntime: sandbox.runtime,
  secretProvider,
});
const application = createWorkerApp(starter, sandboxRunner, config.intakeHttpEnabled, {
  token: config.workflowResultToken,
  read: createWorkflowResultReader(temporalRuntime.workflowClient),
});
const server = serve({ fetch: (request) => application.fetch(request), port: config.httpPort });
const repairCommandProcessor = createBackendRepairCommandProcessor({
  ...backendExecutionScope,
  repairExecutor: createRunRepairExecutor(temporalRuntime.workflowClient),
});
const runCommandProcessor = createBackendRunCommandProcessor({
  ...backendExecutionScope,
  workerId: `${config.temporalNamespace}/${config.temporalTaskQueue}`,
  starter,
  decryptPayload: (encryptedPayload) =>
    decryptRunCommandPayload(runCommandEncryption.privateKey, encryptedPayload),
});
const runCommandPoll = startGuardedPoll('Run command', () => runCommandProcessor.processNext());
const repairPoll = startGuardedPoll('Repair command', () => repairCommandProcessor.processNext());

console.log(
  config.intakeHttpEnabled
    ? `Atlas worker listening on http://localhost:${config.httpPort} for ${config.temporalNamespace}/${config.temporalTaskQueue}`
    : `Atlas worker polling outbound for ${config.temporalNamespace}/${config.temporalTaskQueue}; inbound HTTP is disabled`,
);

const shutdown = () => {
  clearInterval(repairPoll);
  clearInterval(runCommandPoll);
  server.close();
  worker.shutdown();
  sandbox.worker.shutdown();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
try {
  await Promise.all([worker.run(), sandbox.worker.run()]);
} finally {
  await temporalRuntime.close();
}

async function assertOutboundServiceHealth(baseUrl: string, serviceName: string) {
  let response: Response;
  try {
    response = await fetch(new URL('/health', baseUrl));
  } catch (error) {
    throw new Error(
      `${serviceName} is unreachable: ${error instanceof Error ? error.message : 'request failed'}`,
    );
  }
  if (!response.ok) throw new Error(`${serviceName} health check failed (${response.status})`);
}

function startGuardedPoll(name: string, processNext: () => Promise<unknown>) {
  let polling = false;
  return setInterval(() => {
    if (polling) return;
    polling = true;
    void processNext()
      .catch((error: unknown) => {
        console.error(`${name} polling failed`, error);
      })
      .finally(() => {
        polling = false;
      });
  }, 1_000);
}
