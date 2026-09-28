import type { Pool } from 'pg';
import { z } from 'zod';

import { discoverCapabilities } from './capability-ingestion.js';
import { reconcileCapabilitySourceClaims } from './capability-source-conflicts.js';
import type { PotentialCoveragePlanner } from './potential-coverage.js';
import { materializeRemoteCapabilitySource } from './source-policy.js';
import type { RediscoverySourcePolicy } from './registered-source-policy.js';

export const rediscoveryRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    capabilityVersionId: z.string().min(1),
    stepId: z.string().min(1),
  })
  .strict();

interface RegisteredSource {
  readonly organization_id: string;
  readonly service_id: string;
  readonly environment_id: string | null;
  readonly source_key: string;
  readonly discovery_input: Record<string, unknown>;
}

export async function markCapabilitySourceObservationsStale(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string; serviceId: string },
  reason: 'discovery-failed' | 'source-disconnected',
) {
  await pool.query(
    `UPDATE environment_capability_observations observation
     SET freshness_status = 'stale', status_reason = $4, status_changed_at = current_timestamp
     FROM capability_identities identity
     WHERE observation.organization_id = $1 AND observation.environment_id = $2
       AND identity.id = observation.capability_identity_id
       AND identity.organization_id = observation.organization_id AND identity.service_id = $3`,
    [scope.organizationId, scope.environmentId, scope.serviceId, reason],
  );
}

export async function disconnectCapabilitySource(
  pool: Pool,
  scope: {
    organizationId: string;
    environmentId: string;
    serviceId: string;
    sourceKey?: string | undefined;
  },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const removed = await client.query(
      `DELETE FROM capability_source_registrations
       WHERE organization_id = $1 AND service_id = $2 AND environment_id = $3
         AND ($4::text IS NULL OR source_key = $4)
       RETURNING 1`,
      [scope.organizationId, scope.serviceId, scope.environmentId, scope.sourceKey ?? null],
    );
    if (removed.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const retired = await client.query<{ capability_identity_id: string }>(
      `UPDATE environment_capability_source_claims claim
       SET active = false, observed_at = current_timestamp
       FROM capability_identities identity
       WHERE claim.organization_id = $1 AND claim.environment_id = $2
         AND claim.capability_identity_id = identity.id
         AND identity.organization_id = $1 AND identity.service_id = $3
         AND ($4::text IS NULL OR claim.source_key = $4)
       RETURNING claim.capability_identity_id`,
      [scope.organizationId, scope.environmentId, scope.serviceId, scope.sourceKey ?? null],
    );
    for (const claim of retired.rows) {
      await client.query(
        `UPDATE environment_capability_observations observation
         SET freshness_status = 'stale', status_reason = 'source-disconnected',
           status_changed_at = current_timestamp
         WHERE observation.organization_id = $1 AND observation.environment_id = $2
           AND observation.capability_identity_id = $3
           AND NOT EXISTS (
             SELECT 1 FROM environment_capability_source_claims active_claim
             WHERE active_claim.organization_id = observation.organization_id
               AND active_claim.environment_id = observation.environment_id
               AND active_claim.capability_identity_id = observation.capability_identity_id
               AND active_claim.active
           )`,
        [scope.organizationId, scope.environmentId, claim.capability_identity_id],
      );
      await reconcileCapabilitySourceClaims(client, {
        organizationId: scope.organizationId,
        environmentId: scope.environmentId,
        capabilityIdentityId: claim.capability_identity_id,
      });
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function refreshableInput(input: Record<string, unknown>) {
  const source = input.source;
  if (!source || typeof source !== 'object' || Array.isArray(source) || !('url' in source)) {
    return input;
  }
  const refreshableSource = { ...source };
  Reflect.deleteProperty(refreshableSource, 'document');
  return { ...input, source: refreshableSource };
}

async function rediscoverRegisteredSource(
  pool: Pool,
  sourcePolicy: RediscoverySourcePolicy,
  registration: RegisteredSource,
  trigger: 'daily-poll' | 'run-drift',
  plannerModel?: PotentialCoveragePlanner,
) {
  try {
    const materialized = await materializeRemoteCapabilitySource(
      {
        ...refreshableInput(registration.discovery_input),
        ...(registration.environment_id ? { environmentId: registration.environment_id } : {}),
        trigger,
      },
      typeof sourcePolicy === 'function'
        ? sourcePolicy(
            registration.service_id,
            (registration.discovery_input.source as Record<string, unknown> | undefined)?.url,
          )
        : sourcePolicy,
    );
    return await discoverCapabilities(pool, materialized, plannerModel);
  } catch (error) {
    await markCapabilitySourceObservationsStale(
      pool,
      {
        organizationId: registration.organization_id,
        environmentId: registration.environment_id ?? 'production',
        serviceId: registration.service_id,
      },
      'discovery-failed',
    );
    throw error;
  }
}

export async function pollRegisteredCapabilitySources(
  pool: Pool,
  sourcePolicy: RediscoverySourcePolicy,
  plannerModel?: PotentialCoveragePlanner,
) {
  const registrations = await pool.query<RegisteredSource>(
    `SELECT organization_id, service_id, environment_id, source_key, discovery_input
     FROM capability_source_registrations
     ORDER BY organization_id, environment_id, service_id`,
  );
  return Promise.all(
    registrations.rows.map((registration) =>
      rediscoverRegisteredSource(pool, sourcePolicy, registration, 'daily-poll', plannerModel),
    ),
  );
}

async function processRediscoveryRequest(
  pool: Pool,
  sourcePolicy: RediscoverySourcePolicy,
  requestId: string,
  plannerModel?: PotentialCoveragePlanner,
) {
  const request = await pool.query<RegisteredSource>(
    `SELECT request.organization_id, identity.service_id, registration.environment_id,
            registration.source_key, registration.discovery_input
     FROM capability_rediscovery_requests request
     JOIN capability_versions version
       ON version.organization_id = request.organization_id
      AND version.capability_version_id = request.capability_version_id
     JOIN capability_identities identity ON identity.id = version.capability_identity_id
     JOIN capability_source_registrations registration
       ON registration.organization_id = request.organization_id
      AND registration.service_id = identity.service_id
      AND registration.environment_id = request.environment_id
     JOIN environment_capability_source_claims claim
       ON claim.organization_id = request.organization_id
      AND claim.environment_id = request.environment_id
      AND claim.capability_identity_id = identity.id
      AND claim.capability_version_id = request.capability_version_id
      AND claim.source_key = registration.source_key
     WHERE request.id = $1 AND request.processed_at IS NULL`,
    [requestId],
  );
  const registration = request.rows[0];
  if (!registration) return undefined;
  const discovery = await rediscoverRegisteredSource(
    pool,
    sourcePolicy,
    registration,
    'run-drift',
    plannerModel,
  );
  await pool.query(
    `UPDATE capability_rediscovery_requests
     SET discovery_id = $2, processed_at = current_timestamp
     WHERE id = $1`,
    [requestId, discovery.discoveryId],
  );
  return discovery;
}

export async function processPendingCapabilityRediscoveryRequests(
  pool: Pool,
  sourcePolicy: RediscoverySourcePolicy,
  plannerModel?: PotentialCoveragePlanner,
) {
  const pending = await pool.query<{ id: string }>(
    `SELECT id FROM capability_rediscovery_requests
     WHERE processed_at IS NULL ORDER BY requested_at, id`,
  );
  return Promise.all(
    pending.rows.map(({ id }) => processRediscoveryRequest(pool, sourcePolicy, id, plannerModel)),
  );
}

export const manualRediscoveryRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1).optional(),
    serviceId: z.string().min(1),
    sourceKey: z.string().min(1).optional(),
  })
  .strict();

export function summarizeCapabilitySourceEvidence(source: Record<string, unknown>) {
  const manualEvidence =
    source.kind === 'human-confirmed'
      ? source
      : source.evidence && typeof source.evidence === 'object' && !Array.isArray(source.evidence)
        ? (source.evidence as Record<string, unknown>)
        : null;
  return manualEvidence?.kind === 'human-confirmed'
    ? {
        kind: 'human-confirmed' as const,
        label: typeof manualEvidence.label === 'string' ? manualEvidence.label : '',
        confirmedBy:
          typeof manualEvidence.confirmedBy === 'string' ? manualEvidence.confirmedBy : '',
        confirmedAt:
          typeof manualEvidence.confirmedAt === 'string' ? manualEvidence.confirmedAt : '',
      }
    : {
        kind:
          source.repositoryProvider === 'github' ? ('github' as const) : ('repository' as const),
        repository: typeof source.repository === 'string' ? source.repository : '',
        commit: typeof source.commit === 'string' ? source.commit : '',
        path: typeof source.path === 'string' ? source.path : '',
      };
}

export async function readCapabilitySourceRegistrations(
  pool: Pool,
  organizationId: string,
  environmentId?: string,
) {
  const result = await pool.query<{
    service_id: string;
    source_key: string;
    discovery_input: Record<string, unknown>;
    updated_at: Date;
  }>(
    `SELECT service_id, source_key, discovery_input, updated_at
     FROM capability_source_registrations
     WHERE organization_id = $1 AND environment_id IS NOT DISTINCT FROM $2
     ORDER BY service_id`,
    [organizationId, environmentId ?? null],
  );
  return {
    registrations: result.rows.map((row) => {
      const source = (row.discovery_input.source ?? {}) as Record<string, unknown>;
      return {
        serviceId: row.service_id,
        sourceKey: row.source_key,
        format: typeof source.format === 'string' ? source.format : null,
        evidence: summarizeCapabilitySourceEvidence(source),
        url: typeof source.url === 'string' ? source.url : null,
        updatedAt: row.updated_at.toISOString(),
      };
    }),
  };
}

export async function rediscoverRegisteredCapabilitySource(
  pool: Pool,
  sourcePolicy: RediscoverySourcePolicy,
  input: unknown,
  plannerModel?: PotentialCoveragePlanner,
) {
  const request = manualRediscoveryRequestSchema.parse(input);
  const result = await pool.query<RegisteredSource>(
    `SELECT organization_id, service_id, environment_id, source_key, discovery_input
     FROM capability_source_registrations
     WHERE organization_id = $1 AND service_id = $2
       AND environment_id IS NOT DISTINCT FROM $3
       AND ($4::text IS NULL OR source_key = $4)
     ORDER BY updated_at DESC, source_key
     LIMIT 1`,
    [
      request.organizationId,
      request.serviceId,
      request.environmentId ?? null,
      request.sourceKey ?? null,
    ],
  );
  const registration = result.rows[0];
  if (!registration) return undefined;
  return rediscoverRegisteredSource(pool, sourcePolicy, registration, 'daily-poll', plannerModel);
}

export async function requestCapabilityRediscovery(
  pool: Pool,
  sourcePolicy: RediscoverySourcePolicy,
  input: unknown,
  plannerModel?: PotentialCoveragePlanner,
) {
  const request = rediscoveryRequestSchema.parse(input);
  const recorded = await pool.query<{ id: string }>(
    `INSERT INTO capability_rediscovery_requests
      (organization_id, environment_id, capability_version_id, step_id)
     SELECT $1, $2, version.capability_version_id, $4
     FROM capability_versions version
     WHERE version.organization_id = $1 AND version.capability_version_id = $3
     RETURNING id`,
    [request.organizationId, request.environmentId, request.capabilityVersionId, request.stepId],
  );
  const row = recorded.rows[0];
  if (!row) return undefined;
  const discovery = await processRediscoveryRequest(pool, sourcePolicy, row.id, plannerModel);
  return discovery
    ? {
        rediscoveryRequestId: row.id,
        discoveryId: discovery.discoveryId,
        trigger: 'run-drift' as const,
        capabilityVersionId: request.capabilityVersionId,
        stepId: request.stepId,
      }
    : undefined;
}

export function startCapabilityRediscoveryTriggers(
  pool: Pool,
  sourcePolicy: RediscoverySourcePolicy,
  options: {
    dailyPollMs?: number;
    requestPollMs?: number;
    plannerModel?: PotentialCoveragePlanner | undefined;
  } = {},
) {
  let dailyPollRunning = false;
  let requestPollRunning = false;
  const run = (operation: () => Promise<unknown>, setRunning: (running: boolean) => void) => {
    setRunning(true);
    void operation()
      .catch((error: unknown) => {
        console.error('Capability rediscovery trigger failed', error);
      })
      .finally(() => setRunning(false));
  };
  const dailyPoll = setInterval(() => {
    if (!dailyPollRunning) {
      run(
        () => pollRegisteredCapabilitySources(pool, sourcePolicy, options.plannerModel),
        (running) => {
          dailyPollRunning = running;
        },
      );
    }
  }, options.dailyPollMs ?? 86_400_000);
  const requestPoll = setInterval(() => {
    if (!requestPollRunning) {
      run(
        () => processPendingCapabilityRediscoveryRequests(pool, sourcePolicy, options.plannerModel),
        (running) => {
          requestPollRunning = running;
        },
      );
    }
  }, options.requestPollMs ?? 1_000);
  dailyPoll.unref();
  requestPoll.unref();
  return () => {
    clearInterval(dailyPoll);
    clearInterval(requestPoll);
  };
}
