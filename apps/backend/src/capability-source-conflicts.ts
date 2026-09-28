import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { canonicalJson, sha256 } from './capability-versioning.js';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

export const capabilitySourceAuthoritySchema = z
  .object({ sourceKey: z.string().min(1).nullable() })
  .strict();

export function capabilitySourceKey(source: Record<string, unknown>): string {
  const evidence =
    source.evidence && typeof source.evidence === 'object' && !Array.isArray(source.evidence)
      ? (source.evidence as Record<string, unknown>)
      : source;
  const identity =
    evidence.kind === 'human-confirmed'
      ? { kind: 'human-confirmed', label: evidence.label, confirmedBy: evidence.confirmedBy }
      : {
          kind: source.repositoryProvider === 'github' ? 'github' : 'repository',
          repository: source.repository,
          path: source.path,
        };
  return sha256(canonicalJson(identity));
}

export async function reconcileCapabilitySourceClaims(
  queryable: Queryable,
  scope: { organizationId: string; environmentId: string; capabilityIdentityId: string },
) {
  const result = await queryable.query<{
    source_key: string;
    capability_version_id: string;
    capability_fragment_hash: string;
    observed_at: Date;
    authoritative_source_key: string | null;
  }>(
    `SELECT claim.source_key, claim.capability_version_id, version.capability_fragment_hash,
      claim.observed_at,
      authority.source_key AS authoritative_source_key
     FROM environment_capability_source_claims claim
     JOIN capability_versions version
       ON version.organization_id = claim.organization_id
      AND version.capability_version_id = claim.capability_version_id
     LEFT JOIN environment_capability_source_authorities authority
       ON authority.organization_id = claim.organization_id
      AND authority.environment_id = claim.environment_id
      AND authority.capability_identity_id = claim.capability_identity_id
     WHERE claim.organization_id = $1 AND claim.environment_id = $2
       AND claim.capability_identity_id = $3 AND claim.active
     ORDER BY claim.observed_at DESC, claim.source_key`,
    [scope.organizationId, scope.environmentId, scope.capabilityIdentityId],
  );
  if (result.rows.length === 0) return;
  const authoritativeSourceKey = result.rows[0]!.authoritative_source_key;
  const authoritative = authoritativeSourceKey
    ? result.rows.find((claim) => claim.source_key === authoritativeSourceKey)
    : undefined;
  const contracts = new Set(result.rows.map((claim) => claim.capability_fragment_hash.trim()));
  const selected = authoritative ?? result.rows[0]!;
  const status = authoritative
    ? 'authoritative'
    : contracts.size > 1
      ? 'conflicting'
      : 'uncontested';
  await queryable.query(
    `UPDATE environment_capability_observations
     SET capability_version_id = $4, source_resolution_status = $5,
       observed_at = $6, availability_status = 'available', freshness_status = 'fresh',
       status_reason = 'successful-discovery', status_changed_at = current_timestamp
     WHERE organization_id = $1 AND environment_id = $2 AND capability_identity_id = $3`,
    [
      scope.organizationId,
      scope.environmentId,
      scope.capabilityIdentityId,
      selected.capability_version_id,
      status,
      selected.observed_at,
    ],
  );
}

export async function designateCapabilitySourceAuthority(
  pool: Pool,
  input: {
    organizationId: string;
    environmentId: string;
    capabilityIdentityId: string;
    sourceKey: string | null;
    actorId: string;
  },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const identity = await client.query(
      `SELECT 1 FROM environment_capability_observations
       WHERE organization_id = $1 AND environment_id = $2 AND capability_identity_id = $3`,
      [input.organizationId, input.environmentId, input.capabilityIdentityId],
    );
    if (identity.rowCount === 0) {
      await client.query('ROLLBACK');
      return undefined;
    }
    if (input.sourceKey !== null) {
      const claim = await client.query(
        `SELECT 1 FROM environment_capability_source_claims
         WHERE organization_id = $1 AND environment_id = $2 AND capability_identity_id = $3
           AND source_key = $4 AND active`,
        [input.organizationId, input.environmentId, input.capabilityIdentityId, input.sourceKey],
      );
      if (claim.rowCount === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }
      await client.query(
        `INSERT INTO environment_capability_source_authorities
          (organization_id, environment_id, capability_identity_id, source_key, designated_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, environment_id, capability_identity_id)
         DO UPDATE SET source_key = EXCLUDED.source_key, designated_by = EXCLUDED.designated_by,
           designated_at = current_timestamp`,
        [
          input.organizationId,
          input.environmentId,
          input.capabilityIdentityId,
          input.sourceKey,
          input.actorId,
        ],
      );
    } else {
      await client.query(
        `DELETE FROM environment_capability_source_authorities
         WHERE organization_id = $1 AND environment_id = $2 AND capability_identity_id = $3`,
        [input.organizationId, input.environmentId, input.capabilityIdentityId],
      );
    }
    await reconcileCapabilitySourceClaims(client, input);
    const resolved = await client.query<{
      source_resolution_status: string;
      capability_version_id: string;
    }>(
      `SELECT source_resolution_status, capability_version_id
       FROM environment_capability_observations
       WHERE organization_id = $1 AND environment_id = $2 AND capability_identity_id = $3`,
      [input.organizationId, input.environmentId, input.capabilityIdentityId],
    );
    await client.query(
      `INSERT INTO audit_entries
        (organization_id, environment_id, event_type, subject_type, subject_id, actor_id, details)
       VALUES ($1, $2, 'capability-source-authority', 'capability-version', $3, $4,
         jsonb_build_object(
           'capabilityIdentityId', $5::text, 'sourceKey', $6::text, 'action', $7::text))`,
      [
        input.organizationId,
        input.environmentId,
        resolved.rows[0]!.capability_version_id.trim(),
        input.actorId,
        input.capabilityIdentityId,
        input.sourceKey,
        input.sourceKey === null ? 'cleared' : 'designated',
      ],
    );
    await client.query('COMMIT');
    return {
      sourceKey: input.sourceKey,
      resolution: resolved.rows[0]!.source_resolution_status,
      capabilityVersionId: resolved.rows[0]!.capability_version_id.trim(),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
