export interface InspectableDiagramNode {
  stepId?: string;
  kind: string;
  capabilityVersionId: string | null;
}

export interface CapabilityDrawerState {
  capabilityVersionId: string | null;
  restoreFocusStepId: string | null;
  inputMappings?: unknown;
}

export function canInspectDiagramNode(node: InspectableDiagramNode): boolean {
  return node.kind !== 'terminal' && node.capabilityVersionId !== null;
}

export function openCapabilityDrawer(
  node: InspectableDiagramNode,
  inputMappings?: unknown,
): CapabilityDrawerState {
  if (!canInspectDiagramNode(node) || !node.stepId || !node.capabilityVersionId) {
    return { capabilityVersionId: null, restoreFocusStepId: null };
  }
  return {
    capabilityVersionId: node.capabilityVersionId,
    restoreFocusStepId: node.stepId,
    ...(inputMappings !== undefined ? { inputMappings } : {}),
  };
}

export function closeCapabilityDrawer(state: CapabilityDrawerState): CapabilityDrawerState {
  return { capabilityVersionId: null, restoreFocusStepId: state.restoreFocusStepId };
}
