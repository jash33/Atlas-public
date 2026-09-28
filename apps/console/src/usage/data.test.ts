import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { loadUsageReport, usageReportCsvUrl } from './data.js';

afterEach(() => vi.unstubAllGlobals());

const filters = {
  organizationId: 'org_atlas',
  environmentId: 'development',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-09-08T00:00:00.000Z',
  timeZone: 'America/Chicago',
};

describe('Usage API client', () => {
  it('loads the admin usage report for the selected environment and period', async () => {
    const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json({ customer: { startedRuns: 2 } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await loadUsageReport(filters, 'admin-token');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        '/v1/usage-report?organizationId=org_atlas&environmentId=development&periodStart=2026-09-01T00%3A00%3A00.000Z&periodEnd=2026-09-08T00%3A00%3A00.000Z&timeZone=America%2FChicago',
      ),
      expect.objectContaining({
        headers: { authorization: 'Bearer admin-token' },
      }),
    );
  });

  it('points CSV download at the same filters as the JSON report', () => {
    expect(usageReportCsvUrl({ ...filters, workflowId: 'workflow_checkout' })).toContain(
      '/v1/usage-report.csv?',
    );
    expect(usageReportCsvUrl({ ...filters, workflowId: 'workflow_checkout' })).toContain(
      'workflowId=workflow_checkout',
    );
  });

  it('tells non-admins they cannot view customer usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(
        async () => new Response(JSON.stringify({ error: 'admin-role-required' }), { status: 403 }),
      ),
    );

    await expect(loadUsageReport(filters, 'author-token')).rejects.toThrow(
      'Only Admins can view customer usage.',
    );
  });
});
