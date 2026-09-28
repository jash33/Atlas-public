import type { Pool } from 'pg';

import {
  decideNewCompilationSelection,
  loadCapabilitySelectionFacts,
} from './capability-selection.js';
import { canonicalJson, sha256 } from './capability-versioning.js';
import { compareCapabilityObservations } from './capability-comparison.js';

interface CapabilityCatalogRow {
  capability_identity_id: string | number;
  capability_version_id: string;
  kind: 'openapi' | 'asyncapi';
  service_id: string;
  operation_id: string;
  channel_address: string | null;
  message_key: string | null;
  capability_fragment: Record<string, unknown>;
  owner: string | null;
  secret_alias: string | null;
  business_semantics: Record<string, unknown> | null;
  idempotency_field: string | null;
  compensated_by: {
    kind: 'openapi' | 'asyncapi';
    serviceId: string;
    operationId: string;
    channelAddress: string | null;
    messageKey: string | null;
  } | null;
  irreversible_after: boolean | null;
  repository: string | null;
  commit_sha: string | null;
  source_document: string | null;
  evidence_kind: 'repository' | 'github' | 'human-confirmed' | 'atlas-generated';
  generated_candidate_id: string | null;
  evidence_label: string | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  availability_status: 'available' | 'removed';
  freshness_status: 'fresh' | 'stale';
  status_reason: string;
  observed_at: Date;
  status_changed_at: Date;
  source_resolution_status: 'uncontested' | 'conflicting' | 'authoritative';
  authoritative_source_key: string | null;
  source_claims: Array<{
    sourceKey: string;
    capabilityVersionId: string;
    provenance: { evidence: Record<string, unknown> };
  }>;
  approved_hostnames: string[];
  execution_base_url: string | null;
  user_annotations: Array<{
    id: string;
    body: string;
    createdBy: string;
    updatedBy: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

function compatibilityEdgeKey(fromCapabilityVersionId: string, toCapabilityVersionId: string) {
  return JSON.stringify([fromCapabilityVersionId, toCapabilityVersionId]);
}

export async function readCapabilityCatalog(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  environmentId = 'production',
  capabilityVersionId?: string,
) {
  const result = await pool.query<CapabilityCatalogRow>(
    `SELECT cv.capability_version_id, identity.id AS capability_identity_id,
      identity.kind,
      CASE WHEN identity.kind = 'asyncapi'
        THEN cv.capability_fragment #>> '{identity,serviceId}'
        ELSE identity.service_id END AS service_id,
      CASE WHEN identity.kind = 'asyncapi'
        THEN cv.capability_fragment #>> '{identity,operationId}'
        ELSE identity.operation_id END AS operation_id,
      identity.channel_address, identity.message_key,
      cv.capability_fragment, annotation.owner, annotation.secret_alias,
      annotation.business_semantics, annotation.idempotency_field,
      CASE WHEN compensation.id IS NULL THEN NULL ELSE jsonb_build_object(
        'kind', compensation.kind, 'serviceId', compensation.service_id,
        'operationId', compensation.operation_id,
        'channelAddress', compensation.channel_address, 'messageKey', compensation.message_key
      ) END AS compensated_by,
      annotation.irreversible_after, provenance.repository, provenance.commit_sha,
      provenance.path AS source_document, provenance.evidence_kind,
      provenance.evidence_label, provenance.confirmed_by, provenance.confirmed_at, provenance.generated_candidate_id,
      head.availability_status, head.freshness_status, head.status_reason,
      head.observed_at, head.status_changed_at, head.source_resolution_status,
      authority.source_key AS authoritative_source_key, execution_binding.base_url AS execution_base_url,
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
        WHERE user_annotation.organization_id = head.organization_id
          AND user_annotation.capability_identity_id = head.capability_identity_id
      ), '[]'::jsonb) AS user_annotations,
      COALESCE((
        SELECT array_agg(policy.hostname ORDER BY policy.hostname)
        FROM capability_host_policies policy
        WHERE policy.organization_id = head.organization_id
          AND policy.capability_identity_id = head.capability_identity_id
          AND policy.environment_id = head.environment_id
          AND policy.revoked_at IS NULL
      ), ARRAY[]::text[]) AS approved_hostnames,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'sourceKey', claim.source_key,
          'capabilityVersionId', trim(claim.capability_version_id),
          'provenance', jsonb_build_object('evidence',
            CASE WHEN claim_source.evidence_kind IN ('repository', 'github')
              THEN jsonb_build_object(
                'kind', claim_source.evidence_kind, 'repository', claim_source.repository,
                'commit', claim_source.commit_sha, 'path', claim_source.path)
              ELSE jsonb_build_object(
                'kind', 'human-confirmed', 'label', claim_source.evidence_label,
                'confirmedBy', claim_source.confirmed_by, 'confirmedAt', claim_source.confirmed_at)
            END)) ORDER BY claim.observed_at DESC, claim.source_key)
        FROM environment_capability_source_claims claim
        JOIN source_documents claim_source ON claim_source.id = claim.source_document_id
        WHERE claim.organization_id = head.organization_id
          AND claim.environment_id = head.environment_id
          AND claim.capability_identity_id = head.capability_identity_id
          AND claim.active
      ), '[]'::jsonb) AS source_claims
     FROM environment_capability_observations head
     JOIN capability_versions cv
       ON cv.organization_id = head.organization_id
       AND cv.capability_identity_id = head.capability_identity_id
       AND (
         ($3::char(64) IS NULL AND cv.capability_version_id = head.capability_version_id)
         OR cv.capability_version_id = $3::char(64)
       )
     LEFT JOIN environment_capability_version_observations version_observation
       ON version_observation.organization_id = cv.organization_id
      AND version_observation.environment_id = head.environment_id
      AND version_observation.capability_version_id = cv.capability_version_id
     JOIN capability_identities identity ON identity.id = cv.capability_identity_id
     LEFT JOIN manifest_annotations annotation ON annotation.id = cv.manifest_annotation_id
     LEFT JOIN capability_execution_bindings execution_binding
       ON execution_binding.organization_id = head.organization_id
      AND execution_binding.environment_id = head.environment_id
      AND execution_binding.capability_identity_id = head.capability_identity_id
     LEFT JOIN capability_identities compensation
       ON compensation.id = annotation.compensated_by_identity_id
     LEFT JOIN environment_capability_source_authorities authority
       ON authority.organization_id = head.organization_id
      AND authority.environment_id = head.environment_id
      AND authority.capability_identity_id = head.capability_identity_id
     JOIN LATERAL (
       SELECT source.repository, source.commit_sha, source.path, source.evidence_kind,
         source.evidence_label, source.confirmed_by, source.confirmed_at, source.generated_candidate_id
       FROM capability_version_provenance version_provenance
       JOIN source_documents source ON source.id = version_provenance.source_document_id
       WHERE version_provenance.organization_id = cv.organization_id
         AND version_provenance.capability_version_id = cv.capability_version_id
       ORDER BY source.ingested_at DESC, source.id DESC
       LIMIT 1
     ) provenance ON true
     WHERE head.organization_id = $1 AND head.environment_id = $2
       AND (head.deleted_at IS NULL OR $3::char(64) IS NOT NULL)
       AND ($3::char(64) IS NULL OR version_observation.capability_version_id IS NOT NULL)
     ORDER BY identity.kind, identity.service_id, identity.operation_id,
       identity.channel_address, identity.message_key`,
    [organizationId, environmentId, capabilityVersionId ?? null],
  );

  return result.rows.map((row) => ({
    capabilityIdentityId: String(row.capability_identity_id),
    capabilityVersionId: row.capability_version_id.trim(),
    identity: {
      kind: row.kind,
      serviceId: row.service_id,
      operationId: row.operation_id,
      ...(row.channel_address === null ? {} : { channelAddress: row.channel_address }),
      ...(row.message_key === null ? {} : { messageKey: row.message_key }),
    },
    fragment: row.capability_fragment,
    executionBinding: row.execution_base_url ? { baseUrl: row.execution_base_url } : null,
    userAnnotations: row.user_annotations,
    annotation:
      row.owner === null
        ? null
        : {
            owner: row.owner,
            secretAlias: row.secret_alias,
            businessSemantics: row.business_semantics,
            idempotencyField: row.idempotency_field,
            compensatedBy: row.compensated_by,
            irreversibleAfter: row.irreversible_after,
          },
    hostPolicy: {
      environmentId,
      approvedHostnames: row.approved_hostnames,
    },
    provenance: {
      evidence:
        row.evidence_kind === 'atlas-generated'
          ? {
              kind: 'atlas-generated' as const,
              repository: row.repository!,
              commit: row.commit_sha!,
              candidateId: row.generated_candidate_id!,
              label: row.evidence_label!,
              confirmedBy: row.confirmed_by!,
              confirmedAt: row.confirmed_at!.toISOString(),
            }
          : row.evidence_kind !== 'human-confirmed'
            ? {
                kind: row.evidence_kind,
                repository: row.repository!,
                commit: row.commit_sha!,
                path: row.source_document!,
              }
            : {
                kind: 'human-confirmed' as const,
                label: row.evidence_label!,
                confirmedBy: row.confirmed_by!,
                confirmedAt: row.confirmed_at!.toISOString(),
              },
    },
    observation: {
      availability: row.availability_status,
      freshness: row.freshness_status,
      reason: row.status_reason,
      lastObservedAt: row.observed_at.toISOString(),
      statusChangedAt: row.status_changed_at.toISOString(),
    },
    sourceResolution: {
      status: row.source_resolution_status,
      authoritativeSourceKey: row.authoritative_source_key,
      claims: row.source_claims.map((claim) => ({
        ...claim,
        capabilityVersionId: claim.capabilityVersionId.trim(),
      })),
    },
  }));
}

export async function readCapabilityComparisonCatalog(
  pool: Pool,
  organizationId: string,
  environmentId = 'production',
) {
  const comparisonEnvironmentId = environmentId === 'development' ? 'production' : 'development';
  const [selected, counterpart] = await Promise.all([
    readCapabilityCatalog(pool, organizationId, environmentId),
    readCapabilityCatalog(pool, organizationId, comparisonEnvironmentId),
  ]);
  const counterpartByIdentity = new Map(
    counterpart.map((capability) => [capability.capabilityIdentityId, capability]),
  );
  const ahead = new Set<string>();
  if (selected.length > 0 && counterpart.length > 0) {
    const diffs = await pool.query<{
      from_capability_version_id: string;
      to_capability_version_id: string;
    }>(
      `SELECT from_capability_version_id, to_capability_version_id
       FROM compatibility_diffs diff
       JOIN environment_capability_observations production
         ON production.organization_id = diff.organization_id
        AND production.capability_identity_id = diff.capability_identity_id
        AND production.environment_id = 'production'
        AND production.capability_version_id = diff.from_capability_version_id
       JOIN environment_capability_observations development
         ON development.organization_id = diff.organization_id
        AND development.capability_identity_id = diff.capability_identity_id
        AND development.environment_id = 'development'
        AND development.capability_version_id = diff.to_capability_version_id
       JOIN environment_capability_version_observations development_history
         ON development_history.organization_id = development.organization_id
        AND development_history.environment_id = development.environment_id
        AND development_history.capability_version_id = development.capability_version_id
       JOIN environment_capability_version_observations development_prior
         ON development_prior.organization_id = development.organization_id
        AND development_prior.environment_id = development.environment_id
        AND development_prior.capability_version_id = production.capability_version_id
       WHERE diff.organization_id = $1
         AND development_history.first_observed_at > development_prior.first_observed_at`,
      [organizationId],
    );
    for (const row of diffs.rows) {
      ahead.add(
        compatibilityEdgeKey(
          row.from_capability_version_id.trim(),
          row.to_capability_version_id.trim(),
        ),
      );
    }
  }
  const selectedWithComparisons = selected.map((capability) => {
    const other = counterpartByIdentity.get(capability.capabilityIdentityId) ?? null;
    const development = environmentId === 'development' ? capability : other;
    const production = environmentId === 'development' ? other : capability;
    const isAhead = Boolean(
      development &&
      production &&
      ahead.has(
        compatibilityEdgeKey(production.capabilityVersionId, development.capabilityVersionId),
      ),
    );
    return {
      ...capability,
      comparison: {
        state: compareCapabilityObservations(development, production, isAhead),
        development,
        production,
      },
    };
  });
  const selectedIdentityIds = new Set(
    selected.map((capability) => capability.capabilityIdentityId),
  );
  const counterpartOnly = counterpart
    .filter((capability) => !selectedIdentityIds.has(capability.capabilityIdentityId))
    .map((capability) => {
      const development = environmentId === 'development' ? null : capability;
      const production = environmentId === 'development' ? capability : null;
      return {
        ...capability,
        comparison: {
          state: compareCapabilityObservations(development, production, false),
          development,
          production,
        },
      };
    });
  return [...selectedWithComparisons, ...counterpartOnly];
}

const plannerExecutableKeys = new Set([
  '$anchor',
  '$defs',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$ref',
  '$schema',
  '$vocabulary',
  'action',
  'additionalProperties',
  'address',
  'allOf',
  'allowEmptyValue',
  'allowReserved',
  'anyOf',
  'channel',
  'const',
  'contains',
  'content',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'contentType',
  'correlationId',
  'default',
  'definitions',
  'dependentRequired',
  'dependentSchemas',
  'deprecated',
  'description',
  'discriminator',
  'else',
  'encoding',
  'enum',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'explode',
  'format',
  'headers',
  'if',
  'in',
  'items',
  'location',
  'mapping',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'messages',
  'method',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'name',
  'not',
  'nullable',
  'oneOf',
  'operation',
  'operationId',
  'parameters',
  'path',
  'pathParameters',
  'pattern',
  'patternProperties',
  'payload',
  'prefixItems',
  'properties',
  'propertyName',
  'propertyNames',
  'readOnly',
  'references',
  'reply',
  'requestBody',
  'required',
  'responses',
  'schema',
  'schemaFormat',
  'security',
  'style',
  'summary',
  'then',
  'title',
  'type',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
  'writeOnly',
  'x-atlas-data-classification',
  'x-atlas-case',
  'x-atlas-unit',
]);
const executableMapKeys = new Set([
  '$defs',
  'content',
  'definitions',
  'dependentRequired',
  'dependentSchemas',
  'encoding',
  'headers',
  'mapping',
  'messages',
  'patternProperties',
  'properties',
  'references',
  'responses',
  'security',
]);

function plannerSafeDocument(value: unknown, preserveEntryNames = false): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => plannerSafeDocument(child, preserveEntryNames));
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => preserveEntryNames || plannerExecutableKeys.has(key))
      .map(([key, child]) => [key, plannerSafeDocument(child, executableMapKeys.has(key))]),
  );
}

export async function readPlannerCapabilityProjection(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  environmentId = 'production',
) {
  const catalog = await readCapabilityCatalog(pool, organizationId, environmentId);
  const capabilities = [];
  for (const capability of catalog) {
    const facts = await loadCapabilitySelectionFacts(
      pool,
      organizationId,
      capability.capabilityVersionId,
      environmentId,
    );
    if (!facts || !decideNewCompilationSelection(facts).allowed || !capability.annotation) {
      continue;
    }
    capabilities.push({
      capabilityVersionId: capability.capabilityVersionId,
      identity: capability.identity,
      ...(capability.observation ? { observation: capability.observation } : {}),
      fragment: plannerSafeDocument(capability.fragment),
      annotation: {
        owner: capability.annotation.owner,
        businessSemantics: capability.annotation.businessSemantics,
        idempotencyField: capability.annotation.idempotencyField,
        compensatedBy: capability.annotation.compensatedBy,
        irreversibleAfter: capability.annotation.irreversibleAfter,
      },
      ...(capability.userAnnotations.length
        ? { userAnnotations: capability.userAnnotations.map(({ body }) => body) }
        : {}),
    });
  }
  // Workflow inputs are not environment policy. Each workflow declares its own
  // inputs or inherits leftover required fields from its steps; see workflow-input-schema.ts.
  const projection = { capabilities };
  // Discovery health changes readiness, not the definitions bound to a draft.
  const definitions = {
    capabilities: capabilities.map(({ observation: _observation, ...capability }) => capability),
  };
  return {
    fingerprint: sha256(canonicalJson(definitions)),
    ...projection,
  };
}
