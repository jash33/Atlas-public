import {
  groupCatalog,
  type CatalogCapabilityDetail,
  type ServiceGroup,
  type SourceEvidence,
} from './catalog.js';
import type { RepositoryProgress } from './RepositoryAnalysis.js';

export interface CatalogRepositoryConnection {
  id: string;
  repository: string;
  branches: string[];
  last_error?: string | null;
  last_checked_at?: string | null;
  progress?: Partial<RepositoryProgress>;
  targets?: Array<{ last_successful_at: string | null }>;
  candidates?: Array<{ id: string; status: string; kind: string }>;
}

export interface CatalogSourceGroup {
  key: string;
  label: string;
  repository: string | null;
  connectionId: string | null;
  branches: string[];
  capabilities: CatalogCapabilityDetail[];
  services: ServiceGroup[];
}

function repositoryKey(repository: string) {
  const value = repository
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return /^https?:\/\/github\.com\//i.test(value)
    ? value.replace(/^http:/i, 'https:').toLowerCase()
    : value;
}

function repositoriesForCapability(capability: CatalogCapabilityDetail) {
  const evidence: SourceEvidence[] = [];
  for (const side of [
    capability,
    capability.comparison?.development,
    capability.comparison?.production,
  ]) {
    if (!side) continue;
    evidence.push(side.provenance.evidence);
    evidence.push(
      ...(side.sourceResolution?.claims ?? []).map((claim) => claim.provenance.evidence),
    );
  }
  return new Map(
    evidence.flatMap((entry) =>
      entry.kind === 'human-confirmed'
        ? []
        : [[repositoryKey(entry.repository), entry.repository] as const],
    ),
  );
}

// Keep repository membership separate from service IDs: two repositories may both contain billing.
export function groupCatalogSources(
  capabilities: CatalogCapabilityDetail[],
  connections: CatalogRepositoryConnection[] = [],
): CatalogSourceGroup[] {
  const sources = new Map<string, CatalogSourceGroup>();
  function sourceFor(key: string, repository: string | null) {
    let source = sources.get(key);
    if (!source) {
      source = {
        key,
        label: repository
          ? repositoryKey(repository).replace(/^https?:\/\/github\.com\//, '')
          : 'Other sources',
        repository,
        connectionId: null,
        branches: [],
        capabilities: [],
        services: [],
      };
      sources.set(key, source);
    }
    return source;
  }
  for (const connection of connections) {
    const source = sourceFor(repositoryKey(connection.repository), connection.repository);
    source.connectionId = connection.id;
    source.branches = [...new Set([...source.branches, ...connection.branches])];
  }
  for (const capability of capabilities) {
    const repositories = repositoriesForCapability(capability);
    const memberships = repositories.size ? repositories : new Map([['other-sources', null]]);
    for (const [key, repository] of memberships) {
      const source = sourceFor(key, repository);
      if (
        !source.capabilities.some(
          (entry) => entry.capabilityVersionId === capability.capabilityVersionId,
        )
      )
        source.capabilities.push(capability);
    }
  }
  return [...sources.values()]
    .map((source) => ({ ...source, services: groupCatalog(source.capabilities) }))
    .sort(
      (left, right) =>
        Number(right.repository !== null) - Number(left.repository !== null) ||
        left.label.localeCompare(right.label),
    );
}
