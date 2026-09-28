export const switchRoleToViewUsage = 'Switch to Admin to view customer usage.';

export interface UsageReport {
  organizationId: string;
  environmentId: string;
  workflowId: string | null;
  timeZone: string;
  periodStart: string;
  periodEnd: string;
  reportedAt: string;
  completeness: 'verified' | 'incomplete';
  completenessNote: string;
  countingRules: string;
  customer: {
    startedRuns: number;
    outcomes: {
      succeeded: number;
      failed: number;
      cancelled: number;
      inProgress: number;
    };
  };
  test: {
    startedRuns: number;
    outcomes: { passed: number; failed: number };
  };
  rows: Array<{
    kind: 'customer' | 'test';
    runId: string;
    workflowId: string | null;
    workflowName: string;
    environmentId: string;
    startedAt: string;
    outcome: string;
  }>;
}

export function defaultUsagePeriod(now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  const start = end - 7 * 24 * 60 * 60 * 1000;
  return {
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
  };
}

export function usageReportQuery(input: {
  organizationId: string;
  environmentId: string;
  periodStart: string;
  periodEnd: string;
  timeZone: string;
  workflowId?: string;
}) {
  const query = new URLSearchParams({
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    timeZone: input.timeZone,
  });
  if (input.workflowId) query.set('workflowId', input.workflowId);
  return query;
}

export function formatUsageInstant(value: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
