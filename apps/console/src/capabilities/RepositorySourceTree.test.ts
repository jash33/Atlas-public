// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { SessionProvider } from '../shell/session.js';
import { CapabilitiesPage } from './CapabilitiesPage.js';
import type { CatalogCapabilityDetail } from './catalog.js';

vi.mock('./OperationEvidenceDrawer.js', () => ({
  OperationEvidenceDrawer: ({ onClose }: { onClose: () => void }) =>
    createElement('button', { type: 'button', onClick: onClose }, 'Close evidence'),
}));

const ordersRepository = 'https://github.com/acme/orders';
const paymentsRepository = 'https://github.com/acme/payments';
function capability(
  id: string,
  serviceId: string,
  repository: string | null,
): CatalogCapabilityDetail {
  return {
    capabilityVersionId: id,
    identity: { kind: 'openapi', serviceId, operationId: id },
    fragment: { method: 'get', path: `/${id}` },
    annotation: null,
    provenance: {
      evidence: repository
        ? { kind: 'repository', repository, commit: 'abc', path: 'api.json' }
        : {
            kind: 'human-confirmed',
            label: 'Imported API',
            confirmedBy: 'admin',
            confirmedAt: '2026-09-22T12:00:00Z',
          },
    },
    observation: {
      availability: 'available',
      freshness: 'fresh',
      reason: 'successful-discovery',
      lastObservedAt: '2026-09-22T12:00:00Z',
      statusChangedAt: '2026-09-22T12:00:00Z',
    },
  };
}
const catalog = [
  capability('getInvoice', 'billing', ordersRepository),
  capability('shipOrder', 'fulfillment', ordersRepository),
  capability('chargeCard', 'billing', paymentsRepository),
  capability('legacyInvoice', 'billing', null),
];
function connection(id: string, repository: string) {
  return { id, repository, branches: ['main'], last_error: null, targets: [], candidates: [] };
}
const connections = [
  connection('orders', ordersRepository),
  connection('payments', paymentsRepository),
];

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

async function mountPage(
  options: {
    catalog?: CatalogCapabilityDetail[];
    connections?: typeof connections;
    repositoryFailure?: () => boolean;
    hash?: string;
  } = {},
) {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method && init.method !== 'GET') throw new Error('Browsing must not start analysis');
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
      'http://localhost',
    ).pathname;
    if (path === '/v1/capabilities')
      return Response.json({ capabilities: options.catalog ?? catalog });
    if (path === '/v1/capability-discoveries') return Response.json({ discoveries: [] });
    if (path === '/v1/capability-source-connections') return Response.json({ registrations: [] });
    if (path === '/v1/organizations/org_atlas/repositories') {
      if (options.repositoryFailure?.())
        return Response.json({ message: 'Temporarily unavailable' }, { status: 503 });
      return Response.json({
        configured: true,
        connections: options.connections ?? connections,
        catalog: [],
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  window.history.replaceState(null, '', `/${options.hash ?? '#/capabilities'}`);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(createElement(SessionProvider, null, createElement(CapabilitiesPage))),
  );
  return { element: container, fetcher };
}
async function click(element: Element, label: string) {
  const button = [...element.querySelectorAll('button')].find(
    (entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}
async function selectService(element: Element, source: string, service: string) {
  const group = element.querySelector(`[aria-label="${source} service groups"]`);
  const button = [...(group?.querySelectorAll('button') ?? [])].find(
    (entry) => entry.querySelector('strong')?.textContent === service,
  );
  if (!button) throw new Error(`Missing service ${source}/${service}`);
  await act(async () => button.click());
}

describe('repository-first capability browsing', () => {
  it('keeps the repository and service selected after closing a capability opened from a link', async () => {
    const { element } = await mountPage({ hash: '#/capabilities?capabilityVersionId=getInvoice' });
    expect(element.querySelector('[aria-label="acme/orders service groups"]')).not.toBeNull();
    expect(element.querySelector('[aria-label="Discovered operations"]')?.textContent).toContain(
      'getInvoice',
    );
    await click(element, 'Close evidence');
    expect(element.querySelector('[aria-label="Discovered operations"]')?.textContent).toContain(
      'getInvoice',
    );
    expect(
      element.querySelector('[aria-label="acme/orders service groups"] [aria-current="true"]')
        ?.textContent,
    ).toContain('billing');
  });
  it('starts with repositories, expands service groups, and filters same-named services without mixing repositories', async () => {
    const { element, fetcher } = await mountPage();
    const tree = element.querySelector('[aria-label="Capability sources"]')!;
    expect(tree.textContent).toContain('acme/orders');
    expect(tree.textContent).toContain('acme/payments');
    expect(tree.textContent).not.toContain('OpenAPI');
    expect(tree.querySelector('[aria-label="acme/orders service groups"]')).toBeNull();
    expect(element.textContent).toContain('Choose a repository');
    expect(element.querySelector('[aria-label="Discovered operations"]')).toBeNull();

    await click(tree, 'Select repository acme/orders');
    expect(tree.querySelector('[aria-label="acme/orders service groups"]')?.textContent).toContain(
      'fulfillment',
    );
    await selectService(tree, 'acme/orders', 'billing');
    expect(element.querySelector('[aria-label="Discovered operations"]')?.textContent).toContain(
      'getInvoice',
    );
    expect(
      element.querySelector('[aria-label="Discovered operations"]')?.textContent,
    ).not.toContain('chargeCard');
    expect(
      element.querySelector('[aria-label="Discovered operations"]')?.textContent,
    ).not.toContain('shipOrder');

    await click(tree, 'Select repository acme/payments');
    await selectService(tree, 'acme/payments', 'billing');
    expect(element.querySelector('[aria-label="Discovered operations"]')?.textContent).toContain(
      'chargeCard',
    );
    expect(
      element.querySelector('[aria-label="Discovered operations"]')?.textContent,
    ).not.toContain('getInvoice');
    await click(tree, 'Select repository acme/payments');
    expect(tree.querySelector('[aria-label="acme/payments service groups"]')).toBeNull();

    await click(tree, 'Select source Other sources');
    await selectService(tree, 'Other sources', 'billing');
    expect(element.querySelector('[aria-label="Discovered operations"]')?.textContent).toContain(
      'legacyInvoice',
    );
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it('lists connected repositories before they have capabilities and opens their saved analysis', async () => {
    const { element, fetcher } = await mountPage({
      catalog: [],
      connections: [connection('orders', ordersRepository)],
    });
    await click(element, 'Select repository acme/orders');
    expect(
      element.querySelector('[aria-label="acme/orders service groups"]')?.textContent,
    ).toContain('No capabilities yet');
    expect(element.textContent).toContain('No capabilities in this catalog yet');
    expect(element.querySelector('[aria-label="Repository details"]')?.textContent).toContain(
      'Queued',
    );
    await click(element, 'View Analysis');
    expect(
      element.querySelector('[aria-label="Capability views"] [aria-current="page"]')?.textContent,
    ).toBe('Repositories');
    expect(element.textContent).toContain('Repository contracts');
    expect(element.textContent).not.toContain('Back to catalog');
    expect(element.querySelector('#repository-analysis-details')?.getAttribute('aria-label')).toBe(
      'acme/orders analysis details',
    );
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it('keeps catalog repositories available when the connection list fails and allows a read-only retry', async () => {
    let failed = true;
    const { element, fetcher } = await mountPage({ repositoryFailure: () => failed });
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Couldn’t load connected repositories',
    );
    await click(element, 'Select repository acme/orders');
    await selectService(element, 'acme/orders', 'billing');
    expect(element.querySelector('[aria-label="Discovered operations"]')?.textContent).toContain(
      'getInvoice',
    );
    failed = false;
    await click(element, 'Retry loading repositories');
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.textContent).toContain('Repository details');
    await click(element, 'Select repository acme/orders');
    expect(element.querySelector('[aria-label="Repository details"]')).not.toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });
});
