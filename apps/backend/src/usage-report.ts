import type { Pool } from 'pg';
import { z } from 'zod';

export const usageReportCountingRules = [
  'A started workflow counts once, whether it later succeeds, fails, is cancelled, or is still running.',
  'A repeated intake request, repeated lifecycle update, step retry, worker restart, pause/resume, or recovery of the same run adds no new run.',
  'An explicitly started new run with a new run ID counts separately.',
  'Rejected requests and queued requests that have not started do not count as started runs.',
  'Sandbox and test runs are reported separately and are excluded from the customer run total.',
  'The period uses run start time: inclusive start, exclusive end. Outcome counts describe those same runs as of the report time.',
].join(' ');

export const usageReportQuerySchema = z
  .object({
    organizationId: z.string().trim().min(1),
    environmentId: z.string().trim().min(1),
    workflowId: z.string().trim().min(1).optional(),
    periodStart: z.iso.datetime({ offset: true }),
    periodEnd: z.iso.datetime({ offset: true }),
    timeZone: z.string().trim().min(1),
  })
  .strict()
  .superRefine((query, context) => {
    if (Date.parse(query.periodStart) >= Date.parse(query.periodEnd)) {
      context.addIssue({
        code: 'custom',
        message: 'periodEnd must be after periodStart',
        path: ['periodEnd'],
      });
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: query.timeZone }).format();
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'timeZone must be a valid IANA time zone',
        path: ['timeZone'],
      });
    }
  });

export type UsageReportQuery = z.infer<typeof usageReportQuerySchema>;

export type UsageRunKind = 'customer' | 'test';
export type UsageCustomerOutcome = 'succeeded' | 'failed' | 'cancelled' | 'inProgress';
export type UsageTestOutcome = 'passed' | 'failed';
export type UsageCompleteness = 'verified' | 'incomplete';

export interface UsageReportRow {
  readonly kind: UsageRunKind;
  readonly runId: string;
  readonly workflowId: string | null;
  readonly workflowName: string;
  readonly environmentId: string;
  readonly startedAt: string;
  readonly outcome: UsageCustomerOutcome | UsageTestOutcome;
}

export interface UsageReport {
  readonly organizationId: string;
  readonly environmentId: string;
  readonly workflowId: string | null;
  readonly timeZone: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly reportedAt: string;
  readonly completeness: UsageCompleteness;
  readonly completenessNote: string;
  readonly countingRules: string;
  readonly customer: {
    readonly startedRuns: number;
    readonly outcomes: Record<UsageCustomerOutcome, number>;
  };
  readonly test: {
    readonly startedRuns: number;
    readonly outcomes: Record<UsageTestOutcome, number>;
  };
  readonly rows: readonly UsageReportRow[];
}

type CustomerRow = {
  readonly run_id: string;
  readonly workflow_id: string | null;
  readonly workflow_name: string | null;
  readonly environment_id: string;
  readonly started_at: Date;
  readonly state:
    | 'running'
    | 'completed'
    | 'validation_failed'
    | 'manual_review'
    | 'repair_required';
  readonly disposition: 'active' | 'abandoned';
  readonly lifecycle_outcome: 'succeeded' | 'failed' | null;
  readonly has_lifecycle: boolean;
  readonly has_run: boolean;
};

type TestRow = {
  readonly id: string;
  readonly workflow_id: string | null;
  readonly workflow_name: string | null;
  readonly environment_id: string;
  readonly tested_at: Date;
  readonly status: 'passed' | 'failed';
};

const emptyCustomerOutcomes = (): Record<UsageCustomerOutcome, number> => ({
  succeeded: 0,
  failed: 0,
  cancelled: 0,
  inProgress: 0,
});

const emptyTestOutcomes = (): Record<UsageTestOutcome, number> => ({
  passed: 0,
  failed: 0,
});

export function customerRunOutcome(row: {
  state: CustomerRow['state'];
  disposition: CustomerRow['disposition'];
  lifecycle_outcome: CustomerRow['lifecycle_outcome'];
  has_run: boolean;
}): UsageCustomerOutcome {
  if (row.disposition === 'abandoned') return 'cancelled';
  if (row.has_run) {
    if (row.state === 'running') return 'inProgress';
    if (row.state === 'completed') return 'succeeded';
    return 'failed';
  }
  if (row.lifecycle_outcome === 'succeeded') return 'succeeded';
  if (row.lifecycle_outcome === 'failed') return 'failed';
  return 'inProgress';
}

export async function readUsageReport(
  pool: Pick<Pool, 'query'>,
  query: UsageReportQuery,
  reportedAt = new Date(),
): Promise<UsageReport> {
  const filters = [
    query.organizationId,
    query.environmentId,
    query.periodStart,
    query.periodEnd,
    query.workflowId ?? null,
  ];
  const customerResult = await pool.query<CustomerRow>(
    `SELECT run.run_id,
            version.workflow_id,
            COALESCE(identity.name, lifecycle.workflow_name, '') AS workflow_name,
            run.environment_id,
            COALESCE(lifecycle.started_at, run.started_at) AS started_at,
            run.state,
            run.disposition,
            lifecycle.outcome AS lifecycle_outcome,
            TRUE AS has_run,
            lifecycle.run_id IS NOT NULL AS has_lifecycle
     FROM workflow_runs run
     JOIN workflow_versions version
       ON version.organization_id = run.organization_id
      AND version.workflow_version_id = run.workflow_version_id
     LEFT JOIN workflow_identities identity
       ON identity.organization_id = version.organization_id
      AND identity.workflow_id = version.workflow_id
     LEFT JOIN workflow_run_lifecycles lifecycle
       ON lifecycle.organization_id = run.organization_id
      AND lifecycle.environment_id = run.environment_id
      AND lifecycle.run_id = run.run_id
     WHERE run.organization_id = $1
       AND run.environment_id = $2
       AND COALESCE(lifecycle.started_at, run.started_at) >= $3::timestamptz
       AND COALESCE(lifecycle.started_at, run.started_at) < $4::timestamptz
       AND ($5::text IS NULL OR version.workflow_id = $5)
     UNION ALL
     SELECT lifecycle.run_id,
            version.workflow_id,
            COALESCE(identity.name, lifecycle.workflow_name, '') AS workflow_name,
            lifecycle.environment_id,
            lifecycle.started_at,
            COALESCE(run.state, 'running') AS state,
            COALESCE(run.disposition, 'active') AS disposition,
            lifecycle.outcome AS lifecycle_outcome,
            run.run_id IS NOT NULL AS has_run,
            TRUE AS has_lifecycle
     FROM workflow_run_lifecycles lifecycle
     LEFT JOIN workflow_runs run
       ON run.organization_id = lifecycle.organization_id
      AND run.environment_id = lifecycle.environment_id
      AND run.run_id = lifecycle.run_id
     LEFT JOIN workflow_versions version
       ON version.organization_id = run.organization_id
      AND version.workflow_version_id = run.workflow_version_id
     LEFT JOIN workflow_identities identity
       ON identity.organization_id = version.organization_id
      AND identity.workflow_id = version.workflow_id
     WHERE lifecycle.organization_id = $1
       AND lifecycle.environment_id = $2
       AND run.run_id IS NULL
       AND lifecycle.started_at >= $3::timestamptz
       AND lifecycle.started_at < $4::timestamptz
       AND $5::text IS NULL`,
    filters,
  );
  const testResult = await pool.query<TestRow>(
    `SELECT test.id::text AS id,
            version.workflow_id,
            COALESCE(identity.name, '') AS workflow_name,
            test.environment_id,
            test.tested_at,
            test.status
     FROM workflow_sandbox_test_runs test
     JOIN workflow_versions version
       ON version.organization_id = test.organization_id
      AND version.workflow_version_id = test.workflow_version_id
     LEFT JOIN workflow_identities identity
       ON identity.organization_id = version.organization_id
      AND identity.workflow_id = version.workflow_id
     WHERE test.organization_id = $1
       AND test.environment_id = $2
       AND test.tested_at >= $3::timestamptz
       AND test.tested_at < $4::timestamptz
       AND ($5::text IS NULL OR version.workflow_id = $5)`,
    filters,
  );

  const seen = new Set<string>();
  const customerRows: UsageReportRow[] = [];
  let incomplete = false;
  const customerOutcomes = emptyCustomerOutcomes();
  for (const row of customerResult.rows) {
    if (seen.has(row.run_id)) continue;
    seen.add(row.run_id);
    if (!row.has_run || !row.has_lifecycle) incomplete = true;
    const outcome = customerRunOutcome(row);
    customerOutcomes[outcome] += 1;
    customerRows.push({
      kind: 'customer',
      runId: row.run_id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name ?? '',
      environmentId: row.environment_id,
      startedAt: row.started_at.toISOString(),
      outcome,
    });
  }

  const testOutcomes = emptyTestOutcomes();
  const testRows: UsageReportRow[] = testResult.rows.map((row) => {
    testOutcomes[row.status] += 1;
    return {
      kind: 'test' as const,
      runId: `sandbox:${row.id}`,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name ?? '',
      environmentId: row.environment_id,
      startedAt: row.tested_at.toISOString(),
      outcome: row.status,
    };
  });

  const rows = [...customerRows, ...testRows].sort((left, right) =>
    left.startedAt === right.startedAt
      ? left.runId.localeCompare(right.runId)
      : left.startedAt.localeCompare(right.startedAt),
  );

  return {
    organizationId: query.organizationId,
    environmentId: query.environmentId,
    workflowId: query.workflowId ?? null,
    timeZone: query.timeZone,
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
    reportedAt: reportedAt.toISOString(),
    completeness: incomplete ? 'incomplete' : 'verified',
    completenessNote: incomplete
      ? 'This report is incomplete. Some started runs are missing a matching run or lifecycle record. Do not treat these totals as a verified billing figure.'
      : 'Every customer run in this period has a matching started-run record and lifecycle row.',
    countingRules: usageReportCountingRules,
    customer: {
      startedRuns: customerRows.length,
      outcomes: customerOutcomes,
    },
    test: {
      startedRuns: testRows.length,
      outcomes: testOutcomes,
    },
    rows,
  };
}

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function formatUsageReportCsv(report: UsageReport): string {
  const header = [
    `# Atlas usage report`,
    `# timeZone=${report.timeZone}`,
    `# periodStart=${report.periodStart}`,
    `# periodEnd=${report.periodEnd}`,
    `# reportedAt=${report.reportedAt}`,
    `# completeness=${report.completeness}`,
    `# customerStartedRuns=${report.customer.startedRuns}`,
    `# customerSucceeded=${report.customer.outcomes.succeeded}`,
    `# customerFailed=${report.customer.outcomes.failed}`,
    `# customerCancelled=${report.customer.outcomes.cancelled}`,
    `# customerInProgress=${report.customer.outcomes.inProgress}`,
    `# testStartedRuns=${report.test.startedRuns}`,
    `# testPassed=${report.test.outcomes.passed}`,
    `# testFailed=${report.test.outcomes.failed}`,
    `# countingRules=${report.countingRules}`,
    'kind,runId,workflowId,workflowName,environmentId,startedAt,outcome',
  ];
  const body = report.rows.map((row) =>
    [
      row.kind,
      row.runId,
      row.workflowId,
      row.workflowName,
      row.environmentId,
      row.startedAt,
      row.outcome,
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[...header, ...body].join('\n')}\n`;
}
