import type { ExecutionGrantClaims } from '@atlas/execution-grant';
import type { Pool } from 'pg';

export type CapabilitySelectionDenial =
  | 'missing-current-annotation'
  | 'annotation-not-approved'
  | 'capability-version-not-approved'
  | 'superseded-version'
  | 'capability-removed'
  | 'capability-observation-stale'
  | 'conflicting-sources'
  | 'missing-ownership'
  | 'missing-safety-metadata'
  | 'missing-schema-links'
  | 'missing-host-policy'
  | 'grant-version-mismatch';

export interface CapabilitySelectionFacts {
  capabilityVersionId: string;
  isCurrent: boolean;
  isAvailable: boolean;
  isFresh: boolean;
  hasSourceConflict?: boolean;
  hasCurrentAnnotation: boolean;
  annotationApprovalEffective: boolean;
  capabilityVersionApprovalEffective: boolean;
  hasOwnership: boolean;
  hasSafetyMetadata: boolean;
  hasSchemaLinks: boolean;
  hasHostPolicy: boolean;
}

export interface CapabilitySelectionDecision {
  allowed: boolean;
  denials: CapabilitySelectionDenial[];
}

function selectionDecisionFromDenials(
  denials: CapabilitySelectionDenial[],
): CapabilitySelectionDecision {
  return { allowed: denials.length === 0, denials };
}

function effectiveApprovalDenials(facts: CapabilitySelectionFacts) {
  const denials: CapabilitySelectionDenial[] = [];
  if (!facts.annotationApprovalEffective) denials.push('annotation-not-approved');
  if (!facts.capabilityVersionApprovalEffective) {
    denials.push('capability-version-not-approved');
  }
  return denials;
}

export function decideCapabilityApprovability(
  facts: CapabilitySelectionFacts,
): CapabilitySelectionDecision {
  const denials: CapabilitySelectionDenial[] = [];
  if (!facts.hasOwnership) denials.push('missing-ownership');
  if (!facts.hasSafetyMetadata) denials.push('missing-safety-metadata');
  if (!facts.hasSchemaLinks) denials.push('missing-schema-links');
  if (!facts.hasHostPolicy) denials.push('missing-host-policy');
  return selectionDecisionFromDenials(denials);
}

export function decideNewCompilationSelection(
  facts: CapabilitySelectionFacts,
): CapabilitySelectionDecision {
  const denials = effectiveApprovalDenials(facts);
  if (!facts.hasCurrentAnnotation) denials.push('missing-current-annotation');
  if (!facts.isCurrent) denials.push('superseded-version');
  if (!facts.isAvailable) denials.push('capability-removed');
  if (facts.hasSourceConflict) denials.push('conflicting-sources');
  denials.push(...decideCapabilityApprovability(facts).denials);
  return selectionDecisionFromDenials(denials);
}

export function decideWorkflowApprovalSelection(
  facts: CapabilitySelectionFacts,
): CapabilitySelectionDecision {
  const denials = decideNewCompilationSelection(facts).denials;
  if (!facts.isFresh) denials.push('capability-observation-stale');
  return selectionDecisionFromDenials(denials);
}

export function decidePinnedExecution(
  facts: CapabilitySelectionFacts,
  verifiedGrant: Pick<ExecutionGrantClaims, 'approvedCapabilityVersionIds'>,
): CapabilitySelectionDecision {
  const denials = effectiveApprovalDenials(facts);
  if (!verifiedGrant.approvedCapabilityVersionIds.includes(facts.capabilityVersionId)) {
    denials.push('grant-version-mismatch');
  }
  return selectionDecisionFromDenials(denials);
}

function containsSchemaLink(value: unknown, key?: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (key === 'schema' || key === 'payload') return true;
  if (Array.isArray(value)) return value.some((child) => containsSchemaLink(child));
  return Object.entries(value).some(
    ([childKey, child]) =>
      (childKey === '$ref' && typeof child === 'string') || containsSchemaLink(child, childKey),
  );
}

function hasSafetyMetadata(row: {
  business_semantics: unknown;
  idempotency_field: string | null;
  compensated_by_identity_id: string | null;
  irreversible_after: boolean | null;
  capability_fragment: Record<string, unknown>;
}) {
  const semantics = row.business_semantics;
  if (!semantics || typeof semantics !== 'object' || Object.keys(semantics).length === 0) {
    return false;
  }
  const method = row.capability_fragment.method;
  const operation = row.capability_fragment.operation;
  const action =
    operation && typeof operation === 'object'
      ? (operation as Record<string, unknown>).action
      : undefined;
  const mutates =
    action === 'send' ||
    (typeof method === 'string' && !['get', 'head', 'options'].includes(method.toLowerCase()));
  return (
    !mutates ||
    (Boolean(row.idempotency_field) &&
      (Boolean(row.compensated_by_identity_id) || row.irreversible_after === true))
  );
}

interface CapabilitySelectionRow {
  capability_version_id: string;
  current_capability_version_id: string | null;
  availability_status: 'available' | 'removed' | null;
  freshness_status: 'fresh' | 'stale' | null;
  source_resolution_status: 'uncontested' | 'conflicting' | 'authoritative' | null;
  manifest_annotation_id: string | null;
  owner: string | null;
  business_semantics: unknown;
  idempotency_field: string | null;
  compensated_by_identity_id: string | null;
  irreversible_after: boolean | null;
  capability_fragment: Record<string, unknown>;
  annotation_approval_effective: boolean;
  capability_version_approval_effective: boolean;
  host_policy_effective: boolean;
}

export async function loadCapabilitySelectionFacts(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  capabilityVersionId: string,
  environmentId = 'production',
): Promise<CapabilitySelectionFacts | undefined> {
  const result = await pool.query<CapabilitySelectionRow>(
    `SELECT cv.capability_version_id, head.capability_version_id AS current_capability_version_id,
      head.availability_status, head.freshness_status, head.source_resolution_status,
      cv.manifest_annotation_id, ma.owner, ma.business_semantics, ma.idempotency_field,
      ma.compensated_by_identity_id, ma.irreversible_after, cv.capability_fragment,
      EXISTS (
        SELECT 1 FROM manifest_annotation_approvals approval
        WHERE approval.organization_id = cv.organization_id
          AND approval.manifest_annotation_id = cv.manifest_annotation_id
          AND approval.revoked_at IS NULL
      ) AS annotation_approval_effective,
      EXISTS (
        SELECT 1 FROM capability_approvals approval
        WHERE approval.organization_id = cv.organization_id
          AND approval.capability_version_id = cv.capability_version_id
          AND approval.revoked_at IS NULL
      ) AS capability_version_approval_effective,
      EXISTS (
        SELECT 1 FROM capability_host_policies policy
        WHERE policy.organization_id = cv.organization_id
          AND policy.capability_identity_id = cv.capability_identity_id
          AND policy.environment_id = $3
          AND policy.revoked_at IS NULL
      ) AS host_policy_effective
     FROM capability_versions cv
     LEFT JOIN manifest_annotations ma ON ma.id = cv.manifest_annotation_id
     LEFT JOIN environment_capability_observations head
       ON head.organization_id = cv.organization_id
       AND head.capability_identity_id = cv.capability_identity_id
       AND head.environment_id = $3
     WHERE cv.organization_id = $1 AND cv.capability_version_id = $2`,
    [organizationId, capabilityVersionId, environmentId],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    capabilityVersionId: row.capability_version_id.trim(),
    isCurrent: row.current_capability_version_id?.trim() === row.capability_version_id.trim(),
    isAvailable: row.availability_status === 'available',
    isFresh: row.freshness_status === 'fresh',
    hasSourceConflict: row.source_resolution_status === 'conflicting',
    hasCurrentAnnotation: row.manifest_annotation_id !== null,
    annotationApprovalEffective: row.annotation_approval_effective,
    capabilityVersionApprovalEffective: row.capability_version_approval_effective,
    hasOwnership: Boolean(row.owner?.trim()),
    hasSafetyMetadata: hasSafetyMetadata(row),
    hasSchemaLinks: containsSchemaLink(row.capability_fragment),
    hasHostPolicy: row.host_policy_effective,
  };
}

export async function readCapabilitySelection(
  pool: Pool,
  organizationId: string,
  capabilityVersionId: string,
  environmentId = 'production',
) {
  const observed = await pool.query(
    `SELECT 1 FROM environment_capability_version_observations
     WHERE organization_id = $1 AND environment_id = $2 AND capability_version_id = $3`,
    [organizationId, environmentId, capabilityVersionId],
  );
  if (observed.rowCount === 0) return undefined;
  const facts = await loadCapabilitySelectionFacts(
    pool,
    organizationId,
    capabilityVersionId,
    environmentId,
  );
  if (!facts) return undefined;
  return {
    approvability: decideCapabilityApprovability(facts),
    newCompilation: decideNewCompilationSelection(facts),
  };
}

export async function readPinnedExecutionSelection(
  pool: Pool,
  organizationId: string,
  approvedCapabilityVersionIds: readonly string[],
) {
  const selections = [];
  for (const capabilityVersionId of approvedCapabilityVersionIds) {
    const facts = await loadCapabilitySelectionFacts(pool, organizationId, capabilityVersionId);
    selections.push({
      capabilityVersionId,
      decision: facts
        ? decidePinnedExecution(facts, { approvedCapabilityVersionIds })
        : selectionDecisionFromDenials(['grant-version-mismatch']),
    });
  }
  return {
    allowed: selections.every(({ decision }) => decision.allowed),
    capabilities: selections,
  };
}
