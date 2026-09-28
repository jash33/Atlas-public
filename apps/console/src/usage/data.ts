import { consoleConfig } from '../config.js';
import { requestJson } from '../shell/api.js';
import { type UsageReport, usageReportQuery } from './usage.js';

export function loadUsageReport(
  input: {
    organizationId: string;
    environmentId: string;
    periodStart: string;
    periodEnd: string;
    timeZone: string;
    workflowId?: string;
  },
  bearerToken: string,
  signal?: AbortSignal,
) {
  return requestJson<UsageReport>(
    `/v1/usage-report?${usageReportQuery(input)}`,
    {
      ...(signal ? { signal } : {}),
      headers: { authorization: `Bearer ${bearerToken}` },
    },
    (status) =>
      status === 403
        ? 'Only Admins can view customer usage.'
        : `Usage could not be loaded (${status})`,
  );
}

export function usageReportCsvUrl(input: Parameters<typeof usageReportQuery>[0]) {
  return `${consoleConfig.backendUrl}/v1/usage-report.csv?${usageReportQuery(input)}`;
}
