import { parseHashParameter, parseSurfaceHash } from '../shell/router.js';
import type { EnvironmentId } from '../shell/session.js';
import {
  isCapabilityMapLifecycle,
  type CapabilityMapLifecycle,
  type CapabilityMapMode,
} from './capability-map-model.js';

export type CapabilityMapFocusTarget = {
  kind: 'node' | 'relationship';
  id: string;
};

export interface CapabilityMapRouteState {
  impactFocusType: 'change' | 'runtime-mismatch' | null;
  impactFocusId: string | null;
  focusTarget: CapabilityMapFocusTarget | null;
  granularity: CapabilityMapMode;
  lifecycle: CapabilityMapLifecycle;
  search: string;
  showServiceAreas: boolean;
  includeDisconnected: boolean;
}

export const defaultCapabilityMapRouteState: CapabilityMapRouteState = {
  impactFocusType: null,
  impactFocusId: null,
  focusTarget: null,
  granularity: 'full',
  lifecycle: 'all',
  search: '',
  showServiceAreas: false,
  includeDisconnected: false,
};

function parseFocusTarget(value: string | null): CapabilityMapFocusTarget | null {
  if (!value) return null;
  const separator = value.indexOf(':');
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return separator > 0 && id && (kind === 'node' || kind === 'relationship') ? { kind, id } : null;
}

export function capabilityMapRouteStateFromHash(hash: string): CapabilityMapRouteState {
  const focusType = parseHashParameter(hash, 'focusType');
  const focusId = parseHashParameter(hash, 'focusId');
  const lifecycle = parseHashParameter(hash, 'lifecycle');
  const focusTarget = parseFocusTarget(parseHashParameter(hash, 'focusTarget'));
  const requestedGranularity =
    parseHashParameter(hash, 'granularity') === 'grouped' ? 'grouped' : 'full';
  return {
    impactFocusType:
      focusId && (focusType === 'change' || focusType === 'runtime-mismatch') ? focusType : null,
    impactFocusId:
      focusId && (focusType === 'change' || focusType === 'runtime-mismatch') ? focusId : null,
    focusTarget,
    granularity:
      requestedGranularity === 'grouped' &&
      focusTarget?.kind === 'node' &&
      !focusTarget.id.startsWith('service:')
        ? 'full'
        : requestedGranularity,
    lifecycle: isCapabilityMapLifecycle(lifecycle) ? lifecycle : 'all',
    search: parseHashParameter(hash, 'search') ?? '',
    showServiceAreas: parseHashParameter(hash, 'serviceAreas') === 'shown',
    includeDisconnected: parseHashParameter(hash, 'disconnected') === 'shown',
  };
}

export function capabilityMapHash(
  currentHash: string,
  environmentId: EnvironmentId,
  state: CapabilityMapRouteState,
): string {
  const query = currentHash.split('?')[1];
  const parameters = new URLSearchParams(query);
  parameters.set('view', 'map');
  parameters.set('environmentId', environmentId);
  for (const transient of ['panX', 'panY', 'zoom']) parameters.delete(transient);

  const setOptional = (name: string, value: string | null) => {
    if (value) parameters.set(name, value);
    else parameters.delete(name);
  };
  setOptional('focusType', state.impactFocusType);
  setOptional('focusId', state.impactFocusId);
  setOptional(
    'focusTarget',
    state.focusTarget ? `${state.focusTarget.kind}:${state.focusTarget.id}` : null,
  );
  setOptional('granularity', state.granularity === 'grouped' ? 'grouped' : null);
  setOptional('lifecycle', state.lifecycle === 'all' ? null : state.lifecycle);
  setOptional('search', state.search.trim() ? state.search : null);
  setOptional('serviceAreas', state.showServiceAreas ? 'shown' : null);
  setOptional('disconnected', state.includeDisconnected ? 'shown' : null);
  return `#/capabilities?${parameters}`;
}

export function capabilityBlastRadiusHash(
  environmentId: EnvironmentId,
  discoveryId: string,
): string {
  return capabilityMapHash('#/capabilities', environmentId, {
    ...defaultCapabilityMapRouteState,
    impactFocusType: 'change',
    impactFocusId: discoveryId,
  });
}

export function capabilityMapEnvironmentAction(
  previousHash: string,
  currentHash: string,
  environmentId: EnvironmentId,
): { kind: 'use-linked'; environmentId: EnvironmentId } | { kind: 'write-current' } | null {
  if (parseSurfaceHash(currentHash) !== 'capabilities') return null;
  const linkedEnvironment = parseHashParameter(currentHash, 'environmentId');
  if (
    previousHash !== currentHash &&
    (linkedEnvironment === 'development' || linkedEnvironment === 'production') &&
    linkedEnvironment !== environmentId
  ) {
    return { kind: 'use-linked', environmentId: linkedEnvironment };
  }
  return linkedEnvironment === environmentId ? null : { kind: 'write-current' };
}
