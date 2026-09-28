import { consoleFetch } from '../shell/api.js';
import { useEffect, useRef, useState } from 'react';

import { consoleConfig } from '../config.js';
import type {
  CapabilityDiscovery,
  CapabilityDiscoveryDetail,
  CatalogCapability,
  WorkflowRun,
  WorkflowVersionSummary,
} from './summaries.js';

export type Remote<T> =
  | { status: 'loading'; retrying?: boolean; message?: string }
  | { status: 'error'; message: string; refreshFailure?: boolean }
  | { status: 'ready'; data: T };

interface RemoteRefreshOptions<T> {
  refreshIntervalMs?: number;
  refreshOnlyAfterSuccess?: boolean;
  shouldRefresh?: (data: T) => boolean;
}

function remoteDuringLoad<T>(current: Remote<T>, scopeChanged: boolean): Remote<T> {
  if (scopeChanged) return { status: 'loading' };
  if (current.status === 'ready' || (current.status === 'loading' && current.retrying)) {
    return current;
  }
  return { status: 'loading' };
}

function remoteForRetry<T>(current: Remote<T>): Remote<T> {
  if (current.status !== 'error') return current;
  return { status: 'loading', retrying: true, message: current.message };
}

export function environmentQuery(organizationId: string, environmentId: string): URLSearchParams {
  return new URLSearchParams({ organizationId, environmentId });
}

function shouldScheduleRemoteRefresh<T>(
  remote: Remote<T>,
  options: RemoteRefreshOptions<T>,
): boolean {
  if (!options.refreshIntervalMs) return false;
  if (options.shouldRefresh && (remote.status !== 'ready' || !options.shouldRefresh(remote.data)))
    return false;
  return !options.refreshOnlyAfterSuccess || remote.status === 'ready';
}

async function fetchJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await consoleFetch(`${consoleConfig.backendUrl}${path}`, { signal });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return (await response.json()) as T;
}

export function useRemote<T>(
  scope: readonly (string | number | boolean | null | undefined)[],
  load: (signal: AbortSignal) => Promise<T>,
  options: RemoteRefreshOptions<T> = {},
): {
  remote: Remote<T>;
  reload: () => void;
} {
  const scopeKey = JSON.stringify(scope.map((value) => [typeof value, value]));
  const [stored, setStored] = useState<{ scope: string; remote: Remote<T> }>({
    scope: scopeKey,
    remote: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  const current = useRef({ scopeKey, load });
  current.current = { scopeKey, load };
  const previousScope = useRef(scopeKey);

  useEffect(() => {
    const controller = new AbortController();
    const scopeChanged = previousScope.current !== scopeKey;
    previousScope.current = scopeKey;
    const publish = (remote: Remote<T>) => {
      if (!controller.signal.aborted && current.current.scopeKey === scopeKey)
        setStored({ scope: scopeKey, remote });
    };
    setStored((current) => ({
      scope: scopeKey,
      remote: remoteDuringLoad(current.remote, scopeChanged),
    }));
    const load = current.current.load;
    Promise.resolve()
      .then(() => load(controller.signal))
      .then((data) => publish({ status: 'ready', data }))
      .catch((error: unknown) => {
        publish({
          status: 'error',
          message: error instanceof Error ? error.message : 'Request failed',
          ...(!scopeChanged && attempt > 0 ? { refreshFailure: true } : {}),
        });
      });
    return () => controller.abort();
  }, [scopeKey, attempt]);

  const remote = stored.scope === scopeKey ? stored.remote : { status: 'loading' as const };
  const refreshIntervalMs = options.refreshIntervalMs;
  const refreshScheduled = shouldScheduleRemoteRefresh(remote, options);
  useEffect(() => {
    if (!refreshScheduled || !refreshIntervalMs) return;
    const timer = window.setInterval(() => setAttempt((current) => current + 1), refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refreshIntervalMs, refreshScheduled]);

  return {
    remote,
    reload: () => {
      setStored((current) => ({ ...current, remote: remoteForRetry(current.remote) }));
      setAttempt((current) => current + 1);
    },
  };
}

export interface AuditEntry {
  id: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  actorId: string | null;
  recordedAt: string;
}

const recentDiscoveryLimit = 6;

export function useCapabilities(organizationId: string, environmentId: string) {
  return useRemote([environmentId, organizationId], async (signal: AbortSignal) => {
    const query = environmentQuery(organizationId, environmentId);
    const body = await fetchJson<{ capabilities: CatalogCapability[] }>(
      `/v1/capabilities?${query}`,
      signal,
    );
    return body.capabilities;
  });
}

export function useDriftEvidence(organizationId: string, environmentId: string) {
  return useRemote([environmentId, organizationId], async (signal: AbortSignal) => {
    const query = environmentQuery(organizationId, environmentId);
    const body = await fetchJson<{ discoveries: CapabilityDiscovery[] }>(
      `/v1/capability-discoveries?${query}`,
      signal,
    );
    const recent = body.discoveries.slice(-recentDiscoveryLimit);
    const details = await Promise.all(
      recent.map((discovery) =>
        fetchJson<CapabilityDiscoveryDetail>(
          `/v1/capability-discoveries/${discovery.discoveryId}?${query}`,
          signal,
        ),
      ),
    );
    return { discoveries: body.discoveries, details };
  });
}

export function useAttentionRuns(organizationId: string, environmentId: string) {
  return useRemote([organizationId, environmentId], async (signal: AbortSignal) => {
    const query = new URLSearchParams({ organizationId, environmentId, state: 'attention' });
    const body = await fetchJson<{ runs: WorkflowRun[] }>(`/v1/runs?${query}`, signal);
    return body.runs;
  });
}

export function useWorkflowVersions(organizationId: string, environmentId: string) {
  return useRemote([organizationId, environmentId], async (signal: AbortSignal) => {
    const query = new URLSearchParams({ organizationId, environmentId });
    const body = await fetchJson<{ versions: WorkflowVersionSummary[] }>(
      `/v1/workflow-versions?${query}`,
      signal,
    );
    return body.versions;
  });
}

export function useAuditEntries(organizationId: string, environmentId: string) {
  return useRemote([organizationId, environmentId], async (signal: AbortSignal) => {
    const query = new URLSearchParams({ organizationId, environmentId });
    const body = await fetchJson<{ entries: AuditEntry[] }>(`/v1/audit-entries?${query}`, signal);
    return body.entries;
  });
}
