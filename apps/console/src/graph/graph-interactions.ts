export const graphMinZoom = 0.35;
export const graphMaxZoom = 2.75;
export const graphIdentityView: GraphView = { x: 0, y: 0, zoom: 1 };

const buttonZoomFactor = 1.25;
const keyboardPanDistance = 40;
const wheelZoomIntensity = 0.0015;
const graphControlKeys = new Set([
  '+',
  '=',
  '-',
  '_',
  '0',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

export interface GraphView {
  x: number;
  y: number;
  zoom: number;
}

export type GraphItemPositions = Readonly<Record<string, { x: number; y: number }>>;

export function graphViewTransform(view: GraphView): string {
  return `translate(${view.x} ${view.y}) scale(${view.zoom})`;
}

export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * wheelZoomIntensity);
}

export function zoomGraphView(
  view: GraphView,
  factor: number,
  origin: { x: number; y: number },
  minimumZoom = graphMinZoom,
): GraphView {
  const nextZoom = Math.min(graphMaxZoom, Math.max(minimumZoom, view.zoom * factor));
  if (nextZoom === view.zoom) return view;
  const graphX = (origin.x - view.x) / view.zoom;
  const graphY = (origin.y - view.y) / view.zoom;
  return {
    zoom: nextZoom,
    x: origin.x - graphX * nextZoom,
    y: origin.y - graphY * nextZoom,
  };
}

export function zoomGraphViewIn(
  view: GraphView,
  origin: { x: number; y: number },
  minimumZoom = graphMinZoom,
): GraphView {
  return zoomGraphView(view, buttonZoomFactor, origin, minimumZoom);
}

export function zoomGraphViewOut(
  view: GraphView,
  origin: { x: number; y: number },
  minimumZoom = graphMinZoom,
): GraphView {
  return zoomGraphView(view, 1 / buttonZoomFactor, origin, minimumZoom);
}

export function panGraphView(view: GraphView, dx: number, dy: number): GraphView {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

export function resetGraphView(): GraphView {
  return graphIdentityView;
}

export function isGraphControlKey(key: string): boolean {
  return graphControlKeys.has(key);
}

export function graphViewFromKey(
  view: GraphView,
  key: string,
  origin: { x: number; y: number },
  minimumZoom = graphMinZoom,
): GraphView | null {
  if (key === '+' || key === '=') return zoomGraphViewIn(view, origin, minimumZoom);
  if (key === '-' || key === '_') return zoomGraphViewOut(view, origin, minimumZoom);
  if (key === '0') return resetGraphView();
  if (key === 'ArrowLeft') return panGraphView(view, keyboardPanDistance, 0);
  if (key === 'ArrowRight') return panGraphView(view, -keyboardPanDistance, 0);
  if (key === 'ArrowUp') return panGraphView(view, 0, keyboardPanDistance);
  if (key === 'ArrowDown') return panGraphView(view, 0, -keyboardPanDistance);
  return null;
}

export function moveGraphItem(
  positions: GraphItemPositions,
  itemId: string,
  current: { x: number; y: number },
  screenChange: { x: number; y: number },
  zoom: number,
): Record<string, { x: number; y: number }> {
  const safeZoom = zoom === 0 ? 1 : zoom;
  return {
    ...positions,
    [itemId]: {
      x: current.x + screenChange.x / safeZoom,
      y: current.y + screenChange.y / safeZoom,
    },
  };
}
