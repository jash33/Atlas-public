import type { Pool } from 'pg';
import { z } from 'zod';

export const capabilityUserAnnotationSchema = z
  .object({ body: z.string().trim().min(1).max(2000) })
  .strict();

interface AnnotationRow {
  id: string | number;
  body: string;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

function presentAnnotation(row: AnnotationRow) {
  return {
    id: String(row.id),
    body: row.body,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function createCapabilityUserAnnotation(
  pool: Pick<Pool, 'query'>,
  input: {
    organizationId: string;
    capabilityIdentityId: string;
    body: string;
    actorId: string;
  },
) {
  const result = await pool.query<AnnotationRow>(
    `INSERT INTO capability_user_annotations
       (organization_id, capability_identity_id, body, created_by, updated_by)
     SELECT $1, identity.id, $3, $4, $4
     FROM capability_identities identity
     WHERE identity.organization_id = $1 AND identity.id = $2
     RETURNING id, body, created_by, updated_by, created_at, updated_at`,
    [input.organizationId, input.capabilityIdentityId, input.body, input.actorId],
  );
  return result.rows[0] ? presentAnnotation(result.rows[0]) : undefined;
}

export async function updateCapabilityUserAnnotation(
  pool: Pick<Pool, 'query'>,
  input: {
    organizationId: string;
    capabilityIdentityId: string;
    annotationId: string;
    body: string;
    actorId: string;
  },
) {
  const result = await pool.query<AnnotationRow>(
    `UPDATE capability_user_annotations
     SET body = $4, updated_by = $5, updated_at = current_timestamp
     WHERE organization_id = $1 AND capability_identity_id = $2 AND id = $3
     RETURNING id, body, created_by, updated_by, created_at, updated_at`,
    [
      input.organizationId,
      input.capabilityIdentityId,
      input.annotationId,
      input.body,
      input.actorId,
    ],
  );
  return result.rows[0] ? presentAnnotation(result.rows[0]) : undefined;
}

export async function deleteCapabilityUserAnnotation(
  pool: Pick<Pool, 'query'>,
  input: {
    organizationId: string;
    capabilityIdentityId: string;
    annotationId: string;
  },
) {
  const result = await pool.query(
    `DELETE FROM capability_user_annotations
     WHERE organization_id = $1 AND capability_identity_id = $2 AND id = $3
     RETURNING id`,
    [input.organizationId, input.capabilityIdentityId, input.annotationId],
  );
  return Boolean(result.rowCount);
}
