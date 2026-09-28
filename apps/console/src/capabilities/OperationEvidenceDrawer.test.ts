import { describe, expect, it } from 'vite-plus/test';

import {
  defaultDrawerWidth,
  draggedDrawerWidth,
  keyboardDrawerWidth,
  maximumDrawerWidth,
  minimumDrawerWidth,
  parseDrawerWidth,
  readDrawerWidth,
  writeDrawerWidth,
} from './OperationEvidenceDrawer.js';

describe('operation evidence drawer resizing', () => {
  it('grows when its left edge is dragged left and shrinks when dragged right', () => {
    expect(draggedDrawerWidth(defaultDrawerWidth, 500, 420, 1440)).toBe(700);
    expect(draggedDrawerWidth(defaultDrawerWidth, 500, 580, 1440)).toBe(540);
  });

  it('clamps dragging to the supported viewport range', () => {
    expect(draggedDrawerWidth(defaultDrawerWidth, 500, 900, 1440)).toBe(minimumDrawerWidth);
    expect(draggedDrawerWidth(defaultDrawerWidth, 500, -900, 1440)).toBe(maximumDrawerWidth(1440));
  });

  it('supports keyboard resizing from the vertical separator', () => {
    expect(keyboardDrawerWidth(620, 'ArrowLeft', 1440)).toBe(652);
    expect(keyboardDrawerWidth(620, 'ArrowRight', 1440)).toBe(588);
    expect(keyboardDrawerWidth(620, 'Home', 1440)).toBe(minimumDrawerWidth);
    expect(keyboardDrawerWidth(620, 'End', 1440)).toBe(maximumDrawerWidth(1440));
    expect(keyboardDrawerWidth(620, 'Escape', 1440)).toBeNull();
  });

  it('restores a saved width and clamps it to the current viewport', () => {
    expect(parseDrawerWidth('780', 1440)).toBe(780);
    expect(parseDrawerWidth('1400', 1000)).toBe(maximumDrawerWidth(1000));
    expect(parseDrawerWidth('not-a-width', 1440)).toBe(defaultDrawerWidth);
  });

  it('reads and writes the local drawer preference', () => {
    let saved: string | null = '744';
    const storage = {
      getItem: () => saved,
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    };

    expect(readDrawerWidth(storage, 1440)).toBe(744);
    writeDrawerWidth(storage, 812.4);
    expect(saved).toBe('812');
  });
});
