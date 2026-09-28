import type { Pool } from 'pg';
import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const bundleVerificationEventSchema = z
  .object({
    eventType: z.literal('atlas-bundle-verification'),
    outcome: z.enum(['accepted', 'rejected']),
    reason: z.literal('policy-or-integrity-check-failed').optional(),
    artifactId: sha256.optional(),
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();

export async function readAtlasWorkflowBundle(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string },
  artifactId: string,
) {
  if (!sha256.safeParse(artifactId).success) return undefined;
  const result = await pool.query<{ bundle_bytes: Buffer }>(
    `SELECT bundle_bytes FROM atlas_workflow_bundles
     WHERE organization_id = $1 AND environment_id = $2 AND artifact_id = $3`,
    [scope.organizationId, scope.environmentId, artifactId],
  );
  return result.rows[0]?.bundle_bytes;
}

export async function readAtlasBundleExecutionPolicy(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string },
  artifactId: string,
) {
  if (!sha256.safeParse(artifactId).success) return undefined;
  const result = await pool.query<{
    activation_artifact_id: string;
    approval_binding: unknown;
  }>(
    `SELECT activation_artifact_id, approval_binding FROM atlas_workflow_bundles
     WHERE organization_id = $1 AND environment_id = $2 AND artifact_id = $3`,
    [scope.organizationId, scope.environmentId, artifactId],
  );
  const row = result.rows[0];
  return row
    ? { activationArtifactId: row.activation_artifact_id.trim(), approval: row.approval_binding }
    : undefined;
}

export async function recordAtlasBundleVerificationEvent(
  pool: Pick<Pool, 'query'>,
  value: unknown,
) {
  const event = bundleVerificationEventSchema.parse(value);
  await pool.query(
    `INSERT INTO atlas_bundle_verification_events
       (organization_id, environment_id, artifact_id, outcome, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      event.organizationId,
      event.environmentId,
      event.artifactId ?? null,
      event.outcome,
      event.reason ?? null,
    ],
  );
  return event;
}

export async function readLatestAtlasBundleVerificationEvent(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string },
  artifactId: string,
) {
  if (!sha256.safeParse(artifactId).success) return undefined;
  const result = await pool.query<{
    outcome: 'accepted' | 'rejected';
    reason: string | null;
    recorded_at: Date;
  }>(
    `SELECT outcome, reason, recorded_at FROM atlas_bundle_verification_events
     WHERE organization_id = $1 AND environment_id = $2 AND artifact_id = $3
     ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [scope.organizationId, scope.environmentId, artifactId],
  );
  const row = result.rows[0];
  return row
    ? {
        outcome: row.outcome,
        ...(row.reason ? { reason: row.reason } : {}),
        recordedAt: row.recorded_at.toISOString(),
      }
    : undefined;
}
