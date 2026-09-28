import type { Diagnostic, WorkflowReview } from './workflow.js';

export type DiagramDiagnosticSeverity = 'error' | 'warning';

export interface TargetedDiagnostic extends Diagnostic {
  severity: DiagramDiagnosticSeverity;
}

export interface DiagramDiagnosticTargets {
  nodeMarkers: Record<string, TargetedDiagnostic[]>;
  edgeMarkers: Record<string, TargetedDiagnostic[]>;
  diagramMarkers: TargetedDiagnostic[];
}

const STEP_PATH = /(?:^|\.)steps\[([^\]]+)\]/;
const ARGUMENT_PATH = /\.arguments\.([A-Za-z_][\w]*)$/;

export function diagramEdgeKey(edge: {
  kind: string;
  fromStepId: string;
  toStepId: string;
  label?: string;
  mappingField?: string;
}): string {
  const field = edge.mappingField ?? (edge.kind === 'mapping' ? edge.label : undefined);
  return `${edge.kind}:${edge.fromStepId}:${edge.toStepId}:${field ?? ''}`;
}

export function targetDiagramDiagnostics(
  diagnostics: readonly Diagnostic[],
  graph: WorkflowReview['graph'],
): DiagramDiagnosticTargets {
  const stepIds = new Set(graph.nodes.map((node) => node.stepId));
  const nodeMarkers: Record<string, TargetedDiagnostic[]> = {};
  const edgeMarkers: Record<string, TargetedDiagnostic[]> = {};
  const diagramMarkers: TargetedDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    // Checks that have not run are an approval requirement, not a graph error.
    if (diagnostic.code === 'SANDBOX_TESTS_MISSING') continue;
    const targeted = withSeverity(diagnostic);
    const stepId = namedStepTarget(diagnostic.path, stepIds);
    const argument = ARGUMENT_PATH.exec(diagnostic.path)?.[1];
    const mappingEdge =
      stepId && argument
        ? graph.edges.find(
            (edge) =>
              edge.kind === 'mapping' && edge.toStepId === stepId && edge.label === argument,
          )
        : undefined;
    if (mappingEdge) {
      const key = diagramEdgeKey(mappingEdge);
      edgeMarkers[key] = [...(edgeMarkers[key] ?? []), targeted];
      continue;
    }
    if (stepId) {
      nodeMarkers[stepId] = [...(nodeMarkers[stepId] ?? []), targeted];
      continue;
    }
    diagramMarkers.push(targeted);
  }

  return { nodeMarkers, edgeMarkers, diagramMarkers };
}

function namedStepTarget(path: string, stepIds: ReadonlySet<string>): string | undefined {
  const match = STEP_PATH.exec(path);
  if (!match) return undefined;
  const stepId = match[1];
  return stepId && stepIds.has(stepId) ? stepId : undefined;
}

function withSeverity(diagnostic: Diagnostic): TargetedDiagnostic {
  return {
    ...diagnostic,
    severity: diagnostic.kind === 'warning' ? 'warning' : 'error',
  };
}
