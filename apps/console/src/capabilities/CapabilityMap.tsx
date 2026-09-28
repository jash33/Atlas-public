import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { demoTokenForRole } from '../config.js';
import { workflowDetailHash } from '../changes/changes.js';
import {
  graphMinZoom,
  graphViewFromKey,
  graphViewTransform,
  isGraphControlKey,
  panGraphView,
  wheelZoomFactor,
  zoomGraphView,
  zoomGraphViewIn,
  zoomGraphViewOut,
  type GraphView,
} from '../graph/graph-interactions.js';
import type { Remote } from '../home/data.js';
import { parseHashParameter, runDetailHash, useLocationHash } from '../shell/router.js';
import { useConsoleSession, type DemoRole, type EnvironmentId } from '../shell/session.js';
import {
  capabilityMapAccessDeniedMessage,
  useCapabilityOverview,
  type CapabilityOverview,
  type CapabilityOverviewNode,
} from './data.js';
import {
  capabilityMapNodeHeight,
  capabilityMapNodeWidth,
  capabilityMapPointFromScreen,
  buildCapabilityMapView,
  capabilityIdentityIdForVersion,
  connectedCapabilityIds,
  filterCapabilityMapOverview,
  filterCapabilityMapVisibility,
  findCapabilityMapItems,
  layoutCapabilityMap,
  relatedCapabilityMapItems,
  type CapabilityMapEmphasis,
  type CapabilityMapLifecycle,
  type CapabilityMapNode,
  type CapabilityMapView,
} from './capability-map-model.js';
import {
  capabilityMapEnvironmentAction,
  capabilityMapHash,
  capabilityMapRouteStateFromHash,
  defaultCapabilityMapRouteState,
  type CapabilityMapFocusTarget,
  type CapabilityMapRouteState,
} from './capability-map-route.js';
import { OperationEvidenceDrawer } from './OperationEvidenceDrawer.js';

export type CapabilityView = 'catalog' | 'repositories' | 'map' | 'architecture' | 'evidence';

export function capabilityViewFromHash(hash: string): CapabilityView {
  if (/^#\/?evidence-monitoring\/?(?:\?|$)/.test(hash)) return 'evidence';
  const view = parseHashParameter(hash, 'view');
  if (parseHashParameter(hash, 'repositoryConnection')) return 'repositories';
  return view === 'repositories' || view === 'map' || view === 'architecture' || view === 'evidence'
    ? view
    : 'catalog';
}

export function capabilityViewHash(view: CapabilityView, environmentId: EnvironmentId): string {
  const parameters = new URLSearchParams({
    ...(view === 'catalog' ? {} : { view }),
    environmentId,
  });
  return `#/capabilities?${parameters}`;
}

export function CapabilityTabs({
  active,
  environmentId,
}: {
  active: CapabilityView;
  environmentId: EnvironmentId;
}) {
  return (
    <nav aria-label="Capability views" className="cap-view-tabs">
      <a
        aria-current={active === 'catalog' ? 'page' : undefined}
        href={capabilityViewHash('catalog', environmentId)}
      >
        Capabilities
      </a>
      <a
        aria-current={active === 'repositories' ? 'page' : undefined}
        href={capabilityViewHash('repositories', environmentId)}
      >
        Repositories
      </a>
      <a
        aria-current={active === 'map' ? 'page' : undefined}
        href={capabilityViewHash('map', environmentId)}
      >
        Map
      </a>
      <a
        aria-current={active === 'architecture' ? 'page' : undefined}
        href={capabilityViewHash('architecture', environmentId)}
      >
        Architecture
      </a>
      <a
        aria-current={active === 'evidence' ? 'page' : undefined}
        href={capabilityViewHash('evidence', environmentId)}
      >
        Evidence Monitoring
      </a>
    </nav>
  );
}

const relationshipLabels = {
  compensation: 'Compensates',
  'data-flow': 'Data flows',
  'execution-order': 'Runs before',
} as const;

const workflowLifecycleLabels = {
  active: 'Active workflow',
  'approved-inactive': 'Approved, not active',
  'action-required': 'Workflow needs action',
  blocked: 'Workflow checks blocked',
  testing: 'Workflow checks running',
  draft: 'Draft workflow',
  'awaiting-approval': 'Workflow awaiting approval',
  historical: 'Past workflow version',
} as const;

interface CapabilityMapEvidenceScope {
  organizationId: string;
  environmentId: EnvironmentId;
  role: DemoRole;
}

export interface CapabilityBreakSimulation {
  nodeIds: ReadonlySet<string>;
  relationshipIds: ReadonlySet<string>;
  workflows: Array<{ workflowName: string; workflowVersionId: string }>;
}

export function simulateCapabilityBreak(
  view: CapabilityMapView,
  sourceNodeId: string,
): CapabilityBreakSimulation {
  const workflows = new Map<string, string>();
  for (const relationship of view.relationships) {
    if (relationship.sourceNodeId !== sourceNodeId && relationship.targetNodeId !== sourceNodeId) {
      continue;
    }
    for (const evidence of relationship.evidence) {
      workflows.set(evidence.workflowVersionId, evidence.workflowName);
    }
  }

  const nodeIds = new Set([sourceNodeId]);
  const relationshipIds = new Set<string>();
  for (const relationship of view.relationships) {
    if (!relationship.evidence.some(({ workflowVersionId }) => workflows.has(workflowVersionId))) {
      continue;
    }
    relationshipIds.add(relationship.id);
    nodeIds.add(relationship.sourceNodeId);
    nodeIds.add(relationship.targetNodeId);
  }
  return {
    nodeIds,
    relationshipIds,
    workflows: [...workflows]
      .map(([workflowVersionId, workflowName]) => ({ workflowName, workflowVersionId }))
      .sort(
        (left, right) =>
          left.workflowName.localeCompare(right.workflowName) ||
          left.workflowVersionId.localeCompare(right.workflowVersionId),
      ),
  };
}

export function shouldStartCapabilityMapPan(
  button: number,
  startedOnInteractiveItem: boolean,
): boolean {
  return button === 0 && !startedOnInteractiveItem;
}

export function simulatedBreakAfterTargetSelection(
  currentNodeId: string | null,
  nextTarget: CapabilityMapFocusTarget | null,
): string | null {
  return nextTarget === null ? currentNodeId : null;
}

export function ClearSimulatedBreakButton({ onClear }: { onClear: () => void }) {
  return (
    <button className="cap-map-clear-simulation" onClick={onClear} type="button">
      Clear Simulated Break
    </button>
  );
}

export function toggleRelationshipTarget(
  focusTarget: CapabilityMapFocusTarget | null,
  relationshipId: string,
): CapabilityMapFocusTarget | null {
  return focusTarget?.kind === 'relationship' && focusTarget.id === relationshipId
    ? null
    : { kind: 'relationship', id: relationshipId };
}

function capabilityLabel(node: CapabilityOverviewNode | undefined): string {
  return node ? `${node.serviceId} · ${node.operationId}` : 'Unavailable capability';
}

function mapNodeLabel(node: CapabilityMapNode | undefined): string {
  if (!node) return 'Unavailable capability';
  return node.kind === 'service' ? `${node.label} service` : `${node.serviceId} · ${node.label}`;
}

function nodeStatus(
  node: CapabilityMapNode,
  connected: ReadonlySet<string>,
  sourceLabel: string,
  impactRecovered: boolean,
): string {
  const affectedText =
    node.affectedWorkflowCount === undefined
      ? null
      : `${node.affectedWorkflowCount} ${impactRecovered ? 'previously affected' : 'affected'} ${node.affectedWorkflowCount === 1 ? 'workflow' : 'workflows'}`;
  if (node.kind === 'service') {
    return [
      `${node.capabilityIdentityIds.length} capabilities`,
      node.impact?.isSource ? sourceLabel : null,
      node.impact?.affected ? 'Affected' : null,
      affectedText,
    ]
      .filter((status): status is string => status !== null)
      .join(' · ');
  }
  const capability = node.capability;
  if (!capability) return '';
  const statuses = [
    node.impact?.isSource ? sourceLabel : null,
    node.impact?.affected ? 'Affected' : null,
    !connected.has(node.id) ? 'Not connected' : null,
    capability.availability === 'removed' ? 'Removed' : null,
    capability.freshness === 'stale' ? 'Stale' : null,
    capability.sourceResolution === 'conflicting' ? 'Conflicting sources' : null,
    affectedText,
  ].filter((status): status is string => status !== null);
  return statuses.join(' · ');
}

type ImpactPath = NonNullable<
  CapabilityOverviewNode['impact']
>['usages'][number]['evidence']['path'];
type ImpactUsage = NonNullable<CapabilityOverviewNode['impact']>['usages'][number];

function ImpactPathDetails({ path }: { path: ImpactPath }) {
  if (path.length === 0) return null;
  return (
    <ol aria-label="Supported workflow path" className="cap-map-impact-path">
      {path.map((hop, index) => (
        <li key={`${hop.kind}:${hop.fromStepId}:${hop.toStepId}:${index}`}>
          <span>
            {hop.fromStepId} → {hop.toStepId} ({relationshipLabels[hop.kind]})
          </span>
          <small>
            Exact pins <code>{hop.fromCapabilityVersionId}</code> →{' '}
            <code>{hop.toCapabilityVersionId}</code>
          </small>
        </li>
      ))}
    </ol>
  );
}

function ImpactEvidenceLine({
  usage,
  sources,
}: {
  usage: ImpactUsage;
  sources: NonNullable<CapabilityOverview['impact']>['sources'];
}) {
  const sourceVersionId =
    'fromCapabilityVersionId' in usage.evidence
      ? usage.evidence.fromCapabilityVersionId
      : usage.evidence.capabilityVersionId;
  const source = sources.find((candidate) => candidate.capabilityVersionId === sourceVersionId);
  return (
    <small>
      {'discoveryId' in usage.evidence
        ? `Discovery ${usage.evidence.discoveryId}`
        : `Polling observation ${usage.evidence.observationId} · observed ${new Date(
            usage.evidence.observedAt,
          ).toLocaleString()} · HTTP ${usage.evidence.status} · ${usage.evidence.normalizedReason.replaceAll('-', ' ')}`}
      {source
        ? ` · ${'discoveryId' in usage.evidence ? 'change' : 'source'} ${source.serviceId}.${source.operationId}`
        : ''}{' '}
      · exact version <code>{sourceVersionId}</code>
      {usage.evidence.fieldPath ? ` · field ${usage.evidence.fieldPath}` : ''}
      {usage.evidence.sourceStepId ? ` · supported by step ${usage.evidence.sourceStepId}` : ''}
    </small>
  );
}

function ImpactDetails({
  node,
  sources,
  sourceLabel,
  impactRecovered,
  onInspectVersion,
}: {
  node: CapabilityMapNode;
  sources: NonNullable<CapabilityOverview['impact']>['sources'];
  sourceLabel: string;
  impactRecovered: boolean;
  onInspectVersion: (capabilityVersionId: string) => void;
}) {
  if (!node.impact) return null;
  return (
    <section
      aria-label={`${mapNodeLabel(node)} impact explanation`}
      className="cap-map-impact-detail"
    >
      <h3>
        {node.impact.affected
          ? 'What will break'
          : impactRecovered && node.impact.usages.length > 0
            ? 'What was going to break'
            : 'Changed operation'}
      </h3>
      {node.impact.isSource && <strong>This operation is the {sourceLabel.toLowerCase()}.</strong>}
      {node.impact.usages.length === 0 ? (
        <p>Atlas has not established that a workflow call will fail.</p>
      ) : (
        <ul>
          {node.impact.usages.map((usage) => {
            return (
              <li key={`${usage.workflowVersionId}:${usage.stepId}`}>
                <p>{usage.reason}</p>
                <span>
                  Workflow{' '}
                  <a href={workflowDetailHash(usage.workflowVersionId)}>{usage.workflowName}</a>,
                  step <code>{usage.stepId}</code>, exact capability pin{' '}
                  <code>{usage.capabilityVersionId}</code>.
                </span>
                <ImpactEvidenceLine sources={sources} usage={usage} />
                <button
                  className="cat-secondary"
                  onClick={() => onInspectVersion(usage.capabilityVersionId)}
                  type="button"
                >
                  Inspect recorded capability
                </button>
                {usage.currentState ? (
                  <small>
                    Current situation: {workflowLifecycleLabels[usage.workflowLifecycle]}
                    {usage.currentState.replacementWorkflowVersionId
                      ? ` · replaced by ${usage.currentState.replacementWorkflowVersionId}`
                      : ''}
                    {usage.currentState.quarantine === 'active'
                      ? ' · Atlas is blocking new starts'
                      : usage.currentState.quarantine === 'cleared'
                        ? ' · the earlier block has been cleared'
                        : ''}
                    .
                  </small>
                ) : null}
                {usage.currentState?.blockedWorkflowStart ? (
                  <small>
                    Atlas blocked new starts for this workflow at{' '}
                    {new Date(usage.currentState.blockedWorkflowStart.blockedAt).toLocaleString()}
                    {usage.currentState?.quarantineClearedAt
                      ? ` and cleared the block at ${new Date(
                          usage.currentState.quarantineClearedAt,
                        ).toLocaleString()}`
                      : ''}
                    .
                  </small>
                ) : null}
                {usage.currentState?.latestFailedRun ? (
                  <small>
                    Related failed run{' '}
                    <a href={runDetailHash(usage.currentState.latestFailedRun.runId)}>
                      {usage.currentState.latestFailedRun.runId}
                    </a>{' '}
                    at {new Date(usage.currentState.latestFailedRun.failedAt).toLocaleString()} (
                    {usage.currentState.latestFailedRun.failureType}).
                  </small>
                ) : null}
                <ImpactPathDetails path={usage.evidence.path} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function BreakSimulation({
  active,
  node,
  simulation,
  onClear,
  onSimulate,
}: {
  active: boolean;
  node: CapabilityMapNode;
  simulation: CapabilityBreakSimulation;
  onClear: () => void;
  onSimulate: () => void;
}) {
  const otherCapabilityCount = Math.max(0, simulation.nodeIds.size - 1);
  const visibleWorkflows = simulation.workflows.slice(0, 5);
  return (
    <section className={`cap-map-simulation${active ? ' is-active' : ''}`}>
      <span>Impact preview</span>
      <h3>{active ? 'Simulated break' : 'Simulate a break'}</h3>
      {!active ? (
        <>
          <p>
            Preview what depends on <strong>{mapNodeLabel(node)}</strong>. This does not change the
            capability or run any workflow.
          </p>
          <button className="cat-secondary" onClick={onSimulate} type="button">
            Simulate a break
          </button>
        </>
      ) : (
        <div aria-live="polite" className="cap-map-simulation-result" role="status">
          <div className="cap-map-simulation-notice">
            <strong>Simulation only</strong>
            <span>Nothing in Atlas or Burger Town was changed.</span>
          </div>
          {simulation.workflows.length === 0 ? (
            <p className="cap-map-simulation-summary">
              Atlas does not know of a workflow that depends on this capability.
            </p>
          ) : (
            <>
              <p className="cap-map-simulation-summary">
                {simulation.workflows.length}{' '}
                {simulation.workflows.length === 1 ? 'workflow' : 'workflows'} and{' '}
                {otherCapabilityCount} other{' '}
                {otherCapabilityCount === 1 ? 'capability' : 'capabilities'} would be affected.
              </p>
              <div className="cap-map-simulation-workflows">
                <span>Affected {visibleWorkflows.length === 1 ? 'workflow' : 'workflows'}</span>
                <ul>
                  {visibleWorkflows.map((workflow) => (
                    <li key={workflow.workflowVersionId}>
                      <a href={workflowDetailHash(workflow.workflowVersionId)}>
                        {workflow.workflowName}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              {simulation.workflows.length > visibleWorkflows.length ? (
                <small>
                  {simulation.workflows.length - visibleWorkflows.length} more workflows
                </small>
              ) : null}
            </>
          )}
          <button className="cat-secondary" onClick={onClear} type="button">
            Clear Simulated Break
          </button>
        </div>
      )}
    </section>
  );
}

function connectedNodeIds(view: CapabilityMapView): ReadonlySet<string> {
  return new Set(
    view.relationships.flatMap((relationship) => [
      relationship.sourceNodeId,
      relationship.targetNodeId,
    ]),
  );
}

const capabilityMapSearchPadding = 32;
const capabilityMapSearchMaxZoom = 1.8;
export const capabilityMapViewport = { width: 1400, height: 760 } as const;

export function capabilityMapFitView(mapSize: { width: number; height: number }): GraphView {
  const zoom = Math.min(
    1,
    capabilityMapViewport.width / mapSize.width,
    capabilityMapViewport.height / mapSize.height,
  );
  return {
    zoom,
    x: (capabilityMapViewport.width - mapSize.width * zoom) / 2,
    y: (capabilityMapViewport.height - mapSize.height * zoom) / 2,
  };
}

export function capabilityMapSearchView(
  mapSize: { width: number; height: number },
  nodes: ReadonlyArray<{ id: string; x: number; y: number }>,
  matchedNodeIds: ReadonlySet<string>,
): GraphView | null {
  const matches = nodes.filter((node) => matchedNodeIds.has(node.id));
  if (matches.length === 0) return null;

  const minX = Math.min(...matches.map((node) => node.x)) - capabilityMapSearchPadding;
  const minY = Math.min(...matches.map((node) => node.y)) - capabilityMapSearchPadding;
  const maxX =
    Math.max(...matches.map((node) => node.x + capabilityMapNodeWidth)) +
    capabilityMapSearchPadding;
  const maxY =
    Math.max(...matches.map((node) => node.y + capabilityMapNodeHeight)) +
    capabilityMapSearchPadding;
  const width = maxX - minX;
  const height = maxY - minY;
  const zoom = Math.min(capabilityMapSearchMaxZoom, mapSize.width / width, mapSize.height / height);

  return {
    zoom,
    x: (mapSize.width - width * zoom) / 2 - minX * zoom,
    y: (mapSize.height - height * zoom) / 2 - minY * zoom,
  };
}

function CapabilityMapDiagram({
  mapView,
  connected,
  showServiceAreas,
  sourceLabel,
  impactRecovered,
  impactNodeIds,
  impactFocusKey,
  emphasis,
  focusTarget,
  onSelectTarget,
  onClearSimulatedBreak,
  searchNodeIds,
  searchQuery,
  simulatedBreak,
}: {
  mapView: CapabilityMapView;
  connected: ReadonlySet<string>;
  showServiceAreas: boolean;
  sourceLabel: string;
  impactRecovered: boolean;
  impactNodeIds: ReadonlySet<string> | null;
  impactFocusKey: string | null;
  emphasis: CapabilityMapEmphasis;
  focusTarget: CapabilityMapFocusTarget | null;
  onSelectTarget: (target: CapabilityMapFocusTarget | null) => void;
  onClearSimulatedBreak: () => void;
  searchNodeIds: ReadonlySet<string>;
  searchQuery: string;
  simulatedBreak: CapabilityBreakSimulation | null;
}) {
  const markerId = useId().replaceAll(':', '');
  const svgRef = useRef<SVGSVGElement>(null);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const layout = useMemo(
    () => layoutCapabilityMap(mapView, showServiceAreas),
    [mapView, showServiceAreas],
  );
  const fittedView = useMemo(() => capabilityMapFitView(layout), [layout]);
  const incidentView = impactNodeIds
    ? capabilityMapSearchView(capabilityMapViewport, layout.nodes, impactNodeIds)
    : null;
  const defaultView = incidentView ?? fittedView;
  const defaultX = defaultView.x;
  const defaultY = defaultView.y;
  const defaultZoom = defaultView.zoom;
  const [view, setView] = useState<GraphView>(() => defaultView);
  const [expanded, setExpanded] = useState(false);
  const minimumZoom = Math.min(graphMinZoom, fittedView.zoom);
  const fittedSearchView = capabilityMapSearchView(
    capabilityMapViewport,
    layout.nodes,
    searchNodeIds,
  );
  const fittedSearchX = fittedSearchView?.x;
  const fittedSearchY = fittedSearchView?.y;
  const fittedSearchZoom = fittedSearchView?.zoom;

  useEffect(() => {
    if (!searchQuery.trim()) {
      setView({ x: defaultX, y: defaultY, zoom: defaultZoom });
      return;
    }
    if (
      fittedSearchX === undefined ||
      fittedSearchY === undefined ||
      fittedSearchZoom === undefined
    ) {
      return;
    }
    setView({ x: fittedSearchX, y: fittedSearchY, zoom: fittedSearchZoom });
    // Incident observations change every sweep. Only a new focus or changed geometry
    // reframes the camera, so live polling does not undo the user's pan and zoom.
  }, [
    fittedSearchX,
    fittedSearchY,
    fittedSearchZoom,
    defaultX,
    defaultY,
    defaultZoom,
    impactFocusKey,
    searchQuery,
  ]);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', exitOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', exitOnEscape);
    };
  }, [expanded]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      const origin = capabilityMapPointFromScreen(capabilityMapViewport, bounds, {
        x: event.clientX,
        y: event.clientY,
      });
      setView((current) =>
        zoomGraphView(current, wheelZoomFactor(event.deltaY), origin, minimumZoom),
      );
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [minimumZoom]);

  const graphCenter = () => ({
    x: capabilityMapViewport.width / 2,
    y: capabilityMapViewport.height / 2,
  });
  const startPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    const startedOnInteractiveItem =
      event.target instanceof Element && event.target.closest('[role="button"]') !== null;
    if (!shouldStartCapabilityMapPan(event.button, startedOnInteractiveItem)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = capabilityMapPointFromScreen(capabilityMapViewport, bounds, {
      x: event.clientX,
      y: event.clientY,
    });
    pointerRef.current = { id: event.pointerId, ...point };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const movePan = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = capabilityMapPointFromScreen(capabilityMapViewport, bounds, {
      x: event.clientX,
      y: event.clientY,
    });
    setView((current) => panGraphView(current, point.x - pointer.x, point.y - pointer.y));
    pointerRef.current = { id: pointer.id, ...point };
  };
  const endPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (pointerRef.current?.id === event.pointerId) pointerRef.current = null;
  };

  return (
    <div
      className={`cap-map-diagram${expanded ? ' is-expanded' : ''}${simulatedBreak ? ' is-simulating' : ''}`}
    >
      <svg
        aria-label="Pan and zoom capability map"
        className="cap-map-svg"
        onDoubleClick={() => setView(fittedView)}
        onKeyDown={(event) => {
          if (!isGraphControlKey(event.key)) return;
          event.preventDefault();
          if (event.key === '0') {
            setView(fittedView);
            return;
          }
          setView(
            (current) =>
              graphViewFromKey(current, event.key, graphCenter(), minimumZoom) ?? current,
          );
        }}
        onPointerCancel={endPan}
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        ref={svgRef}
        role="group"
        tabIndex={0}
        viewBox={`0 0 ${capabilityMapViewport.width} ${capabilityMapViewport.height}`}
      >
        <defs>
          <marker
            id={`${markerId}-arrow`}
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            markerWidth="8"
            orient="auto"
            refX="7"
            refY="4"
          >
            <path d="M0 0 L8 4 L0 8 z" fill="context-stroke" />
          </marker>
        </defs>
        <g transform={graphViewTransform(view)}>
          {layout.serviceAreas.map((service) => (
            <g className="cap-map-service" key={service.serviceId}>
              <rect
                height={service.height}
                rx="12"
                width={service.width}
                x={service.x}
                y={service.y}
              />
              <text x={service.x + 14} y={service.y + 24}>
                {service.serviceId}
              </text>
            </g>
          ))}
          {layout.relationships.map((relationship) => {
            const simulated = simulatedBreak?.relationshipIds.has(relationship.id) === true;
            return (
              <g
                aria-label={`${relationshipLabels[relationship.kind]} from ${mapNodeLabel(mapView.nodes.find((node) => node.id === relationship.sourceNodeId))} to ${mapNodeLabel(mapView.nodes.find((node) => node.id === relationship.targetNodeId))}${simulated ? ', simulated break impact' : ''}`}
                aria-pressed={
                  focusTarget?.kind === 'relationship' && focusTarget.id === relationship.id
                }
                className={`cap-map-edge cap-map-edge-${relationship.kind}${relationship.affected ? ' is-affected' : ''}${simulated ? ' is-simulated-break' : ''}${emphasis.relationshipIds.has(relationship.id) ? '' : ' is-faded'}${focusTarget?.kind === 'relationship' && focusTarget.id === relationship.id ? ' is-selected' : ''}`}
                key={relationship.id}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectTarget(toggleRelationshipTarget(focusTarget, relationship.id));
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectTarget(toggleRelationshipTarget(focusTarget, relationship.id));
                }}
                role="button"
                tabIndex={0}
              >
                <title>
                  {`${relationshipLabels[relationship.kind]} through ${relationship.evidence.length} ${relationship.evidence.length === 1 ? 'workflow connection' : 'workflow connections'}`}
                </title>
                <path d={relationship.path} fill="none" markerEnd={`url(#${markerId}-arrow)`} />
                <text textAnchor="middle" x={relationship.labelX} y={relationship.labelY}>
                  {relationshipLabels[relationship.kind]}
                </text>
              </g>
            );
          })}
          {layout.nodes.map((node) => {
            const status = nodeStatus(node, connected, sourceLabel, impactRecovered);
            const selected = focusTarget?.kind === 'node' && focusTarget.id === node.id;
            const simulated = simulatedBreak?.nodeIds.has(node.id) === true;
            const brokenSource =
              node.impact?.isSource === true && sourceLabel === 'Broken request source';
            const handleKeyDown = (event: ReactKeyboardEvent<SVGGElement>) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelectTarget(selected ? null : { kind: 'node', id: node.id });
            };
            return (
              <g
                aria-label={`${mapNodeLabel(node)}${status ? `, ${status}` : ''}${simulated ? ', simulated break impact' : ''}`}
                aria-pressed={selected}
                className={`cap-map-svg-node cap-map-svg-node-${node.kind}${node.impact?.affected ? ' is-affected' : ''}${simulated ? ' is-simulated-break' : ''}${node.impact?.isSource ? ' is-impact-source' : ''}${brokenSource ? ' is-broken-source' : ''}${emphasis.nodeIds.has(node.id) ? '' : ' is-faded'}${selected ? ' is-selected' : ''}`}
                key={node.id}
                onClick={() => onSelectTarget(selected ? null : { kind: 'node', id: node.id })}
                onKeyDown={handleKeyDown}
                role="button"
                tabIndex={0}
                transform={`translate(${node.x} ${node.y})`}
              >
                <rect height={capabilityMapNodeHeight} rx="9" width={capabilityMapNodeWidth} />
                <text className="cap-map-svg-service" x="12" y="19">
                  {node.kind === 'service' ? 'Service group' : node.serviceId}
                </text>
                <text className="cap-map-svg-name" x="12" y="40">
                  {node.label}
                </text>
                <text className="cap-map-svg-status" x="12" y="60">
                  {status ||
                    (node.capability?.kind === 'openapi' ? 'API operation' : 'Event operation')}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      {simulatedBreak ? <ClearSimulatedBreakButton onClear={onClearSimulatedBreak} /> : null}
      <div className="cap-map-controls">
        <button
          aria-label="Zoom in"
          onClick={() => setView((current) => zoomGraphViewIn(current, graphCenter(), minimumZoom))}
          type="button"
        >
          +
        </button>
        <button
          aria-label="Zoom out"
          onClick={() =>
            setView((current) => zoomGraphViewOut(current, graphCenter(), minimumZoom))
          }
          type="button"
        >
          −
        </button>
        <button aria-label="Reset map to fit" onClick={() => setView(fittedView)} type="button">
          Fit
        </button>
        <button
          aria-label={expanded ? 'Exit full screen map' : 'Open full screen map'}
          aria-pressed={expanded}
          onClick={() => setExpanded((current) => !current)}
          title={expanded ? 'Exit full screen' : 'Full screen'}
          type="button"
        >
          <svg
            aria-hidden="true"
            className="cap-map-fullscreen-icon"
            data-direction={expanded ? 'inward' : 'outward'}
            fill="none"
            viewBox="0 0 24 24"
          >
            {expanded ? (
              <>
                <path d="M4 4l6 6M10 6v4H6" />
                <path d="M20 4l-6 6M18 10h-4V6" />
                <path d="M4 20l6-6M6 14h4v4" />
                <path d="M20 20l-6-6M14 18v-4h4" />
              </>
            ) : (
              <>
                <path d="M10 10 4 4M4 8V4h4" />
                <path d="m14 10 6-6M16 4h4v4" />
                <path d="m10 14-6 6M4 16v4h4" />
                <path d="m14 14 6 6M16 20h4v-4" />
              </>
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}

export function CapabilityMap({
  overview,
  routeState,
  onRouteStateChange,
  evidenceScope,
}: {
  overview: CapabilityOverview;
  routeState?: CapabilityMapRouteState;
  onRouteStateChange?: (state: CapabilityMapRouteState) => void;
  evidenceScope?: CapabilityMapEvidenceScope;
}) {
  const [localRouteState, setLocalRouteState] = useState(defaultCapabilityMapRouteState);
  const [simulatedBreakNodeId, setSimulatedBreakNodeId] = useState<string | null>(null);
  const [inspection, setInspection] = useState<{
    snapshotId: string;
    capabilityVersionId: string;
  } | null>(null);
  const inspectionVersionId =
    inspection?.snapshotId === overview.snapshotId ? inspection.capabilityVersionId : null;
  const impactRecovered =
    overview.impact?.type === 'runtime-mismatch' && overview.impact.state === 'recovered';
  const recoveredAt =
    overview.impact?.type === 'runtime-mismatch' && overview.impact.state === 'recovered'
      ? overview.impact.recoveredAt
      : undefined;
  const sourceLabel =
    overview.impact?.type === 'runtime-mismatch'
      ? impactRecovered
        ? 'Earlier broken request source'
        : 'Broken request source'
      : 'Change source';
  const state = routeState ?? localRouteState;
  const updateState = (next: CapabilityMapRouteState) => {
    if (onRouteStateChange) onRouteStateChange(next);
    else setLocalRouteState(next);
  };
  const lifecycleOverview = useMemo(
    () => filterCapabilityMapOverview(overview, state.lifecycle),
    [overview, state.lifecycle],
  );
  const visibleOverview = useMemo(
    () =>
      filterCapabilityMapVisibility(lifecycleOverview, state.lifecycle, state.includeDisconnected),
    [lifecycleOverview, state.includeDisconnected, state.lifecycle],
  );
  const fullView = useMemo(
    () => buildCapabilityMapView(visibleOverview, 'full'),
    [visibleOverview],
  );
  const groupedView = useMemo(
    () => buildCapabilityMapView(visibleOverview, 'grouped'),
    [visibleOverview],
  );
  const mapView = state.granularity === 'grouped' ? groupedView : fullView;
  const simulatedBreak = simulatedBreakNodeId
    ? simulateCapabilityBreak(mapView, simulatedBreakNodeId)
    : null;
  const searchMatches = useMemo(
    () => findCapabilityMapItems(mapView, state.search),
    [mapView, state.search],
  );

  if (overview.status === 'empty') {
    return (
      <section className="cat-onboarding cap-map-empty">
        <h2>No capabilities to map</h2>
        {overview.notices.map((notice) => (
          <p key={notice}>{notice}</p>
        ))}
      </section>
    );
  }

  const originalNodes = new Map(overview.nodes.map((node) => [node.capabilityIdentityId, node]));
  const fullNodes = new Map(fullView.nodes.map((node) => [node.id, node]));
  const nodes = new Map(mapView.nodes.map((node) => [node.id, node]));
  const connected = connectedNodeIds(mapView);
  const originalConnected = connectedCapabilityIds(overview);
  const focusMatches =
    state.focusTarget?.kind === 'node'
      ? relatedCapabilityMapItems(mapView, state.focusTarget.id)
      : state.focusTarget?.kind === 'relationship'
        ? (() => {
            const relationship = mapView.relationships.find(
              (candidate) => candidate.id === state.focusTarget?.id,
            );
            return relationship
              ? {
                  nodeIds: new Set([relationship.sourceNodeId, relationship.targetNodeId]),
                  relationshipIds: new Set([relationship.id]),
                }
              : findCapabilityMapItems(mapView, '');
          })()
        : findCapabilityMapItems(mapView, '');
  const hasSearch = state.search.trim().length > 0;
  const impactNodeIds = visibleOverview.impact
    ? new Set(
        mapView.nodes
          .filter(
            (node) =>
              node.impact?.affected ||
              node.impact?.isSource ||
              (impactRecovered && (node.impact?.usages.length ?? 0) > 0),
          )
          .map((node) => node.id),
      )
    : null;
  const impactRelationshipIds = visibleOverview.impact
    ? new Set(
        mapView.relationships
          .filter((relationship) => relationship.affected)
          .map((relationship) => relationship.id),
      )
    : null;
  const emphasis: CapabilityMapEmphasis = {
    nodeIds: new Set(
      mapView.nodes
        .filter(
          (node) =>
            (!hasSearch || searchMatches.nodeIds.has(node.id)) &&
            (simulatedBreak
              ? simulatedBreak.nodeIds.has(node.id)
              : focusMatches.nodeIds.has(node.id)),
        )
        .filter((node) => simulatedBreak !== null || !impactNodeIds || impactNodeIds.has(node.id))
        .map((node) => node.id),
    ),
    relationshipIds: new Set(
      mapView.relationships
        .filter(
          (relationship) =>
            (!hasSearch || searchMatches.relationshipIds.has(relationship.id)) &&
            (simulatedBreak
              ? simulatedBreak.relationshipIds.has(relationship.id)
              : focusMatches.relationshipIds.has(relationship.id)) &&
            (simulatedBreak !== null ||
              !impactRelationshipIds ||
              impactRelationshipIds.has(relationship.id)),
        )
        .map((relationship) => relationship.id),
    ),
  };
  const selectTarget = (focusTarget: CapabilityMapFocusTarget | null) => {
    setInspection(null);
    setSimulatedBreakNodeId((current) => simulatedBreakAfterTargetSelection(current, focusTarget));
    updateState({ ...state, focusTarget });
  };
  const selectedNode =
    state.focusTarget?.kind === 'node' ? nodes.get(state.focusTarget.id) : undefined;
  const selectedRelationship =
    state.focusTarget?.kind === 'relationship'
      ? mapView.relationships.find((relationship) => relationship.id === state.focusTarget?.id)
      : undefined;
  const selectedNodeCapability =
    selectedNode?.kind === 'capability'
      ? selectedNode.capability
      : selectedNode?.capabilityIdentityIds.length
        ? originalNodes.get(selectedNode.capabilityIdentityIds[0]!)
        : undefined;
  const selectedCapabilityVersionId =
    inspectionVersionId ??
    selectedNodeCapability?.capabilityVersionId ??
    (state.focusTarget?.kind === 'node'
      ? originalNodes.get(state.focusTarget.id)?.capabilityVersionId
      : selectedRelationship?.evidence[0]?.sourceCapabilityVersionId);
  const inspectVersion = (capabilityVersionId: string) => {
    const capabilityIdentityId = capabilityIdentityIdForVersion(overview, capabilityVersionId);
    if (capabilityIdentityId) {
      setInspection({ snapshotId: overview.snapshotId, capabilityVersionId });
      updateState({
        ...state,
        focusTarget: { kind: 'node', id: capabilityIdentityId },
        granularity: 'full',
      });
    }
  };
  return (
    <>
      <section aria-labelledby="capability-map-title" className="cap-map">
        {overview.status === 'partial' && (
          <aside className="cap-map-notice" role="status">
            <strong>Some connections could not be shown</strong>
            {overview.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </aside>
        )}
        {visibleOverview.impact && (
          <aside
            className={`cap-map-impact-summary${impactRecovered ? ' is-recovered' : ''}`}
            role="status"
          >
            <div>
              <strong>{impactRecovered ? 'Recovered' : 'Blast radius'}</strong>
              {impactRecovered && recoveredAt ? (
                <span>
                  Burger Town accepted the prepared request again at{' '}
                  {new Date(recoveredAt).toLocaleString()}. The live warning is cleared; the earlier
                  blast radius remains below.
                </span>
              ) : null}
              {visibleOverview.impact.analysis === 'unavailable' ? (
                <span>Atlas could not find enough information to check this change.</span>
              ) : visibleOverview.impact.analysis === 'complete' &&
                visibleOverview.impact.affectedStepCount === 0 ? (
                <span>
                  Atlas found no workflow items that were affected by this{' '}
                  {visibleOverview.impact.type === 'runtime-mismatch' ? 'broken request' : 'change'}
                  .
                </span>
              ) : (
                <span>
                  When Atlas found this{' '}
                  {visibleOverview.impact.type === 'runtime-mismatch' ? 'broken request' : 'change'}
                  ,{' '}
                  {'affectedEndpointCount' in visibleOverview.impact
                    ? `${visibleOverview.impact.affectedEndpointCount} ${
                        visibleOverview.impact.affectedEndpointCount === 1
                          ? 'endpoint'
                          : 'endpoints'
                      } and `
                    : ''}
                  {visibleOverview.impact.affectedStepCount} workflow{' '}
                  {visibleOverview.impact.affectedStepCount === 1 ? 'item was' : 'items were'} going
                  to break across {visibleOverview.impact.affectedWorkflowCount}{' '}
                  {visibleOverview.impact.affectedWorkflowCount === 1 ? 'workflow' : 'workflows'}.
                </span>
              )}
            </div>
            {visibleOverview.impact.analysis === 'partial' ? (
              <p>Some information was missing, so this answer may be incomplete.</p>
            ) : null}
            {!impactRecovered &&
            visibleOverview.impact.currentlyExposedStepCount !== undefined &&
            visibleOverview.impact.analysis !== 'unavailable' ? (
              <p>
                Current situation: {visibleOverview.impact.currentlyExposedStepCount} affected{' '}
                {visibleOverview.impact.currentlyExposedStepCount === 1 ? 'item is' : 'items are'}{' '}
                in an active workflow.
              </p>
            ) : null}
            {visibleOverview.impact.recordedAt ? (
              <p>Recorded {new Date(visibleOverview.impact.recordedAt).toLocaleString()}.</p>
            ) : null}
            <p>
              {sourceLabel}:{' '}
              {visibleOverview.impact.sources
                .map((source) => `${source.serviceId} · ${source.operationId}`)
                .join(', ') || 'No changed operation was found.'}
            </p>
          </aside>
        )}
        <header className="cap-map-summary">
          <div>
            <h2 id="capability-map-title">Capability map</h2>
            <p>
              {visibleOverview.nodes.length} of {lifecycleOverview.nodes.length}{' '}
              {lifecycleOverview.nodes.length === 1 ? 'capability' : 'capabilities'} shown ·{' '}
              {visibleOverview.relationships.length}{' '}
              {visibleOverview.relationships.length === 1 ? 'connection' : 'connections'}
            </p>
          </div>
          <small>
            The map shows capabilities used by established workflows or connected to another
            capability. The Catalog remains the complete inventory.
          </small>
        </header>
        <section aria-label="Map tools" className="cap-map-tools">
          <label className="cap-map-tool-search">
            <span>Find on map</span>
            <input
              onChange={(event) => updateState({ ...state, search: event.target.value })}
              placeholder="Search capabilities, services, workflows, or steps"
              type="search"
              value={state.search}
            />
          </label>
          <div className="cap-map-tool-options">
            <label className="cap-map-tool-status">
              <span>Workflow status</span>
              <select
                onChange={(event) =>
                  updateState({
                    ...state,
                    lifecycle: event.target.value as CapabilityMapLifecycle,
                    focusTarget: null,
                  })
                }
                value={state.lifecycle}
              >
                <option value="all">All established workflows</option>
                <option value="active">Active</option>
                <option value="approved-inactive">Approved, not active</option>
                <option value="action-required">Needs action</option>
                <option value="blocked">Checks blocked</option>
                <option value="testing">Checks running</option>
                <option value="draft">Draft</option>
                <option value="awaiting-approval">Awaiting approval</option>
                <option value="historical">Past workflow versions</option>
              </select>
            </label>
            <label className="cap-map-check">
              <input
                checked={state.showServiceAreas}
                disabled={state.granularity === 'grouped'}
                onChange={(event) =>
                  updateState({ ...state, showServiceAreas: event.target.checked })
                }
                type="checkbox"
              />
              <span>Show service areas</span>
            </label>
            <label className="cap-map-check">
              <input
                checked={state.includeDisconnected}
                onChange={(event) =>
                  updateState({
                    ...state,
                    includeDisconnected: event.target.checked,
                    focusTarget: null,
                  })
                }
                type="checkbox"
              />
              <span>Include disconnected capabilities</span>
            </label>
            <button
              aria-pressed={state.granularity === 'grouped'}
              className="cap-map-tool-toggle"
              disabled={groupedView.groupedServiceCount === 0}
              onClick={() => {
                updateState({
                  ...state,
                  granularity: state.granularity === 'full' ? 'grouped' : 'full',
                  focusTarget: null,
                });
              }}
              type="button"
            >
              {state.granularity === 'full' ? 'Group supported services' : 'Show every capability'}
            </button>
          </div>
          {hasSearch || state.focusTarget ? (
            <div className="cap-map-tool-footer">
              <div className="cap-map-tool-actions">
                <button
                  onClick={() => {
                    updateState({ ...state, search: '', focusTarget: null });
                  }}
                  type="button"
                >
                  Clear focus
                </button>
              </div>
            </div>
          ) : null}
        </section>
        {visibleOverview.nodes.length === 0 ? (
          <aside className="cap-map-notice" role="status">
            <strong>No workflow-connected capabilities to show</strong>
            <p>
              This environment has {lifecycleOverview.nodes.length}{' '}
              {lifecycleOverview.nodes.length === 1 ? 'capability' : 'capabilities'}, but none match
              the map&apos;s current workflow scope. Include disconnected capabilities to see the
              full inventory here.
            </p>
          </aside>
        ) : null}
        <div className="cap-map-board">
          <CapabilityMapDiagram
            connected={connected}
            emphasis={emphasis}
            focusTarget={state.focusTarget}
            impactRecovered={impactRecovered}
            impactNodeIds={impactNodeIds}
            impactFocusKey={
              visibleOverview.impact
                ? `${visibleOverview.impact.type}:${visibleOverview.impact.id}`
                : null
            }
            mapView={mapView}
            onClearSimulatedBreak={() => setSimulatedBreakNodeId(null)}
            onSelectTarget={selectTarget}
            searchNodeIds={searchMatches.nodeIds}
            searchQuery={state.search}
            showServiceAreas={state.showServiceAreas}
            simulatedBreak={simulatedBreak}
            sourceLabel={sourceLabel}
          />
        </div>
        <details className="cap-map-text">
          <summary>Structured text view</summary>
          <section>
            <h3>Capabilities</h3>
            <ul>
              {visibleOverview.nodes.map((node) => {
                const affectedWorkflowCount = fullNodes.get(
                  node.capabilityIdentityId,
                )?.affectedWorkflowCount;
                const affectedText =
                  affectedWorkflowCount === undefined
                    ? ''
                    : ` · ${affectedWorkflowCount} ${impactRecovered ? 'previously affected' : 'affected'} ${affectedWorkflowCount === 1 ? 'workflow' : 'workflows'}`;
                return (
                  <li key={node.capabilityIdentityId}>
                    <strong>{capabilityLabel(node)}</strong>
                    <br />
                    <span>
                      Current version <code>{node.capabilityVersionId}</code>
                      {!originalConnected.has(node.capabilityIdentityId) ? ' · Not connected' : ''}
                      {node.availability === 'removed' ? ' · Removed' : ''}
                      {node.freshness === 'stale' ? ' · Stale' : ''}
                      {node.sourceResolution === 'conflicting' ? ' · Conflicting sources' : ''}
                      {node.impact?.isSource ? ` · ${sourceLabel}` : ''}
                      {node.impact?.affected ? ' · Affected' : ''}
                      {affectedText}
                    </span>
                    {node.impact?.usages.map((usage) => (
                      <p key={`${usage.workflowVersionId}:${usage.stepId}`}>
                        {usage.reason} Workflow {usage.workflowName}, step{' '}
                        <code>{usage.stepId}</code>, exact capability pin{' '}
                        <code>{usage.capabilityVersionId}</code>.
                        {usage.evidence.path.map(
                          (hop) =>
                            ` ${hop.fromStepId} to ${hop.toStepId} (${relationshipLabels[hop.kind]}).`,
                        )}
                        <br />
                        <ImpactEvidenceLine
                          sources={visibleOverview.impact?.sources ?? []}
                          usage={usage}
                        />
                      </p>
                    ))}
                    <br />
                    <button onClick={() => inspectVersion(node.capabilityVersionId)} type="button">
                      Inspect evidence
                    </button>
                  </li>
                );
              })}
            </ul>
            <h3>Connections</h3>
            {visibleOverview.relationships.length === 0 ? (
              <p>No connections match this workflow status.</p>
            ) : (
              <ol>
                {visibleOverview.relationships.map((relationship) => (
                  <li key={relationship.id}>
                    <strong>{relationshipLabels[relationship.kind]}</strong>:{' '}
                    {capabilityLabel(originalNodes.get(relationship.sourceCapabilityIdentityId))} →{' '}
                    {capabilityLabel(originalNodes.get(relationship.targetCapabilityIdentityId))}
                    <br />
                    <span>
                      {relationship.evidence.workflowName} (
                      {relationship.evidence.workflowVersionId}
                      ), steps {relationship.evidence.sourceStepId} →{' '}
                      {relationship.evidence.targetStepId}
                      {relationship.evidence.destinationField
                        ? `, field ${relationship.evidence.destinationField}`
                        : ''}
                    </span>
                    <br />
                    <span>
                      {workflowLifecycleLabels[relationship.evidence.workflowLifecycle]} · Exact
                      versions <code>{relationship.evidence.sourceCapabilityVersionId}</code> →{' '}
                      <code>{relationship.evidence.targetCapabilityVersionId}</code>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </details>
        <small className="cap-map-snapshot">Map snapshot {overview.snapshotId}</small>
      </section>
      {evidenceScope && selectedCapabilityVersionId && (
        <OperationEvidenceDrawer
          capabilityVersionId={selectedCapabilityVersionId}
          environmentId={evidenceScope.environmentId}
          onClose={() => selectTarget(null)}
          onSelectVersion={inspectVersion}
          organizationId={evidenceScope.organizationId}
          role={evidenceScope.role}
          topContent={
            <>
              <aside className="cap-map-drawer-connection" role="status">
                <strong>Recorded map evidence</strong>
                <p>
                  This evidence comes from map snapshot <code>{overview.snapshotId}</code>.
                </p>
                {selectedNode?.kind === 'service' ? (
                  <p>
                    The selected group contains {selectedNode.capabilityIdentityIds.length}{' '}
                    capabilities. The simulation covers the group; operation evidence begins with{' '}
                    <strong>{selectedNodeCapability?.operationId}</strong>.
                  </p>
                ) : null}
                {selectedRelationship ? (
                  <>
                    <strong>Selected connection</strong>
                    {selectedRelationship.evidence.map((evidence, index) => (
                      <p
                        key={`${selectedRelationship.relationshipIds[index] ?? selectedRelationship.id}-${evidence.workflowVersionId}`}
                      >
                        {evidence.workflowName}, steps {evidence.sourceStepId} →{' '}
                        {evidence.targetStepId}
                        {evidence.destinationField ? `, field ${evidence.destinationField}` : ''}.{' '}
                        {workflowLifecycleLabels[evidence.workflowLifecycle]}. Exact versions{' '}
                        <code>{evidence.sourceCapabilityVersionId}</code> →{' '}
                        <code>{evidence.targetCapabilityVersionId}</code>.
                      </p>
                    ))}
                  </>
                ) : null}
              </aside>
              {selectedNode ? (
                <BreakSimulation
                  active={simulatedBreakNodeId === selectedNode.id}
                  node={selectedNode}
                  onClear={() => setSimulatedBreakNodeId(null)}
                  onSimulate={() => setSimulatedBreakNodeId(selectedNode.id)}
                  simulation={simulateCapabilityBreak(mapView, selectedNode.id)}
                />
              ) : null}
              {selectedNode ? (
                <ImpactDetails
                  impactRecovered={impactRecovered}
                  node={selectedNode}
                  onInspectVersion={inspectVersion}
                  sources={visibleOverview.impact?.sources ?? []}
                  sourceLabel={sourceLabel}
                />
              ) : null}
            </>
          }
        />
      )}
    </>
  );
}

export function CapabilityMapResult({
  remote,
  reload,
  routeState,
  onRouteStateChange,
  evidenceScope,
}: {
  remote: Remote<CapabilityOverview>;
  reload: () => void;
  routeState?: CapabilityMapRouteState;
  onRouteStateChange?: (state: CapabilityMapRouteState) => void;
  evidenceScope?: CapabilityMapEvidenceScope;
}) {
  if (remote.status === 'loading') {
    return (
      <p aria-busy="true" className="home-loading" role="status">
        {remote.retrying ? 'Retrying capability map…' : 'Loading capability map…'}
      </p>
    );
  }
  if (remote.status === 'error') {
    if (remote.message === capabilityMapAccessDeniedMessage) {
      return (
        <section className="cap-map-failure cap-map-denied" role="alert">
          <h2>Map access denied</h2>
          <p>{remote.message}</p>
        </section>
      );
    }
    return (
      <section className="cap-map-failure" role="alert">
        <h2>
          {remote.refreshFailure
            ? 'Capability map refresh failed'
            : 'Capability map could not be loaded'}
        </h2>
        <p>{remote.message}</p>
        <button onClick={reload} type="button">
          Try again
        </button>
      </section>
    );
  }
  return (
    <CapabilityMap
      {...(evidenceScope ? { evidenceScope } : {})}
      {...(onRouteStateChange ? { onRouteStateChange } : {})}
      overview={remote.data}
      {...(routeState ? { routeState } : {})}
    />
  );
}

export function capabilityOverviewFocusFromRoute(routeState: CapabilityMapRouteState) {
  return routeState.impactFocusType && routeState.impactFocusId
    ? { type: routeState.impactFocusType, id: routeState.impactFocusId }
    : undefined;
}

export function CapabilityMapPage() {
  const { organizationId, environmentId, role, setEnvironmentId } = useConsoleSession();
  const bearerToken = demoTokenForRole(role);
  const locationHash = useLocationHash();
  const previousLocationHash = useRef(locationHash);
  const routeState = useMemo(() => capabilityMapRouteStateFromHash(locationHash), [locationHash]);
  const overview = useCapabilityOverview(
    organizationId,
    environmentId,
    bearerToken,
    capabilityOverviewFocusFromRoute(routeState),
  );
  const setRouteState = useCallback(
    (next: CapabilityMapRouteState) => {
      const hash = capabilityMapHash(locationHash, environmentId, next);
      if (hash === window.location.hash) return;
      window.history.replaceState(null, '', hash);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    },
    [environmentId, locationHash],
  );

  useEffect(() => {
    const environmentAction = capabilityMapEnvironmentAction(
      previousLocationHash.current,
      locationHash,
      environmentId,
    );
    previousLocationHash.current = locationHash;
    if (environmentAction?.kind === 'use-linked') {
      setEnvironmentId(environmentAction.environmentId);
      return;
    }
    if (environmentAction?.kind === 'write-current') setRouteState(routeState);
  }, [environmentId, locationHash, routeState, setEnvironmentId, setRouteState]);

  return (
    <div className="capability-view-content">
      <header className="cat-heading">
        <div>
          <h1>Capability map</h1>
          <p className="cat-intro">
            Capabilities used by established workflows and the connections between them. Use the
            Catalog for the complete inventory.
          </p>
        </div>
      </header>
      <CapabilityMapResult
        evidenceScope={{ organizationId, environmentId, role }}
        onRouteStateChange={setRouteState}
        remote={overview.remote}
        reload={overview.reload}
        routeState={routeState}
      />
    </div>
  );
}
