import { objectSchemaSchema, type ObjectSchema, type JsonValue } from '@atlas/workflow-ir';
import { useCallback, useEffect, useState } from 'react';

import type { Remote } from '../home/data.js';
import { requestJson } from '../shell/api.js';

export const catalogLifecycleStatuses = [
  'draft',
  'testing',
  'awaiting-approval',
  'approved-inactive',
  'active',
  'blocked',
  'action-required',
] as const;

export type WorkflowLifecycleStatus = (typeof catalogLifecycleStatuses)[number];

export interface WorkflowCatalogRow {
  workflowId: string;
  name: string;
  activeVersion: { workflowVersionId: string } | null;
  latestVersion: {
    workflowVersionId: string;
    status: WorkflowLifecycleStatus;
  };
  mostRecentRun: {
    runId: string;
    workflowVersionId: string;
    state: string;
    startedAt: string;
  } | null;
  updatedAt: string;
}

export interface WorkflowCatalogDetail extends Omit<WorkflowCatalogRow, 'mostRecentRun'> {
  inputSchema: ObjectSchema | null;
  invocationExample?: Record<string, JsonValue> | null;
  versions: Array<{
    workflowVersionId: string;
    status: WorkflowLifecycleStatus;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
    approval: { approvedBy: string; approvedAt: string } | null;
  }>;
  recentRuns: Array<{
    runId: string;
    workflowVersionId: string;
    trigger:
      | { type: 'manual' }
      | { type: 'webhook'; deliveryId: string }
      | { type: 'api'; deliveryId: string }
      | { type: 'schedule'; scheduleId: string; scheduledFor: string };
    state: string;
    startedAt: string;
    durationMs?: number;
    outcome?: 'succeeded' | 'failed';
  }>;
}

export async function loadWorkflowCatalog(
  organizationId: string,
  environmentId: string,
  signal: AbortSignal,
): Promise<WorkflowCatalogRow[]> {
  const query = new URLSearchParams({ organizationId, environmentId });
  const body = await requestJson<{ workflows: WorkflowCatalogRow[] }>(
    `/v1/workflow-catalog?${query}`,
    { signal },
  );
  return body.workflows;
}

export function saveWorkflowCatalogDraft(
  input: {
    organizationId: string;
    environmentId: string;
    workflowId: string;
    name: string;
    draft: unknown;
  },
  bearerToken: string,
  signal: AbortSignal,
) {
  return requestJson('/v1/workflow-catalog/versions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ...input, status: 'draft' }),
    signal,
  });
}

export async function loadWorkflowDetail(
  organizationId: string,
  environmentId: string,
  workflowId: string,
  signal: AbortSignal,
): Promise<WorkflowCatalogDetail> {
  const query = new URLSearchParams({ organizationId, environmentId });
  const detail = await requestJson<WorkflowCatalogDetail>(
    `/v1/workflow-catalog/${encodeURIComponent(workflowId)}?${query}`,
    { signal },
    (status) =>
      status === 404
        ? 'This workflow is unavailable in the selected environment.'
        : `Workflow detail request failed (${status})`,
  );
  const inputSchema = parsedInputSchema(detail.inputSchema);
  if (inputSchema || !detail.activeVersion) {
    return { ...detail, inputSchema };
  }
  return {
    ...detail,
    inputSchema: await loadActiveVersionInputSchema(
      organizationId,
      environmentId,
      workflowId,
      detail.activeVersion.workflowVersionId,
      signal,
    ),
  };
}

export function inputSchemaFromDraft(draft: unknown): ObjectSchema | null {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
  const executable = (draft as { executable?: unknown }).executable;
  if (!executable || typeof executable !== 'object' || Array.isArray(executable)) return null;
  return parsedInputSchema((executable as { inputSchema?: unknown }).inputSchema);
}

function parsedInputSchema(value: unknown): ObjectSchema | null {
  const parsed = objectSchemaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function loadActiveVersionInputSchema(
  organizationId: string,
  environmentId: string,
  workflowId: string,
  workflowVersionId: string,
  signal: AbortSignal,
): Promise<ObjectSchema | null> {
  const query = new URLSearchParams({ organizationId, environmentId });
  try {
    const body = await requestJson<{ draft: unknown }>(
      `/v1/workflow-catalog/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(workflowVersionId)}?${query}`,
      { signal },
    );
    return inputSchemaFromDraft(body.draft);
  } catch {
    return null;
  }
}

export async function loadCatalogWorkflowReview<T>(
  organizationId: string,
  environmentId: string,
  workflowId: string,
  workflowVersionId: string,
  signal: AbortSignal,
): Promise<{
  draft: unknown;
  projectionFingerprint: string;
  review: T;
  workflowId: string;
  name: string;
}> {
  const scope = new URLSearchParams({ organizationId, environmentId });
  const [target, projection, detail] = await Promise.all([
    requestJson<{ draft: unknown }>(
      `/v1/workflow-catalog/${encodeURIComponent(workflowId)}/versions/${encodeURIComponent(workflowVersionId)}?${scope}`,
      { signal },
    ),
    requestJson<{ fingerprint: string }>(`/v1/planner-capabilities?${scope}`, { signal }),
    loadWorkflowDetail(organizationId, environmentId, workflowId, signal),
  ]);
  const review = await requestJson<T>('/v1/workflow-reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId,
      environmentId,
      projectionFingerprint: projection.fingerprint,
      draft: target.draft,
    }),
    signal,
  });
  return {
    draft: target.draft,
    projectionFingerprint: projection.fingerprint,
    review,
    workflowId: detail.workflowId,
    name: detail.name,
  };
}

export function useWorkflowDetail(
  organizationId: string,
  environmentId: string,
  workflowId: string,
) {
  const scope = `${organizationId}\u0000${environmentId}\u0000${workflowId}`;
  const load = useCallback(
    (signal: AbortSignal) => loadWorkflowDetail(organizationId, environmentId, workflowId, signal),
    [environmentId, organizationId, workflowId],
  );
  return useScopedRemote(scope, load, 'Workflow detail request failed');
}

export function useWorkflowCatalog(organizationId: string, environmentId: string) {
  const scope = `${organizationId}\u0000${environmentId}`;
  const load = useCallback(
    (signal: AbortSignal) => loadWorkflowCatalog(organizationId, environmentId, signal),
    [environmentId, organizationId],
  );
  return useScopedRemote(scope, load, 'Workflow Catalog request failed');
}

export function useScopedRemote<T>(
  scope: string,
  load: (signal: AbortSignal) => Promise<T>,
  fallbackMessage: string,
) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<{ scope: string; remote: Remote<T> }>({
    scope,
    remote: { status: 'loading' },
  });

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot({ scope, remote: { status: 'loading' } });
    void load(controller.signal)
      .then((data) => setSnapshot({ scope, remote: { status: 'ready', data } }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSnapshot({
          scope,
          remote: {
            status: 'error',
            message: error instanceof Error ? error.message : fallbackMessage,
          },
        });
      });
    return () => controller.abort();
  }, [attempt, fallbackMessage, load, scope]);

  return {
    remote: remoteForScope(scope, snapshot),
    reload: useCallback(() => setAttempt((current) => current + 1), []),
  };
}

export function remoteForScope<T>(
  scope: string,
  snapshot: { scope: string; remote: Remote<T> },
): Remote<T> {
  return snapshot.scope === scope ? snapshot.remote : { status: 'loading' };
}

export function matchesCatalogSearch(workflow: WorkflowCatalogRow, search: string): boolean {
  const normalized = search.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return `${workflow.name} ${workflow.workflowId}`.toLocaleLowerCase().includes(normalized);
}
