import type { CapabilityArchitecture } from '@atlas/workflow-ir';

import type { GraphView } from '../graph/graph-interactions.js';

export const architectureNodeWidth = 180;
export const architectureNodeHeight = 64;
export const architectureViewport = { width: 1400, height: 640 } as const;
const columnGap = 48;
const rowGap = 120;
const padding = 36;

export type ArchitectureRecipeFilter = 'all' | string;

export interface ArchitectureGraphNode {
  id: string;
  operationId: string;
  workflowId: string;
  workflowName: string;
  x: number;
  y: number;
}

export interface ArchitectureGraphRelationship {
  id: string;
  kind: 'data-flow' | 'execution-order';
  sourceNodeId: string;
  targetNodeId: string;
  destinationField?: string;
  path: string;
}

export interface ArchitectureGraphLayout {
  width: number;
  height: number;
  nodes: ArchitectureGraphNode[];
  relationships: ArchitectureGraphRelationship[];
}

function operationsInOrder(architecture: CapabilityArchitecture, workflowId: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (operationId: string) => {
    if (seen.has(operationId)) return;
    seen.add(operationId);
    ordered.push(operationId);
  };
  for (const relationship of architecture.relationships) {
    if (relationship.workflowId !== workflowId || relationship.kind !== 'execution-order') continue;
    add(relationship.sourceOperationId);
    add(relationship.targetOperationId);
  }
  for (const relationship of architecture.relationships) {
    if (relationship.workflowId !== workflowId) continue;
    add(relationship.sourceOperationId);
    add(relationship.targetOperationId);
  }
  return ordered;
}

function edgePath(source: ArchitectureGraphNode, target: ArchitectureGraphNode): string {
  const startX = source.x + architectureNodeWidth;
  const startY = source.y + architectureNodeHeight / 2;
  const endX = target.x;
  const endY = target.y + architectureNodeHeight / 2;
  const midX = (startX + endX) / 2;
  return `M ${startX} ${startY} C ${midX} ${startY} ${midX} ${endY} ${endX} ${endY}`;
}

export function layoutCapabilityArchitecture(
  architecture: CapabilityArchitecture,
  recipe: ArchitectureRecipeFilter,
): ArchitectureGraphLayout {
  const workflows =
    recipe === 'all'
      ? architecture.workflows
      : architecture.workflows.filter((workflow) => workflow.workflowId === recipe);
  const nodes: ArchitectureGraphNode[] = [];
  const nodeByKey = new Map<string, ArchitectureGraphNode>();
  workflows.forEach((workflow, row) => {
    operationsInOrder(architecture, workflow.workflowId).forEach((operationId, column) => {
      const node: ArchitectureGraphNode = {
        id: `${workflow.workflowId}:${operationId}`,
        operationId,
        workflowId: workflow.workflowId,
        workflowName: workflow.summary,
        x: padding + column * (architectureNodeWidth + columnGap),
        y: padding + row * (architectureNodeHeight + rowGap),
      };
      nodes.push(node);
      nodeByKey.set(node.id, node);
    });
  });
  const relationships: ArchitectureGraphRelationship[] = architecture.relationships.flatMap(
    (relationship) => {
      if (recipe !== 'all' && relationship.workflowId !== recipe) return [];
      const source = nodeByKey.get(`${relationship.workflowId}:${relationship.sourceOperationId}`);
      const target = nodeByKey.get(`${relationship.workflowId}:${relationship.targetOperationId}`);
      if (!source || !target) return [];
      return [
        {
          id: relationship.id,
          kind: relationship.kind,
          sourceNodeId: source.id,
          targetNodeId: target.id,
          ...(relationship.destinationField
            ? { destinationField: relationship.destinationField }
            : {}),
          path: edgePath(source, target),
        },
      ];
    },
  );
  const width =
    Math.max(640, ...nodes.map((node) => node.x + architectureNodeWidth + padding), padding * 2) ||
    640;
  const height =
    Math.max(280, ...nodes.map((node) => node.y + architectureNodeHeight + padding), padding * 2) ||
    280;
  return { width, height, nodes, relationships };
}

export function architectureFitView(mapSize: { width: number; height: number }): GraphView {
  const zoom = Math.min(
    1,
    architectureViewport.width / mapSize.width,
    architectureViewport.height / mapSize.height,
  );
  return {
    zoom,
    x: (architectureViewport.width - mapSize.width * zoom) / 2,
    y: (architectureViewport.height - mapSize.height * zoom) / 2,
  };
}

export function architecturePointFromScreen(
  bounds: { left: number; top: number; width: number; height: number },
  screenPoint: { x: number; y: number },
) {
  const scale = Math.min(
    bounds.width / architectureViewport.width,
    bounds.height / architectureViewport.height,
  );
  if (!Number.isFinite(scale) || scale <= 0) return { x: 0, y: 0 };
  const leftSpace = (bounds.width - architectureViewport.width * scale) / 2;
  const topSpace = (bounds.height - architectureViewport.height * scale) / 2;
  return {
    x: (screenPoint.x - bounds.left - leftSpace) / scale,
    y: (screenPoint.y - bounds.top - topSpace) / scale,
  };
}
