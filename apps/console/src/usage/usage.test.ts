import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vite-plus/test';

import { UsageReportView } from './UsagePage.js';
import { defaultUsagePeriod, usageReportQuery, type UsageReport } from './usage.js';

const report: UsageReport = {
  organizationId: 'org_atlas',
  environmentId: 'development',
  workflowId: null,
  timeZone: 'America/Chicago',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-09-08T00:00:00.000Z',
  reportedAt: '2026-09-08T18:00:00.000Z',
  completeness: 'incomplete',
  completenessNote:
    'This report is incomplete. Some started runs are missing a matching run or lifecycle record. Do not treat these totals as a verified billing figure.',
  countingRules:
    'A started workflow counts once, whether it later succeeds, fails, is cancelled, or is still running.',
  customer: {
    startedRuns: 2,
    outcomes: { succeeded: 1, failed: 1, cancelled: 0, inProgress: 0 },
  },
  test: {
    startedRuns: 1,
    outcomes: { passed: 1, failed: 0 },
  },
  rows: [
    {
      kind: 'customer',
      runId: 'run_ok',
      workflowId: 'workflow_checkout',
      workflowName: 'Checkout',
      environmentId: 'development',
      startedAt: '2026-09-03T15:00:00.000Z',
      outcome: 'succeeded',
    },
    {
      kind: 'test',
      runId: 'sandbox:1',
      workflowId: 'workflow_kitchen',
      workflowName: 'Kitchen',
      environmentId: 'development',
      startedAt: '2026-09-05T18:00:00.000Z',
      outcome: 'passed',
    },
  ],
};

describe('usage report query', () => {
  it('defaults to the previous seven UTC days ending at the next midnight', () => {
    expect(defaultUsagePeriod(new Date('2026-09-08T18:30:00.000Z'))).toEqual({
      periodStart: '2026-09-02T00:00:00.000Z',
      periodEnd: '2026-09-09T00:00:00.000Z',
    });
  });

  it('applies the same workflow and environment filters used by the CSV export', () => {
    expect(
      usageReportQuery({
        organizationId: 'org_atlas',
        environmentId: 'development',
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-09-08T00:00:00.000Z',
        timeZone: 'America/Chicago',
        workflowId: 'workflow_checkout',
      }).toString(),
    ).toBe(
      'organizationId=org_atlas&environmentId=development&periodStart=2026-09-01T00%3A00%3A00.000Z&periodEnd=2026-09-08T00%3A00%3A00.000Z&timeZone=America%2FChicago&workflowId=workflow_checkout',
    );
  });
});

describe('UsageReportView', () => {
  it('explains counting rules and shows customer outcomes separately from test totals', () => {
    const html = renderToStaticMarkup(createElement(UsageReportView, { report }));
    expect(html).toContain('A started workflow counts once');
    expect(html).toContain('Do not treat these totals as a verified billing figure');
    expect(html).toContain('>2</dd>');
    expect(html).toContain('Customer started runs');
    expect(html).toContain('Test runs');
    expect(html).toContain('run_ok');
    expect(html).toContain('sandbox:1');
    expect(html).not.toContain('REDACTED');
    expect(html).not.toContain('payload');
  });
});
