import { canonicalEnvironmentIdSchema, type CanonicalEnvironmentId } from '@atlas/workflow-ir';

export interface WorkerConfig {
  workflowResultToken: string;
  backendUrl: string;
  bundleTrustConfigJson: string;
  environmentId: CanonicalEnvironmentId;
  executionGrantPublicKey: string;
  httpPort: number;
  intakeHttpEnabled: boolean;
  mockServicesUrl: string;
  slackApiUrl: string;
  hubspotApiUrl: string;
  organizationId: string;
  runCommandEncryptionKeyAlias: string;
  secretConfigPath: string;
  temporalPayloadEncryptionKeyAlias: string;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  workerToken: string;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const mockServicesUrl = environment.MOCK_SERVICES_URL ?? 'http://localhost:4100';
  const configuredEnvironmentId = environment.ATLAS_EXECUTION_ENVIRONMENT_ID ?? 'production';
  // TODO(#148-transition-removal): remove the tailored stale-config error after the rename window.
  const environmentId = canonicalEnvironmentIdSchema.safeParse(configuredEnvironmentId);
  if (!environmentId.success) {
    throw new Error(
      configuredEnvironmentId === 'production-like'
        ? 'ATLAS_EXECUTION_ENVIRONMENT_ID "production-like" is retired; use "production"'
        : 'ATLAS_EXECUTION_ENVIRONMENT_ID must be "development" or "production"',
    );
  }
  const config = {
    workflowResultToken: environment.ATLAS_WORKFLOW_RESULT_TOKEN ?? 'replace-locally',
    backendUrl: environment.ATLAS_BACKEND_URL ?? 'http://localhost:4000',
    bundleTrustConfigJson: environment.ATLAS_BUNDLE_TRUST_CONFIG ?? '{"keys":[]}',
    environmentId: environmentId.data,
    executionGrantPublicKey: environment.EXECUTION_GRANT_PUBLIC_KEY ?? 'replace-locally',
    httpPort: Number(environment.ATLAS_WORKER_PORT ?? 4200),
    intakeHttpEnabled: environment.ATLAS_WORKER_INTAKE_HTTP_ENABLED !== 'false',
    mockServicesUrl,
    slackApiUrl:
      environment.SLACK_DEMO_MODE === 'official-test' ? 'https://slack.com' : mockServicesUrl,
    hubspotApiUrl:
      environment.HUBSPOT_DEMO_MODE === 'official-test'
        ? 'https://api.hubapi.com'
        : mockServicesUrl,
    organizationId: environment.ATLAS_EXECUTION_ORGANIZATION_ID ?? 'org_atlas',
    runCommandEncryptionKeyAlias:
      environment.RUN_COMMAND_ENCRYPTION_KEY_ALIAS ?? 'runCommandEncryptionKey',
    secretConfigPath: environment.WORKER_SECRET_CONFIG_PATH ?? './.local/worker-secrets.json',
    temporalPayloadEncryptionKeyAlias:
      environment.TEMPORAL_PAYLOAD_ENCRYPTION_KEY_ALIAS ?? 'temporalPayloadEncryptionKey',
    temporalAddress: environment.TEMPORAL_ADDRESS ?? 'localhost:7233',
    temporalNamespace: environment.TEMPORAL_NAMESPACE ?? 'atlas-development',
    temporalTaskQueue: environment.TEMPORAL_TASK_QUEUE ?? 'atlas-development',
    workerToken: environment.ATLAS_WORKER_TOKEN ?? 'replace-locally',
  };

  // Fail at startup if an explicitly supplied value is empty or the backend URL is invalid.
  for (const [name, value] of Object.entries(config).filter(
    ([, value]) => typeof value === 'string',
  )) {
    const stringValue = value as string;
    if (stringValue.trim().length === 0) {
      throw new Error(`${name} must not be empty`);
    }
  }
  new URL(config.backendUrl);
  new URL(config.mockServicesUrl);
  new URL(config.slackApiUrl);
  new URL(config.hubspotApiUrl);
  if (!Number.isInteger(config.httpPort) || config.httpPort <= 0) {
    throw new Error('httpPort must be a positive integer');
  }

  return config;
}
