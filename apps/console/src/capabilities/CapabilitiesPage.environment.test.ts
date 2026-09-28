import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import type { CatalogCapabilityDetail } from './catalog.js';

const testState = vi.hoisted(() => ({
  environmentId: 'production' as 'development' | 'production',
}));

const dataSpies = vi.hoisted(() => ({
  catalog: vi.fn<(organizationId: string, environmentId: string) => unknown>(),
  discoveries: vi.fn<(organizationId: string, environmentId: string) => unknown>(),
}));

vi.mock('../shell/session.js', () => ({
  useConsoleSession: () => ({
    organizationId: 'org_atlas',
    environmentId: testState.environmentId,
    role: 'author',
  }),
}));

vi.mock('./data.js', () => {
  const ready = <T>(data: T) => ({
    remote: { status: 'ready' as const, data },
    reload: vi.fn<() => void>(),
  });
  const capability = (environmentId: string): CatalogCapabilityDetail => ({
    capabilityIdentityId: `${environmentId}-capability`,
    capabilityVersionId: `${environmentId}-version`,
    identity: {
      kind: 'openapi' as const,
      serviceId: `${environmentId}-service`,
      operationId: `${environmentId}-operation`,
    },
    fragment: { method: 'get', path: `/${environmentId}` },
    annotation: null,
    provenance: {
      evidence: {
        kind: 'repository',
        repository: `https://github.com/acme/${environmentId}-repo`,
        commit: 'abc',
        path: 'api.json',
      },
    },
    observation: {
      availability: 'available',
      freshness: 'fresh',
      reason: 'successful-discovery',
      lastObservedAt: '2026-08-27T00:00:00.000Z',
      statusChangedAt: '2026-08-27T00:00:00.000Z',
    },
  });
  return {
    useCatalogCapabilities: dataSpies.catalog.mockImplementation(
      (_organizationId: string, environmentId: string) => ready([capability(environmentId)]),
    ),
    useServiceDiscoveries: dataSpies.discoveries.mockImplementation(
      (_organizationId: string, _environmentId: string) => ready([]),
    ),
    useSourceRegistrations: () => ready([]),
    useCatalogRepositories: () => ready([]),
    useDiscoveryDetail: () => ({
      remote: { status: 'loading' as const },
      reload: vi.fn<() => void>(),
    }),
    useCapabilityInspection: () => ({
      remote: { status: 'loading' as const },
      reload: vi.fn<() => void>(),
    }),
    usePlannerProjection: () => ({
      remote: { status: 'loading' as const },
      reload: vi.fn<() => void>(),
    }),
    useBurgerTownMonitoring: () =>
      ready({
        state: 'unavailable' as const,
        lastCompletedSweepAt: null,
        readinessMessage: 'Monitoring is unavailable in this test.',
      }),
    changeBurgerTownMonitoring: vi.fn<() => Promise<never>>(),
    rerunRegisteredSource: vi.fn<() => Promise<never>>(),
  };
});

import { CapabilitiesPage } from './CapabilitiesPage.js';

beforeAll(() => {
  vi.stubGlobal('window', {
    innerWidth: 1440,
    localStorage: { getItem: () => null, setItem: () => undefined },
    location: { hash: '' },
  });
});

describe('CapabilitiesPage environment isolation', () => {
  it('replaces a production-only estate with development-scoped content after switching', () => {
    testState.environmentId = 'production';
    const production = renderToStaticMarkup(createElement(CapabilitiesPage));
    expect(production).toContain('acme/production-repo');

    testState.environmentId = 'development';
    const development = renderToStaticMarkup(createElement(CapabilitiesPage));
    expect(development).toContain('acme/development-repo');
    expect(development).not.toContain('acme/production-repo');
    expect(dataSpies.catalog).toHaveBeenLastCalledWith('org_atlas', 'development');
    expect(dataSpies.discoveries).toHaveBeenLastCalledWith('org_atlas', 'development');
  });

  it('opens a notification-linked capability and keeps the risk notice inside its drawer', () => {
    testState.environmentId = 'production';
    window.location.hash = `#/capabilities?${new URLSearchParams({
      capability: 'production-capability',
      noticeTitle: 'Capability source is stale',
      noticeMessage: 'The latest discovery could not confirm this operation.',
      noticeSeverity: 'warning',
    })}`;

    const html = renderToStaticMarkup(createElement(CapabilitiesPage));
    const drawerIndex = html.indexOf('aria-label="Operation evidence"');
    const noticeIndex = html.indexOf('Capability source is stale');

    expect(drawerIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeGreaterThan(drawerIndex);
  });
});
