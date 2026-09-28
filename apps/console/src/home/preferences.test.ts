import { describe, expect, it, vi } from 'vite-plus/test';

import {
  homeWidgetsStorageKey,
  parseHomeWidgetIds,
  readHomeWidgetIds,
  toggleHomeWidget,
  writeHomeWidgetIds,
} from './preferences.js';

describe('Home widget preferences', () => {
  it('defaults to a welcome page with no widgets', () => {
    expect(parseHomeWidgetIds(null)).toEqual([]);
    expect(parseHomeWidgetIds('not-json')).toEqual([]);
    expect(parseHomeWidgetIds('{"runs":true}')).toEqual([]);
  });

  it('keeps known widgets in product order and ignores stale values', () => {
    expect(parseHomeWidgetIds('["activity","unknown","runs","activity"]')).toEqual([
      'runs',
      'activity',
    ]);
  });

  it('adds and removes one widget without disturbing the others', () => {
    expect(toggleHomeWidget(['runs'], 'activity')).toEqual(['runs', 'activity']);
    expect(toggleHomeWidget(['runs', 'activity'], 'runs')).toEqual(['activity']);
  });

  it('fails open when browser storage is unavailable', () => {
    expect(
      readHomeWidgetIds({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toEqual([]);

    const setItem = vi.fn<(key: string, value: string) => void>(() => {
      throw new Error('blocked');
    });
    expect(() => writeHomeWidgetIds({ setItem }, ['runs'])).not.toThrow();
    expect(setItem).toHaveBeenCalledWith(homeWidgetsStorageKey, '["runs"]');
  });
});
