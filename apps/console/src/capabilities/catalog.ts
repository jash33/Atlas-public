// Pure mappers for the Capabilities Catalog Explorer.

import type { CapabilityDiscovery, DriftClassification } from '../home/summaries.js';
import type { CanonicalCapabilityComparisonState } from '@atlas/workflow-ir';

export type CapabilityComparisonState = CanonicalCapabilityComparisonState;

export interface CapabilityIdentity {
  kind: 'openapi' | 'asyncapi';
  serviceId: string;
  operationId: string;
  channelAddress?: string;
  messageKey?: string;
}

export interface CapabilityAnnotation {
  owner: string;
  secretAlias: string | null;
  businessSemantics: Record<string, unknown> | null;
  idempotencyField: string | null;
  compensatedBy: {
    operationId: string;
    channelAddress?: string | null;
    messageKey?: string | null;
  } | null;
  irreversibleAfter: boolean | null;
}

export interface CapabilityUserAnnotation {
  id: string;
  body: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type SourceEvidence =
  | { kind: 'repository' | 'github'; repository: string; commit: string; path: string }
  | {
      kind: 'atlas-generated';
      repository: string;
      commit: string;
      candidateId: string;
      label: string;
      confirmedBy: string;
      confirmedAt: string;
      supportingCode?: Array<{
        operationId: string;
        path: string;
        functionName: string;
        startLine: number;
        endLine: number;
      }>;
    }
  | {
      kind: 'human-confirmed';
      label: string;
      confirmedBy: string;
      confirmedAt: string;
    };

export function sourceEvidenceLabel(evidence: SourceEvidence): string {
  return evidence.kind === 'atlas-generated'
    ? `Atlas-generated from ${evidence.repository} @ ${evidence.commit.slice(0, 8)}`
    : evidence.kind === 'human-confirmed'
      ? evidence.label
      : `${evidence.repository} · ${evidence.path}`;
}

export interface CatalogCapabilityDetail {
  capabilityIdentityId?: string;
  capabilityVersionId: string;
  identity: CapabilityIdentity;
  fragment: Record<string, unknown>;
  annotation: CapabilityAnnotation | null;
  userAnnotations?: CapabilityUserAnnotation[];
  provenance: { evidence: SourceEvidence };
  observation: {
    availability: 'available' | 'removed';
    freshness: 'fresh' | 'stale';
    reason: string;
    lastObservedAt: string;
    statusChangedAt: string;
  };
  sourceResolution?: {
    status: 'uncontested' | 'conflicting' | 'authoritative';
    authoritativeSourceKey: string | null;
    claims: Array<{
      sourceKey: string;
      capabilityVersionId: string;
      provenance: { evidence: SourceEvidence };
    }>;
  };
  comparison?: {
    state: CapabilityComparisonState;
    development: CapabilityComparisonSide | null;
    production: CapabilityComparisonSide | null;
  };
}

export type CapabilityComparisonSide = Omit<CatalogCapabilityDetail, 'comparison'>;

export const capabilityComparisonLabels: Record<CapabilityComparisonState, string> = {
  matching: 'Matching',
  ahead: 'Development ahead',
  different: 'Different',
  'missing-in-production': 'Missing in Production',
  'missing-in-development': 'Missing in Development',
  'removed-in-development': 'Removed in Development',
  'removed-in-production': 'Removed in Production',
  'stale-in-development': 'Stale in Development',
  'stale-in-production': 'Stale in Production',
  'conflicting-in-development': 'Conflicting in Development',
  'conflicting-in-production': 'Conflicting in Production',
};

export function isCapabilityDifference(capability: CatalogCapabilityDetail): boolean {
  return capability.comparison?.state !== undefined && capability.comparison.state !== 'matching';
}

export interface SourceDocumentGroup {
  evidence: SourceEvidence;
  operations: CatalogCapabilityDetail[];
}

export interface ServiceGroup {
  serviceId: string;
  kinds: Array<'openapi' | 'asyncapi'>;
  operationCount: number;
  annotatedCount: number;
  documents: SourceDocumentGroup[];
}

export const formatLabels = {
  openapi: 'OpenAPI 3.1',
  asyncapi: 'AsyncAPI 3.0',
  'atlas-manifest': 'Atlas safety manifest',
} as const;

export function groupCatalog(capabilities: CatalogCapabilityDetail[]): ServiceGroup[] {
  const services = new Map<string, Map<string, SourceDocumentGroup>>();
  for (const capability of capabilities) {
    const documents = services.get(capability.identity.serviceId) ?? new Map();
    services.set(capability.identity.serviceId, documents);
    const documentKey = JSON.stringify(capability.provenance.evidence);
    const group = documents.get(documentKey) ?? {
      evidence: capability.provenance.evidence,
      operations: [],
    };
    group.operations.push(capability);
    documents.set(documentKey, group);
  }
  return [...services.entries()]
    .map(([serviceId, documents]) => {
      const groups = [...documents.values()].map((group) => ({
        ...group,
        operations: [...group.operations].sort((left, right) =>
          left.identity.operationId.localeCompare(right.identity.operationId),
        ),
      }));
      groups.sort((left, right) =>
        JSON.stringify(left.evidence).localeCompare(JSON.stringify(right.evidence)),
      );
      const operations = groups.flatMap((group) => group.operations);
      return {
        serviceId,
        kinds: [...new Set(operations.map((operation) => operation.identity.kind))].sort(),
        operationCount: operations.length,
        annotatedCount: operations.filter((operation) => operation.annotation !== null).length,
        documents: groups,
      };
    })
    .sort((left, right) => left.serviceId.localeCompare(right.serviceId));
}

export function operationRoute(
  capability: Pick<CatalogCapabilityDetail, 'identity' | 'fragment'>,
): string {
  if (capability.identity.kind === 'asyncapi') {
    if (capability.identity.channelAddress && capability.identity.messageKey) {
      return `${capability.identity.channelAddress} · ${capability.identity.messageKey}`;
    }
    return capability.identity.operationId;
  }
  const method = capability.fragment.method;
  const path = capability.fragment.path;
  if (typeof method === 'string' && typeof path === 'string') {
    return `${method.toUpperCase()} ${path}`;
  }
  return capability.identity.operationId;
}

export function latestDiscoveryByService(
  discoveries: CapabilityDiscovery[],
): Map<string, CapabilityDiscovery> {
  const latest = new Map<string, CapabilityDiscovery>();
  for (const discovery of discoveries) {
    const current = latest.get(discovery.serviceId);
    if (!current || discovery.discoveredAt >= current.discoveredAt) {
      latest.set(discovery.serviceId, discovery);
    }
  }
  return latest;
}

export interface DiscoveryOutcome {
  discoveryId: string;
  trigger: string;
  capabilities: Array<{ capabilityVersionId: string }>;
  changes: Array<{ classification: DriftClassification }>;
}

export function summarizeDiscoveryOutcome(outcome: DiscoveryOutcome): string {
  const capabilityCount = outcome.capabilities.length;
  const capabilityPart = `${capabilityCount} capabilit${capabilityCount === 1 ? 'y' : 'ies'} discovered`;
  if (outcome.changes.length === 0) return `${capabilityPart} · no changes`;
  const counts: Record<DriftClassification, number> = {
    breaking: 0,
    conditional: 0,
    metadata: 0,
    compatible: 0,
  };
  for (const change of outcome.changes) counts[change.classification] += 1;
  const breakdown = (['breaking', 'conditional', 'metadata', 'compatible'] as const)
    .filter((classification) => counts[classification] > 0)
    .map((classification) => `${counts[classification]} ${classification}`)
    .join(', ');
  const changePart = `${outcome.changes.length} change${outcome.changes.length === 1 ? '' : 's'}`;
  return `${capabilityPart} · ${changePart} (${breakdown})`;
}

export interface SchemaEvidence {
  label: string;
  schema: unknown;
  reference?: string;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveSchema(
  schema: unknown,
  references: Record<string, unknown> | undefined,
): { schema: unknown; reference?: string } {
  if (isJsonObject(schema) && typeof schema.$ref === 'string' && references?.[schema.$ref]) {
    return { schema: references[schema.$ref], reference: schema.$ref };
  }
  return { schema };
}

function contentSchemas(
  label: string,
  content: unknown,
  references: Record<string, unknown> | undefined,
): SchemaEvidence[] {
  if (!isJsonObject(content)) return [];
  return Object.entries(content).flatMap(([mediaType, mediaValue]) => {
    if (!isJsonObject(mediaValue) || mediaValue.schema === undefined) return [];
    return [{ label: `${label} · ${mediaType}`, ...resolveSchema(mediaValue.schema, references) }];
  });
}

// Presents the typed request/response or message schemas of a capability fragment,
// resolving local $refs through the fragment's own reference snapshot.
export function extractOperationSchemas(
  kind: 'openapi' | 'asyncapi',
  fragment: Record<string, unknown>,
): SchemaEvidence[] {
  const references = isJsonObject(fragment.references) ? fragment.references : undefined;
  if (kind === 'asyncapi') {
    const message = isJsonObject(fragment.message) ? fragment.message : {};
    return [
      ...(message.payload === undefined
        ? []
        : [{ label: 'Message payload', ...resolveSchema(message.payload, references) }]),
      ...(message.headers === undefined
        ? []
        : [{ label: 'Message headers', ...resolveSchema(message.headers, references) }]),
    ];
  }
  const operation = isJsonObject(fragment.operation) ? fragment.operation : {};
  const parameters = [
    ...(Array.isArray(fragment.pathParameters) ? fragment.pathParameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : []),
  ];
  const parameterSchemas = parameters.flatMap((parameter): SchemaEvidence[] => {
    if (!isJsonObject(parameter) || typeof parameter.name !== 'string') return [];
    const location = typeof parameter.in === 'string' ? ` · ${parameter.in}` : '';
    const required = parameter.required === true ? ' · required' : '';
    return [
      {
        label: `Parameter ${parameter.name}${location}${required}`,
        ...resolveSchema(parameter.schema, references),
      },
    ];
  });
  const requestBody = isJsonObject(operation.requestBody) ? operation.requestBody : undefined;
  const responses = isJsonObject(operation.responses) ? operation.responses : {};
  return [
    ...parameterSchemas,
    ...contentSchemas('Request body', requestBody?.content, references),
    ...Object.entries(responses).flatMap(([status, response]) =>
      isJsonObject(response)
        ? contentSchemas(`Response ${status}`, response.content, references)
        : [],
    ),
  ];
}

const selectionDenialDescriptions: Record<string, string> = {
  'missing-current-annotation': 'No safety annotation is attached to this version',
  'annotation-not-approved': 'The safety annotation has not been approved by an admin',
  'capability-version-not-approved': 'This exact capability version has not been approved',
  'superseded-version': 'A newer capability version has superseded this one',
  'capability-removed': 'A successful discovery confirmed that this operation was removed',
  'capability-observation-stale': 'Atlas cannot confirm that this observation is still current',
  'conflicting-sources': 'Multiple sources claim different current contracts for this capability',
  'missing-ownership': 'The safety annotation names no owning team',
  'missing-safety-metadata': 'Business semantics, idempotency, or compensation metadata is missing',
  'missing-schema-links': 'The operation fragment carries no typed schema links',
  'missing-host-policy': 'No execution host allowlist policy covers this capability',
};

export function describeSelectionDenial(denial: string): string {
  return selectionDenialDescriptions[denial] ?? denial;
}

export function describeRequestFailure(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const payload = body as { error?: unknown; issues?: unknown; message?: unknown };
    const code = typeof payload.error === 'string' ? payload.error : null;
    const issues = Array.isArray(payload.issues) ? payload.issues : [];
    const firstIssue = issues.find(
      (issue): issue is { path: unknown[]; message: string } =>
        Boolean(issue) &&
        typeof issue === 'object' &&
        typeof (issue as { message?: unknown }).message === 'string',
    );
    if (code && firstIssue) {
      const path = Array.isArray(firstIssue.path) ? firstIssue.path.join('.') : '';
      return path ? `${code}: ${path} — ${firstIssue.message}` : `${code}: ${firstIssue.message}`;
    }
    if (code && typeof payload.message === 'string') return payload.message;
    if (code) {
      const descriptions: Record<string, string> = {
        'source-url-invalid': 'Enter a valid source URL for the backend to fetch',
        'source-protocol-denied': 'Atlas only fetches capability sources over HTTP or HTTPS',
        'source-host-not-allowlisted':
          'Atlas blocked this source because its host is not in the source allowlist',
        'source-credentials-denied':
          'Atlas blocked credentials embedded in the source URL; use a secret reference instead',
        'source-address-unresolved': 'Atlas could not resolve the source host from the backend',
        'source-address-denied': 'Atlas blocked the resolved source address under network policy',
        'source-fetch-failed': 'Atlas could not reach the source from the backend',
        'source-redirect-denied':
          'Atlas blocked a source redirect; register the final allowlisted URL directly',
        'source-document-ambiguous':
          'Choose either a backend source URL or a pasted specification, not both',
        'source-document-invalid': 'The source did not return a valid JSON specification',
        'source-repository-evidence-invalid':
          'Enter a GitHub repository URL with an exact commit and file path',
        'source-repository-evidence-mismatch':
          'Atlas blocked this source because the fetched file does not match its GitHub evidence',
        'source-author-role-required':
          'Only an author or admin in this organization may connect capability sources',
        'source-environment-not-authorized':
          'Atlas blocked this source because the selected environment is not authorized',
        'source-authorization-not-configured': 'Source connection authorization is not configured',
      };
      return descriptions[code] ?? code;
    }
  }
  return `Request failed (${status})`;
}
