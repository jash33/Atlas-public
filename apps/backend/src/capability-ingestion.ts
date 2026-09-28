import type { Pool, PoolClient } from 'pg';
import { quarantineWorkflowsForBreakingDrift } from './workflow-quarantine.js';
import { z } from 'zod';
import { saveSourceCapabilityVersion } from './capability-source-version.js';

import { queueCapabilityRediscoveryRetests } from './automatic-workflow-retests.js';
import {
  isUnmappedDiscoveryChange,
  projectDiscoveredSource,
  suggestPotentialCoverage,
  type PotentialCoveragePlanner,
  type VerifiedPotentialCoverage,
} from './potential-coverage.js';

import {
  type DiscoveredCapability,
  type JsonObject,
  validateAndDiscoverCapabilities,
} from './capability-documents.js';
import {
  type ApprovedFieldRename,
  type CapabilitySafety,
  type ChangeClassification,
  canonicalJson,
  capabilitySafetyChanges,
  compatibilityDiff,
  sha256,
} from './capability-versioning.js';
import {
  capabilitySourceKey,
  reconcileCapabilitySourceClaims,
} from './capability-source-conflicts.js';

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

const jsonObjectSchema = z.record(z.string(), z.unknown());

function evidenceJsonProjection(alias: 'source' | 'manifest') {
  return `CASE WHEN ${alias}.evidence_kind IN ('repository', 'github')
    THEN jsonb_build_object(
      'kind', ${alias}.evidence_kind, 'repository', ${alias}.repository,
      'commit', ${alias}.commit_sha, 'path', ${alias}.path
    ) WHEN ${alias}.evidence_kind = 'atlas-generated' THEN jsonb_build_object(
      'kind', 'atlas-generated', 'repository', ${alias}.repository,
      'commit', ${alias}.commit_sha, 'candidateId', ${alias}.generated_candidate_id,
      'label', ${alias}.evidence_label, 'confirmedBy', ${alias}.confirmed_by,
      'confirmedAt', ${alias}.confirmed_at,
      'supportingCode', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'operationId', dependency.operation_id, 'path', dependency.path,
        'functionName', dependency.function_name, 'startLine', dependency.start_line,
        'endLine', dependency.end_line))
        FROM repository_operation_dependencies dependency
        JOIN repository_contract_candidates candidate ON candidate.run_id = dependency.run_id
        WHERE candidate.id = ${alias}.generated_candidate_id AND dependency.service_id = ${alias}.service_id), '[]'::jsonb)
    ) ELSE jsonb_build_object(
      'kind', 'human-confirmed', 'label', ${alias}.evidence_label,
      'confirmedBy', ${alias}.confirmed_by, 'confirmedAt',
      to_char(${alias}.confirmed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) END`;
}

const capabilityReferenceSchema = z.union([
  z.object({ operationId: z.string().min(1) }).strict(),
  z
    .object({
      channelAddress: z.string().min(1),
      messageKey: z.string().min(1),
      operationId: z.string().min(1),
    })
    .strict(),
]);
const annotationSchema = z
  .object({
    capability: capabilityReferenceSchema,
    owner: z.string().min(1),
    secretAlias: z.string().min(1).nullable(),
    businessSemantics: jsonObjectSchema,
    idempotencyField: z.string().min(1).nullable(),
    compensatedBy: capabilityReferenceSchema.nullable(),
    irreversibleAfter: z.boolean(),
    fieldRenames: z
      .array(
        z
          .object({
            schema: z.string().startsWith('#/'),
            from: z.string().min(1),
            to: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
const repositoryEvidenceSchema = z
  .object({
    repository: z.string().url(),
    commit: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
const humanConfirmedEvidenceSchema = z
  .object({
    kind: z.literal('human-confirmed'),
    label: z.string().min(1),
    confirmedBy: z.string().min(1),
    confirmedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const specificationSourceSchema = z.union([
  z
    .object({
      format: z.enum(['openapi', 'asyncapi']),
      document: jsonObjectSchema,
      url: z.string().url().optional(),
      repository: z.string().url(),
      repositoryProvider: z.literal('github').optional(),
      commit: z.string().min(1),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      format: z.enum(['openapi', 'asyncapi']),
      document: jsonObjectSchema,
      url: z.string().url().optional(),
      evidence: humanConfirmedEvidenceSchema,
    })
    .strict(),
]);
const manifestSourceSchema = z.union([repositoryEvidenceSchema, humanConfirmedEvidenceSchema]);
const ingestionSchema = z
  .object({
    organizationId: z.string().min(1),
    serviceId: z.string().min(1),
    source: specificationSourceSchema,
    manifest: z
      .object({
        source: manifestSourceSchema,
        annotations: z.array(annotationSchema),
      })
      .strict(),
  })
  .strict();
export const discoveryTriggerSchema = z.enum(['repository-push', 'daily-poll', 'run-drift']);
const discoverySchema = ingestionSchema.extend({
  trigger: discoveryTriggerSchema,
  environmentId: z.string().min(1).optional(),
});

type CapabilityReference = z.infer<typeof capabilityReferenceSchema>;
type Annotation = z.infer<typeof annotationSchema>;
type RepositoryEvidence = z.infer<typeof repositoryEvidenceSchema>;
type HumanConfirmedEvidence = z.infer<typeof humanConfirmedEvidenceSchema>;
type SourceEvidence =
  | ({ kind: 'repository' | 'github' } & RepositoryEvidence)
  | HumanConfirmedEvidence;

function specificationEvidence(source: z.infer<typeof specificationSourceSchema>): SourceEvidence {
  return 'evidence' in source
    ? source.evidence
    : {
        kind: source.repositoryProvider === 'github' ? 'github' : 'repository',
        repository: source.repository,
        commit: source.commit,
        path: source.path,
      };
}

function manifestEvidence(source: z.infer<typeof manifestSourceSchema>): SourceEvidence {
  return 'kind' in source
    ? source
    : {
        kind: 'repository',
        repository: source.repository,
        commit: source.commit,
        path: source.path,
      };
}

function referenceMatches(reference: CapabilityReference, capability: DiscoveredCapability) {
  return (
    reference.operationId === capability.identity.operationId &&
    (!('channelAddress' in reference) ||
      (reference.channelAddress === capability.identity.channelAddress &&
        reference.messageKey === capability.identity.messageKey))
  );
}

function normalizedAnnotation(annotation: Annotation) {
  return {
    owner: annotation.owner,
    secretAlias: annotation.secretAlias,
    businessSemantics: annotation.businessSemantics,
    idempotencyField: annotation.idempotencyField,
    compensatedBy: annotation.compensatedBy,
    irreversibleAfter: annotation.irreversibleAfter,
    ...(annotation.fieldRenames.length > 0 ? { fieldRenames: annotation.fieldRenames } : {}),
  };
}

async function insertIdentity(
  client: PoolClient,
  organizationId: string,
  capability: DiscoveredCapability,
) {
  if (capability.identity.kind === 'asyncapi') {
    const result = await client.query<{ id: string }>(
      `INSERT INTO capability_identities
        (organization_id, kind, service_id, operation_id, channel_address, message_key)
       VALUES ($1, 'asyncapi', $2, $3, $4, $5)
       ON CONFLICT (organization_id, channel_address, message_key) WHERE kind = 'asyncapi'
       DO UPDATE SET service_id = EXCLUDED.service_id, operation_id = EXCLUDED.operation_id
       RETURNING id`,
      [
        organizationId,
        capability.identity.serviceId,
        capability.identity.operationId,
        capability.identity.channelAddress,
        capability.identity.messageKey,
      ],
    );
    return result.rows[0]!.id;
  }
  const result = await client.query<{ id: string }>(
    `INSERT INTO capability_identities
      (organization_id, kind, service_id, operation_id, channel_address, message_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, service_id, operation_id) WHERE kind = 'openapi'
     DO UPDATE SET service_id = EXCLUDED.service_id
     RETURNING id`,
    [
      organizationId,
      capability.identity.kind,
      capability.identity.serviceId,
      capability.identity.operationId,
      capability.identity.channelAddress ?? null,
      capability.identity.messageKey ?? null,
    ],
  );
  return result.rows[0]!.id;
}

async function insertAnnotation(
  client: PoolClient,
  organizationId: string,
  identityId: string,
  sourceDocumentId: string,
  compensatedByIdentityId: string | null,
  annotation: Annotation,
  annotationHash: string,
) {
  const normalized = normalizedAnnotation(annotation);
  const result = await client.query<{ id: string }>(
    `INSERT INTO manifest_annotations
      (organization_id, capability_identity_id, annotation_hash, owner, secret_alias,
       business_semantics, idempotency_field, source_document_id,
       compensated_by_identity_id, irreversible_after, field_renames)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (organization_id, capability_identity_id, annotation_hash)
     DO UPDATE SET annotation_hash = EXCLUDED.annotation_hash
     RETURNING id`,
    [
      organizationId,
      identityId,
      annotationHash,
      normalized.owner,
      normalized.secretAlias,
      normalized.businessSemantics,
      normalized.idempotencyField,
      sourceDocumentId,
      compensatedByIdentityId,
      normalized.irreversibleAfter,
      JSON.stringify(annotation.fieldRenames),
    ],
  );
  return result.rows[0]!.id;
}

async function writeCompatibilityDiffs(
  client: PoolClient,
  organizationId: string,
  identityId: string,
  capabilityVersionId: string,
  fragment: JsonObject,
) {
  const previous = await client.query<{
    capability_version_id: string;
    capability_fragment: JsonObject;
    idempotency_field: string | null;
    compensated_by_identity_id: string | null;
    irreversible_after: boolean;
  }>(
    `SELECT version.capability_version_id, version.capability_fragment,
            annotation.idempotency_field,
            annotation.compensated_by_identity_id::text,
            coalesce(annotation.irreversible_after, false) AS irreversible_after
     FROM capability_versions version
     LEFT JOIN manifest_annotations annotation ON annotation.id = version.manifest_annotation_id
     WHERE version.organization_id = $1 AND version.capability_identity_id = $2
       AND version.capability_version_id <> $3`,
    [organizationId, identityId, capabilityVersionId],
  );
  const current = await client.query<{
    idempotency_field: string | null;
    compensated_by_identity_id: string | null;
    irreversible_after: boolean;
  }>(
    `SELECT annotation.idempotency_field,
            annotation.compensated_by_identity_id::text,
            coalesce(annotation.irreversible_after, false) AS irreversible_after
     FROM capability_versions version
     LEFT JOIN manifest_annotations annotation ON annotation.id = version.manifest_annotation_id
     WHERE version.organization_id = $1 AND version.capability_version_id = $2`,
    [organizationId, capabilityVersionId],
  );
  const currentSafety: CapabilitySafety = {
    idempotencyField: current.rows[0]?.idempotency_field ?? null,
    compensatedByIdentityId: current.rows[0]?.compensated_by_identity_id ?? null,
    irreversibleAfter: current.rows[0]?.irreversible_after ?? false,
  };
  for (const prior of previous.rows) {
    const approvedRenameResult = await client.query<{ field_renames: ApprovedFieldRename[] }>(
      `SELECT annotation.field_renames
       FROM capability_versions version
       JOIN manifest_annotations annotation ON annotation.id = version.manifest_annotation_id
       JOIN manifest_annotation_approvals approval
         ON approval.organization_id = version.organization_id
        AND approval.manifest_annotation_id = annotation.id
        AND approval.revoked_at IS NULL
       WHERE version.organization_id = $1 AND version.capability_version_id = $2`,
      [organizationId, prior.capability_version_id],
    );
    const diff = compatibilityDiff(
      prior.capability_fragment,
      fragment,
      approvedRenameResult.rows[0]?.field_renames ?? [],
    );
    const safetyChanges = capabilitySafetyChanges(
      {
        idempotencyField: prior.idempotency_field,
        compensatedByIdentityId: prior.compensated_by_identity_id,
        irreversibleAfter: prior.irreversible_after,
      },
      currentSafety,
    );
    const classification = safetyChanges.some((change) => change.classification === 'breaking')
      ? 'breaking'
      : diff.classification;
    await client.query(
      `INSERT INTO compatibility_diffs
        (organization_id, capability_identity_id, from_capability_version_id,
         to_capability_version_id, classification, diff)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING`,
      [
        organizationId,
        identityId,
        prior.capability_version_id,
        capabilityVersionId,
        classification,
        {
          fromFragmentHash: sha256(canonicalJson(prior.capability_fragment)),
          toFragmentHash: sha256(canonicalJson(fragment)),
          changes: diff.changes,
          fieldChanges: [...diff.fieldChanges, ...safetyChanges],
        },
      ],
    );
  }
}

async function insertSourceDocument(
  client: PoolClient,
  input: {
    organizationId: string;
    serviceId: string;
    format: 'openapi' | 'asyncapi' | 'atlas-manifest';
    document: JsonObject;
    evidence: SourceEvidence;
  },
) {
  const documentHash = sha256(canonicalJson(input.document));
  const repository = input.evidence.kind !== 'human-confirmed' ? input.evidence.repository : null;
  const commit = input.evidence.kind !== 'human-confirmed' ? input.evidence.commit : null;
  const path = input.evidence.kind !== 'human-confirmed' ? input.evidence.path : null;
  const label = input.evidence.kind === 'human-confirmed' ? input.evidence.label : null;
  const confirmedBy = input.evidence.kind === 'human-confirmed' ? input.evidence.confirmedBy : null;
  const confirmedAt = input.evidence.kind === 'human-confirmed' ? input.evidence.confirmedAt : null;
  const result = await client.query<{ id: string; document_hash: string }>(
    `INSERT INTO source_documents
      (organization_id, service_id, format, document, document_hash, evidence_kind,
       repository, commit_sha, path, evidence_label, confirmed_by, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (
       organization_id, service_id, format, evidence_kind,
       repository, commit_sha, path, evidence_label, confirmed_by, confirmed_at
     ) DO UPDATE SET document_hash = source_documents.document_hash
     RETURNING id, document_hash`,
    [
      input.organizationId,
      input.serviceId,
      input.format,
      input.document,
      documentHash,
      input.evidence.kind,
      repository,
      commit,
      path,
      label,
      confirmedBy,
      confirmedAt,
    ],
  );
  const stored = result.rows[0]!;
  if (stored.document_hash.trim() !== documentHash) {
    throw new z.ZodError([
      {
        code: 'custom',
        path: ['source'],
        message: 'Provenance already identifies different source bytes',
      },
    ]);
  }
  return stored.id;
}

export async function ingestCapabilities(pool: Pool, input: unknown, environmentId = 'production') {
  return capabilityTransaction(pool, (client) =>
    ingestCapabilitiesInTransaction(client, input, environmentId),
  );
}

async function capabilityTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function ingestCapabilitiesInTransaction(
  client: PoolClient,
  input: unknown,
  environmentId: string,
) {
  const request = ingestionSchema.parse(input);
  const discovered = await validateAndDiscoverCapabilities(
    request.source.format,
    request.source.document,
    request.serviceId,
  );
  const annotated = request.manifest.annotations.map((annotation) => {
    const matches = discovered.filter((capability) =>
      referenceMatches(annotation.capability, capability),
    );
    if (matches.length !== 1) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['manifest', 'annotations'],
          message: 'Annotation must resolve to exactly one capability',
        },
      ]);
    }
    return { annotation, capability: matches[0]! };
  });
  const annotationByIdentity = new Map<string, Annotation>();
  for (const { annotation, capability } of annotated) {
    const identityKey = canonicalJson(capability.identity);
    if (annotationByIdentity.has(identityKey)) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['manifest', 'annotations'],
          message: 'Capability has more than one current annotation',
        },
      ]);
    }
    annotationByIdentity.set(identityKey, annotation);
  }

  await client.query('INSERT INTO organizations (id) VALUES ($1) ON CONFLICT DO NOTHING', [
    request.organizationId,
  ]);
  const sourceDocumentId = await insertSourceDocument(client, {
    organizationId: request.organizationId,
    serviceId: request.serviceId,
    format: request.source.format,
    document: request.source.document,
    evidence: specificationEvidence(request.source),
  });
  const sourceKey = capabilitySourceKey(request.source);
  await client.query(
    `DELETE FROM environment_capability_source_claims claim
       USING source_documents legacy_source, source_documents current_source,
         capability_identities identity
       WHERE claim.organization_id = $1 AND claim.environment_id = $2
         AND claim.source_key LIKE 'legacy:%'
         AND legacy_source.id = claim.source_document_id
         AND current_source.id = $3
         AND identity.id = claim.capability_identity_id
         AND identity.organization_id = $1 AND identity.service_id = $4
         AND legacy_source.evidence_kind = current_source.evidence_kind
         AND legacy_source.repository IS NOT DISTINCT FROM current_source.repository
         AND legacy_source.path IS NOT DISTINCT FROM current_source.path
         AND legacy_source.evidence_label IS NOT DISTINCT FROM current_source.evidence_label
         AND legacy_source.confirmed_by IS NOT DISTINCT FROM current_source.confirmed_by`,
    [request.organizationId, environmentId, sourceDocumentId, request.serviceId],
  );
  const manifestSourceDocumentId = await insertSourceDocument(client, {
    organizationId: request.organizationId,
    serviceId: request.serviceId,
    format: 'atlas-manifest',
    document: { annotations: request.manifest.annotations },
    evidence: manifestEvidence(request.manifest.source),
  });
  const identityIds = new Map<string, string>();
  for (const capability of discovered) {
    identityIds.set(
      canonicalJson(capability.identity),
      await insertIdentity(client, request.organizationId, capability),
    );
  }
  const discoveredIdentityIds = [...identityIds.values()];
  const retiredClaims = await client.query<{ capability_identity_id: string }>(
    `UPDATE environment_capability_source_claims claim
       SET active = false, observed_at = current_timestamp
       FROM capability_identities identity
       WHERE claim.organization_id = $1 AND claim.environment_id = $2
         AND claim.source_key = $3 AND claim.capability_identity_id = identity.id
         AND identity.organization_id = $1 AND identity.service_id = $4
         AND identity.kind = $5 AND NOT (identity.id = ANY($6::bigint[]))
       RETURNING claim.capability_identity_id`,
    [
      request.organizationId,
      environmentId,
      sourceKey,
      request.serviceId,
      request.source.format,
      discoveredIdentityIds,
    ],
  );
  await client.query(
    `UPDATE environment_capability_observations observation
       SET availability_status = 'removed', freshness_status = 'fresh',
         status_reason = 'operation-absent-from-successful-discovery',
         status_changed_at = current_timestamp
       FROM capability_identities identity
       WHERE observation.capability_identity_id = identity.id
         AND observation.organization_id = $1
         AND observation.environment_id = $2
         AND identity.organization_id = $1
         AND identity.service_id = $3
         AND identity.kind = $4
         AND NOT (identity.id = ANY($5::bigint[]))`,
    [
      request.organizationId,
      environmentId,
      request.serviceId,
      request.source.format,
      discoveredIdentityIds,
    ],
  );
  for (const retired of retiredClaims.rows) {
    await reconcileCapabilitySourceClaims(client, {
      organizationId: request.organizationId,
      environmentId,
      capabilityIdentityId: retired.capability_identity_id,
    });
  }
  const capabilities = [];
  for (const capability of discovered) {
    const annotation = annotationByIdentity.get(canonicalJson(capability.identity));
    const identityId = identityIds.get(canonicalJson(capability.identity))!;
    const normalized = annotation ? normalizedAnnotation(annotation) : null;
    const annotationHash = sha256(canonicalJson(normalized));
    const compensatedByIdentityId = annotation?.compensatedBy
      ? identityIds.get(
          canonicalJson(
            discovered.find((candidate) => referenceMatches(annotation.compensatedBy!, candidate))
              ?.identity,
          ),
        )
      : null;
    if (annotation?.compensatedBy && !compensatedByIdentityId) {
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['manifest', 'annotations'],
          message: 'compensatedBy must resolve to exactly one ingested capability',
        },
      ]);
    }
    const annotationId = annotation
      ? await insertAnnotation(
          client,
          request.organizationId,
          identityId,
          manifestSourceDocumentId,
          compensatedByIdentityId ?? null,
          annotation,
          annotationHash,
        )
      : null;
    const capabilityVersionId = await saveSourceCapabilityVersion(client, {
      organizationId: request.organizationId,
      identityId,
      sourceDocumentId,
      manifestSourceDocumentId,
      annotationId,
      annotationHash,
      capability,
    });
    await client.query(
      `INSERT INTO capability_identity_heads
          (organization_id, capability_identity_id, capability_version_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, capability_identity_id)
         DO UPDATE SET capability_version_id = EXCLUDED.capability_version_id
         WHERE (
           SELECT source.ingested_at
           FROM capability_version_provenance provenance
           JOIN source_documents source ON source.id = provenance.source_document_id
           WHERE provenance.organization_id = EXCLUDED.organization_id
             AND provenance.capability_version_id = EXCLUDED.capability_version_id
           ORDER BY source.ingested_at DESC, source.id DESC
           LIMIT 1
         ) >= (
           SELECT source.ingested_at
           FROM capability_version_provenance provenance
           JOIN source_documents source ON source.id = provenance.source_document_id
           WHERE provenance.organization_id = capability_identity_heads.organization_id
             AND provenance.capability_version_id = capability_identity_heads.capability_version_id
           ORDER BY source.ingested_at DESC, source.id DESC
           LIMIT 1
         )`,
      [request.organizationId, identityId, capabilityVersionId],
    );
    await client.query(
      `INSERT INTO environment_capability_observations
          (organization_id, environment_id, capability_identity_id, capability_version_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, environment_id, capability_identity_id)
         DO UPDATE SET capability_version_id = EXCLUDED.capability_version_id,
           observed_at = current_timestamp, availability_status = 'available',
           freshness_status = 'fresh', status_reason = 'successful-discovery',
           status_changed_at = current_timestamp
         WHERE (
           SELECT source.ingested_at
           FROM capability_version_provenance provenance
           JOIN source_documents source ON source.id = provenance.source_document_id
           WHERE provenance.organization_id = EXCLUDED.organization_id
             AND provenance.capability_version_id = EXCLUDED.capability_version_id
           ORDER BY source.ingested_at DESC, source.id DESC
           LIMIT 1
         ) >= (
           SELECT source.ingested_at
           FROM capability_version_provenance provenance
           JOIN source_documents source ON source.id = provenance.source_document_id
           WHERE provenance.organization_id = environment_capability_observations.organization_id
             AND provenance.capability_version_id = environment_capability_observations.capability_version_id
           ORDER BY source.ingested_at DESC, source.id DESC
           LIMIT 1
         )`,
      [request.organizationId, environmentId, identityId, capabilityVersionId],
    );
    await client.query(
      `INSERT INTO environment_capability_version_observations
          (organization_id, environment_id, capability_version_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
      [request.organizationId, environmentId, capabilityVersionId],
    );
    await client.query(
      `INSERT INTO environment_capability_source_claims
          (organization_id, environment_id, capability_identity_id, source_key,
           capability_version_id, source_document_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (organization_id, environment_id, capability_identity_id, source_key)
         DO UPDATE SET capability_version_id = EXCLUDED.capability_version_id,
           source_document_id = EXCLUDED.source_document_id, active = true,
           observed_at = current_timestamp
         WHERE (
           SELECT ingested_at FROM source_documents
           WHERE id = EXCLUDED.source_document_id
         ) >= (
           SELECT ingested_at FROM source_documents
           WHERE id = environment_capability_source_claims.source_document_id
         )`,
      [
        request.organizationId,
        environmentId,
        identityId,
        sourceKey,
        capabilityVersionId,
        sourceDocumentId,
      ],
    );
    await reconcileCapabilitySourceClaims(client, {
      organizationId: request.organizationId,
      environmentId,
      capabilityIdentityId: identityId,
    });
    await writeCompatibilityDiffs(client, request.organizationId, identityId, capabilityVersionId, {
      identity: capability.identity,
      ...capability.fragment,
    });
    capabilities.push({ capabilityVersionId, identity: capability.identity });
  }
  return { capabilities };
}

function capabilityIdentityKey(identity: JsonObject) {
  if (identity.kind === 'asyncapi') {
    return canonicalJson({
      kind: identity.kind,
      channelAddress: identity.channelAddress ?? null,
      messageKey: identity.messageKey ?? null,
    });
  }
  return canonicalJson({
    kind: identity.kind,
    serviceId: identity.serviceId,
    operationId: identity.operationId,
  });
}

async function readServiceHeadVersions(
  pool: Queryable,
  organizationId: string,
  environmentId: string,
  serviceId: string,
  kind: 'openapi' | 'asyncapi',
) {
  const heads = await pool.query<{
    capability_version_id: string;
    identity: JsonObject;
  }>(
    `SELECT head.capability_version_id,
      jsonb_build_object(
        'kind', identity.kind, 'serviceId', identity.service_id,
        'operationId', identity.operation_id, 'channelAddress', identity.channel_address,
        'messageKey', identity.message_key
      ) AS identity
     FROM environment_capability_observations head
     JOIN capability_identities identity ON identity.id = head.capability_identity_id
     WHERE head.organization_id = $1 AND head.environment_id = $2
       AND identity.kind = $4 AND ($4 = 'asyncapi' OR identity.service_id = $3)
       AND head.availability_status = 'available'`,
    [organizationId, environmentId, serviceId, kind],
  );
  return new Map(
    heads.rows.map((row) => [
      capabilityIdentityKey(row.identity),
      row.capability_version_id.trim(),
    ]),
  );
}

async function loadDiscoveredSourceProjection(
  pool: Queryable,
  organizationId: string,
  capabilities: readonly { capabilityVersionId: string; identity: { operationId: string } }[],
) {
  if (capabilities.length === 0) return [];
  const versions = await pool.query<{
    capability_fragment: JsonObject;
    operation_id: string;
  }>(
    `SELECT version.capability_fragment, identity.operation_id
     FROM capability_versions version
     JOIN capability_identities identity ON identity.id = version.capability_identity_id
     WHERE version.organization_id = $1 AND version.capability_version_id = ANY($2::char(64)[])
     ORDER BY identity.operation_id`,
    [organizationId, capabilities.map((capability) => capability.capabilityVersionId)],
  );
  return projectDiscoveredSource(
    versions.rows.map((row) => ({
      identity: { operationId: row.operation_id },
      fragment: row.capability_fragment,
    })),
  );
}

async function verifiedPotentialCoverageByContract(
  pool: Queryable,
  organizationId: string,
  changes: readonly {
    fromCapabilityVersionId: string;
    toCapabilityVersionId?: string | null;
    classification: string;
    fieldChanges: unknown[];
  }[],
  capabilities: readonly { capabilityVersionId: string; identity: { operationId: string } }[],
  plannerModel?: PotentialCoveragePlanner,
): Promise<ReadonlyMap<string, VerifiedPotentialCoverage>> {
  const unmappedContracts = changes.filter(isUnmappedDiscoveryChange).map((change) => ({
    fromCapabilityVersionId: change.fromCapabilityVersionId,
    fieldChanges: change.fieldChanges.flatMap((field) => {
      if (!field || typeof field !== 'object' || !('kind' in field)) return [];
      const record = field as { kind: unknown; path?: unknown; fromPath?: unknown };
      return typeof record.kind === 'string'
        ? [
            {
              kind: record.kind,
              ...(typeof record.path === 'string' ? { path: record.path } : {}),
              ...(typeof record.fromPath === 'string' ? { fromPath: record.fromPath } : {}),
            },
          ]
        : [];
    }),
  }));
  const hints = await suggestPotentialCoverage({
    unmappedContracts,
    discoveredSource: await loadDiscoveredSourceProjection(pool, organizationId, capabilities),
    plannerModel,
  });
  return new Map(hints.map((hint) => [hint.fromCapabilityVersionId, hint]));
}

export async function discoverCapabilities(
  pool: Pool,
  input: unknown,
  plannerModel?: PotentialCoveragePlanner,
) {
  const discovery = await capabilityTransaction(pool, (client) =>
    discoverCapabilitiesInTransaction(client, input),
  );
  return addDiscoveryCoverage(
    pool,
    discoverySchema.parse(input).organizationId,
    discovery,
    plannerModel,
  );
}

// For a larger operation that already owns a transaction. All required discovery writes
// use this client; optional model suggestions are added only after the caller commits.
export async function discoverCapabilitiesInTransaction(database: PoolClient, input: unknown) {
  const request = discoverySchema.parse(input);
  const { trigger, environmentId: requestedEnvironmentId, ...ingestion } = request;
  const environmentId = requestedEnvironmentId ?? 'production';
  const registrationEnvironmentId = requestedEnvironmentId ?? null;
  await database.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    JSON.stringify(['capability-discovery', request.organizationId, environmentId]),
  ]);
  const previousVersionByIdentity = await readServiceHeadVersions(
    database,
    request.organizationId,
    environmentId,
    request.serviceId,
    request.source.format,
  );
  const result = await ingestCapabilitiesInTransaction(database, ingestion, environmentId);
  const currentVersionByIdentity = await readServiceHeadVersions(
    database,
    request.organizationId,
    environmentId,
    request.serviceId,
    request.source.format,
  );
  const discovery = await database.query<{ id: string }>(
    `INSERT INTO capability_discoveries (organization_id, service_id, environment_id, trigger)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [request.organizationId, request.serviceId, environmentId, trigger],
  );
  const changes = [];
  for (const capability of result.capabilities) {
    const identityKey = capabilityIdentityKey(capability.identity);
    const fromCapabilityVersionId = previousVersionByIdentity.get(identityKey);
    if (currentVersionByIdentity.get(identityKey) !== capability.capabilityVersionId) continue;
    if (!fromCapabilityVersionId || fromCapabilityVersionId === capability.capabilityVersionId) {
      continue;
    }
    const diff = await database.query<{
      classification: ChangeClassification;
      diff: { fieldChanges?: unknown[] };
    }>(
      `SELECT classification, diff FROM compatibility_diffs
       WHERE organization_id = $1 AND from_capability_version_id = $2
         AND to_capability_version_id = $3`,
      [request.organizationId, fromCapabilityVersionId, capability.capabilityVersionId],
    );
    const detected = diff.rows[0];
    if (!detected) continue;
    changes.push({
      fromCapabilityVersionId,
      toCapabilityVersionId: capability.capabilityVersionId,
      classification: detected.classification,
      fieldChanges: detected.diff.fieldChanges ?? [],
      affectedWorkflows: await readWorkflowDependencies(
        database,
        request.organizationId,
        fromCapabilityVersionId,
      ),
    });
  }
  for (const [identityKey, fromCapabilityVersionId] of previousVersionByIdentity) {
    if (currentVersionByIdentity.has(identityKey)) continue;
    changes.push({
      fromCapabilityVersionId,
      toCapabilityVersionId: null,
      classification: 'breaking' as const,
      changeKind: 'removal' as const,
      fieldChanges: [],
      affectedWorkflows: await readWorkflowDependencies(
        database,
        request.organizationId,
        fromCapabilityVersionId,
        environmentId,
      ),
    });
  }
  for (const change of changes) {
    await database.query(
      `INSERT INTO capability_discovery_changes
        (discovery_id, organization_id, from_capability_version_id,
         to_capability_version_id, classification, change_kind, field_changes, affected_workflows)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        discovery.rows[0]!.id,
        request.organizationId,
        change.fromCapabilityVersionId,
        change.toCapabilityVersionId,
        change.classification,
        change.changeKind ?? 'version-change',
        JSON.stringify(change.fieldChanges),
        JSON.stringify(change.affectedWorkflows),
      ],
    );
    if (change.classification === 'breaking' && change.toCapabilityVersionId) {
      await quarantineWorkflowsForBreakingDrift(
        database,
        request.organizationId,
        change.fromCapabilityVersionId,
        change.toCapabilityVersionId,
      );
    }
    if (change.toCapabilityVersionId)
      await queueCapabilityRediscoveryRetests(database, {
        organizationId: request.organizationId,
        discoveryId: discovery.rows[0]!.id,
        fromCapabilityVersionId: change.fromCapabilityVersionId,
        toCapabilityVersionId: change.toCapabilityVersionId,
      });
  }
  const registrationSourceKey = capabilitySourceKey(ingestion.source);
  const legacyRegistrations = await database.query<{ discovery_input: Record<string, unknown> }>(
    `SELECT discovery_input FROM capability_source_registrations
     WHERE organization_id = $1 AND service_id = $2
       AND environment_id IS NOT DISTINCT FROM $3 AND source_key = 'legacy'`,
    [request.organizationId, request.serviceId, registrationEnvironmentId],
  );
  for (const legacy of legacyRegistrations.rows) {
    const source = legacy.discovery_input.source;
    if (
      source &&
      typeof source === 'object' &&
      !Array.isArray(source) &&
      capabilitySourceKey(source as Record<string, unknown>) === registrationSourceKey
    ) {
      await database.query(
        `UPDATE capability_source_registrations SET source_key = $4
         WHERE organization_id = $1 AND service_id = $2
           AND environment_id IS NOT DISTINCT FROM $3 AND source_key = 'legacy'`,
        [
          request.organizationId,
          request.serviceId,
          registrationEnvironmentId,
          registrationSourceKey,
        ],
      );
    }
  }
  await database.query(
    `INSERT INTO capability_source_registrations
      (organization_id, service_id, environment_id, source_key, discovery_input)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, service_id, environment_id, source_key)
     DO UPDATE SET discovery_input = EXCLUDED.discovery_input, updated_at = current_timestamp`,
    [
      request.organizationId,
      request.serviceId,
      registrationEnvironmentId,
      registrationSourceKey,
      JSON.stringify(ingestion),
    ],
  );
  return {
    discoveryId: discovery.rows[0]!.id,
    trigger,
    changes,
    capabilities: result.capabilities.map((capability) => ({
      ...capability,
      lifecycleStatus:
        currentVersionByIdentity.get(capabilityIdentityKey(capability.identity)) ===
        capability.capabilityVersionId
          ? ('current' as const)
          : ('superseded' as const),
    })),
  };
}

export async function addDiscoveryCoverage(
  database: Pool,
  organizationId: string,
  discovery: Awaited<ReturnType<typeof discoverCapabilitiesInTransaction>>,
  plannerModel?: PotentialCoveragePlanner,
) {
  const potentialCoverageByFrom = await verifiedPotentialCoverageByContract(
    database,
    organizationId,
    discovery.changes,
    discovery.capabilities,
    plannerModel,
  );
  const changes = await Promise.all(
    discovery.changes.map(async (change) => {
      const hint = potentialCoverageByFrom.get(change.fromCapabilityVersionId);
      if (!hint) return change;
      const potentialCoverage = {
        operationId: hint.operationId,
        ...(hint.fieldPath ? { fieldPath: hint.fieldPath } : {}),
      };
      await database.query(
        `UPDATE capability_discovery_changes SET potential_coverage = $4
       WHERE discovery_id = $1 AND organization_id = $2 AND from_capability_version_id = $3`,
        [
          discovery.discoveryId,
          organizationId,
          change.fromCapabilityVersionId,
          JSON.stringify(potentialCoverage),
        ],
      );
      return { ...change, potentialCoverage };
    }),
  );
  return { ...discovery, changes };
}

export async function readCapabilityDiscovery(
  pool: Pool,
  organizationId: string,
  discoveryId: string,
  environmentId?: string,
) {
  const discovery = await pool.query<{
    id: string;
    service_id: string;
    trigger: 'repository-push' | 'daily-poll' | 'run-drift';
    discovered_at: Date;
  }>(
    `SELECT id, service_id, trigger, discovered_at
     FROM capability_discoveries
     WHERE id = $1 AND organization_id = $2
       AND ($3::text IS NULL OR environment_id = $3)`,
    [discoveryId, organizationId, environmentId ?? null],
  );
  const row = discovery.rows[0];
  if (!row) return undefined;
  const changes = await pool.query<{
    fromCapabilityVersionId: string;
    toCapabilityVersionId: string | null;
    changeKind: 'version-change' | 'removal';
    classification: ChangeClassification;
    fieldChanges: unknown[];
    affectedWorkflows: Array<{ workflowVersionId: string; stepId: string }>;
    potentialCoverage: { operationId: string; fieldPath?: string } | null;
  }>(
    `SELECT from_capability_version_id AS "fromCapabilityVersionId",
      to_capability_version_id AS "toCapabilityVersionId", classification,
      change_kind AS "changeKind",
      field_changes AS "fieldChanges", affected_workflows AS "affectedWorkflows",
      potential_coverage AS "potentialCoverage"
     FROM capability_discovery_changes
     WHERE discovery_id = $1 AND organization_id = $2
     ORDER BY to_capability_version_id`,
    [discoveryId, organizationId],
  );
  const approvedWorkflowVersionIds = environmentId
    ? new Set(
        (
          await pool.query<{ workflow_version_id: string }>(
            `SELECT DISTINCT workflow_version_id FROM workflow_approvals
             WHERE organization_id = $1 AND environment_id = $2`,
            [organizationId, environmentId],
          )
        ).rows.map(({ workflow_version_id }) => workflow_version_id),
      )
    : undefined;
  const runtimeSignals = await pool.query<{
    environment_id: string;
    capability_version_id: string;
    step_id: string;
    affected_workflows: Array<{ workflowVersionId: string; stepId: string }>;
  }>(
    `SELECT request.environment_id, request.capability_version_id, request.step_id,
       COALESCE(
         jsonb_agg(
           DISTINCT jsonb_build_object(
             'workflowVersionId', dependency.workflow_version_id,
             'stepId', dependency.step_id
           )
         ) FILTER (WHERE approval.workflow_version_id IS NOT NULL),
         '[]'::jsonb
       ) AS affected_workflows
     FROM capability_rediscovery_requests request
     LEFT JOIN workflow_capability_dependencies dependency
       ON dependency.organization_id = request.organization_id
      AND dependency.capability_version_id = request.capability_version_id
      AND dependency.step_id = request.step_id
     LEFT JOIN workflow_approvals approval
       ON approval.organization_id = dependency.organization_id
      AND approval.environment_id = request.environment_id
      AND approval.workflow_version_id = dependency.workflow_version_id
     WHERE request.discovery_id = $1 AND request.organization_id = $2
       AND ($3::text IS NULL OR request.environment_id = $3)
     GROUP BY request.id, request.environment_id, request.capability_version_id, request.step_id
     ORDER BY request.id`,
    [discoveryId, organizationId, environmentId ?? null],
  );
  return {
    discoveryId: row.id,
    organizationId,
    serviceId: row.service_id,
    trigger: row.trigger,
    discoveredAt: row.discovered_at.toISOString(),
    ...(environmentId ? { environmentId } : {}),
    changes: changes.rows.map((change) => ({
      fromCapabilityVersionId: change.fromCapabilityVersionId.trim(),
      toCapabilityVersionId: change.toCapabilityVersionId?.trim() ?? null,
      changeKind: change.changeKind,
      classification: change.classification,
      fieldChanges: change.fieldChanges,
      organizationAffectedWorkflowCount: change.affectedWorkflows.length,
      affectedWorkflows: approvedWorkflowVersionIds
        ? change.affectedWorkflows.filter(({ workflowVersionId }) =>
            approvedWorkflowVersionIds.has(workflowVersionId),
          )
        : change.affectedWorkflows,
      ...(change.potentialCoverage ? { potentialCoverage: change.potentialCoverage } : {}),
    })),
    runtimeSignals: runtimeSignals.rows.map((signal) => ({
      environmentId: signal.environment_id,
      capabilityVersionId: signal.capability_version_id.trim(),
      stepId: signal.step_id,
      affectedWorkflows: signal.affected_workflows,
    })),
  };
}

export async function readCapabilityDiscoveries(
  pool: Pool,
  organizationId: string,
  environmentId = 'production',
) {
  const result = await pool.query<{
    id: string;
    service_id: string;
    trigger: 'repository-push' | 'daily-poll' | 'run-drift';
    discovered_at: Date;
  }>(
    `SELECT id, service_id, trigger, discovered_at
     FROM capability_discoveries
     WHERE organization_id = $1 AND environment_id = $2
     ORDER BY discovered_at, id`,
    [organizationId, environmentId],
  );
  return {
    discoveries: result.rows.map((row) => ({
      discoveryId: row.id,
      serviceId: row.service_id,
      trigger: row.trigger,
      discoveredAt: row.discovered_at.toISOString(),
    })),
  };
}

export async function readCapabilityVersion(
  pool: Pool,
  organizationId: string,
  capabilityVersionId: string,
  environmentId = 'production',
) {
  const result = await pool.query<{
    capabilityIdentityId: string;
    capabilityVersionId: string;
    lifecycleStatus: 'current' | 'removed' | 'superseded';
    availabilityStatus: 'available' | 'removed' | null;
    freshnessStatus: 'fresh' | 'stale' | null;
    statusReason: string | null;
    lastObservedAt: Date | null;
    statusChangedAt: Date | null;
    identity: JsonObject;
    annotation: JsonObject | null;
    fragment: JsonObject;
    userAnnotations: Array<{
      id: string;
      body: string;
      createdBy: string;
      updatedBy: string;
      createdAt: string;
      updatedAt: string;
    }>;
  }>(
    `SELECT cv.capability_identity_id AS "capabilityIdentityId",
      cv.capability_version_id AS "capabilityVersionId",
      CASE WHEN head.capability_version_id = cv.capability_version_id
        AND head.availability_status = 'removed' THEN 'removed'
        WHEN head.capability_version_id = cv.capability_version_id THEN 'current'
        ELSE 'superseded' END AS "lifecycleStatus",
      head.availability_status AS "availabilityStatus",
      head.freshness_status AS "freshnessStatus", head.status_reason AS "statusReason",
      head.observed_at AS "lastObservedAt", head.status_changed_at AS "statusChangedAt",
      jsonb_build_object(
        'kind', ci.kind, 'serviceId', ci.service_id, 'operationId', ci.operation_id,
        'channelAddress', ci.channel_address, 'messageKey', ci.message_key
      ) AS identity,
      CASE WHEN ma.id IS NULL THEN NULL ELSE jsonb_build_object(
          'owner', ma.owner, 'secretAlias', ma.secret_alias,
          'businessSemantics', ma.business_semantics, 'idempotencyField', ma.idempotency_field,
          'compensatedBy', CASE WHEN compensation.id IS NULL THEN NULL ELSE jsonb_build_object(
            'operationId', compensation.operation_id,
            'channelAddress', compensation.channel_address,
            'messageKey', compensation.message_key
          ) END,
          'irreversibleAfter', ma.irreversible_after
          , 'fieldRenames', ma.field_renames
        ) END AS annotation,
      cv.capability_fragment AS fragment,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', user_annotation.id::text,
          'body', user_annotation.body,
          'createdBy', user_annotation.created_by,
          'updatedBy', user_annotation.updated_by,
          'createdAt', user_annotation.created_at,
          'updatedAt', user_annotation.updated_at
        ) ORDER BY user_annotation.created_at, user_annotation.id)
        FROM capability_user_annotations user_annotation
        WHERE user_annotation.organization_id = cv.organization_id
          AND user_annotation.capability_identity_id = cv.capability_identity_id
      ), '[]'::jsonb) AS "userAnnotations"
     FROM capability_versions cv
     JOIN capability_identities ci ON ci.id = cv.capability_identity_id
     LEFT JOIN environment_capability_observations head
       ON head.organization_id = cv.organization_id
      AND head.capability_identity_id = cv.capability_identity_id
      AND head.environment_id = $3
     LEFT JOIN manifest_annotations ma ON ma.id = cv.manifest_annotation_id
     LEFT JOIN capability_identities compensation ON compensation.id = ma.compensated_by_identity_id
     WHERE cv.organization_id = $1 AND cv.capability_version_id = $2
       AND EXISTS (
         SELECT 1 FROM environment_capability_version_observations observation
         WHERE observation.organization_id = cv.organization_id
           AND observation.environment_id = $3
           AND observation.capability_version_id = cv.capability_version_id
       )`,
    [organizationId, capabilityVersionId, environmentId],
  );
  const version = result.rows[0];
  if (!version) return undefined;
  const provenance = await pool.query(
    `SELECT jsonb_build_object(
        'sourceDocumentId', source.id,
        'evidence', ${evidenceJsonProjection('source')},
        'manifest', CASE WHEN manifest.id IS NULL THEN NULL ELSE jsonb_build_object(
          'sourceDocumentId', manifest.id,
          'evidence', ${evidenceJsonProjection('manifest')}
        ) END
      ) AS value
     FROM capability_version_provenance provenance
     JOIN source_documents source ON source.id = provenance.source_document_id
     LEFT JOIN source_documents manifest ON manifest.id = provenance.manifest_source_document_id
     WHERE provenance.organization_id = $1 AND provenance.capability_version_id = $2
     ORDER BY source.ingested_at, source.id, provenance.id`,
    [organizationId, capabilityVersionId],
  );
  const provenanceHistory = provenance.rows.map(({ value }) => value);
  const approval = await pool.query<{ approved_by: string; approved_at: Date }>(
    `SELECT approved_by, approved_at FROM capability_approvals
     WHERE organization_id = $1 AND capability_version_id = $2 AND revoked_at IS NULL`,
    [organizationId, capabilityVersionId],
  );
  const runtimeObservations = await pool.query<{
    environment_id: string;
    run_id: string;
    step_id: string;
    attempt: number;
    duration_ms: number;
    status: 'succeeded' | 'failed';
    failure_type: string | null;
    recorded_at: Date;
  }>(
    `SELECT environment_id, run_id, step_id, attempt, duration_ms, status,
            failure_type, recorded_at
     FROM workflow_run_step_attempts
     WHERE organization_id = $1 AND capability_version_id = $2 AND environment_id = $3
     ORDER BY recorded_at DESC, id DESC
     LIMIT 20`,
    [organizationId, capabilityVersionId, environmentId],
  );
  const identityVersions = await pool.query<{
    capability_version_id: string;
    lifecycle_status: 'current' | 'superseded';
    published_at: Date;
    introduced_by:
      | { kind: 'repository' | 'github'; repository: string; commit: string; path: string }
      | { kind: 'human-confirmed'; label: string; confirmedBy: string; confirmedAt: string };
  }>(
    `SELECT sibling.capability_version_id,
      CASE WHEN head.capability_version_id = sibling.capability_version_id
        THEN 'current' ELSE 'superseded' END AS lifecycle_status,
      sibling.published_at,
      introduced.value AS introduced_by
     FROM capability_versions cv
     JOIN capability_versions sibling
       ON sibling.organization_id = cv.organization_id
      AND sibling.capability_identity_id = cv.capability_identity_id
     LEFT JOIN environment_capability_observations head
       ON head.organization_id = sibling.organization_id
      AND head.capability_identity_id = sibling.capability_identity_id
      AND head.environment_id = $3
     JOIN LATERAL (
       SELECT ${evidenceJsonProjection('source')} AS value
       FROM capability_version_provenance provenance
       JOIN source_documents source ON source.id = provenance.source_document_id
       WHERE provenance.organization_id = sibling.organization_id
         AND provenance.capability_version_id = sibling.capability_version_id
       ORDER BY source.ingested_at, source.id, provenance.id
       LIMIT 1
     ) introduced ON true
     WHERE cv.organization_id = $1 AND cv.capability_version_id = $2
       AND EXISTS (
         SELECT 1 FROM environment_capability_version_observations observation
         WHERE observation.organization_id = sibling.organization_id
           AND observation.environment_id = $3
           AND observation.capability_version_id = sibling.capability_version_id
       )
     ORDER BY sibling.published_at, sibling.capability_version_id`,
    [organizationId, capabilityVersionId, environmentId],
  );
  return {
    ...version,
    capabilityVersionId: version.capabilityVersionId.trim(),
    observation:
      version.availabilityStatus === null
        ? null
        : {
            availability: version.availabilityStatus,
            freshness: version.freshnessStatus,
            reason: version.statusReason,
            lastObservedAt: version.lastObservedAt?.toISOString() ?? null,
            statusChangedAt: version.statusChangedAt?.toISOString() ?? null,
          },
    provenance: provenanceHistory.at(-1),
    provenanceHistory,
    approval: approval.rows[0]
      ? {
          approvedBy: approval.rows[0].approved_by,
          approvedAt: approval.rows[0].approved_at.toISOString(),
        }
      : null,
    runtimeObservations: runtimeObservations.rows.map((observation) => ({
      environmentId: observation.environment_id,
      runId: observation.run_id,
      stepId: observation.step_id,
      attempt: observation.attempt,
      durationMs: observation.duration_ms,
      status: observation.status,
      failureType: observation.failure_type,
      recordedAt: observation.recorded_at.toISOString(),
    })),
    identityVersions: identityVersions.rows.map((row) => ({
      capabilityVersionId: row.capability_version_id.trim(),
      lifecycleStatus: row.lifecycle_status,
      publishedAt: row.published_at.toISOString(),
      introducedBy: row.introduced_by,
    })),
  };
}

export async function readWorkflowDependencies(
  pool: Queryable,
  organizationId: string,
  capabilityVersionId: string,
  environmentId?: string,
) {
  const result = await pool.query(
    `SELECT workflow_version_id AS "workflowVersionId", step_id AS "stepId"
     FROM workflow_capability_dependencies dependency
     WHERE organization_id = $1 AND capability_version_id = $2
       AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM workflow_approvals approval
         WHERE approval.organization_id = dependency.organization_id
           AND approval.workflow_version_id = dependency.workflow_version_id
           AND approval.environment_id = $3
       ))
     ORDER BY workflow_version_id, step_id`,
    [organizationId, capabilityVersionId, environmentId ?? null],
  );
  return result.rows;
}
