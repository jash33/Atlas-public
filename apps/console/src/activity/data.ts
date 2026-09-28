import { useRemote } from '../home/data.js';
import { requestJson } from '../shell/api.js';
import type { AuditEntry } from './activity.js';

export async function loadActivityHistory(
  organizationId: string,
  environmentId: string,
  signal: AbortSignal,
): Promise<AuditEntry[]> {
  const query = new URLSearchParams({ organizationId, environmentId });
  const result = await requestJson<{ entries: AuditEntry[] }>(`/v1/audit-entries?${query}`, {
    signal,
  });
  return result.entries;
}

export function useActivityHistory(organizationId: string, environmentId: string) {
  return useRemote([environmentId, organizationId], (signal: AbortSignal) =>
    loadActivityHistory(organizationId, environmentId, signal),
  );
}
