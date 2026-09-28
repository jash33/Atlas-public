import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { CapabilityArchitecture } from '@atlas/workflow-ir';

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
import { RemoteView } from '../shell/RemoteView.js';
import { parseHashParameter, useLocationHash } from '../shell/router.js';
import { useConsoleSession, type EnvironmentId } from '../shell/session.js';
import { demoTokenForRole } from '../config.js';
import {
  architectureFitView,
  architectureNodeHeight,
  architectureNodeWidth,
  architecturePointFromScreen,
  architectureViewport,
  layoutCapabilityArchitecture,
  type ArchitectureRecipeFilter,
} from './capability-architecture-model.js';
import { useCapabilityArchitecture } from './data.js';

const relationshipLabels = {
  'data-flow': 'Passes data to',
  'execution-order': 'Runs before',
} as const;

export function architectureRecipeFromHash(hash: string): ArchitectureRecipeFilter {
  return parseHashParameter(hash, 'recipe') ?? 'all';
}

export function capabilityArchitectureHash(
  environmentId: EnvironmentId,
  recipe: ArchitectureRecipeFilter,
): string {
  const parameters = new URLSearchParams({
    view: 'architecture',
    environmentId,
  });
  if (recipe !== 'all') parameters.set('recipe', recipe);
  return `#/capabilities?${parameters}`;
}

export function CapabilityArchitectureGraph({
  architecture,
  recipe,
}: {
  architecture: CapabilityArchitecture;
  recipe: ArchitectureRecipeFilter;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const layout = useMemo(
    () => layoutCapabilityArchitecture(architecture, recipe),
    [architecture, recipe],
  );
  const fittedView = useMemo(() => architectureFitView(layout), [layout]);
  const [view, setView] = useState<GraphView>(() => fittedView);
  const minimumZoom = Math.min(graphMinZoom, fittedView.zoom);

  useEffect(() => {
    setView({ x: fittedView.x, y: fittedView.y, zoom: fittedView.zoom });
  }, [fittedView.x, fittedView.y, fittedView.zoom]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = svg.getBoundingClientRect();
      const origin = architecturePointFromScreen(bounds, {
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
    x: architectureViewport.width / 2,
    y: architectureViewport.height / 2,
  });
  const startPan = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = architecturePointFromScreen(bounds, {
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
    const point = architecturePointFromScreen(bounds, {
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
    <div className="cap-arch-diagram">
      <svg
        aria-label="Pan and zoom provider architecture"
        className="cap-arch-canvas"
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
        viewBox={`0 0 ${architectureViewport.width} ${architectureViewport.height}`}
      >
        <g transform={graphViewTransform(view)}>
          {layout.relationships.map((relationship) => (
            <g className={`cap-arch-edge cap-arch-edge-${relationship.kind}`} key={relationship.id}>
              <path d={relationship.path} fill="none" />
              <title>
                {relationshipLabels[relationship.kind]}
                {relationship.destinationField ? ` ${relationship.destinationField}` : ''}
              </title>
            </g>
          ))}
          {layout.nodes.map((node) => (
            <g className="cap-arch-node" key={node.id}>
              <rect
                height={architectureNodeHeight}
                rx="8"
                width={architectureNodeWidth}
                x={node.x}
                y={node.y}
              />
              <text x={node.x + 12} y={node.y + 28}>
                {node.operationId}
              </text>
              <text className="cap-arch-node-recipe" x={node.x + 12} y={node.y + 46}>
                {node.workflowName}
              </text>
            </g>
          ))}
        </g>
      </svg>
      <div className="cap-arch-controls">
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
        <button
          aria-label="Reset architecture to fit"
          onClick={() => setView(fittedView)}
          type="button"
        >
          Fit
        </button>
      </div>
      <p className="cap-arch-hint">Drag to pan · scroll to zoom</p>
    </div>
  );
}

export function CapabilityArchitectureView({
  architecture,
  environmentId,
  recipe,
}: {
  architecture: CapabilityArchitecture;
  environmentId: EnvironmentId;
  recipe: ArchitectureRecipeFilter;
}) {
  if (architecture.status === 'empty') {
    return (
      <section className="cap-arch-empty" role="status">
        <p>{architecture.notices[0]}</p>
        <p>
          Connect Burger Town from Catalog. Atlas reads OpenAPI operations and, when present, the
          Arazzo recipes that describe how those operations are meant to chain.
        </p>
      </section>
    );
  }
  return (
    <section className="cap-arch">
      {architecture.notices.map((notice) => (
        <p className="cap-arch-notice" key={notice} role="note">
          {notice}
        </p>
      ))}
      <div className="cap-arch-recipes" role="tablist" aria-label="Provider recipes">
        <a
          aria-current={recipe === 'all' ? 'true' : undefined}
          href={capabilityArchitectureHash(environmentId, 'all')}
        >
          All recipes
        </a>
        {architecture.workflows.map((workflow) => (
          <a
            aria-current={recipe === workflow.workflowId ? 'true' : undefined}
            href={capabilityArchitectureHash(environmentId, workflow.workflowId)}
            key={workflow.workflowId}
          >
            {workflow.summary}
          </a>
        ))}
      </div>
      <CapabilityArchitectureGraph architecture={architecture} recipe={recipe} />
    </section>
  );
}

export function CapabilityArchitecturePage() {
  const { organizationId, environmentId, role } = useConsoleSession();
  const architecture = useCapabilityArchitecture(
    organizationId,
    environmentId,
    demoTokenForRole(role),
  );
  const recipe = architectureRecipeFromHash(useLocationHash());
  return (
    <div className="capability-view-content">
      <header className="cat-heading">
        <div>
          <h1>Provider architecture</h1>
          <p className="cat-intro">
            How the connected source says its APIs chain. This is the posted recipe, not Atlas blast
            radius. Proven impact stays on Map.
          </p>
        </div>
      </header>
      <RemoteView remote={architecture.remote} reload={architecture.reload}>
        {(data) => (
          <CapabilityArchitectureView
            architecture={data}
            environmentId={environmentId}
            recipe={recipe}
          />
        )}
      </RemoteView>
    </div>
  );
}
