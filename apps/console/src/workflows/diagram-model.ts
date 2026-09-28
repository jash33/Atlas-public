import {
  versionedExecutableWorkflowSchema,
  buildWorkflowGraph,
  isCapabilityStep,
} from '@atlas/workflow-ir';

import type { VerifiedCapabilityIdentity } from './validated-request.js';
import {
  graphEdgeLabel,
  type RetryPolicy,
  type WorkflowGraphEdge,
  type WorkflowReview,
} from './workflow.js';

export type DiagramConstraint = 'order' | 'data';

export interface DiagramNode {
  stepId: string;
  name: string;
  apiAction: string | null;
  credential: string | null;
  kind: string;
  irreversible: boolean;
  retryPolicy: RetryPolicy | null;
  terminalState: string | null;
  capabilityVersionId: string | null;
  interactive: boolean;
  constrainedBy: DiagramConstraint[];
}

export interface DiagramEdge {
  fromStepId: string;
  toStepId: string;
  kind: WorkflowGraphEdge['kind'];
  label: string;
  mappingField?: string;
  origin?: 'requested' | 'inferred';
  maxRevalidations?: number;
}

export interface MappingOriginBinding {
  stepId: string;
  destinationPath: readonly string[];
  origin: 'requested' | 'inferred';
}

export interface DiagramModel {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  independentStepIds: string[];
}

type ReviewGraph = WorkflowReview['graph'];
type ReviewStep = Pick<WorkflowReview['steps'][number], 'stepId' | 'capabilityVersionId'> &
  Partial<Pick<WorkflowReview['steps'][number], 'secretReference' | 'httpCall' | 'capabilityId'>>;

export function humanStepName(stepId: string): string {
  const spaced = stepId
    .replaceAll(/([a-z\d])([A-Z])/g, '$1 $2')
    .replaceAll(/[-_]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!spaced) return stepId;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function diagramFromReviewGraph(
  graph: ReviewGraph,
  steps: readonly ReviewStep[] = [],
  identities: readonly VerifiedCapabilityIdentity[] = [],
  mappingOrigins: readonly MappingOriginBinding[] = [],
): DiagramModel {
  const stepById = new Map(steps.map((step) => [step.stepId, step]));
  const constrained = new Map<string, Set<DiagramConstraint>>();
  const connected = new Set<string>();
  const inputSourced = inputSourcedMappingEdges(graph.edges, mappingOrigins);
  for (const edge of [...graph.edges, ...inputSourced]) {
    if (edge.kind !== 'next' && edge.kind !== 'mapping') continue;
    const constraint: DiagramConstraint = edge.kind === 'mapping' ? 'data' : 'order';
    addConstraint(constrained, edge.toStepId, constraint);
    connected.add(edge.fromStepId);
    connected.add(edge.toStepId);
  }
  const nodes = graph.nodes.map((node) => {
    const step = stepById.get(node.stepId);
    const capabilityVersionId =
      node.kind === 'terminal' ? null : (step?.capabilityVersionId ?? null);
    const labels = stepPresentation(node, step, identities, capabilityVersionId);
    return {
      stepId: node.stepId,
      name: labels.name,
      apiAction: labels.apiAction,
      credential: labels.credential,
      kind: node.kind,
      irreversible: node.irreversible,
      retryPolicy: node.retryPolicy,
      terminalState: node.terminalState,
      capabilityVersionId,
      interactive: capabilityVersionId !== null,
      constrainedBy: [...(constrained.get(node.stepId) ?? [])],
    };
  });
  return {
    nodes: inputSourced.length > 0 ? [runtimeInputNode(), ...nodes] : nodes,
    edges: [...graph.edges, ...inputSourced].map((edge) => ({
      fromStepId: edge.fromStepId,
      toStepId: edge.toStepId,
      kind: edge.kind,
      label: graphEdgeLabel(edge),
      ...(edge.kind === 'mapping' && edge.label ? { mappingField: edge.label } : {}),
      ...(edge.origin ? { origin: edge.origin } : {}),
      ...(edge.kind === 'revalidation' && edge.maxRevalidations
        ? { maxRevalidations: edge.maxRevalidations }
        : {}),
    })),
    independentStepIds: graph.nodes
      .filter((node) => node.kind !== 'terminal' && !connected.has(node.stepId))
      .map((node) => node.stepId),
  };
}

export function diagramFromExecutable(
  executable: unknown,
  identities: readonly VerifiedCapabilityIdentity[] = [],
  steps: readonly ReviewStep[] = [],
  mappingOrigins: readonly MappingOriginBinding[] = [],
): DiagramModel {
  const parsed = versionedExecutableWorkflowSchema.safeParse(executable);
  if (!parsed.success) {
    throw new TypeError('Executable cannot form a workflow graph');
  }
  const graph = buildWorkflowGraph({ executable: parsed.data, mappingOrigins });
  const fromExecutable = parsed.data.steps.flatMap((step) =>
    !isCapabilityStep(step)
      ? []
      : [{ stepId: step.id, capabilityVersionId: step.capabilityVersionId }],
  );
  const byStepId = new Map(steps.map((step) => [step.stepId, step]));
  return diagramFromReviewGraph(
    graph,
    fromExecutable.map((step) => ({
      ...step,
      ...(byStepId.get(step.stepId) ?? {}),
      capabilityVersionId: step.capabilityVersionId,
    })),
    identities,
    mappingOrigins,
  );
}

const runtimeInputStepId = 'runtime-input';

function runtimeInputNode(): DiagramNode {
  return {
    stepId: runtimeInputStepId,
    name: 'Runtime input',
    apiAction: null,
    credential: null,
    kind: 'input',
    irreversible: false,
    retryPolicy: null,
    terminalState: null,
    capabilityVersionId: null,
    interactive: false,
    constrainedBy: [],
  };
}

function mappingFieldFromPath(destinationPath: readonly string[]): string {
  return destinationPath.join('.');
}

function inputSourcedMappingEdges(
  edges: ReviewGraph['edges'],
  mappingOrigins: readonly MappingOriginBinding[],
): WorkflowGraphEdge[] {
  const mapped = new Set(
    edges
      .filter((edge) => edge.kind === 'mapping' && edge.label)
      .map((edge) => `${edge.toStepId}:${edge.label}`),
  );
  return mappingOrigins.flatMap((binding) => {
    const field = mappingFieldFromPath(binding.destinationPath);
    if (!field || mapped.has(`${binding.stepId}:${field}`)) return [];
    return [
      {
        fromStepId: runtimeInputStepId,
        toStepId: binding.stepId,
        kind: 'mapping' as const,
        label: field,
        origin: binding.origin,
      },
    ];
  });
}

function stepPresentation(
  node: { stepId: string; kind: string },
  step: ReviewStep | undefined,
  identities: readonly VerifiedCapabilityIdentity[],
  capabilityVersionId: string | null,
): { name: string; apiAction: string | null; credential: string | null } {
  if (node.kind === 'terminal') {
    return { name: humanStepName(node.stepId), apiAction: null, credential: null };
  }
  const identity =
    (capabilityVersionId &&
      identities.find((candidate) => candidate.capabilityVersionId === capabilityVersionId)) ??
    identityFromCapabilityId(step?.capabilityId);
  return {
    name: humanStepName(node.stepId),
    apiAction: identity
      ? `${identity.serviceId} · ${identity.operationId}`
      : step?.httpCall
        ? `${step.httpCall.method} ${step.httpCall.path}`
        : null,
    credential: step?.secretReference?.trim() ? step.secretReference : null,
  };
}

function identityFromCapabilityId(
  capabilityId: ReviewStep['capabilityId'],
): { serviceId: string; operationId: string } | undefined {
  if (!capabilityId || typeof capabilityId !== 'object') return undefined;
  const serviceId = capabilityId.serviceId;
  const operationId = capabilityId.operationId;
  if (typeof serviceId !== 'string' || typeof operationId !== 'string') return undefined;
  return { serviceId, operationId };
}

function addConstraint(
  constrained: Map<string, Set<DiagramConstraint>>,
  stepId: string,
  constraint: DiagramConstraint,
) {
  const current = constrained.get(stepId) ?? new Set();
  current.add(constraint);
  constrained.set(stepId, current);
}
