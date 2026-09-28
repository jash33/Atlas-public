// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { RepositoryContracts, repositoryFreshness } from './RepositoryContracts.js';
import type { RepositoryProgress } from './RepositoryAnalysis.js';

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function collection(overrides: Record<string, unknown> = {}) {
  return {
    configured: true,
    connections: [
      {
        id: 'connection',
        repository: 'https://github.com/example/api',
        branches: ['main'],
        last_error: null,
        next_check_at: '2026-09-22T12:00:00Z',
        targets: [],
        candidates: [],
        ...overrides,
      },
    ],
    catalog: [],
  };
}
async function mountRepository(
  fetcher: typeof fetch,
  canManage = false,
  initialConnectionId?: string,
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetcher);
  const element = document.createElement('div');
  document.body.append(element);
  container = element;
  root = createRoot(element);
  await act(async () => {
    root?.render(
      createElement(RepositoryContracts, {
        organizationId: 'org',
        environmentId: 'development',
        bearerToken: 'viewer',
        canManage,
        initialConnectionId: initialConnectionId ?? null,
        onClose: () => {},
      }),
    );
  });
  return element;
}
async function openAnalysis(element: HTMLDivElement, name = 'example/api') {
  const button = [...element.querySelectorAll('button')].find(
    (entry) => entry.getAttribute('aria-label') === `View analysis for ${name}`,
  );
  if (!button) throw new Error(`Repository ${name} is missing from the list`);
  await act(async () => button.click());
  return element;
}
async function mountInitialConnection(lastError: string | null) {
  return openAnalysis(
    await mountRepository(async () => Response.json(collection({ last_error: lastError }))),
  );
}
function runningProgress(): RepositoryProgress {
  return {
    status: 'running',
    phase: 'extracting',
    message: 'Reading customer validation.',
    startedAt: new Date(Date.now() - 60000).toISOString(),
    updatedAt: new Date().toISOString(),
    operationsDrafted: 12,
    operationsDiscovered: 30,
    servicesFound: 2,
    sourceFiles: 80,
    filesRead: 20,
    activity: [
      {
        at: new Date().toISOString(),
        phase: 'extracting',
        message: '12 operation definitions drafted.',
      },
    ],
  };
}

describe('repository contract review', () => {
  it('opens on a repository list and shows saved failures only for the selected repository', async () => {
    const data = collection({ last_error: 'This repository is either private or unreachable.' });
    data.connections.push({
      ...collection().connections[0]!,
      id: 'second',
      repository: 'https://github.com/example/billing',
      branches: ['release'],
    });
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(data));
    const element = await mountRepository(fetcher);
    const list = element.querySelector('[aria-label="Connected repositories"]')!;
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(list.textContent).toContain('example/api');
    expect(list.textContent).toContain('example/billing');
    expect(list.textContent).toContain('main');
    expect(list.textContent).toContain('release');
    expect(list.textContent).toContain('Needs attention');
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.querySelector('#repository-analysis-details')).toBeNull();

    await openAnalysis(element);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Couldn’t connect to example/api',
    );
    await openAnalysis(element, 'example/billing');
    expect(element.querySelector('#repository-analysis-details')?.getAttribute('aria-label')).toBe(
      'example/billing analysis details',
    );
    expect(element.querySelector('[role="alert"]')).toBeNull();
    const back = [...element.querySelectorAll('button')].find(
      (entry) => entry.textContent === 'Back to repository list',
    )!;
    await act(async () => back.click());
    expect(element.querySelector('#repository-analysis-details')).toBeNull();
    expect(list.querySelectorAll('li')).toHaveLength(2);
    expect(fetcher.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });
  it('keeps new ingestion visible and sends it only to the selected repository', async () => {
    const data = collection();
    data.connections.push({
      ...data.connections[0]!,
      id: 'second',
      repository: 'https://github.com/example/billing',
    });
    const posted: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST') {
        posted.push(input instanceof Request ? input.url : input.toString());
        return Response.json({ status: 'queued' });
      }
      return Response.json(data);
    });
    const element = await mountRepository(fetcher, true);
    await openAnalysis(element, 'example/billing');
    const ingestion = element.querySelector(
      '[aria-label="Ingest new capabilities or revise descriptions"]',
    )!;
    const button = ingestion.querySelector('button')!;
    expect(button.textContent).toBe('Start a new ingestion');
    expect(button.closest('details')).toBeNull();
    expect(ingestion.textContent).toContain('full definitions for human review');
    await act(async () => button.click());
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('/repositories/second/ingest');
  });
  it('opens the repository named by a notification link', async () => {
    const data = collection();
    data.connections.push({
      ...data.connections[0]!,
      id: 'second',
      repository: 'https://github.com/example/billing',
    });
    const element = await mountRepository(async () => Response.json(data), false, 'second');
    expect(element.querySelector('#repository-analysis-details')?.getAttribute('aria-label')).toBe(
      'example/billing analysis details',
    );
    expect(element.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label')).toBe(
      'View analysis for example/billing',
    );
  });
  it('shows an initial fetch failure without claiming analysis is still running', async () => {
    const element = await mountInitialConnection(
      'This repository is either private or unreachable.',
    );
    expect(element.textContent).toContain('Tracking main');
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'This repository is either private or unreachable.',
    );
    expect(element.querySelector('[role="alert"]')?.textContent).toContain(
      'Couldn’t connect to example/api',
    );
    expect(element.textContent).not.toContain('Initial analysis is queued or running.');
    expect(element.textContent).toContain('Analysis failed');
    expect(
      element.querySelector('[role="alert"]')?.classList.contains('repository-tone-error'),
    ).toBe(true);
    expect(element.querySelector('.repository-spinner')).toBeNull();
  });
  it('shows pending analysis before the first check has returned', async () => {
    const element = await mountInitialConnection(null);
    expect(element.textContent).toContain(
      'Your analysis is queued. Waiting for a worker to start.',
    );
    expect(element.querySelector('[role="alert"]')).toBeNull();
  });
  it('does not blame repository access for a saved Atlas database failure', async () => {
    const element = await mountInitialConnection(
      'column "progress" of relation "github_repository_connections" does not exist',
    );
    const alert = element.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Analysis needs attention');
    expect(alert?.textContent).not.toContain('Couldn’t connect');
    expect(alert?.textContent).not.toContain('Check the repository address');
    expect(element.querySelector('.repository-spinner')).toBeNull();
  });
  it('shows a distinct loading state until the first response arrives', async () => {
    const response = Promise.withResolvers<Response>();
    const element = await mountRepository(() => response.promise);
    expect(element.querySelector('[aria-busy="true"]')?.textContent).toContain(
      'Loading repositories',
    );
    await act(async () => {
      response.resolve(Response.json(collection()));
    });
    expect(element.querySelector('[aria-busy="true"]')).toBeNull();
    expect(element.querySelector('[aria-label="Connected repositories"]')?.textContent).toContain(
      'example/api',
    );
    expect(element.querySelector('#repository-analysis-details')).toBeNull();
  });
  it('refreshes real stage updates and counts without pretending drafts are verified', async () => {
    vi.useFakeTimers();
    let progress = runningProgress();
    const element = await mountRepository(async () => Response.json(collection({ progress })));
    await openAnalysis(element);
    expect(element.querySelector('[aria-current="step"]')?.textContent).toContain('Read contracts');
    expect(element.querySelector('progress')?.value).toBe(12);
    expect(element.querySelector('progress')?.max).toBe(30);
    expect(element.textContent).toContain('Drafts still need final checks');
    progress = {
      ...progress,
      phase: 'checking',
      operationsDrafted: 30,
      message: 'Checking source references.',
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(element.querySelector('[aria-current="step"]')?.textContent).toContain('Check results');
    expect(element.textContent).toContain('Checking source references.');
    expect(element.querySelector('progress')?.value).toBe(30);
  });
  it('marks missing worker updates as uncertain while keeping the last confirmed work', async () => {
    vi.useFakeTimers();
    const progress = runningProgress();
    const element = await mountRepository(async () => Response.json(collection({ progress })));
    await openAnalysis(element);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125000);
    });
    expect(element.textContent).toContain('No recent analysis updates');
    expect(element.textContent).toContain('Analysis may still be running');
    expect(element.querySelector('progress')?.value).toBe(12);
    expect(element.querySelector('.repository-spinner')).toBeNull();
  });
  it('shows polling failures and clears them when the connection recovers', async () => {
    vi.useFakeTimers();
    const progress = runningProgress();
    let connected = true;
    const fetcher = vi.fn<typeof fetch>(async () => {
      if (!connected) throw new Error('Connection unavailable');
      return Response.json(
        collection({ progress: { ...progress, updatedAt: new Date().toISOString() } }),
      );
    });
    const element = await mountRepository(fetcher);
    await openAnalysis(element);
    connected = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(element.textContent).toContain('Live updates interrupted');
    expect(element.textContent).toContain('Connection to Atlas interrupted');
    expect(element.querySelector('progress')?.value).toBe(12);
    connected = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.textContent).not.toContain('Updates interrupted');
  });
  it('shows a queued retry instead of the error from the previous attempt', async () => {
    const element = await mountRepository(async () =>
      Response.json(
        collection({
          last_error: 'Previous fetch failed',
          progress: { ...runningProgress(), status: 'queued', phase: 'connecting' },
        }),
      ),
    );
    await openAnalysis(element);
    expect(element.textContent).toContain('Waiting to start');
    expect(element.querySelector('[role="alert"]')).toBeNull();
    expect(element.textContent).not.toContain('Previous fetch failed');
  });
  it('opens the real review from the completed stage and keeps publication controls hidden for viewers', async () => {
    const candidate = {
      id: 'draft',
      branch: 'main',
      repository: 'https://github.com/example/api',
      commit_sha: 'abc',
      kind: 'initial',
      status: 'review',
      candidate_hash: 'hash',
      documents: [],
      changes: [],
    };
    const fetcher = vi.fn<typeof fetch>(async (input) =>
      Response.json(
        (input instanceof Request ? input.url : input.toString()).endsWith('/candidates/draft')
          ? candidate
          : collection({
              progress: { ...runningProgress(), status: 'succeeded', phase: 'complete' },
              candidates: [candidate],
            }),
      ),
    );
    const element = await mountRepository(fetcher);
    await openAnalysis(element);
    const button = [...element.querySelectorAll('button')].find(
      (entry) => entry.textContent === 'Review contracts →',
    )!;
    await act(async () => button.click());
    expect(element.querySelector('[aria-label="Review repository candidate"]')).not.toBeNull();
    expect(element.textContent).not.toContain('Accept these contracts');
    expect(
      fetcher.mock.calls.some(([input]) =>
        (input instanceof Request ? input.url : input.toString()).endsWith('/candidates/draft'),
      ),
    ).toBe(true);
  });
  it('shows source freshness independently of accepted versions', () => {
    const target = {
      target_key: 'branch:main',
      last_successful_commit: 'abc',
      last_successful_at: '2026-09-21T12:00:00Z',
      last_error: null,
    };
    expect(repositoryFreshness(target, Date.parse('2026-09-21T12:30:00Z'))).toBe(
      'Checked recently',
    );
    expect(repositoryFreshness(target, Date.parse('2026-09-21T15:00:00Z'))).toBe('Out of date');
    expect(repositoryFreshness({ ...target, last_error: 'Fetch failed' })).toContain(
      'last successful result',
    );
  });
  it('saves the team notification preference without starting an analysis', async () => {
    let environmentId: string | null = null;
    const postedUrls: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (init?.method === 'POST') {
        postedUrls.push(url);
        if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
        environmentId = JSON.parse(init.body).environmentId;
        return Response.json({ environmentId });
      }
      return Response.json(collection({ notify_environment_id: environmentId }));
    });
    const element = await mountRepository(fetcher, true);
    await openAnalysis(element);
    const checkbox = element.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => checkbox.click());
    expect(environmentId).toBe('development');
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(environmentId).toBeNull();
    expect(checkbox.checked).toBe(false);
    expect(postedUrls).toHaveLength(2);
    expect(postedUrls.every((url) => url.endsWith('/connection/notifications'))).toBe(true);
  });
  it('keeps repository review accessible to viewers without publication controls', () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryContracts, {
        organizationId: 'org',
        bearerToken: 'viewer',
        canManage: false,
        onClose: () => {},
      }),
    );
    expect(html).toContain('Accepted repository capabilities');
    expect(html).toContain('Deployment confirmation');
    expect(html).not.toContain('Connect and analyze');
    expect(html).not.toContain('Accept these contracts');
  });
});
