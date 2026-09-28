import type { Pool } from 'pg';
import { z } from 'zod';

import {
  burgerTownRecognizedErrorSchema,
  type BurgerTownConnectionPlan,
} from './burger-town-connection.js';
import { canonicalJson, sha256 } from './capability-versioning.js';
import {
  BurgerTownMonitoringUnavailable,
  type BurgerTownMonitoringState,
  type BurgerTownMonitoringStore,
} from './burger-town-monitor.js';

const expectedSuccessSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    acceptAnyStatus: z.boolean().optional(),
  })
  .strict();

interface PollingDefinitionRow {
  definition_key: string;
  revision: number;
  capability_version_id: string;
  application_url: string;
  method: string;
  path: string;
  request_body: Record<string, unknown>;
  expected_success: unknown;
  recognized_error: unknown;
  capability_ready: boolean;
  host_ready: boolean;
}

interface RuntimeIncidentIdentity {
  organizationId: string;
  environmentId: string;
  capabilityIdentityId: string;
  operationId: string;
  reason: 'required-field-missing';
  fieldPath: string;
}

function runtimeIncidentIdentityValues(identity: RuntimeIncidentIdentity) {
  return [
    identity.organizationId,
    identity.environmentId,
    identity.capabilityIdentityId,
    identity.operationId,
    identity.reason,
    identity.fieldPath,
  ];
}

function runtimeIncidentSignature(identity: RuntimeIncidentIdentity) {
  return sha256(canonicalJson(identity));
}

function displayName(definitionKey: string) {
  return definitionKey.split(':').at(-1) ?? definitionKey;
}

export function createPostgresBurgerTownMonitoringStore(
  pool: Pool,
  _plan?: BurgerTownConnectionPlan,
): BurgerTownMonitoringStore {
  return {
    async readStatus(scope) {
      const result = await pool.query<{
        state: BurgerTownMonitoringState;
        last_completed_sweep_at: Date | null;
        readiness_message: string | null;
      }>(
        `SELECT state, last_completed_sweep_at, readiness_message
         FROM capability_monitoring_state
         WHERE organization_id = $1 AND environment_id = $2`,
        [scope.organizationId, scope.environmentId],
      );
      const row = result.rows[0];
      return row
        ? {
            state: row.state,
            lastCompletedSweepAt: row.last_completed_sweep_at?.toISOString() ?? null,
            readinessMessage: row.readiness_message,
          }
        : { state: 'unavailable', lastCompletedSweepAt: null, readinessMessage: null };
    },

    async loadReadyTargets(scope) {
      const result = await pool.query<PollingDefinitionRow>(
        `WITH latest AS (
           SELECT definition.*, row_number() OVER (
             PARTITION BY organization_id, environment_id, definition_key
             ORDER BY revision DESC
           ) AS position
           FROM capability_polling_definitions definition
           WHERE organization_id = $1 AND environment_id = $2
         )
         SELECT latest.definition_key, latest.revision, trim(latest.capability_version_id) AS capability_version_id,
                latest.application_url, latest.method, latest.path, latest.request_body,
                latest.expected_success, latest.recognized_error,
                EXISTS (
                  SELECT 1 FROM capability_approvals approval
                  WHERE approval.organization_id = latest.organization_id
                    AND approval.capability_version_id = latest.capability_version_id
                    AND approval.revoked_at IS NULL
                ) AS capability_ready,
                EXISTS (
                  SELECT 1
                  FROM capability_versions capability
                  JOIN capability_host_policies policy
                    ON policy.organization_id = capability.organization_id
                   AND policy.capability_identity_id = capability.capability_identity_id
                   AND policy.environment_id = latest.environment_id
                   AND policy.revoked_at IS NULL
                  WHERE capability.organization_id = latest.organization_id
                    AND capability.capability_version_id = latest.capability_version_id
                    AND policy.hostname = lower((regexp_match(latest.application_url, '^https?://([^/:]+)'))[1])
                ) AS host_ready
         FROM latest
         WHERE latest.position = 1 AND latest.enabled
           AND latest.expected_success->>'acceptAnyStatus' IS DISTINCT FROM 'true'
         ORDER BY latest.definition_key`,
        [scope.organizationId, scope.environmentId],
      );
      const targets = result.rows.map((row) => {
        if (!row.capability_ready || !row.host_ready) {
          throw new BurgerTownMonitoringUnavailable(
            `${displayName(row.definition_key)} is not ready for monitoring`,
          );
        }
        try {
          const expected = expectedSuccessSchema.parse(row.expected_success);
          const recognizedError = burgerTownRecognizedErrorSchema.parse(row.recognized_error);
          return {
            definitionKey: row.definition_key,
            revision: row.revision,
            capabilityVersionId: row.capability_version_id,
            url: new URL(row.path, row.application_url).href,
            method: row.method,
            requestBody: row.request_body,
            expectedStatus: expected.status,
            acceptAnyStatus: expected.acceptAnyStatus === true,
            recognizedError: {
              status: recognizedError.status,
              code: recognizedError.code,
              codePath: recognizedError.codePath,
              fieldPathPath: recognizedError.fieldPathPath,
              ...(recognizedError.fieldPath ? { fieldPath: recognizedError.fieldPath } : {}),
            },
          };
        } catch (error) {
          throw new BurgerTownMonitoringUnavailable(
            `${displayName(row.definition_key)} has incomplete polling settings`,
            { cause: error },
          );
        }
      });

      return targets;
    },

    async hasSuccessfulBaseline(scope, target) {
      const result = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM capability_polling_baselines
           WHERE organization_id = $1 AND environment_id = $2
             AND definition_key = $3 AND revision = $4
         )`,
        [scope.organizationId, scope.environmentId, target.definitionKey, target.revision],
      );
      return result.rows[0]?.exists === true;
    },

    async saveStatus(scope, status) {
      await pool.query(
        `INSERT INTO capability_monitoring_state
          (organization_id, environment_id, state, changed_at, last_completed_sweep_at, readiness_message)
         VALUES ($1, $2, $3, current_timestamp, $4, $5)
         ON CONFLICT (organization_id, environment_id) DO UPDATE
           SET state = EXCLUDED.state, changed_at = current_timestamp,
               last_completed_sweep_at = EXCLUDED.last_completed_sweep_at,
               readiness_message = EXCLUDED.readiness_message`,
        [
          scope.organizationId,
          scope.environmentId,
          status.state,
          status.lastCompletedSweepAt,
          status.readinessMessage,
        ],
      );
    },

    async saveSuccessfulResponse(scope, target, succeededAt) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO capability_polling_baselines
            (organization_id, environment_id, definition_key, revision, last_succeeded_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (organization_id, environment_id, definition_key, revision) DO UPDATE
             SET last_succeeded_at = EXCLUDED.last_succeeded_at`,
          [
            scope.organizationId,
            scope.environmentId,
            target.definitionKey,
            target.revision,
            succeededAt,
          ],
        );
        const recovered = await client.query<{ id: string; condition_key: string }>(
          `UPDATE runtime_contract_mismatches
           SET state = 'recovered', recovered_at = $6
           WHERE organization_id = $1 AND environment_id = $2
             AND definition_key = $3 AND polling_definition_revision = $4
             AND capability_version_id = $5 AND state = 'active'
           RETURNING id, condition_key`,
          [
            scope.organizationId,
            scope.environmentId,
            target.definitionKey,
            target.revision,
            target.capabilityVersionId,
            succeededAt,
          ],
        );
        await client.query('COMMIT');
        return recovered.rows.map((row) => ({ id: row.id, conditionKey: row.condition_key }));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async savePollingFailure(scope, target, failure, observedAt) {
      await pool.query(
        `INSERT INTO capability_polling_failures
          (organization_id, environment_id, definition_key, polling_definition_revision,
           capability_version_id, reason, status_code, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT
           (organization_id, environment_id, definition_key, polling_definition_revision)
         DO UPDATE SET reason = EXCLUDED.reason, status_code = EXCLUDED.status_code,
           last_seen_at = EXCLUDED.last_seen_at,
           occurrence_count = capability_polling_failures.occurrence_count + 1`,
        [
          scope.organizationId,
          scope.environmentId,
          target.definitionKey,
          target.revision,
          target.capabilityVersionId,
          failure.reason,
          failure.status,
          observedAt,
        ],
      );
    },

    async saveRuntimeMismatch(scope, target, mismatch, observedAt) {
      const observationId = crypto.randomUUID();
      const client = await pool.connect();
      let stored: { id: string } | undefined;
      try {
        await client.query('BEGIN');
        const baselineQualifiedTargetResult = await client.query<{
          capability_identity_id: string;
          operation_id: string;
        }>(
          `SELECT identity.id::text AS capability_identity_id, identity.operation_id
           FROM capability_polling_baselines baseline
           JOIN capability_polling_definitions definition
             ON definition.organization_id = baseline.organization_id
            AND definition.environment_id = baseline.environment_id
            AND definition.definition_key = baseline.definition_key
            AND definition.revision = baseline.revision
           JOIN capability_versions version
             ON version.organization_id = definition.organization_id
            AND version.capability_version_id = definition.capability_version_id
           JOIN capability_identities identity
             ON identity.id = version.capability_identity_id
            AND identity.organization_id = version.organization_id
           WHERE baseline.organization_id = $1 AND baseline.environment_id = $2
             AND baseline.definition_key = $3 AND baseline.revision = $4
             AND definition.capability_version_id = $5`,
          [
            scope.organizationId,
            scope.environmentId,
            target.definitionKey,
            target.revision,
            target.capabilityVersionId,
          ],
        );
        const baselineQualifiedTarget = baselineQualifiedTargetResult.rows[0];
        if (!baselineQualifiedTarget) {
          await client.query('ROLLBACK');
          return null;
        }
        const fieldPath = mismatch.fieldPath.slice(0, 512);
        const incidentIdentity: RuntimeIncidentIdentity = {
          organizationId: scope.organizationId,
          environmentId: scope.environmentId,
          capabilityIdentityId: baselineQualifiedTarget.capability_identity_id,
          operationId: baselineQualifiedTarget.operation_id,
          reason: mismatch.reason,
          fieldPath,
        };
        const incidentIdentityValues = runtimeIncidentIdentityValues(incidentIdentity);
        const conditionSignature = runtimeIncidentSignature(incidentIdentity);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          conditionSignature,
        ]);
        await client.query(
          `INSERT INTO runtime_contract_mismatch_observations
            (id, organization_id, environment_id, capability_identity_id,
             capability_version_id, definition_key, polling_definition_revision,
             operation_id, reason, field_path, status_code, observed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            observationId,
            scope.organizationId,
            scope.environmentId,
            baselineQualifiedTarget.capability_identity_id,
            target.capabilityVersionId,
            target.definitionKey,
            target.revision,
            baselineQualifiedTarget.operation_id,
            mismatch.reason,
            fieldPath,
            mismatch.status,
            observedAt,
          ],
        );
        const activeCondition = await client.query<{ id: string; condition_key: string }>(
          `SELECT id, condition_key
           FROM runtime_contract_mismatches
           WHERE organization_id = $1 AND environment_id = $2
             AND capability_identity_id = $3 AND operation_id = $4
             AND reason = $5 AND field_path = $6 AND state = 'active'
           ORDER BY last_seen_at DESC
           LIMIT 1
           FOR UPDATE`,
          incidentIdentityValues,
        );
        const active = activeCondition.rows[0];
        const condition = active
          ? await client.query<{ id: string }>(
              `UPDATE runtime_contract_mismatches
               SET capability_version_id = $2, definition_key = $3,
                   polling_definition_revision = $4, status_code = $5,
                   last_seen_at = $6,
                   occurrence_count = occurrence_count + 1,
                   latest_observation_id = $7
               WHERE id = $1
               RETURNING id`,
              [
                active.id,
                target.capabilityVersionId,
                target.definitionKey,
                target.revision,
                mismatch.status,
                observedAt,
                observationId,
              ],
            )
          : await client.query<{ id: string }>(
              `INSERT INTO runtime_contract_mismatches
                (id, organization_id, environment_id, condition_key, capability_identity_id,
                 capability_version_id, definition_key, polling_definition_revision,
                 operation_id, reason, field_path, status_code, first_seen_at, last_seen_at,
                 latest_observation_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)
               RETURNING id`,
              [
                `runtime-mismatch-${sha256(observationId)}`,
                scope.organizationId,
                scope.environmentId,
                `runtime-contract-mismatch:${conditionSignature}:${sha256(observationId)}`,
                baselineQualifiedTarget.capability_identity_id,
                target.capabilityVersionId,
                target.definitionKey,
                target.revision,
                baselineQualifiedTarget.operation_id,
                mismatch.reason,
                fieldPath,
                mismatch.status,
                observedAt,
                observationId,
              ],
            );
        stored = condition.rows[0];
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return stored?.id ?? null;
    },
  };
}
