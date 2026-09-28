import type { Pool, PoolClient } from 'pg';

import type { JsonObject } from './capability-documents.js';
import { readWorkflowDependencies } from './capability-ingestion.js';
import { saveSourceCapabilityVersion } from './capability-source-version.js';
import { canonicalJson, compatibilityDiff, sha256 } from './capability-versioning.js';
import {
  asObject,
  extractRequestResponseContract,
  normalizeRepositoryContract,
  requestResponseHash,
  type RequestResponseContract,
} from './repository-contract-normalization.js';
import type { ExtractedRepositoryService } from './repository-contract-extraction.js';

type Database = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
export interface AcceptedRepositoryContract {
  service_id: string;
  openapi: JsonObject;
  arazzo: JsonObject | null;
  capability_versions: Record<string, string>;
  candidate_id: string;
}
export interface RepositoryCandidate {
  id: string;
  run_id: string;
  connection_id: string;
  branch: string;
  commit_sha: string;
  base_commit_sha: string;
  kind: 'initial' | 'periodic' | 'preview';
  status: 'review' | 'preview' | 'accepted' | 'rejected' | 'superseded';
  candidate_hash: string;
  request_response_hash: string;
  baseline_hash: string;
  documents: ExtractedRepositoryService[];
  changes: RepositoryContractChange[];
}
export interface RepositoryContractChange {
  serviceId: string;
  operationId: string;
  previousVersion: string;
  classification: string;
  changes: string[];
  fieldChanges: unknown[];
  previous: RequestResponseContract;
  next: RequestResponseContract;
  affectedWorkflows: { workflowVersionId: string; stepId: string }[];
}

export async function readAcceptedRepositoryContracts(
  db: Database,
  connectionId: string,
  branch: string,
) {
  return (
    await db.query<AcceptedRepositoryContract>(
      `SELECT service_id, openapi, arazzo, capability_versions, candidate_id
    FROM repository_accepted_contracts WHERE connection_id = $1 AND branch = $2 ORDER BY service_id`,
      [connectionId, branch],
    )
  ).rows;
}
export const repositoryBaselineHash = (contracts: AcceptedRepositoryContract[]) =>
  sha256(
    canonicalJson(
      contracts.map((entry) => ({
        serviceId: entry.service_id,
        candidateId: entry.candidate_id,
        versions: entry.capability_versions,
      })),
    ),
  );
export const repositoryCandidateHash = (
  candidate: Pick<
    RepositoryCandidate,
    | 'connection_id'
    | 'branch'
    | 'commit_sha'
    | 'base_commit_sha'
    | 'kind'
    | 'baseline_hash'
    | 'documents'
    | 'changes'
  >,
) => sha256(canonicalJson(candidate));

/** Compare selected input/output contracts and read dependents; never write catalog or live state. */
export async function compareRepositoryContracts(
  db: Database,
  organizationId: string,
  input: {
    serviceId: string;
    operationId: string;
    previousVersion: string;
    previous: RequestResponseContract;
    next: RequestResponseContract;
  },
): Promise<RepositoryContractChange | null> {
  if (canonicalJson(input.previous) === canonicalJson(input.next)) return null;
  const diff = compatibilityDiff(input.previous, input.next);
  return {
    serviceId: input.serviceId,
    operationId: input.operationId,
    previousVersion: input.previousVersion,
    ...diff,
    previous: input.previous,
    next: input.next,
    affectedWorkflows: await readWorkflowDependencies(db, organizationId, input.previousVersion),
  };
}

export async function repositoryContractChanges(
  db: Database,
  organizationId: string,
  accepted: AcceptedRepositoryContract[],
  documents: ExtractedRepositoryService[],
) {
  const changes: RepositoryContractChange[] = [];
  for (const before of accepted) {
    const after = documents.find((document) => document.serviceId === before.service_id);
    if (!after) throw new Error(`Analysis did not cover ${before.service_id}`);
    const prior = await normalizeRepositoryContract(before.service_id, before.openapi, null);
    const next = await normalizeRepositoryContract(before.service_id, after.openapi, null);
    for (const operation of prior.operations) {
      const replacement = next.operations.find(
        (entry) => entry.identity.operationId === operation.identity.operationId,
      );
      if (!replacement)
        throw new Error(
          `Cannot match existing operation ${operation.identity.operationId}; its accepted definition is retained`,
        );
      const change = await compareRepositoryContracts(db, organizationId, {
        serviceId: before.service_id,
        operationId: operation.identity.operationId,
        previousVersion: before.capability_versions[operation.identity.operationId]!,
        previous: extractRequestResponseContract(operation.fragment),
        next: extractRequestResponseContract(replacement.fragment),
      });
      if (change) changes.push(change);
    }
  }
  return changes;
}

export async function requireRepositoryReviewer(
  db: Database,
  organizationId: string,
  actorId: string,
) {
  const member = await db.query(
    `SELECT 1 FROM organization_memberships membership JOIN users person ON person.id = membership.user_id
    WHERE membership.organization_id = $1 AND membership.user_id = $2 AND membership.role = 'admin'`,
    [organizationId, actorId],
  );
  if (!member.rowCount)
    throw new Error('An authorized human administrator must review repository contracts');
}

export async function publishRepositoryContractCandidate(
  client: PoolClient,
  input: {
    organizationId: string;
    repository: string;
    candidate: RepositoryCandidate;
    reviewerId: string;
  },
) {
  const { candidate, organizationId, reviewerId } = input;
  const accepted = await readAcceptedRepositoryContracts(
    client,
    candidate.connection_id,
    candidate.branch,
  );
  const published: { serviceId: string; versions: Record<string, string> }[] = [];
  for (const service of candidate.documents) {
    const normalized = await normalizeRepositoryContract(
      service.serviceId,
      service.openapi,
      service.arazzo,
    );
    const prior = accepted.find((entry) => entry.service_id === service.serviceId);
    const source = await client.query<{ id: string }>(
      `INSERT INTO source_documents
      (organization_id, service_id, format, document, document_hash, evidence_kind, repository, commit_sha,
       evidence_label, confirmed_by, confirmed_at, generated_candidate_id)
      VALUES ($1,$2,'openapi',$3,$4,'atlas-generated',$5,$6,$7,$8,now(),$9) RETURNING id::text`,
      [
        organizationId,
        service.serviceId,
        service.openapi,
        sha256(canonicalJson(service.openapi)),
        input.repository,
        candidate.commit_sha,
        `Atlas repository analysis ${candidate.id}`,
        reviewerId,
        candidate.id,
      ],
    );
    const sourceId = source.rows[0]!.id;
    const versions = Object.create(null) as Record<string, string>;
    for (const capability of normalized.operations) {
      const identity = await client.query<{ id: string }>(
        `INSERT INTO capability_identities
        (organization_id,kind,service_id,operation_id) VALUES ($1,'openapi',$2,$3)
        ON CONFLICT (organization_id, service_id, operation_id) WHERE kind = 'openapi'
        DO UPDATE SET service_id = EXCLUDED.service_id RETURNING id::text`,
        [organizationId, service.serviceId, capability.identity.operationId],
      );
      const previousVersion = prior?.capability_versions[capability.identity.operationId];
      const previous = previousVersion
        ? (
            await client.query<{
              capability_fragment: JsonObject;
              manifest_annotation_id: string | null;
              annotation_hash: string | null;
            }>(
              `SELECT version.capability_fragment, version.manifest_annotation_id::text, annotation.annotation_hash
        FROM capability_versions version LEFT JOIN manifest_annotations annotation ON annotation.id = version.manifest_annotation_id
        WHERE version.organization_id = $1 AND version.capability_version_id = $2`,
              [organizationId, previousVersion],
            )
          ).rows[0]
        : undefined;
      // No new whole-fragment version for an unchanged operation, even if reference layout differs.
      const unchanged =
        candidate.kind === 'periodic' &&
        previous &&
        requestResponseHash(previous.capability_fragment) ===
          requestResponseHash(capability.fragment);
      const versionId = await saveSourceCapabilityVersion(client, {
        organizationId,
        identityId: identity.rows[0]!.id,
        sourceDocumentId: sourceId,
        manifestSourceDocumentId: null,
        annotationId: previous?.manifest_annotation_id ?? null,
        annotationHash: previous?.annotation_hash?.trim() ?? sha256(canonicalJson(null)),
        capability,
        ...(unchanged ? { fragment: previous.capability_fragment } : {}),
      });
      versions[capability.identity.operationId] = versionId;
      await client.query(
        `INSERT INTO capability_identity_heads (organization_id,capability_identity_id,capability_version_id)
        VALUES ($1,$2,$3) ON CONFLICT (organization_id,capability_identity_id) DO NOTHING`,
        [organizationId, identity.rows[0]!.id, versionId],
      );
    }
    await client.query(
      `INSERT INTO repository_accepted_contracts
      (connection_id,branch,service_id,candidate_id,openapi,arazzo,structured_contract,descriptions,capability_versions)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (connection_id,branch,service_id) DO UPDATE SET candidate_id = EXCLUDED.candidate_id,
      openapi = EXCLUDED.openapi, arazzo = EXCLUDED.arazzo, structured_contract = EXCLUDED.structured_contract,
      descriptions = EXCLUDED.descriptions, capability_versions = EXCLUDED.capability_versions, accepted_at = now()`,
      [
        candidate.connection_id,
        candidate.branch,
        service.serviceId,
        candidate.id,
        service.openapi,
        service.arazzo,
        normalized.contract,
        normalized.descriptions,
        versions,
      ],
    );
    if (service.arazzo) {
      const sourceKey = `github:${candidate.connection_id}:${candidate.branch}`;
      const version = await client.query<{ id: string }>(
        `INSERT INTO capability_architecture_versions
        (organization_id,source_key,service_id,document_hash,document_yaml,source_url,commit_sha,capability_versions)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (organization_id,source_key,service_id,document_hash)
        DO UPDATE SET document_hash = capability_architecture_versions.document_hash RETURNING id::text`,
        [
          organizationId,
          sourceKey,
          service.serviceId,
          sha256(canonicalJson(service.arazzo)),
          JSON.stringify(service.arazzo),
          input.repository,
          candidate.commit_sha,
          versions,
        ],
      );
      await client.query(
        `INSERT INTO capability_architecture_selections (organization_id,scope,service_id,source_key,version_id)
        VALUES ($1,$2,$3,$2,$4) ON CONFLICT (organization_id,scope,service_id,source_key) DO UPDATE SET version_id = EXCLUDED.version_id`,
        [organizationId, sourceKey, service.serviceId, version.rows[0]!.id],
      );
    }
    published.push({ serviceId: service.serviceId, versions });
  }
  return published;
}

export async function readRepositoryCatalog(db: Database, organizationId: string) {
  const result = await db.query(
    `SELECT accepted.connection_id AS "connectionId", accepted.branch,
    accepted.service_id AS "serviceId", accepted.candidate_id AS "candidateId", accepted.openapi,
    accepted.arazzo, accepted.capability_versions AS "capabilityVersions", accepted.accepted_at AS "acceptedAt",
    connection.repository, candidate.commit_sha AS commit, candidate.reviewed_by AS "reviewedBy"
    FROM repository_accepted_contracts accepted JOIN github_repository_connections connection ON connection.id = accepted.connection_id
    JOIN repository_contract_candidates candidate ON candidate.id = accepted.candidate_id
    WHERE connection.organization_id = $1 ORDER BY connection.repository,accepted.branch,accepted.service_id`,
    [organizationId],
  );
  return result.rows;
}

export function candidateApprovalContent(candidate: RepositoryCandidate) {
  return {
    connection_id: candidate.connection_id,
    branch: candidate.branch,
    commit_sha: candidate.commit_sha,
    base_commit_sha: candidate.base_commit_sha,
    kind: candidate.kind,
    baseline_hash: candidate.baseline_hash,
    documents: candidate.documents,
    changes: candidate.changes,
  };
}

export function selectedContractHash(documents: ExtractedRepositoryService[]) {
  return Promise.all(
    documents.map(async (service) => [
      service.serviceId,
      (await normalizeRepositoryContract(service.serviceId, service.openapi, null))
        .requestResponseHash,
    ]),
  ).then((values) => sha256(canonicalJson(Object.fromEntries(values))));
}

export function operationIds(document: JsonObject) {
  return Object.values(asObject(document.paths)).flatMap((item) =>
    Object.values(asObject(item)).flatMap((operation) =>
      operation &&
      typeof operation === 'object' &&
      typeof (operation as JsonObject).operationId === 'string'
        ? [(operation as JsonObject).operationId as string]
        : [],
    ),
  );
}
