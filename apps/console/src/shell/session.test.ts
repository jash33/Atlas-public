import { describe, expect, it, vi } from 'vite-plus/test';

import {
  canonicalizeRetiredEnvironmentUrl,
  demoProfileDetails,
  demoRoles,
  environmentStorageKey,
  environmentColorsStorageKey,
  readInitialEnvironment,
  readInitialDemoProfile,
  readInitialRole,
  readStored,
  readStoredEnvironmentColors,
  writeStored,
  writeStoredEnvironmentColors,
} from './session.js';

describe('demo profile link', () => {
  it('opens Burger Town in Development with the author role', () => {
    const values = new Map<string, string>([['atlas.console.role', 'operator']]);
    const storage = {
      getItem: vi.fn<(key: string) => string | null>((key) => values.get(key) ?? null),
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => values.set(key, value)),
    };
    vi.stubGlobal('window', {
      localStorage: storage,
      location: {
        href: 'http://localhost:5173/?demoProfile=burger-town&role=author#/capabilities?environmentId=development',
      },
    });

    expect(readInitialDemoProfile()).toBe('burger-town');
    expect(demoProfileDetails[readInitialDemoProfile()]).toMatchObject({
      organizationName: 'Burger Town',
      displayUser: { name: 'Burger Town Demo', email: 'demo@burgertown.local' },
      users: {
        author: { name: 'Burger Town Demo', email: 'demo@burgertown.local' },
      },
    });
    expect(readInitialRole()).toBe('author');
    expect(readInitialEnvironment()).toBe('development');
    expect(values.get('atlas.console.role')).toBe('author');
    vi.unstubAllGlobals();
  });

  it('uses the configured profile for an ordinary Console link', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => undefined },
      location: { href: 'http://localhost:5173/#/capabilities' },
    });

    expect(readInitialDemoProfile('burger-town')).toBe('burger-town');
    vi.unstubAllGlobals();
  });
});

describe('demo role preference', () => {
  it('persists a role switch and restores it on reload', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn<(key: string) => string | null>((key) => values.get(key) ?? null),
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => {
        values.set(key, value);
      }),
    };
    vi.stubGlobal('window', { localStorage: storage });

    writeStored('atlas.console.role', 'operator');

    expect(readStored('atlas.console.role', demoRoles, 'author')).toBe('operator');
    expect(storage.setItem).toHaveBeenCalledWith('atlas.console.role', 'operator');
    vi.unstubAllGlobals();
  });
});

describe('environment color preference', () => {
  it('persists both colors and restores them on reload', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn<(key: string) => string | null>((key) => values.get(key) ?? null),
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => {
        values.set(key, value);
      }),
    };
    vi.stubGlobal('window', { localStorage: storage });
    const colors = { development: '#256d9b', production: '#8f416f' };

    writeStoredEnvironmentColors(colors);

    expect(readStoredEnvironmentColors()).toEqual(colors);
    expect(storage.setItem).toHaveBeenCalledWith(
      environmentColorsStorageKey,
      JSON.stringify(colors),
    );
    vi.unstubAllGlobals();
  });

  it('moves a retired color preference to the canonical Production key', () => {
    const values = new Map<string, string>([
      [
        environmentColorsStorageKey,
        JSON.stringify({ development: '#256d9b', 'production-like': '#8f416f' }),
      ],
    ]);
    const storage = {
      getItem: vi.fn<(key: string) => string | null>((key) => values.get(key) ?? null),
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => values.set(key, value)),
    };
    vi.stubGlobal('window', { localStorage: storage });

    expect(readStoredEnvironmentColors()).toEqual({
      development: '#256d9b',
      production: '#8f416f',
    });
    expect(JSON.parse(values.get(environmentColorsStorageKey)!)).toEqual({
      development: '#256d9b',
      production: '#8f416f',
    });
    vi.unstubAllGlobals();
  });
});

describe('retired environment transition', () => {
  it('moves a retired saved selection to Production and persists only the canonical value', () => {
    const values = new Map([[environmentStorageKey, 'production-like']]);
    const storage = {
      getItem: vi.fn<(key: string) => string | null>((key) => values.get(key) ?? null),
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => values.set(key, value)),
    };
    vi.stubGlobal('window', { localStorage: storage, location: { href: 'http://atlas.local/' } });

    expect(readInitialEnvironment()).toBe('production');
    expect(values.get(environmentStorageKey)).toBe('production');
    vi.unstubAllGlobals();
  });

  it('uses a canonical bookmarked environment and persists it as the current selection', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn<(key: string) => string | null>((key) => values.get(key) ?? null),
      setItem: vi.fn<(key: string, value: string) => void>((key, value) => values.set(key, value)),
    };
    vi.stubGlobal('window', {
      localStorage: storage,
      location: { href: 'http://atlas.local/#/runs?environmentId=production' },
    });

    expect(readInitialEnvironment()).toBe('production');
    expect(values.get(environmentStorageKey)).toBe('production');
    vi.unstubAllGlobals();
  });

  it('replaces retired search and hash parameters with the canonical Production identity', () => {
    const replaceState =
      vi.fn<(data: unknown, unused: string, url?: string | URL | null) => void>();
    vi.stubGlobal('window', {
      location: {
        href: 'http://atlas.local/?environmentId=production-like#/runs?environmentId=production-like&runId=run-1',
      },
      history: { replaceState },
    });

    canonicalizeRetiredEnvironmentUrl();

    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState.mock.calls[0]?.[2]?.toString()).toBe(
      'http://atlas.local/?environmentId=production#/runs?environmentId=production&runId=run-1',
    );
    vi.unstubAllGlobals();
  });
});
