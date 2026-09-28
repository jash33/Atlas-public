import { capabilityOverviewWorkflowLifecycleSchema } from '@atlas/workflow-ir';

import type {
  CapabilityOverview,
  CapabilityOverviewNode,
  CapabilityOverviewRelationship,
} from './data.js';

export const capabilityMapNodeWidth = 190;
export const capabilityMapNodeHeight = 76;

const canvasPadding = 42;
const branchColumnGap = 52;
const branchRowGap = 86;
const componentGap = 104;
const rootBandGap = 120;
const maximumRootBands = 3;
const entriesPerRootBand = 18;
const serviceAreaPadding = 18;
const serviceAreaHeader = 28;
const unclearServiceNames = new Set(['', 'default', 'unknown', 'uncategorized', 'unassigned']);

export type CapabilityMapMode = 'full' | 'grouped';
export type CapabilityMapLifecycle =
  | 'all'
  | CapabilityOverviewRelationship['evidence']['workflowLifecycle'];

export function isCapabilityMapLifecycle(value: string | null): value is CapabilityMapLifecycle {
  return value === 'all' || capabilityOverviewWorkflowLifecycleSchema.safeParse(value).success;
}

export function capabilityIdentityIdForVersion(
  overview: CapabilityOverview,
  capabilityVersionId: string,
): string | null {
  const current = overview.nodes.find((node) => node.capabilityVersionId === capabilityVersionId);
  if (current) return current.capabilityIdentityId;
  const source = overview.impact?.sources.find(
    (candidate) => candidate.capabilityVersionId === capabilityVersionId,
  );
  if (source) return source.capabilityIdentityId;
  const affected = overview.nodes.find((node) =>
    node.impact?.usages.some((usage) => usage.capabilityVersionId === capabilityVersionId),
  );
  if (affected) return affected.capabilityIdentityId;
  const relationship = overview.relationships.find(
    (candidate) =>
      candidate.evidence.sourceCapabilityVersionId === capabilityVersionId ||
      candidate.evidence.targetCapabilityVersionId === capabilityVersionId,
  );
  if (!relationship) return null;
  return relationship.evidence.sourceCapabilityVersionId === capabilityVersionId
    ? relationship.sourceCapabilityIdentityId
    : relationship.targetCapabilityIdentityId;
}

export interface CapabilityMapNode {
  id: string;
  kind: 'capability' | 'service';
  label: string;
  serviceId: string;
  operationId?: string;
  capabilityIdentityIds: string[];
  capability?: CapabilityOverviewNode;
  impact?: CapabilityOverviewNode['impact'];
  affectedWorkflowCount?: number;
}

export interface CapabilityMapRelationship {
  id: string;
  kind: CapabilityOverviewRelationship['kind'];
  sourceNodeId: string;
  targetNodeId: string;
  relationshipIds: string[];
  evidence: CapabilityOverviewRelationship['evidence'][];
  affectedWorkflowVersionIds: string[];
  affected: boolean;
}

export interface CapabilityMapView {
  snapshotId: string;
  mode: CapabilityMapMode;
  groupedServiceCount: number;
  nodes: CapabilityMapNode[];
  relationships: CapabilityMapRelationship[];
}

export interface CapabilityMapEmphasis {
  nodeIds: ReadonlySet<string>;
  relationshipIds: ReadonlySet<string>;
}

export interface CapabilityMapPositionedNode extends CapabilityMapNode {
  x: number;
  y: number;
}

export interface CapabilityMapPositionedRelationship extends CapabilityMapRelationship {
  path: string;
  labelX: number;
  labelY: number;
}

export function filterCapabilityMapOverview(
  overview: CapabilityOverview,
  lifecycle: CapabilityMapLifecycle,
): CapabilityOverview {
  if (lifecycle === 'all') return overview;
  const recovered =
    overview.impact?.type === 'runtime-mismatch' && overview.impact.state === 'recovered';
  const nodes = overview.nodes.map((node) => {
    if (!node.impact) return node;
    const usages = node.impact.usages.filter((usage) => usage.workflowLifecycle === lifecycle);
    return {
      ...node,
      impact: {
        ...node.impact,
        affected: !recovered && usages.length > 0,
        affectedWorkflowCount: new Set(usages.map((usage) => usage.workflowVersionId)).size,
        usages,
      },
    };
  });
  const affectedUsages = nodes.flatMap((node) => node.impact?.usages ?? []);
  const currentlyExposedUsages = affectedUsages.filter(
    (usage) => usage.currentState?.isActive ?? usage.workflowLifecycle === 'active',
  );
  return {
    ...overview,
    nodes,
    relationships: overview.relationships.filter(
      (relationship) => relationship.evidence.workflowLifecycle === lifecycle,
    ),
    ...(overview.impact
      ? {
          impact: {
            ...overview.impact,
            affectedWorkflowCount: new Set(affectedUsages.map((usage) => usage.workflowVersionId))
              .size,
            affectedStepCount: affectedUsages.length,
            currentlyExposedWorkflowCount: new Set(
              currentlyExposedUsages.map((usage) => usage.workflowVersionId),
            ).size,
            currentlyExposedStepCount: currentlyExposedUsages.length,
          },
        }
      : {}),
  };
}

export function filterCapabilityMapVisibility(
  overview: CapabilityOverview,
  lifecycle: CapabilityMapLifecycle,
  includeDisconnected: boolean,
): CapabilityOverview {
  if (includeDisconnected) return overview;
  const visibleCapabilityIds = new Set(
    overview.relationships.flatMap((relationship) => [
      relationship.sourceCapabilityIdentityId,
      relationship.targetCapabilityIdentityId,
    ]),
  );
  for (const node of overview.nodes) {
    const usedByWorkflow =
      node.workflowLifecycles?.some(
        (workflowLifecycle) => lifecycle === 'all' || workflowLifecycle === lifecycle,
      ) ||
      node.impact?.usages.some(
        (usage) => lifecycle === 'all' || usage.workflowLifecycle === lifecycle,
      );
    if (usedByWorkflow) {
      visibleCapabilityIds.add(node.capabilityIdentityId);
    }
  }
  const nodes = overview.nodes.filter((node) =>
    visibleCapabilityIds.has(node.capabilityIdentityId),
  );
  return {
    ...overview,
    nodes,
    services: overview.services.flatMap((service) => {
      const capabilityIdentityIds = service.capabilityIdentityIds.filter((id) =>
        visibleCapabilityIds.has(id),
      );
      return capabilityIdentityIds.length > 0 ? [{ ...service, capabilityIdentityIds }] : [];
    }),
  };
}

function usefulService(serviceId: string, memberCount: number, totalCount: number): boolean {
  return (
    memberCount > 1 &&
    memberCount < totalCount &&
    !unclearServiceNames.has(serviceId.trim().toLowerCase())
  );
}

function orderedCapabilities(overview: CapabilityOverview): CapabilityOverviewNode[] {
  const nodesById = new Map(overview.nodes.map((node) => [node.capabilityIdentityId, node]));
  const orderedIds = overview.services.flatMap((service) => service.capabilityIdentityIds);
  const seen = new Set<string>();
  return [...orderedIds, ...overview.nodes.map((node) => node.capabilityIdentityId)].flatMap(
    (id) => {
      const node = nodesById.get(id);
      if (!node || seen.has(id)) return [];
      seen.add(id);
      return [node];
    },
  );
}

function serviceIdsToGroup(overview: CapabilityOverview): ReadonlySet<string> {
  const knownNodeIds = new Set(overview.nodes.map((node) => node.capabilityIdentityId));
  return new Set(
    overview.services.flatMap((service) => {
      const memberCount = new Set(
        service.capabilityIdentityIds.filter((id) => knownNodeIds.has(id)),
      ).size;
      return usefulService(service.serviceId, memberCount, overview.nodes.length)
        ? [service.serviceId]
        : [];
    }),
  );
}

export function buildCapabilityMapView(
  overview: CapabilityOverview,
  mode: CapabilityMapMode,
): CapabilityMapView {
  const ordered = orderedCapabilities(overview);
  const groupedServiceIds = mode === 'grouped' ? serviceIdsToGroup(overview) : new Set<string>();
  const visibleNodeIdByCapability = new Map<string, string>();
  const nodes: CapabilityMapNode[] = [];
  const addedNodeIds = new Set<string>();

  for (const capability of ordered) {
    const isServiceGroup = groupedServiceIds.has(capability.serviceId);
    const id = isServiceGroup ? `service:${capability.serviceId}` : capability.capabilityIdentityId;
    visibleNodeIdByCapability.set(capability.capabilityIdentityId, id);
    if (addedNodeIds.has(id)) continue;
    addedNodeIds.add(id);

    if (isServiceGroup) {
      const members = ordered.filter((node) => node.serviceId === capability.serviceId);
      const usages = members.flatMap((member) => member.impact?.usages ?? []);
      const isSource = members.some((member) => member.impact?.isSource);
      const affected = members.some((member) => member.impact?.affected);
      const impact =
        usages.length > 0 || isSource
          ? {
              affected,
              isSource,
              affectedWorkflowCount: new Set(usages.map((usage) => usage.workflowVersionId)).size,
              usages,
            }
          : undefined;
      nodes.push({
        id,
        kind: 'service',
        label: capability.serviceId,
        serviceId: capability.serviceId,
        capabilityIdentityIds: members.map((node) => node.capabilityIdentityId),
        ...(impact ? { impact, affectedWorkflowCount: impact.affectedWorkflowCount } : {}),
      });
      continue;
    }

    nodes.push({
      id,
      kind: 'capability',
      label: capability.operationId,
      serviceId: capability.serviceId,
      operationId: capability.operationId,
      capabilityIdentityIds: [capability.capabilityIdentityId],
      capability,
      ...(capability.impact
        ? {
            impact: capability.impact,
            affectedWorkflowCount: capability.impact.affectedWorkflowCount,
          }
        : {}),
    });
  }

  const relationshipsByGroup = new Map<string, CapabilityMapRelationship>();
  for (const relationship of overview.relationships) {
    const sourceNodeId = visibleNodeIdByCapability.get(relationship.sourceCapabilityIdentityId);
    const targetNodeId = visibleNodeIdByCapability.get(relationship.targetCapabilityIdentityId);
    if (!sourceNodeId || !targetNodeId) continue;
    const key = `${relationship.kind}\u0000${sourceNodeId}\u0000${targetNodeId}`;
    const existing = relationshipsByGroup.get(key);
    if (existing) {
      existing.relationshipIds.push(relationship.id);
      existing.evidence.push(relationship.evidence);
      existing.affectedWorkflowVersionIds = [
        ...new Set([
          ...existing.affectedWorkflowVersionIds,
          ...(relationship.impact?.workflowVersionIds ?? []),
        ]),
      ];
      existing.affected = existing.affectedWorkflowVersionIds.length > 0;
      continue;
    }
    relationshipsByGroup.set(key, {
      id:
        mode === 'full'
          ? relationship.id
          : `grouped:${relationship.kind}:${sourceNodeId}:${targetNodeId}`,
      kind: relationship.kind,
      sourceNodeId,
      targetNodeId,
      relationshipIds: [relationship.id],
      evidence: [relationship.evidence],
      affectedWorkflowVersionIds: relationship.impact?.workflowVersionIds ?? [],
      affected: relationship.impact?.affected === true,
    });
  }

  const relationships = [...relationshipsByGroup.values()];

  return {
    snapshotId: overview.snapshotId,
    mode,
    groupedServiceCount: groupedServiceIds.size,
    nodes,
    relationships,
  };
}

export function capabilityMapPointFromScreen(
  mapSize: { width: number; height: number },
  bounds: { left: number; top: number; width: number; height: number },
  screenPoint: { x: number; y: number },
) {
  const scale = Math.min(bounds.width / mapSize.width, bounds.height / mapSize.height);
  if (!Number.isFinite(scale) || scale <= 0) return { x: 0, y: 0 };
  const leftSpace = (bounds.width - mapSize.width * scale) / 2;
  const topSpace = (bounds.height - mapSize.height * scale) / 2;
  return {
    x: (screenPoint.x - bounds.left - leftSpace) / scale,
    y: (screenPoint.y - bounds.top - topSpace) / scale,
  };
}

export function findCapabilityMapItems(
  view: CapabilityMapView,
  query: string,
): CapabilityMapEmphasis {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return {
      nodeIds: new Set(view.nodes.map((node) => node.id)),
      relationshipIds: new Set(view.relationships.map((relationship) => relationship.id)),
    };
  }

  const nodeIds = new Set(
    view.nodes
      .filter((node) =>
        [node.label, node.serviceId, node.operationId, ...node.capabilityIdentityIds]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(needle)),
      )
      .map((node) => node.id),
  );
  const relationshipIds = new Set<string>();
  for (const relationship of view.relationships) {
    const matches = relationship.evidence.some((evidence) =>
      [
        evidence.workflowId,
        evidence.workflowName,
        evidence.workflowVersionId,
        evidence.sourceStepId,
        evidence.targetStepId,
        evidence.sourceCapabilityVersionId,
        evidence.targetCapabilityVersionId,
        evidence.destinationField,
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(needle)),
    );
    if (!matches) continue;
    relationshipIds.add(relationship.id);
    nodeIds.add(relationship.sourceNodeId);
    nodeIds.add(relationship.targetNodeId);
  }
  return { nodeIds, relationshipIds };
}

export function connectedCapabilityIds(overview: CapabilityOverview): ReadonlySet<string> {
  return new Set(
    overview.relationships.flatMap((relationship) => [
      relationship.sourceCapabilityIdentityId,
      relationship.targetCapabilityIdentityId,
    ]),
  );
}

export function relatedCapabilityMapItems(
  view: CapabilityMapView,
  selectedNodeId: string | null,
): CapabilityMapEmphasis {
  if (!selectedNodeId) return findCapabilityMapItems(view, '');
  const nodeIds = new Set([selectedNodeId]);
  const relationshipIds = new Set<string>();
  for (const relationship of view.relationships) {
    if (
      relationship.sourceNodeId !== selectedNodeId &&
      relationship.targetNodeId !== selectedNodeId
    ) {
      continue;
    }
    relationshipIds.add(relationship.id);
    nodeIds.add(relationship.sourceNodeId);
    nodeIds.add(relationship.targetNodeId);
  }
  return { nodeIds, relationshipIds };
}

function partitionCapabilityMap(view: CapabilityMapView) {
  const nodeOrder = new Map(view.nodes.map((node, index) => [node.id, index]));
  const neighbors = new Map(view.nodes.map((node) => [node.id, new Set<string>()]));
  for (const relationship of view.relationships) {
    if (!neighbors.has(relationship.sourceNodeId) || !neighbors.has(relationship.targetNodeId)) {
      continue;
    }
    neighbors.get(relationship.sourceNodeId)!.add(relationship.targetNodeId);
    neighbors.get(relationship.targetNodeId)!.add(relationship.sourceNodeId);
  }

  const isolated = view.nodes.filter((node) => neighbors.get(node.id)!.size === 0);
  const visited = new Set<string>();
  const components = view.nodes.flatMap((node) => {
    if (neighbors.get(node.id)!.size === 0 || visited.has(node.id)) return [];
    const ids: string[] = [];
    const queue = [node.id];
    visited.add(node.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      ids.push(current);
      const adjacent = [...neighbors.get(current)!].sort(
        (left, right) => nodeOrder.get(left)! - nodeOrder.get(right)!,
      );
      for (const candidate of adjacent) {
        if (visited.has(candidate)) continue;
        visited.add(candidate);
        queue.push(candidate);
      }
    }
    return [ids];
  });
  return { isolated, components, nodeOrder };
}

function componentLayers(
  component: readonly string[],
  relationships: readonly CapabilityMapRelationship[],
  nodeOrder: ReadonlyMap<string, number>,
) {
  const componentIds = new Set(component);
  const outgoing = new Map(component.map((id) => [id, new Set<string>()]));
  const indegrees = new Map(component.map((id) => [id, 0]));
  for (const relationship of relationships) {
    if (
      !componentIds.has(relationship.sourceNodeId) ||
      !componentIds.has(relationship.targetNodeId) ||
      relationship.sourceNodeId === relationship.targetNodeId ||
      outgoing.get(relationship.sourceNodeId)!.has(relationship.targetNodeId)
    ) {
      continue;
    }
    outgoing.get(relationship.sourceNodeId)!.add(relationship.targetNodeId);
    indegrees.set(relationship.targetNodeId, indegrees.get(relationship.targetNodeId)! + 1);
  }

  const ranks = new Map<string, number>();
  const queue = component.filter((id) => indegrees.get(id) === 0);
  for (const id of queue) ranks.set(id, 0);
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const target of outgoing.get(source)!) {
      ranks.set(target, Math.max(ranks.get(target) ?? 0, ranks.get(source)! + 1));
      indegrees.set(target, indegrees.get(target)! - 1);
      if (indegrees.get(target) === 0) queue.push(target);
    }
  }

  for (const seed of component) {
    if (ranks.has(seed)) continue;
    ranks.set(seed, 0);
    const cycleQueue = [seed];
    while (cycleQueue.length > 0) {
      const source = cycleQueue.shift()!;
      for (const target of outgoing.get(source)!) {
        if (ranks.has(target)) continue;
        ranks.set(target, ranks.get(source)! + 1);
        cycleQueue.push(target);
      }
    }
  }

  const layers = new Map<number, string[]>();
  for (const id of component) {
    const rank = ranks.get(id)!;
    const layer = layers.get(rank) ?? [];
    layer.push(id);
    layers.set(rank, layer);
  }
  return [...layers.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, ids]) => ids.sort((left, right) => nodeOrder.get(left)! - nodeOrder.get(right)!));
}

function positionCapabilityMapNodes(view: CapabilityMapView) {
  const { isolated, components, nodeOrder } = partitionCapabilityMap(view);
  const positions = new Map<string, { x: number; y: number }>();
  const entries = [
    ...components.map((ids) => ({ ids, order: Math.min(...ids.map((id) => nodeOrder.get(id)!)) })),
    ...isolated.map((node) => ({ ids: [node.id], order: nodeOrder.get(node.id)! })),
  ]
    .sort((left, right) => left.order - right.order)
    .map(({ ids }) => {
      const layers = componentLayers(ids, view.relationships, nodeOrder);
      const widestLayer = Math.max(...layers.map((layer) => layer.length));
      return {
        layers,
        width: widestLayer * capabilityMapNodeWidth + (widestLayer - 1) * branchColumnGap,
        height: layers.length * capabilityMapNodeHeight + (layers.length - 1) * branchRowGap,
      };
    });
  const rootBandCount = Math.min(
    maximumRootBands,
    Math.max(1, Math.ceil(entries.length / entriesPerRootBand)),
  );
  const totalWidth = entries.reduce((sum, entry) => sum + entry.width + componentGap, 0);
  const targetBandWidth = totalWidth / rootBandCount;
  const bands: (typeof entries)[] = [[]];
  let currentBandWidth = 0;
  for (const entry of entries) {
    const canStartNextBand = bands.length < rootBandCount && bands.at(-1)!.length > 0;
    if (canStartNextBand && currentBandWidth + entry.width > targetBandWidth) {
      bands.push([]);
      currentBandWidth = 0;
    }
    bands.at(-1)!.push(entry);
    currentBandWidth += entry.width + componentGap;
  }

  let bandY = canvasPadding;
  for (const band of bands) {
    let componentX = canvasPadding;
    let bandHeight = capabilityMapNodeHeight;
    for (const { layers, width: componentWidth, height: componentHeight } of band) {
      bandHeight = Math.max(bandHeight, componentHeight);
      layers.forEach((layer, layerIndex) => {
        const layerWidth =
          layer.length * capabilityMapNodeWidth + (layer.length - 1) * branchColumnGap;
        const layerOffset = (componentWidth - layerWidth) / 2;
        layer.forEach((id, nodeIndex) => {
          positions.set(id, {
            x: componentX + layerOffset + nodeIndex * (capabilityMapNodeWidth + branchColumnGap),
            y: bandY + layerIndex * (capabilityMapNodeHeight + branchRowGap),
          });
        });
      });
      componentX += componentWidth + componentGap;
    }
    bandY += bandHeight + rootBandGap;
  }

  return view.nodes.map((node) => ({ ...node, ...positions.get(node.id)! }));
}

export function layoutCapabilityMap(view: CapabilityMapView, showServiceAreas: boolean) {
  const positionedNodes = positionCapabilityMapNodes(view);
  const positionedById = new Map(positionedNodes.map((node) => [node.id, node]));
  const relationships = view.relationships.flatMap((relationship) => {
    const source = positionedById.get(relationship.sourceNodeId);
    const target = positionedById.get(relationship.targetNodeId);
    if (!source || !target) return [];
    const flowsDown = target.y > source.y;
    const flowsUp = target.y < source.y;
    const flowsRight = target.x > source.x;
    const sourceX =
      flowsDown || flowsUp
        ? source.x + capabilityMapNodeWidth / 2
        : flowsRight
          ? source.x + capabilityMapNodeWidth
          : source.x;
    const targetX =
      flowsDown || flowsUp
        ? target.x + capabilityMapNodeWidth / 2
        : flowsRight
          ? target.x
          : target.x + capabilityMapNodeWidth;
    const sourceY = flowsDown
      ? source.y + capabilityMapNodeHeight
      : flowsUp
        ? source.y
        : source.y + capabilityMapNodeHeight / 2;
    const targetY = flowsDown
      ? target.y
      : flowsUp
        ? target.y + capabilityMapNodeHeight
        : target.y + capabilityMapNodeHeight / 2;
    const isSelfRelationship = relationship.sourceNodeId === relationship.targetNodeId;
    const selfX = source.x + capabilityMapNodeWidth;
    const selfY = source.y + capabilityMapNodeHeight / 2;
    const selfPath = `M ${selfX - 8} ${selfY} C ${selfX + 70} ${selfY - 70}, ${selfX + 70} ${selfY + 70}, ${selfX - 8} ${selfY + 8}`;
    const middleY = (sourceY + targetY) / 2;
    const sideX = Math.max(source.x, target.x) + capabilityMapNodeWidth + branchColumnGap / 2;
    const connectedPath = flowsDown
      ? `M ${sourceX} ${sourceY} C ${sourceX} ${middleY}, ${targetX} ${middleY}, ${targetX} ${targetY}`
      : flowsUp
        ? `M ${sourceX} ${sourceY} C ${sideX} ${sourceY}, ${sideX} ${targetY}, ${targetX} ${targetY}`
        : `M ${sourceX} ${sourceY} C ${(sourceX + targetX) / 2} ${sourceY}, ${(sourceX + targetX) / 2} ${targetY}, ${targetX} ${targetY}`;
    return [
      {
        ...relationship,
        path: isSelfRelationship ? selfPath : connectedPath,
        labelX: isSelfRelationship ? selfX + 36 : flowsUp ? sideX : (sourceX + targetX) / 2,
        labelY: isSelfRelationship ? selfY - 46 : (sourceY + targetY) / 2 - 8,
      },
    ];
  });

  const serviceAreas =
    showServiceAreas && view.mode === 'full'
      ? [...new Set(positionedNodes.map((node) => node.serviceId))].flatMap((serviceId) => {
          const members = positionedNodes.filter((node) => node.serviceId === serviceId);
          if (!usefulService(serviceId, members.length, positionedNodes.length)) return [];
          const minX = Math.min(...members.map((node) => node.x));
          const maxX = Math.max(...members.map((node) => node.x + capabilityMapNodeWidth));
          const minY = Math.min(...members.map((node) => node.y));
          const maxY = Math.max(...members.map((node) => node.y + capabilityMapNodeHeight));
          return [
            {
              serviceId,
              x: minX - serviceAreaPadding,
              y: minY - serviceAreaPadding - serviceAreaHeader,
              width: maxX - minX + serviceAreaPadding * 2,
              height: maxY - minY + serviceAreaPadding * 2 + serviceAreaHeader,
            },
          ];
        })
      : [];

  const contentRight = Math.max(
    0,
    ...positionedNodes.map((node) => node.x + capabilityMapNodeWidth),
  );
  const contentBottom = Math.max(
    0,
    ...positionedNodes.map((node) => node.y + capabilityMapNodeHeight),
  );
  return {
    nodes: positionedNodes,
    relationships,
    serviceAreas,
    width: Math.max(520, contentRight + canvasPadding),
    height: Math.max(320, contentBottom + canvasPadding),
  };
}
