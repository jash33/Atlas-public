import { scalePoint } from 'd3';

import type { DiagramEdge, DiagramModel, DiagramNode } from './diagram-model.js';

export const draftGraphNodeWidth = 228;
export const draftGraphNodeHeight = 156;

const columnGap = 64;
const paddingX = 24;
const paddingTop = 48;
const paddingBottom = 36;

export interface DraftGraphLaidOutNode extends DiagramNode {
  x: number;
  y: number;
}

export interface DraftGraphLaidOutEdge extends DiagramEdge {
  path: string;
  labelX: number;
  labelY: number;
}

export interface DraftGraphLayout {
  width: number;
  height: number;
  nodes: DraftGraphLaidOutNode[];
  edges: DraftGraphLaidOutEdge[];
}

export type DraftGraphPositions = Readonly<Record<string, { x: number; y: number }>>;

type Side = 'left' | 'right' | 'top' | 'bottom';

export function layoutDraftGraph(
  model: DiagramModel,
  positions?: DraftGraphPositions,
): DraftGraphLayout {
  const count = Math.max(model.nodes.length, 1);
  const width = paddingX * 2 + count * draftGraphNodeWidth + Math.max(count - 1, 0) * columnGap;
  const height = paddingTop + draftGraphNodeHeight + paddingBottom;
  const ids = model.nodes.map((node) => node.stepId);
  const x = scalePoint<string>()
    .domain(ids)
    .range([paddingX + draftGraphNodeWidth / 2, width - paddingX - draftGraphNodeWidth / 2]);
  const nodes = model.nodes.map((node) => {
    const placed: DraftGraphLaidOutNode = {
      ...node,
      x: (x(node.stepId) ?? width / 2) - draftGraphNodeWidth / 2,
      y: paddingTop,
    };
    const override = positions?.[node.stepId];
    return override ? { ...placed, x: override.x, y: override.y } : placed;
  });
  const byId = new Map(nodes.map((node) => [node.stepId, node] as const));

  return {
    width,
    height,
    nodes,
    edges: model.edges.map((edge) => layoutEdge(edge, byId, model.edges)),
  };
}

function layoutEdge(
  edge: DiagramEdge,
  byId: ReadonlyMap<string, DraftGraphLaidOutNode>,
  edges: readonly DiagramEdge[],
): DraftGraphLaidOutEdge {
  const from = byId.get(edge.fromStepId);
  const to = byId.get(edge.toStepId);
  if (!from || !to) {
    return { ...edge, path: '', labelX: 0, labelY: 0 };
  }
  const offset = verticalOffset(edge, edges);
  const [fromSide, toSide] = facingSides(from, to);
  const source = sideAnchor(from, fromSide, offset);
  const target = sideAnchor(to, toSide, offset);
  const path = cubicPath(source, target, fromSide, toSide);
  return {
    ...edge,
    path,
    labelX: (source[0] + target[0]) / 2,
    labelY: (source[1] + target[1]) / 2 - 8,
  };
}

function facingSides(from: DraftGraphLaidOutNode, to: DraftGraphLaidOutNode): [Side, Side] {
  const dx = to.x + draftGraphNodeWidth / 2 - (from.x + draftGraphNodeWidth / 2);
  const dy = to.y + draftGraphNodeHeight / 2 - (from.y + draftGraphNodeHeight / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? ['right', 'left'] : ['left', 'right'];
  }
  return dy >= 0 ? ['bottom', 'top'] : ['top', 'bottom'];
}

function sideAnchor(node: DraftGraphLaidOutNode, side: Side, offset: number): [number, number] {
  const centerX = node.x + draftGraphNodeWidth / 2;
  const centerY = node.y + draftGraphNodeHeight / 2;
  if (side === 'right') return [node.x + draftGraphNodeWidth, centerY + offset];
  if (side === 'left') return [node.x, centerY + offset];
  if (side === 'bottom') return [centerX + offset, node.y + draftGraphNodeHeight];
  return [centerX + offset, node.y];
}

function cubicPath(
  source: [number, number],
  target: [number, number],
  fromSide: Side,
  toSide: Side,
): string {
  const distance = Math.hypot(target[0] - source[0], target[1] - source[1]);
  const strength = Math.max(48, distance * 0.4);
  const c1 = offsetPoint(source, fromSide, strength);
  const c2 = offsetPoint(target, toSide, strength);
  return `M${source[0]},${source[1]}C${c1[0]},${c1[1]},${c2[0]},${c2[1]},${target[0]},${target[1]}`;
}

function offsetPoint(point: [number, number], side: Side, distance: number): [number, number] {
  if (side === 'right') return [point[0] + distance, point[1]];
  if (side === 'left') return [point[0] - distance, point[1]];
  if (side === 'bottom') return [point[0], point[1] + distance];
  return [point[0], point[1] - distance];
}

function verticalOffset(edge: DiagramEdge, edges: readonly DiagramEdge[]): number {
  if (edge.kind === 'mapping') {
    const sibling = edges
      .filter(
        (candidate) =>
          candidate.kind === 'mapping' &&
          candidate.fromStepId === edge.fromStepId &&
          candidate.toStepId === edge.toStepId,
      )
      .indexOf(edge);
    return -32 - sibling * 18;
  }
  if (edge.kind === 'compensation' || edge.kind === 'revalidation') return 40;
  return 0;
}
