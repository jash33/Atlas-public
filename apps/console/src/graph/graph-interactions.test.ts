import { describe, expect, it } from 'vite-plus/test';

import {
  graphIdentityView,
  graphMaxZoom,
  graphMinZoom,
  isGraphControlKey,
  graphViewFromKey,
  graphViewTransform,
  moveGraphItem,
  panGraphView,
  wheelZoomFactor,
  zoomGraphView,
  zoomGraphViewIn,
  zoomGraphViewOut,
} from './graph-interactions.js';

describe('graph view controls', () => {
  it('zooms around the chosen point without moving that point on screen', () => {
    const zoomed = zoomGraphView(graphIdentityView, 2, { x: 100, y: 50 });

    expect(zoomed).toEqual({ x: -100, y: -50, zoom: 2 });
    expect((100 - zoomed.x) / zoomed.zoom).toBe(100);
    expect((50 - zoomed.y) / zoomed.zoom).toBe(50);
  });

  it('supports wheel, button, keyboard, pan, reset, and zoom limits', () => {
    const panned = panGraphView(graphIdentityView, 12, -8);
    const zoomedIn = zoomGraphViewIn(graphIdentityView, { x: 40, y: 20 });
    const zoomedOut = zoomGraphViewOut(graphIdentityView, { x: 40, y: 20 });
    const clampedIn = zoomGraphView(graphIdentityView, 100, { x: 40, y: 20 });
    const clampedOut = zoomGraphView(graphIdentityView, 0.01, { x: 40, y: 20 });
    const wideMapZoom = zoomGraphView(graphIdentityView, 0.1, { x: 40, y: 20 }, 0.08);

    expect(graphViewTransform(graphIdentityView)).toBe('translate(0 0) scale(1)');
    expect(panned).toEqual({ x: 12, y: -8, zoom: 1 });
    expect(zoomedIn.zoom).toBeGreaterThan(1);
    expect(zoomedOut.zoom).toBeLessThan(1);
    expect(clampedIn.zoom).toBe(graphMaxZoom);
    expect(clampedOut.zoom).toBe(graphMinZoom);
    expect(wideMapZoom.zoom).toBe(0.1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(120)).toBeLessThan(1);
    expect(wheelZoomFactor(-120)).toBeGreaterThan(1);
    expect(graphViewFromKey(graphIdentityView, 'ArrowLeft', { x: 0, y: 0 })).toEqual({
      x: 40,
      y: 0,
      zoom: 1,
    });
    expect(graphViewFromKey(graphIdentityView, '+', { x: 40, y: 20 })).toEqual(zoomedIn);
    expect(graphViewFromKey(zoomedIn, '0', { x: 40, y: 20 })).toEqual(graphIdentityView);
    expect(graphViewFromKey(graphIdentityView, 'Enter', { x: 0, y: 0 })).toBeNull();
    expect(isGraphControlKey('ArrowDown')).toBe(true);
    expect(isGraphControlKey('Enter')).toBe(false);
  });
});

describe('graph item movement', () => {
  it('converts screen movement into graph movement at the current zoom', () => {
    expect(moveGraphItem({}, 'payment', { x: 24, y: 48 }, { x: 40, y: -20 }, 2)).toEqual({
      payment: { x: 44, y: 38 },
    });
  });
});
