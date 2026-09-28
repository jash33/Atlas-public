import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_equalsString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_basic,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useState } from 'react';

import type { Remote } from '../home/data.js';
import {
  parseHashParameter,
  runDetailHash,
  surfaceHash,
  workflowCatalogDetailHash,
  useLocationHash,
} from '../shell/router.js';
import { environmentLabels, useConsoleSession, type EnvironmentId } from '../shell/session.js';
import {
  catalogLifecycleStatuses,
  matchesCatalogSearch,
  useWorkflowCatalog,
  type WorkflowCatalogRow,
  type WorkflowLifecycleStatus,
} from './catalog.js';
import { WorkflowDetailPage } from './WorkflowDetailPage.js';
import { formatWorkflowDateTime, workflowLifecycleLabels } from './presentation.js';

const pageSize = 25;

const catalogTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  filterFns: {
    catalogSearch: (row, _columnId, value) =>
      typeof value !== 'string' || matchesCatalogSearch(row.original, value),
    equalsString: filterFn_equalsString,
  },
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic },
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

const columnHelper = createColumnHelper<typeof catalogTableFeatures, WorkflowCatalogRow>();

function navigateRow(event: React.MouseEvent<HTMLTableRowElement>, workflowId: string) {
  if ((event.target as HTMLElement).closest('a, button, input, select')) return;
  window.location.hash = workflowCatalogDetailHash(workflowId);
}

const columns = columnHelper.columns([
  columnHelper.accessor((workflow) => `${workflow.name} ${workflow.workflowId}`, {
    id: 'name',
    header: 'Name',
    cell: ({ row }) => {
      const workflow = row.original;
      return (
        <div className="wfc-name-cell">
          <a href={workflowCatalogDetailHash(workflow.workflowId)}>
            <strong>{workflow.name}</strong>
            <code>{workflow.workflowId}</code>
          </a>
        </div>
      );
    },
    enableSorting: false,
  }),
  columnHelper.accessor((workflow) => workflow.activeVersion?.workflowVersionId ?? '', {
    id: 'activeVersion',
    header: 'Active version',
    cell: ({ row }) =>
      row.original.activeVersion ? (
        <code>{row.original.activeVersion.workflowVersionId}</code>
      ) : (
        <span className="wfc-muted">Not active</span>
      ),
    enableSorting: false,
    enableGlobalFilter: false,
  }),
  columnHelper.accessor((workflow) => workflow.latestVersion.status, {
    id: 'latest',
    header: 'Latest version/status',
    cell: ({ row }) => (
      <div className="wfc-version-cell">
        <code>{row.original.latestVersion.workflowVersionId}</code>
        <span className={`wfc-status wfc-status-${row.original.latestVersion.status}`}>
          {workflowLifecycleLabels[row.original.latestVersion.status]}
        </span>
      </div>
    ),
    filterFn: 'equalsString',
    enableSorting: false,
    enableGlobalFilter: false,
  }),
  columnHelper.accessor((workflow) => workflow.mostRecentRun?.startedAt ?? '', {
    id: 'lastRun',
    header: 'Last run',
    cell: ({ row }) =>
      row.original.mostRecentRun ? (
        <div className="wfc-run-cell">
          <a href={runDetailHash(row.original.mostRecentRun.runId)}>
            {row.original.mostRecentRun.state.replaceAll('_', ' ')}
          </a>
          <time dateTime={row.original.mostRecentRun.startedAt}>
            {formatWorkflowDateTime(row.original.mostRecentRun.startedAt)}
          </time>
        </div>
      ) : (
        <span className="wfc-muted">Never run</span>
      ),
    enableSorting: false,
    enableGlobalFilter: false,
  }),
  columnHelper.accessor((workflow) => Date.parse(workflow.updatedAt), {
    id: 'updatedAt',
    header: ({ column }) => (
      <button
        aria-label={`Sort by updated time${column.getIsSorted() === 'desc' ? ', newest first' : ''}`}
        className="wfc-sort"
        onClick={column.getToggleSortingHandler()}
        type="button"
      >
        Updated <span aria-hidden="true">{column.getIsSorted() === 'asc' ? '↑' : '↓'}</span>
      </button>
    ),
    cell: ({ row }) => (
      <time dateTime={row.original.updatedAt}>
        {formatWorkflowDateTime(row.original.updatedAt)}
      </time>
    ),
    sortFn: 'basic',
    enableGlobalFilter: false,
  }),
]);

export interface WorkflowCatalogFilters {
  search: string;
  status: WorkflowLifecycleStatus | '';
}

export function WorkflowCatalogTable({
  filters,
  onFiltersChange,
  workflows,
}: {
  filters: WorkflowCatalogFilters;
  onFiltersChange: (filters: WorkflowCatalogFilters) => void;
  workflows: WorkflowCatalogRow[];
}) {
  const table = useTable({
    features: catalogTableFeatures,
    columns,
    data: workflows,
    getRowId: (workflow) => workflow.workflowId,
    getColumnCanGlobalFilter: (column) => column.id === 'name',
    globalFilterFn: 'catalogSearch',
    enableSortingRemoval: false,
    state: {
      globalFilter: filters.search,
      columnFilters: filters.status ? [{ id: 'latest', value: filters.status }] : [],
    },
    initialState: {
      sorting: [{ id: 'updatedAt', desc: true }],
      pagination: { pageIndex: 0, pageSize },
    },
  });

  const filteredCount = table.getFilteredRowModel().rows.length;
  const pagination = table.state.pagination;
  const pageStart = filteredCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const pageEnd = Math.min((pagination.pageIndex + 1) * pagination.pageSize, filteredCount);

  return (
    <section className="wfc-results" aria-label="Workflow Catalog results">
      <div className="wfc-controls">
        <label className="wfc-search">
          <span>Search workflows</span>
          <input
            onChange={(event) => onFiltersChange({ ...filters, search: event.target.value })}
            placeholder="Name or workflow ID"
            type="search"
            value={filters.search}
          />
        </label>
        <label>
          <span>Lifecycle status</span>
          <select
            onChange={(event) =>
              onFiltersChange({
                ...filters,
                status: event.target.value as WorkflowLifecycleStatus | '',
              })
            }
            value={filters.status}
          >
            <option value="">All statuses</option>
            {catalogLifecycleStatuses.map((status) => (
              <option key={status} value={status}>
                {workflowLifecycleLabels[status]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filteredCount === 0 ? (
        <div className="wfc-empty wfc-filtered-empty">
          <h2>No matching workflows</h2>
          <p>Clear the search or lifecycle filter to see this environment’s workflows.</p>
          <button
            onClick={() => {
              onFiltersChange({ search: '', status: '' });
            }}
            type="button"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <div className="wfc-table-scroll" tabIndex={0}>
            <table>
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id} scope="col">
                        {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} onClick={(event) => navigateRow(event, row.original.workflowId)}>
                    {row.getAllCells().map((cell) => (
                      <td key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav aria-label="Workflow Catalog pages" className="wfc-pagination">
            <p aria-live="polite">
              {pageStart}–{pageEnd} of {filteredCount} workflows
            </p>
            <div>
              <button
                disabled={!table.getCanPreviousPage()}
                onClick={() => table.previousPage()}
                type="button"
              >
                Previous
              </button>
              <span>
                Page {pagination.pageIndex + 1} of {table.getPageCount()}
              </span>
              <button
                disabled={!table.getCanNextPage()}
                onClick={() => table.nextPage()}
                type="button"
              >
                Next
              </button>
            </div>
          </nav>
        </>
      )}
    </section>
  );
}

export function WorkflowCatalogContent({
  environmentId,
  remote,
  reload,
}: {
  environmentId: EnvironmentId;
  remote: Remote<WorkflowCatalogRow[]>;
  reload: () => void;
}) {
  if (remote.status === 'loading') {
    return (
      <div aria-busy="true" className="wfc-loading">
        Loading workflows for {environmentLabels[environmentId]}…
      </div>
    );
  }
  if (remote.status === 'error') {
    return (
      <div className="wfc-failure" role="alert">
        <h2>Workflow Catalog could not load</h2>
        <p>{remote.message}</p>
        <button onClick={reload} type="button">
          Try again
        </button>
      </div>
    );
  }
  if (remote.data.length === 0) {
    return (
      <div className="wfc-empty">
        <h2>No workflows in {environmentLabels[environmentId]}</h2>
        <p>Create a workflow to start this environment’s Catalog.</p>
        <a href={surfaceHash('workflows')}>Create workflow</a>
      </div>
    );
  }
  return <ReadyWorkflowCatalog workflows={remote.data} />;
}

function ReadyWorkflowCatalog({ workflows }: { workflows: WorkflowCatalogRow[] }) {
  const [filters, setFilters] = useState<WorkflowCatalogFilters>({
    search: '',
    status: '',
  });
  return (
    <WorkflowCatalogTable filters={filters} onFiltersChange={setFilters} workflows={workflows} />
  );
}

function WorkflowCatalogIndexPage() {
  const { organizationId, environmentId } = useConsoleSession();
  const catalog = useWorkflowCatalog(organizationId, environmentId);
  return (
    <div className="wfc">
      <header className="wfc-heading">
        <div>
          <p className="wfc-kicker">Selected environment</p>
          <h1>Workflow Catalog</h1>
          <p>
            Find saved workflows, compare the active and latest versions, and copy the ingest
            request for an active version.
          </p>
        </div>
        <a className="wfc-create" href={surfaceHash('workflows')}>
          Create workflow
        </a>
      </header>
      <WorkflowCatalogContent
        environmentId={environmentId}
        key={`${organizationId}:${environmentId}`}
        reload={catalog.reload}
        remote={catalog.remote}
      />
    </div>
  );
}

export function WorkflowCatalogPage() {
  const workflowId = parseHashParameter(useLocationHash(), 'workflowId');
  return workflowId ? <WorkflowDetailPage workflowId={workflowId} /> : <WorkflowCatalogIndexPage />;
}
