import { canonicalEnvironmentIdSchema, type CanonicalEnvironmentId } from '@atlas/workflow-ir';

export interface IngestConfig {
  workerUrl: string;
  workflowResultToken: string;
  responseTimeoutMs: number;
  backendToken: string;
  backendUrl: string;
  callerToken: string;
  environmentId: CanonicalEnvironmentId;
  httpPort: number;
  organizationId: string;
}

export function loadIngestConfig(environment: NodeJS.ProcessEnv = process.env): IngestConfig {
  const configuredEnvironmentId = environment.ATLAS_EXECUTION_ENVIRONMENT_ID ?? 'development';
  const environmentId = canonicalEnvironmentIdSchema.safeParse(configuredEnvironmentId);
  if (!environmentId.success) {
    throw new Error(
      configuredEnvironmentId === 'production-like'
        ? 'ATLAS_EXECUTION_ENVIRONMENT_ID "production-like" is retired; use "production"'
        : 'ATLAS_EXECUTION_ENVIRONMENT_ID must be "development" or "production"',
    );
  }
  const config = {
    workerUrl: environment.ATLAS_INGEST_WORKER_URL ?? 'http://localhost:4200',
    workflowResultToken: environment.ATLAS_WORKFLOW_RESULT_TOKEN ?? 'replace-locally',
    responseTimeoutMs: Number(environment.ATLAS_INGEST_RESPONSE_TIMEOUT_MS ?? 60_000),
    backendToken: environment.ATLAS_INGEST_BACKEND_TOKEN ?? 'replace-locally',
    backendUrl: environment.ATLAS_BACKEND_URL ?? 'http://localhost:4000',
    callerToken: environment.ATLAS_INGEST_CALLER_TOKEN ?? 'replace-locally',
    environmentId: environmentId.data,
    httpPort: Number(environment.ATLAS_INGEST_PORT ?? 4300),
    organizationId: environment.ATLAS_EXECUTION_ORGANIZATION_ID ?? 'org_atlas',
  };

  for (const [name, value] of Object.entries(config).filter(
    ([, value]) => typeof value === 'string',
  )) {
    const stringValue = value as string;
    if (stringValue.trim().length === 0) {
      throw new Error(`${name} must not be empty`);
    }
  }
  new URL(config.backendUrl);
  new URL(config.workerUrl);
  if (!Number.isSafeInteger(config.responseTimeoutMs) || config.responseTimeoutMs < 1) {
    throw new Error('responseTimeoutMs must be a positive integer');
  }
  if (!Number.isInteger(config.httpPort) || config.httpPort <= 0) {
    throw new Error('httpPort must be a positive integer');
  }

  return config;
}
