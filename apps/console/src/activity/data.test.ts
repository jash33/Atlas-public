import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { loadActivityHistory } from './data.js';

afterEach(() => vi.unstubAllGlobals());

describe('Activity API client', () => {
  it('loads append-only history in the globally selected environment', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ entries: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;

    await loadActivityHistory('org_atlas', 'production', signal);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/v1/audit-entries?organizationId=org_atlas&environmentId=production',
      ),
      { signal },
    );
  });
});
