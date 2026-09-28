import { capabilityArchitectureSchema, type CapabilityArchitecture } from '@atlas/workflow-ir';
import type { Pool, PoolClient } from 'pg';

import { parseArazzoDocument, type ParsedArazzoDocument } from './arazzo-document.js';
import { canonicalJson, sha256 } from './capability-versioning.js';

export async function saveCapabilityArchitecture(
  client: Pick<PoolClient, 'query'>,
  input: {
    organizationId: string;
    environmentId: string;
    serviceId: string;
    sourceUrl: string;
    documentYaml: string;
    confirmedAt: Date;
  },
) {
  const parsed = parseArazzoDocument(input.documentYaml);
  const sourceKey = `document:${input.sourceUrl}`;
  const version = await client.query<{ id: string }>(
    `INSERT INTO capability_architecture_versions
      (organization_id,source_key,service_id,document_hash,document_yaml,source_url)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (organization_id,source_key,service_id,document_hash)
     DO UPDATE SET document_hash=capability_architecture_versions.document_hash RETURNING id::text`,
    [
      input.organizationId,
      sourceKey,
      input.serviceId,
      sha256(input.documentYaml),
      input.documentYaml,
      input.sourceUrl,
    ],
  );
  await client.query(
    `INSERT INTO capability_architecture_selections (organization_id,scope,service_id,source_key,version_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (organization_id,scope,service_id,source_key)
     DO UPDATE SET version_id=EXCLUDED.version_id`,
    [input.organizationId, input.environmentId, input.serviceId, sourceKey, version.rows[0]!.id],
  );
  await client.query(
    `INSERT INTO capability_architectures
       (organization_id, environment_id, service_id, source_url, document_hash,
        document_yaml, title, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (organization_id, environment_id)
     DO UPDATE SET service_id = EXCLUDED.service_id, source_url = EXCLUDED.source_url,
       document_hash = EXCLUDED.document_hash, document_yaml = EXCLUDED.document_yaml,
       title = EXCLUDED.title, confirmed_at = EXCLUDED.confirmed_at`,
    [
      input.organizationId,
      input.environmentId,
      input.serviceId,
      input.sourceUrl,
      sha256(input.documentYaml),
      input.documentYaml,
      parsed.title,
      input.confirmedAt,
    ],
  );
  return parsed;
}

function relationshipId(relationship: ParsedArazzoDocument['relationships'][number]) {
  return `arazzo-${sha256(canonicalJson(relationship))}`;
}

export async function readCapabilityArchitecture(
  pool: Pool,
  organizationId: string,
  environmentId: string,
): Promise<CapabilityArchitecture> {
  const stored = await pool.query<{
    source_url: string;
    document_yaml: string;
    service_id: string;
    capability_versions: Record<string, string>;
  }>(
    `SELECT version.source_url,version.document_yaml,version.service_id,version.capability_versions
     FROM capability_architecture_selections selection JOIN capability_architecture_versions version ON version.id=selection.version_id
     WHERE selection.organization_id = $1 AND selection.scope = $2
     ORDER BY version.service_id,version.source_key`,
    [organizationId, environmentId],
  );
  if (!stored.rows.length) {
    return capabilityArchitectureSchema.parse({
      status: 'empty',
      title: '',
      sourceUrl: null,
      notices: [
        'No provider recipes are stored for this environment. Connect a source that publishes Arazzo to see how it says its APIs connect.',
      ],
      workflows: [],
      nodes: [],
      relationships: [],
    });
  }

  const architectures: CapabilityArchitecture[] = [];
  for (const row of stored.rows) {
    const parsed = parseArazzoDocument(row.document_yaml);
    const operationIds = [
      ...new Set(
        parsed.relationships.flatMap((relationship) => [
          relationship.sourceOperationId,
          relationship.targetOperationId,
        ]),
      ),
    ].sort();
    const identities = await pool.query<{
      operation_id: string;
      capability_identity_id: string;
      capability_version_id: string;
      service_id: string;
    }>(
      `SELECT identity.operation_id, identity.id::text AS capability_identity_id,
            version.capability_version_id, identity.service_id
     FROM capability_versions version
     LEFT JOIN environment_capability_version_observations observed
       ON version.organization_id = observed.organization_id
      AND version.capability_version_id = observed.capability_version_id
      AND observed.environment_id=$2
     JOIN capability_identities identity
       ON identity.id = version.capability_identity_id
     WHERE version.organization_id = $1 AND identity.service_id=$4
       AND identity.operation_id = ANY($3::text[])
       AND (observed.environment_id IS NOT NULL OR version.capability_version_id=ANY($5::char(64)[]))`,
      [
        organizationId,
        environmentId,
        operationIds,
        row.service_id,
        Object.values(row.capability_versions),
      ],
    );
    const identityByOperation = new Map(
      identities.rows.map((identity) => [identity.operation_id, identity]),
    );
    const unmatched = operationIds.filter((operationId) => !identityByOperation.has(operationId));
    const notices = [
      'These connections come from the provider Arazzo recipes. They are not Atlas blast radius.',
    ];
    if (unmatched.length > 0) {
      notices.push(
        `${unmatched.length} ${unmatched.length === 1 ? 'operation is' : 'operations are'} named in the recipes but not ingested in this environment.`,
      );
    }

    architectures.push(
      capabilityArchitectureSchema.parse({
        status: 'ready',
        title: parsed.title,
        sourceUrl: row.source_url,
        notices,
        workflows: parsed.workflows,
        nodes: operationIds.map((operationId) => {
          const identity = identityByOperation.get(operationId);
          return {
            operationId,
            capabilityIdentityId: identity?.capability_identity_id ?? null,
            capabilityVersionId: identity?.capability_version_id ?? null,
            serviceId: identity?.service_id ?? null,
          };
        }),
        relationships: parsed.relationships.map((relationship) => ({
          id: relationshipId(relationship),
          ...relationship,
        })),
      }),
    );
  }
  if (architectures.length === 1) return architectures[0]!;
  // Qualify identifiers when several services publish recipes in the same scope.
  return capabilityArchitectureSchema.parse({
    status: 'ready',
    title: architectures.map((entry) => entry.title).join(' · '),
    sourceUrl: null,
    notices: [...new Set(architectures.flatMap((entry) => entry.notices))],
    workflows: architectures.flatMap((entry, index) =>
      entry.workflows.map((workflow) => ({
        ...workflow,
        workflowId: `${stored.rows[index]!.service_id}:${workflow.workflowId}`,
      })),
    ),
    nodes: architectures.flatMap((entry, index) =>
      entry.nodes.map((node) => ({
        ...node,
        catalogOperationId: node.operationId,
        operationId: `${stored.rows[index]!.service_id}:${node.operationId}`,
      })),
    ),
    relationships: architectures.flatMap((entry, index) =>
      entry.relationships.map((relationship) => ({
        ...relationship,
        id: `${stored.rows[index]!.service_id}:${relationship.id}`,
        workflowId: `${stored.rows[index]!.service_id}:${relationship.workflowId}`,
        sourceOperationId: `${stored.rows[index]!.service_id}:${relationship.sourceOperationId}`,
        targetOperationId: `${stored.rows[index]!.service_id}:${relationship.targetOperationId}`,
      })),
    ),
  });
}

/** Compact provider recipes for the planner. Hints only — never a mandate to copy every step. */
export type PlannerRecipeHints = {
  readonly title: string;
  readonly workflows: ReadonlyArray<{
    readonly workflowId: string;
    readonly summary: string;
    readonly description?: string;
  }>;
  readonly connections: ReadonlyArray<{
    readonly kind: 'data-flow' | 'execution-order';
    readonly workflowId: string;
    readonly sourceOperationId: string;
    readonly targetOperationId: string;
    readonly sourceServiceId?: string;
    readonly targetServiceId?: string;
    readonly destinationField?: string;
  }>;
};

export function plannerRecipeHints(
  architecture: CapabilityArchitecture,
): PlannerRecipeHints | undefined {
  if (architecture.status !== 'ready') return undefined;
  if (architecture.workflows.length === 0 && architecture.relationships.length === 0) {
    return undefined;
  }
  return {
    title: architecture.title,
    workflows: architecture.workflows.map(({ workflowId, summary, description }) => ({
      workflowId,
      summary,
      ...(description ? { description } : {}),
    })),
    connections: architecture.relationships.map(
      ({ kind, workflowId, sourceOperationId, targetOperationId, destinationField }) => {
        const source = architecture.nodes.find((node) => node.operationId === sourceOperationId);
        const target = architecture.nodes.find((node) => node.operationId === targetOperationId);
        return {
          kind,
          workflowId,
          sourceOperationId: source?.catalogOperationId ?? sourceOperationId,
          targetOperationId: target?.catalogOperationId ?? targetOperationId,
          ...(source?.catalogOperationId && source.serviceId
            ? { sourceServiceId: source.serviceId }
            : {}),
          ...(target?.catalogOperationId && target.serviceId
            ? { targetServiceId: target.serviceId }
            : {}),
          ...(destinationField ? { destinationField } : {}),
        };
      },
    ),
  };
}
