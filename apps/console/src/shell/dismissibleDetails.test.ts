import { describe, expect, it, vi } from 'vite-plus/test';

import { dismissDetailsFromOutside } from './dismissibleDetails.js';

describe('dismissible details', () => {
  it('closes an open popover for an outside target', () => {
    const details = {
      contains: vi.fn<(target: Node | null) => boolean>(() => false),
      open: true,
    };
    const target = {} as EventTarget;

    dismissDetailsFromOutside(details, target);

    expect(details.open).toBe(false);
    expect(details.contains).toHaveBeenCalledWith(target);
  });

  it('keeps the popover open for an inside target', () => {
    const details = {
      contains: vi.fn<(target: Node | null) => boolean>(() => true),
      open: true,
    };

    dismissDetailsFromOutside(details, {} as EventTarget);

    expect(details.open).toBe(true);
  });
});
