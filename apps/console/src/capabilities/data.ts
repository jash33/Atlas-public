// Data access for the Capabilities Catalog Explorer. Every mutation goes through
// the real ingestion and discovery APIs; failures surface as thrown Errors.

import {
  capabilityArchitectureSchema,
  capabilityOverviewSchema,
  type CapabilityArchitecture,
  type CapabilityOverview,
  type CapabilityOverviewNode,
  type CapabilityOverviewRelationship,
} from '@atlas/workflow-ir';

import { environmentQuery, useRemote } from '../home/data.js';
import { requestJsonWithFailure } from '../shell/api.js';
import type { CatalogRepositoryConnection } from './repository-sources.js';
import type {
  CapabilityDiscovery,
  CapabilityDiscoveryDetail,
  DiscoveryChange,
} from '../home/summaries.js';
import {
  describeRequestFailure,
  type CapabilityAnnotation,
  type CapabilityIdentity,
  type CapabilityUserAnnotation,
  type CatalogCapabilityDetail,
  type DiscoveryOutcome,
  type SourceEvidence,
} from './catalog.js';

const requestJson = requestJsonWithFailure(describeRequestFailure);

export async function deleteCapability(
  organizationId: string,
  environmentId: string,
  capabilityIdentityId: string,
  bearerToken: string,
) {
  return requestJson<{ deleted: true }>(
    `/v1/organizations/${encodeURIComponent(organizationId)}/environments/${encodeURIComponent(environmentId)}/capabilities/${encodeURIComponent(capabilityIdentityId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${bearerToken}` } },
  );
}

function capabilityAnnotationsPath(organizationId: string, capabilityIdentityId: string) {
  return `/v1/organizations/${encodeURIComponent(organizationId)}/capabilities/${encodeURIComponent(capabilityIdentityId)}/annotations`;
}

export async function createCapabilityUserAnnotation(
  organizationId: string,
  capabilityIdentityId: string,
  body: string,
  bearerToken: string,
) {
  return requestJson<CapabilityUserAnnotation>(
    capabilityAnnotationsPath(organizationId, capabilityIdentityId),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body }),
    },
  );
}

export async function updateCapabilityUserAnnotation(
  organizationId: string,
  capabilityIdentityId: string,
  annotationId: string,
  body: string,
  bearerToken: string,
) {
  return requestJson<CapabilityUserAnnotation>(
    `${capabilityAnnotationsPath(organizationId, capabilityIdentityId)}/${encodeURIComponent(annotationId)}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body }),
    },
  );
}

export async function deleteCapabilityUserAnnotation(
  organizationId: string,
  capabilityIdentityId: string,
  annotationId: string,
  bearerToken: string,
) {
  return requestJson<{ deleted: true }>(
    `${capabilityAnnotationsPath(organizationId, capabilityIdentityId)}/${encodeURIComponent(annotationId)}`,
    { method: 'DELETE', headers: { authorization: `Bearer ${bearerToken}` } },
  );
}
export const capabilityMapAccessDeniedMessage =
  "You do not have access to this organization's capability map.";

export function describeCapabilityOverviewFailure(status: number, body: unknown): string {
  if (status === 403) return capabilityMapAccessDeniedMessage;
  return describeRequestFailure(status, body);
}

const requestCapabilityOverviewJson = requestJsonWithFailure(describeCapabilityOverviewFailure);

export function useCatalogCapabilities(organizationId: string, environmentId: string) {
  return useRemote([environmentId, organizationId], async (signal: AbortSignal) => {
    const query = environmentQuery(organizationId, environmentId);
    const body = await requestJson<{ capabilities: CatalogCapabilityDetail[] }>(
      `/v1/capabilities?${query}`,
      { signal },
    );
    return body.capabilities;
  });
}

export function useCatalogRepositories(organizationId: string, bearerToken: string) {
  return useRemote([organizationId, bearerToken], async (signal: AbortSignal) => {
    const body = await requestJson<{ connections: CatalogRepositoryConnection[] }>(
      `/v1/organizations/${encodeURIComponent(organizationId)}/repositories`,
      { signal, headers: { authorization: `Bearer ${bearerToken}` } },
    );
    return body.connections;
  });
}

export type {
  CapabilityArchitecture,
  CapabilityOverview,
  CapabilityOverviewNode,
  CapabilityOverviewRelationship,
};

export function useCapabilityArchitecture(
  organizationId: string,
  environmentId: string,
  bearerToken: string,
) {
  return useRemote([bearerToken, environmentId, organizationId], async (signal: AbortSignal) => {
    const query = environmentQuery(organizationId, environmentId);
    return capabilityArchitectureSchema.parse(
      await requestCapabilityOverviewJson<unknown>(`/v1/capability-architecture?${query}`, {
        signal,
        headers: { authorization: `Bearer ${bearerToken}` },
      }),
    );
  });
}

export function useCapabilityOverview(
  organizationId: string,
  environmentId: string,
  bearerToken: string,
  focus?: { type: 'change' | 'runtime-mismatch'; id: string },
) {
  const focusType = focus?.type;
  const focusId = focus?.id;
  return useRemote(
    [bearerToken, environmentId, focusId, focusType, organizationId],
    async (signal: AbortSignal) => {
      const query = new URLSearchParams(environmentQuery(organizationId, environmentId));
      if (focusType && focusId) {
        query.set('focusType', focusType);
        query.set('focusId', focusId);
      }
      return capabilityOverviewSchema.parse(
        await requestCapabilityOverviewJson<unknown>(`/v1/capability-overview?${query}`, {
          signal,
          headers: { authorization: `Bearer ${bearerToken}` },
        }),
      );
    },
  );
}

export function useServiceDiscoveries(organizationId: string, environmentId: string) {
  return useRemote([environmentId, organizationId], async (signal: AbortSignal) => {
    const query = environmentQuery(organizationId, environmentId);
    const body = await requestJson<{ discoveries: CapabilityDiscovery[] }>(
      `/v1/capability-discoveries?${query}`,
      { signal },
    );
    return body.discoveries;
  });
}

export interface SourceRegistration {
  serviceId: string;
  sourceKey: string;
  format: string | null;
  url: string | null;
  evidence: SourceEvidence;
  updatedAt: string;
}

export function useSourceRegistrations(
  organizationId: string,
  environmentId: string,
  bearerToken: string,
) {
  return useRemote([bearerToken, environmentId, organizationId], async (signal: AbortSignal) => {
    const query = environmentQuery(organizationId, environmentId);
    const body = await requestJson<{ registrations: SourceRegistration[] }>(
      `/v1/capability-source-connections?${query}`,
      { signal, headers: { authorization: `Bearer ${bearerToken}` } },
    );
    return body.registrations;
  });
}

export function useDiscoveryDetail(
  organizationId: string,
  environmentId: string,
  discoveryId: string | null,
) {
  return useRemote(
    [organizationId, environmentId, discoveryId],
    async (signal: AbortSignal): Promise<CapabilityDiscoveryDetail | null> => {
      if (!discoveryId) return null;
      const query = environmentQuery(organizationId, environmentId);
      return requestJson<CapabilityDiscoveryDetail>(
        `/v1/capability-discoveries/${discoveryId}?${query}`,
        { signal },
      );
    },
  );
}

export interface SourceProvenance {
  sourceDocumentId: string;
  evidence: SourceEvidence;
  manifest: {
    sourceDocumentId: string;
    evidence: SourceEvidence;
  } | null;
}

export interface IdentityVersion {
  capabilityVersionId: string;
  lifecycleStatus: 'current' | 'superseded';
  publishedAt: string;
  introducedBy: SourceEvidence;
}

export interface CapabilityVersionDetail {
  capabilityIdentityId: string;
  capabilityVersionId: string;
  lifecycleStatus: 'current' | 'removed' | 'superseded';
  observation: CatalogCapabilityDetail['observation'] | null;
  identity: CapabilityIdentity;
  annotation: (CapabilityAnnotation & { fieldRenames?: unknown[] }) | null;
  userAnnotations?: CapabilityUserAnnotation[];
  fragment: Record<string, unknown>;
  provenance: SourceProvenance | undefined;
  provenanceHistory: SourceProvenance[];
  approval: { approvedBy: string; approvedAt: string } | null;
  runtimeObservations: Array<{
    environmentId: string;
    runId: string;
    stepId: string;
    attempt: number;
    durationMs: number;
    status: 'succeeded' | 'failed';
    failureType: string | null;
    recordedAt: string;
  }>;
  identityVersions: IdentityVersion[];
}

export interface SelectionDecision {
  allowed: boolean;
  denials: string[];
}

export interface CapabilityInspection {
  version: CapabilityVersionDetail;
  selection: { approvability: SelectionDecision; newCompilation: SelectionDecision } | null;
  dependencies: Array<{ workflowVersionId: string; stepId: string }>;
}

export function useCapabilityInspection(
  organizationId: string,
  environmentId: string,
  capabilityVersionId: string | null,
) {
  return useRemote(
    [organizationId, environmentId, capabilityVersionId],
    async (signal: AbortSignal): Promise<CapabilityInspection | null> => {
      if (!capabilityVersionId) return null;
      const query = new URLSearchParams({ organizationId, environmentId });
      const [version, selection, dependencies] = await Promise.all([
        requestJson<CapabilityVersionDetail>(
          `/v1/capability-versions/${capabilityVersionId}?${query}`,
          { signal },
        ),
        requestJson<CapabilityInspection['selection']>(
          `/v1/capability-versions/${capabilityVersionId}/selection?${query}`,
          { signal },
        ).catch(() => null),
        requestJson<{ dependencies: CapabilityInspection['dependencies'] }>(
          `/v1/capability-versions/${capabilityVersionId}/workflow-dependencies?${query}`,
          { signal },
        ),
      ]);
      return { version, selection, dependencies: dependencies.dependencies };
    },
  );
}

export interface PlannerProjectionSummary {
  fingerprint: string;
  capabilityVersionIds: Set<string>;
}

export function usePlannerProjection(organizationId: string, environmentId: string) {
  return useRemote(
    [organizationId, environmentId],
    async (signal: AbortSignal): Promise<PlannerProjectionSummary> => {
      const query = new URLSearchParams({ organizationId, environmentId });
      const body = await requestJson<{
        fingerprint: string;
        capabilities: Array<{ capabilityVersionId: string }>;
      }>(`/v1/planner-capabilities?${query}`, { signal });
      return {
        fingerprint: body.fingerprint,
        capabilityVersionIds: new Set(
          body.capabilities.map((capability) => capability.capabilityVersionId),
        ),
      };
    },
  );
}

export async function approveCapabilityVersionSafety(
  organizationId: string,
  capabilityVersionId: string,
  bearerToken: string,
): Promise<{ approvedBy: string; approvedAt: string }> {
  return requestJson<{ approvedBy: string; approvedAt: string }>(
    `/v1/capability-versions/${capabilityVersionId}/safety-approval`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ organizationId }),
    },
  );
}

export async function setCapabilitySourceAuthority(
  organizationId: string,
  environmentId: string,
  capabilityIdentityId: string,
  sourceKey: string | null,
  bearerToken: string,
): Promise<{ sourceKey: string | null; resolution: string; capabilityVersionId: string }> {
  return requestJson(
    `/v1/organizations/${encodeURIComponent(organizationId)}/environments/${encodeURIComponent(environmentId)}/capabilities/${encodeURIComponent(capabilityIdentityId)}/source-authority`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sourceKey }),
    },
  );
}

export interface DiscoverySubmission {
  organizationId: string;
  serviceId: string;
  source: {
    format: 'openapi';
    document: Record<string, unknown>;
    evidence: { kind: 'human-confirmed'; label: string };
  };
  manifest: {
    source: { kind: 'human-confirmed'; label: string };
    annotations: unknown[];
  };
}

export interface DiscoveryResult extends DiscoveryOutcome {
  changes: DiscoveryChange[];
  capabilities: Array<{
    capabilityVersionId: string;
    identity: CapabilityIdentity;
    lifecycleStatus: 'current' | 'superseded';
  }>;
}

export interface BurgerTownConnectionResult extends DiscoveryResult {
  pollingDefinitionCount: number;
  monitoringState: 'unavailable' | 'stopped' | 'starting' | 'active' | 'stopping';
  arazzoWorkflowCount?: number;
}

export interface BurgerTownConnectionDefaults {
  applicationUrl: string;
  openApiUrl: string;
  arazzoUrl?: string;
}

export async function readBurgerTownConnectionDefaults(
  organizationId: string,
  environmentId: string,
  bearerToken: string,
  signal?: AbortSignal,
): Promise<BurgerTownConnectionDefaults> {
  const query = environmentQuery(organizationId, environmentId);
  return requestJson<BurgerTownConnectionDefaults>(`/v1/burger-town-source-connections?${query}`, {
    ...(signal ? { signal } : {}),
    headers: { authorization: `Bearer ${bearerToken}` },
  });
}

export function useBurgerTownConnectionDefaults(
  organizationId: string,
  environmentId: string,
  bearerToken: string,
) {
  return useRemote([bearerToken, environmentId, organizationId], (signal: AbortSignal) =>
    readBurgerTownConnectionDefaults(organizationId, environmentId, bearerToken, signal),
  );
}

export interface BurgerTownMonitoringStatus {
  state: 'unavailable' | 'stopped' | 'starting' | 'active' | 'stopping';
  lastCompletedSweepAt: string | null;
  readinessMessage: string | null;
}

export async function readBurgerTownMonitoring(
  organizationId: string,
  environmentId: string,
  bearerToken: string,
  signal?: AbortSignal,
): Promise<BurgerTownMonitoringStatus> {
  const query = environmentQuery(organizationId, environmentId);
  return requestJson<BurgerTownMonitoringStatus>(`/v1/burger-town-monitoring?${query}`, {
    ...(signal ? { signal } : {}),
    headers: { authorization: `Bearer ${bearerToken}` },
  });
}

export async function changeBurgerTownMonitoring(
  action: 'start' | 'stop',
  input: { organizationId: string; environmentId: string },
  bearerToken: string,
): Promise<BurgerTownMonitoringStatus> {
  return requestJson<BurgerTownMonitoringStatus>(`/v1/burger-town-monitoring/${action}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}

export function useBurgerTownMonitoring(
  organizationId: string,
  environmentId: string,
  bearerToken: string,
) {
  return useRemote(
    [bearerToken, environmentId, organizationId],
    (signal: AbortSignal) =>
      readBurgerTownMonitoring(organizationId, environmentId, bearerToken, signal),
    {
      refreshIntervalMs: 1_000,
      refreshOnlyAfterSuccess: true,
      shouldRefresh: (status) =>
        status.state === 'starting' || status.state === 'active' || status.state === 'stopping',
    },
  );
}

export async function runSourceDiscovery(
  submission: DiscoverySubmission,
  environmentId: string,
  bearerToken: string,
): Promise<DiscoveryResult> {
  return requestJson<DiscoveryResult>('/v1/capability-source-connections', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...submission, environmentId }),
  });
}

export async function connectBurgerTown(
  input: {
    organizationId: string;
    environmentId: string;
    applicationUrl: string;
    openApiUrl: string;
    arazzoUrl?: string;
  },
  bearerToken: string,
): Promise<BurgerTownConnectionResult> {
  return requestJson<BurgerTownConnectionResult>('/v1/burger-town-source-connections', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}

export async function rerunRegisteredSource(
  organizationId: string,
  environmentId: string,
  serviceId: string,
  bearerToken: string,
  sourceKey?: string,
): Promise<DiscoveryResult> {
  return requestJson<DiscoveryResult>(
    `/v1/capability-source-connections/${encodeURIComponent(serviceId)}/rediscovery`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ organizationId, environmentId, ...(sourceKey ? { sourceKey } : {}) }),
    },
  );
}
