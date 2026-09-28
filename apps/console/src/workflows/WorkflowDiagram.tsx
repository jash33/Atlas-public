import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { diagramEdgeKey } from './diagram-diagnostics.js';
import type { DiagramDiagnosticTargets, TargetedDiagnostic } from './diagram-diagnostics.js';
import { canInspectDiagramNode, type CapabilityDrawerState } from './diagram-drawer.js';
import {
  draftGraphNodeHeight,
  draftGraphNodeWidth,
  layoutDraftGraph,
  type DraftGraphLaidOutNode,
} from './draft-graph.js';
import {
  graphIdentityView,
  graphViewFromKey,
  graphViewTransform,
  isGraphControlKey,
  moveGraphItem,
  panGraphView,
  resetGraphView,
  wheelZoomFactor,
  zoomGraphView,
  zoomGraphViewIn,
  zoomGraphViewOut,
  type GraphView,
} from '../graph/graph-interactions.js';
import type { DiagramModel, DiagramNode } from './diagram-model.js';
import type { DiagramPreview } from './diagram-preview.js';
import { retryPolicySummary } from './workflow.js';

const dragThreshold = 5;

export function WorkflowDiagram({
  drawer,
  failedStep,
  onCloseDrawer,
  onOpenNode,
  preview,
  targets,
  title = 'Draft graph',
  versionLabel = 'Draft',
  validatedLabel = 'Server validated',
}: {
  drawer: CapabilityDrawerState;
  failedStep?: { message: string; stepId: string };
  onCloseDrawer: () => void;
  onOpenNode: (node: DiagramNode) => void;
  preview: DiagramPreview;
  targets: DiagramDiagnosticTargets;
  title?: string;
  versionLabel?: string;
  validatedLabel?: string;
}) {
  if (preview.status === 'hidden') return null;

  return (
    <section
      className="wf-graph"
      aria-label={title === 'Draft graph' ? 'Workflow draft graph' : title}
    >
      <div className="wf-panel-heading">
        <div>
          <small>{versionLabel}</small>
          <h3>{title}</h3>
          {(preview.status === 'server' ||
            preview.status === 'unsaved-preview' ||
            preview.status === 'draft-preview') && (
            <p className="wf-graph-hint">Drag steps · scroll to zoom</p>
          )}
        </div>
        <span className={preview.status === 'server' ? 'wf-ready' : 'wf-not-ready'}>
          {preview.status === 'server'
            ? validatedLabel
            : preview.status === 'unsaved-preview'
              ? 'Unsaved preview'
              : preview.status === 'draft-preview'
                ? 'Checks incomplete'
                : 'Not a validated graph'}
        </span>
      </div>
      {preview.status === 'unsaved-preview' && (
        <p className="wf-diagram-banner" role="status">
          {preview.banner}
        </p>
      )}
      {preview.status === 'invalid-yaml' && (
        <div className="wf-diagram-invalid" role="alert">
          <strong>Invalid YAML — diagram replaced</strong>
          <p>
            {preview.line !== undefined && preview.column !== undefined
              ? `Line ${preview.line}, column ${preview.column}. `
              : ''}
            {preview.detail}
          </p>
        </div>
      )}
      {preview.status === 'identity-changed' && (
        <div className="wf-diagram-invalid" role="alert">
          <strong>Identity fields changed</strong>
          <p>{preview.detail}</p>
        </div>
      )}
      {(preview.status === 'server' ||
        preview.status === 'unsaved-preview' ||
        preview.status === 'draft-preview') && (
        <DiagramBody
          title={title}
          drawer={drawer}
          {...(failedStep ? { failedStep } : {})}
          model={preview.graph}
          onCloseDrawer={onCloseDrawer}
          onOpenNode={onOpenNode}
          targets={targets}
        />
      )}
    </section>
  );
}

function DiagramBody({
  title,
  drawer,
  failedStep,
  model,
  onCloseDrawer,
  onOpenNode,
  targets,
}: {
  title: string;
  drawer: CapabilityDrawerState;
  failedStep?: { message: string; stepId: string };
  model: DiagramModel;
  onCloseDrawer: () => void;
  onOpenNode: (node: DiagramNode) => void;
  targets: DiagramDiagnosticTargets;
}) {
  const markerId = useId().replaceAll(':', '');
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<GraphDrag | null>(null);
  const didDragRef = useRef(false);
  const [viewport, setViewport] = useState<GraphView>(graphIdentityView);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [interaction, setInteraction] = useState<'idle' | 'panning' | 'dragging'>('idle');
  const layout = useMemo(() => layoutDraftGraph(model, positions), [model, positions]);
  const knownSteps = model.nodes.map((node) => node.stepId).join('\0');

  useEffect(() => {
    setPositions((current) => {
      const known = new Set(knownSteps.split('\0').filter(Boolean));
      let changed = false;
      const next = { ...current };
      for (const stepId of Object.keys(next)) {
        if (!known.has(stepId)) {
          delete next[stepId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [knownSteps]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      setViewport((current) =>
        zoomGraphView(current, wheelZoomFactor(event.deltaY), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
      );
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const graphCenter = () => {
    const rect = svgRef.current?.getBoundingClientRect();
    return rect ? { x: rect.width / 2, y: rect.height / 2 } : { x: 0, y: 0 };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest('.wf-d3-controls')) return;
    const handle = target?.closest('[data-diagram-draggable]');
    const stepId = handle?.getAttribute('data-diagram-draggable');
    const node = stepId ? layout.nodes.find((candidate) => candidate.stepId === stepId) : undefined;
    didDragRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      kind: stepId && node ? 'node' : 'pan',
      lastX: event.clientX,
      lastY: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      zoom: viewport.zoom,
      ...(stepId && node ? { stepId, nodeStart: { x: node.x, y: node.y } } : {}),
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.moved) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < dragThreshold) {
        return;
      }
      drag.moved = true;
      didDragRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setInteraction(drag.kind === 'node' ? 'dragging' : 'panning');
    }
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (drag.kind === 'pan') {
      setViewport((current) => panGraphView(current, dx, dy));
      return;
    }
    if (drag.kind === 'node' && drag.stepId && drag.nodeStart) {
      setPositions((current) =>
        moveGraphItem(
          current,
          drag.stepId!,
          drag.nodeStart!,
          { x: event.clientX - drag.startX, y: event.clientY - drag.startY },
          drag.zoom,
        ),
      );
    }
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setInteraction('idle');
  };

  return (
    <>
      {targets.diagramMarkers.length > 0 && (
        <ul className="wf-diagram-level-diagnostics">
          {targets.diagramMarkers.map((diagnostic) => (
            <li key={`${diagnostic.code}:${diagnostic.path}`}>
              <DiagnosticMarker diagnostic={diagnostic} />
            </li>
          ))}
        </ul>
      )}
      <div
        className={['wf-d3-viewport', interaction !== 'idle' ? `is-${interaction}` : '']
          .filter(Boolean)
          .join(' ')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        ref={viewportRef}
      >
        <svg
          aria-label={`${title} canvas`}
          className="wf-d3-graph"
          onDoubleClick={(event) => {
            if ((event.target as Element | null)?.closest('[data-diagram-draggable]')) return;
            setViewport(resetGraphView());
          }}
          onKeyDown={(event) => {
            if (!isGraphControlKey(event.key)) return;
            event.preventDefault();
            setViewport(
              (current) => graphViewFromKey(current, event.key, graphCenter()) ?? current,
            );
          }}
          ref={svgRef}
          tabIndex={0}
        >
          <defs>
            <pattern height="22" id={`${markerId}-grid`} patternUnits="userSpaceOnUse" width="22">
              <circle className="wf-d3-grid-dot" cx="1.2" cy="1.2" r="1.1" />
            </pattern>
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
          <rect className="wf-d3-hit" fill="transparent" height="100%" width="100%" />
          <g transform={graphViewTransform(viewport)}>
            <rect
              className="wf-d3-grid"
              fill={`url(#${markerId}-grid)`}
              height="8000"
              width="8000"
              x="-4000"
              y="-4000"
            />
            <g className="wf-d3-edges">
              {layout.edges.map((edge, index) => {
                const key = diagramEdgeKey(edge);
                return (
                  <g
                    className={[
                      'wf-d3-edge',
                      `wf-d3-edge-${edge.kind}`,
                      edge.origin ? `wf-d3-edge-mapping-${edge.origin}` : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    key={`${key}:${index}`}
                  >
                    <path d={edge.path} fill="none" markerEnd={`url(#${markerId}-arrow)`} />
                    <text textAnchor="middle" x={edge.labelX} y={edge.labelY}>
                      {edge.label}
                    </text>
                  </g>
                );
              })}
            </g>
            <g className="wf-d3-nodes">
              {layout.nodes.map((node) => (
                <DiagramNodeCard
                  didDragRef={didDragRef}
                  drawer={drawer}
                  failed={failedStep?.stepId === node.stepId}
                  independent={model.independentStepIds.includes(node.stepId)}
                  key={node.stepId}
                  markers={targets.nodeMarkers[node.stepId] ?? []}
                  node={node}
                  onCloseDrawer={onCloseDrawer}
                  onOpenNode={onOpenNode}
                  {...(failedStep?.stepId === node.stepId && failedStep.message
                    ? { failedMessage: failedStep.message }
                    : {})}
                />
              ))}
            </g>
          </g>
        </svg>
        <div className="wf-d3-controls">
          <button
            aria-label="Zoom in"
            onClick={() => setViewport((current) => zoomGraphViewIn(current, graphCenter()))}
            type="button"
          >
            +
          </button>
          <button
            aria-label="Zoom out"
            onClick={() => setViewport((current) => zoomGraphViewOut(current, graphCenter()))}
            type="button"
          >
            −
          </button>
          <button
            aria-label="Reset graph view"
            onClick={() => setViewport(resetGraphView())}
            type="button"
          >
            ⌂
          </button>
        </div>
      </div>
      {layout.edges.some(
        (edge) => (targets.edgeMarkers[diagramEdgeKey(edge)] ?? []).length > 0,
      ) && (
        <ul className="wf-diagram-edge-markers">
          {layout.edges.flatMap((edge, index) => {
            const key = diagramEdgeKey(edge);
            return (targets.edgeMarkers[key] ?? []).map((diagnostic) => (
              <li key={`${key}:${index}:${diagnostic.code}`}>
                <span>
                  {nodeName(model, edge.fromStepId)} {edge.label} {nodeName(model, edge.toStepId)}
                </span>
                <DiagnosticMarker diagnostic={diagnostic} />
              </li>
            ));
          })}
        </ul>
      )}
      <p className="wf-graph-note">
        Steps, order, data mappings, credentials, and irreversible boundaries are shown in ordinary
        language. Mappings you asked for and mappings Atlas inferred are marked separately.
        Independent steps have no order or data edge between them. Drag a step to rearrange it;
        connections stay attached.
      </p>
    </>
  );
}

function DiagramNodeCard({
  didDragRef,
  drawer,
  failed,
  failedMessage,
  independent,
  markers,
  node,
  onCloseDrawer,
  onOpenNode,
}: {
  didDragRef: { current: boolean };
  drawer: CapabilityDrawerState;
  failed: boolean;
  failedMessage?: string;
  independent: boolean;
  markers: readonly TargetedDiagnostic[];
  node: DraftGraphLaidOutNode;
  onCloseDrawer: () => void;
  onOpenNode: (node: DiagramNode) => void;
}) {
  const inspectable = canInspectDiagramNode(node);
  const selected =
    node.capabilityVersionId !== null && drawer.capabilityVersionId === node.capabilityVersionId;
  return (
    <g transform={`translate(${node.x} ${node.y})`}>
      <foreignObject height={draftGraphNodeHeight} width={draftGraphNodeWidth}>
        <div
          className={nodeClassName(node, selected, independent, failed)}
          data-diagram-draggable={node.stepId}
        >
          {inspectable ? (
            <button
              aria-expanded={selected}
              aria-label={`Inspect ${node.name} capability evidence`}
              data-diagram-step={node.stepId}
              onClick={() => {
                if (didDragRef.current) return;
                if (selected) onCloseDrawer();
                else onOpenNode(node);
              }}
              type="button"
            >
              <NodeCopy independent={independent} node={node} />
            </button>
          ) : (
            <div>
              <NodeCopy independent={independent} node={node} />
            </div>
          )}
          {failed && failedMessage && <p className="wf-graph-node-failure">{failedMessage}</p>}
          {markers.length > 0 && (
            <ul className="wf-diagram-markers">
              {markers.map((diagnostic) => (
                <li key={`${diagnostic.code}:${diagnostic.path}`}>
                  <DiagnosticMarker diagnostic={diagnostic} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </foreignObject>
    </g>
  );
}

function NodeCopy({ node, independent }: { node: DiagramNode; independent: boolean }) {
  const retrySummary = retryPolicySummary(node.retryPolicy);
  return (
    <>
      <span>{kindLabel(node.kind)}</span>
      <strong>{node.name}</strong>
      {node.apiAction && <em className="wf-diagram-action">{node.apiAction}</em>}
      {node.credential && <small className="wf-diagram-credential">Uses {node.credential}</small>}
      {retrySummary && <small>{retrySummary}</small>}
      {node.terminalState && <small>Ends as {node.terminalState}</small>}
      {node.constrainedBy.includes('order') && <small>Ordered after a prior step</small>}
      {node.constrainedBy.includes('data') && <small>Uses data from a prior step</small>}
      {independent && <small>No order or data dependency</small>}
    </>
  );
}

function kindLabel(kind: string): string {
  if (kind === 'capabilityCall') return 'Step';
  if (kind === 'terminal') return 'End';
  if (kind === 'input') return 'Input';
  return kind.replaceAll(/([A-Z])/g, ' $1');
}

function nodeName(
  model: { nodes: ReadonlyArray<{ stepId: string; name: string }> },
  stepId: string,
): string {
  return model.nodes.find((node) => node.stepId === stepId)?.name ?? stepId;
}

function nodeClassName(node: DiagramNode, selected: boolean, independent: boolean, failed = false) {
  const classes = ['wf-graph-node', `wf-graph-node-${node.kind}`];
  if (node.irreversible) classes.push('wf-irreversible');
  if (independent) classes.push('wf-independent');
  if (node.interactive) classes.push('wf-graph-node-interactive');
  if (selected) classes.push('wf-graph-node-selected');
  if (failed) classes.push('wf-graph-node-failed');
  return classes.join(' ');
}

function DiagnosticMarker({ diagnostic }: { diagnostic: TargetedDiagnostic }) {
  return (
    <span className={diagnostic.severity === 'warning' ? 'wf-diagram-warning' : 'wf-diagram-error'}>
      <b>{diagnostic.severity === 'warning' ? 'Warning' : 'Error'}</b>
      <span>{diagnostic.message}</span>
    </span>
  );
}

interface GraphDrag {
  pointerId: number;
  kind: 'pan' | 'node';
  lastX: number;
  lastY: number;
  startX: number;
  startY: number;
  moved: boolean;
  zoom: number;
  stepId?: string;
  nodeStart?: { x: number; y: number };
}
