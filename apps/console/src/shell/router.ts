import { useSyncExternalStore } from 'react';

export const surfaces = [
  'home',
  'workflows',
  'workflow-catalog',
  'capabilities',
  'runs',
  'changes',
  'activity',
  'usage',
  'settings',
] as const;

export type Surface = (typeof surfaces)[number];

export function parseSurfaceHash(hash: string): Surface {
  const path = hash.replace(/^#\/?/, '').split('?')[0]!.replace(/\/$/, '');
  if (path === '') return 'home';
  if (path === 'evidence-monitoring') return 'capabilities';
  return (surfaces as readonly string[]).includes(path) ? (path as Surface) : 'home';
}

export function runDetailHash(runId: string): string {
  return `#/runs?${new URLSearchParams({ runId })}`;
}

export function workflowCatalogDetailHash(workflowId: string): string {
  return `#/workflow-catalog?${new URLSearchParams({ workflowId })}`;
}

export function workflowReviewHash(workflowId: string, workflowVersionId: string): string {
  return `#/workflows?${new URLSearchParams({ catalogWorkflowId: workflowId, catalogWorkflowVersionId: workflowVersionId, action: 'review' })}`;
}

export function workflowEditHash(workflowId: string, workflowVersionId: string): string {
  return `#/workflows?${new URLSearchParams({ catalogWorkflowId: workflowId, catalogWorkflowVersionId: workflowVersionId, action: 'edit' })}`;
}

export function parseHashParameter(hash: string, name: string): string | null {
  const query = hash.split('?')[1];
  return query ? new URLSearchParams(query).get(name) : null;
}

export function surfaceHash(surface: Surface): string {
  return surface === 'home' ? '#/' : `#/${surface}`;
}

export function subscribeToHashChanges(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function readLocationHash(): string {
  return window.location.hash;
}

export function useSurface(): Surface {
  return useSyncExternalStore(subscribeToHashChanges, () => parseSurfaceHash(readLocationHash()));
}

export function useLocationHash(): string {
  return useSyncExternalStore(subscribeToHashChanges, readLocationHash, readLocationHash);
}
