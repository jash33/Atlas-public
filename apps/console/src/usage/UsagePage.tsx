import { useCallback, useEffect, useMemo, useState } from 'react';

import { demoTokenForRole } from '../config.js';
import { consoleFetch } from '../shell/api.js';
import { environmentLabels, useConsoleSession } from '../shell/session.js';
import { loadWorkflowCatalog } from '../workflow-catalog/catalog.js';
import { loadUsageReport, usageReportCsvUrl } from './data.js';
import {
  defaultUsagePeriod,
  formatUsageInstant,
  switchRoleToViewUsage,
  type UsageReport,
} from './usage.js';

export function UsagePage() {
  const { organizationId, environmentId, role } = useConsoleSession();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const defaults = useMemo(() => defaultUsagePeriod(), []);
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [workflowId, setWorkflowId] = useState('');
  const [workflows, setWorkflows] = useState<Array<{ workflowId: string; name: string }>>([]);
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const canView = role === 'admin';
  const token = demoTokenForRole(role);
  const filters = useMemo(
    () => ({
      organizationId,
      environmentId,
      periodStart,
      periodEnd,
      timeZone,
      ...(workflowId ? { workflowId } : {}),
    }),
    [environmentId, organizationId, periodEnd, periodStart, timeZone, workflowId],
  );

  useEffect(() => {
    if (!canView) return;
    const abort = new AbortController();
    void loadWorkflowCatalog(organizationId, environmentId, abort.signal)
      .then((catalog) => {
        if (!abort.signal.aborted) {
          setWorkflows(catalog.map((row) => ({ workflowId: row.workflowId, name: row.name })));
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setWorkflows([]);
      });
    return () => abort.abort();
  }, [canView, environmentId, organizationId]);

  const load = useCallback(async () => {
    if (!canView) return;
    setBusy(true);
    setError(undefined);
    try {
      setReport(await loadUsageReport(filters, token));
    } catch (cause) {
      setReport(undefined);
      setError(cause instanceof Error ? cause.message : 'Usage could not be loaded');
    } finally {
      setBusy(false);
    }
  }, [canView, filters, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function downloadCsv() {
    const response = await consoleFetch(usageReportCsvUrl(filters), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      setError(`Usage export could not be downloaded (${response.status})`);
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'atlas-usage.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="usage">
      <header className="usage-heading">
        <div>
          <p>Customer usage</p>
          <h1>Started workflow runs</h1>
          <span>
            {environmentLabels[environmentId]} · {timeZone}. This is a usage record, not an invoice.
          </span>
        </div>
        <div className="usage-notice">
          <strong>Reporting only</strong>
          <small>Counts are for later billing review. They are not prices or invoices.</small>
        </div>
      </header>
      {!canView ? (
        <p className="usage-role-note">{switchRoleToViewUsage}</p>
      ) : (
        <>
          <form
            className="usage-filters"
            onSubmit={(event) => {
              event.preventDefault();
              void load();
            }}
          >
            <label>
              Start
              <input
                onChange={(event) => setPeriodStart(new Date(event.target.value).toISOString())}
                type="datetime-local"
                value={toLocalInputValue(periodStart)}
              />
            </label>
            <label>
              End (exclusive)
              <input
                onChange={(event) => setPeriodEnd(new Date(event.target.value).toISOString())}
                type="datetime-local"
                value={toLocalInputValue(periodEnd)}
              />
            </label>
            <label>
              Workflow
              <select onChange={(event) => setWorkflowId(event.target.value)} value={workflowId}>
                <option value="">All workflows</option>
                {workflows.map((workflow) => (
                  <option key={workflow.workflowId} value={workflow.workflowId}>
                    {workflow.name}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy} type="submit">
              Update report
            </button>
            <button disabled={busy || !report} onClick={() => void downloadCsv()} type="button">
              Download CSV
            </button>
          </form>
          {error && (
            <p className="usage-error" role="alert">
              {error}
            </p>
          )}
          {report && <UsageReportView report={report} />}
        </>
      )}
    </div>
  );
}

export function UsageReportView({ report }: { report: UsageReport }) {
  return (
    <section className="usage-report">
      {report.completeness === 'incomplete' && (
        <p className="usage-incomplete" role="status">
          {report.completenessNote}
        </p>
      )}
      <p className="usage-rules">{report.countingRules}</p>
      <dl className="usage-totals">
        <div>
          <dt>Customer started runs</dt>
          <dd>{report.customer.startedRuns}</dd>
        </div>
        <div>
          <dt>Succeeded</dt>
          <dd>{report.customer.outcomes.succeeded}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{report.customer.outcomes.failed}</dd>
        </div>
        <div>
          <dt>Cancelled</dt>
          <dd>{report.customer.outcomes.cancelled}</dd>
        </div>
        <div>
          <dt>Still running</dt>
          <dd>{report.customer.outcomes.inProgress}</dd>
        </div>
        <div>
          <dt>Test runs</dt>
          <dd>{report.test.startedRuns}</dd>
        </div>
        <div>
          <dt>Test passed</dt>
          <dd>{report.test.outcomes.passed}</dd>
        </div>
        <div>
          <dt>Test failed</dt>
          <dd>{report.test.outcomes.failed}</dd>
        </div>
      </dl>
      <p className="usage-reported">
        Report time {formatUsageInstant(report.reportedAt, report.timeZone)} · {report.timeZone}
      </p>
      <div className="usage-table-scroll" tabIndex={0}>
        <table className="usage-rows">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Run</th>
              <th>Workflow</th>
              <th>Started</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={`${row.kind}:${row.runId}`}>
                <td>{row.kind}</td>
                <td>{row.runId}</td>
                <td>{row.workflowName || row.workflowId || '—'}</td>
                <td>{formatUsageInstant(row.startedAt, report.timeZone)}</td>
                <td>{row.outcome}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function toLocalInputValue(iso: string) {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
