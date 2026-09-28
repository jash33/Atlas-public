import type { ReactNode } from 'react';
import type { Remote } from '../home/data.js';
import { CatalogWorkflowDiagram } from './CatalogWorkflowDiagram.js';
import {
  runDetailHash,
  surfaceHash,
  workflowEditHash,
  workflowReviewHash,
} from '../shell/router.js';
import { environmentLabels, useConsoleSession, type EnvironmentId } from '../shell/session.js';
import { InvokeUnavailablePanel, InvokeViaApiPanel } from './InvokeViaApiPanel.js';
import { useWorkflowDetail, type WorkflowCatalogDetail } from './catalog.js';
import { formatWorkflowDateTime, workflowLifecycleLabels } from './presentation.js';

export function approvedDiagramVersion(detail: WorkflowCatalogDetail): string | undefined {
  return (
    detail.activeVersion?.workflowVersionId ??
    detail.versions.find((version) => version.approval !== null)?.workflowVersionId
  );
}

function lifecycleSummary(detail: WorkflowCatalogDetail): string {
  if (!detail.activeVersion) return workflowLifecycleLabels[detail.latestVersion.status];
  if (detail.activeVersion.workflowVersionId === detail.latestVersion.workflowVersionId) {
    return 'Active';
  }
  return `Active with newer ${workflowLifecycleLabels[detail.latestVersion.status].toLocaleLowerCase()}`;
}

function latestVersionAction(detail: WorkflowCatalogDetail): { label: string; href: string } {
  const { workflowId, latestVersion } = detail;
  if (
    latestVersion.status === 'awaiting-approval' ||
    latestVersion.status === 'approved-inactive'
  ) {
    return {
      label: 'Review and approve this version in Create Workflow',
      href: workflowReviewHash(workflowId, latestVersion.workflowVersionId),
    };
  }
  if (latestVersion.status === 'active') {
    return {
      label: 'Review this version in Create Workflow',
      href: workflowReviewHash(workflowId, latestVersion.workflowVersionId),
    };
  }
  return {
    label: 'Edit latest version in Create Workflow',
    href: workflowEditHash(workflowId, latestVersion.workflowVersionId),
  };
}

function formatRunDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

function triggerLabel(run: WorkflowCatalogDetail['recentRuns'][number]): string {
  if (run.trigger.type === 'webhook') return `Webhook · ${run.trigger.deliveryId}`;
  if (run.trigger.type === 'api') return `API · ${run.trigger.deliveryId}`;
  if (run.trigger.type === 'schedule') return `Schedule · ${run.trigger.scheduleId}`;
  return 'Manual';
}

export function WorkflowDetailContent({
  environmentId,
  remote,
  reload,
  diagram,
}: {
  environmentId: EnvironmentId;
  remote: Remote<WorkflowCatalogDetail>;
  reload: () => void;
  diagram?: ReactNode;
}) {
  if (remote.status === 'loading') {
    return (
      <div aria-busy="true" className="wfc-loading">
        Loading workflow details for {environmentLabels[environmentId]}…
      </div>
    );
  }
  if (remote.status === 'error') {
    return (
      <div className="wfc-failure" role="alert">
        <h1>Workflow details could not load</h1>
        <p>{remote.message}</p>
        <a href={surfaceHash('workflow-catalog')}>Back to Workflow Catalog</a>
        <button onClick={reload} type="button">
          Try again
        </button>
      </div>
    );
  }

  const detail = remote.data;
  const versionAction = latestVersionAction(detail);
  return (
    <div className="wfd">
      <a className="wfd-back" href={surfaceHash('workflow-catalog')}>
        ← Workflow Catalog
      </a>
      <header className="wfd-heading">
        <div>
          <p className="wfc-kicker">{environmentLabels[environmentId]} workflow</p>
          <h1>{detail.name}</h1>
          <code>{detail.workflowId}</code>
        </div>
        <a className="wfc-create" href={versionAction.href}>
          {versionAction.label}
        </a>
      </header>

      <section aria-labelledby="workflow-overview-heading" className="wfd-panel">
        <h2 id="workflow-overview-heading">Overview</h2>
        <dl className="wfd-overview-grid">
          <div>
            <dt>Lifecycle</dt>
            <dd>{lifecycleSummary(detail)}</dd>
          </div>
          <div>
            <dt>Active version</dt>
            <dd>{detail.activeVersion?.workflowVersionId ?? 'None'}</dd>
          </div>
          <div>
            <dt>Latest version</dt>
            <dd>{detail.latestVersion.workflowVersionId}</dd>
          </div>
          <div>
            <dt>Latest lifecycle</dt>
            <dd>{workflowLifecycleLabels[detail.latestVersion.status]}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>
              <time dateTime={detail.updatedAt}>{formatWorkflowDateTime(detail.updatedAt)}</time>
            </dd>
          </div>
        </dl>
      </section>

      {approvedDiagramVersion(detail) ? diagram : null}

      {detail.activeVersion ? (
        <InvokeViaApiPanel
          key={`${environmentId}:${detail.activeVersion.workflowVersionId}`}
          environmentId={environmentId}
          inputSchema={detail.inputSchema}
          invocationExample={detail.invocationExample ?? null}
          workflowName={detail.name}
        />
      ) : (
        <InvokeUnavailablePanel environmentId={environmentId} />
      )}

      <section aria-labelledby="version-history-heading" className="wfd-panel">
        <header className="wfd-section-heading">
          <div>
            <p>Immutable evidence</p>
            <h2 id="version-history-heading">Version history</h2>
          </div>
          <span>{detail.versions.length} versions</span>
        </header>
        {detail.versions.length === 0 ? (
          <p className="wfd-empty">No version history is available for this workflow.</p>
        ) : (
          <ol className="wfd-version-list">
            {detail.versions.map((version) => (
              <li key={version.workflowVersionId}>
                <div>
                  <code>{version.workflowVersionId}</code>
                  <span className={`wfc-status wfc-status-${version.status}`}>
                    {workflowLifecycleLabels[version.status]}
                  </span>
                  {version.isActive && <strong>Active version</strong>}
                </div>
                <dl>
                  <div>
                    <dt>Saved</dt>
                    <dd>
                      <time dateTime={version.createdAt}>
                        {formatWorkflowDateTime(version.createdAt)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>Approval evidence</dt>
                    <dd>
                      {version.approval ? (
                        <>
                          {version.approval.approvedBy} ·{' '}
                          <time dateTime={version.approval.approvedAt}>
                            {formatWorkflowDateTime(version.approval.approvedAt)}
                          </time>
                        </>
                      ) : (
                        'Not approved'
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="recent-runs-heading" className="wfd-panel">
        <header className="wfd-section-heading">
          <div>
            <p>Selected environment</p>
            <h2 id="recent-runs-heading">Recent runs</h2>
          </div>
          <span>{detail.recentRuns.length} shown</span>
        </header>
        {detail.recentRuns.length === 0 ? (
          <p className="wfd-empty">No runs have started for this workflow in this environment.</p>
        ) : (
          <ul className="wfd-run-list">
            {detail.recentRuns.map((run) => (
              <li key={run.runId}>
                <a href={runDetailHash(run.runId)}>{run.runId}</a>
                <code>{run.workflowVersionId}</code>
                <span>{triggerLabel(run)}</span>
                <strong>{run.state.replaceAll('_', ' ')}</strong>
                {run.outcome ? (
                  <span>{run.outcome === 'succeeded' ? 'Succeeded' : 'Failed'}</span>
                ) : null}
                {run.durationMs === undefined ? null : (
                  <span>{formatRunDuration(run.durationMs)}</span>
                )}
                <time dateTime={run.startedAt}>{formatWorkflowDateTime(run.startedAt)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function WorkflowDetailPage({ workflowId }: { workflowId: string }) {
  const { organizationId, environmentId } = useConsoleSession();
  const detail = useWorkflowDetail(organizationId, environmentId, workflowId);
  const diagramVersion =
    detail.remote.status === 'ready' ? approvedDiagramVersion(detail.remote.data) : undefined;
  return (
    <WorkflowDetailContent
      environmentId={environmentId}
      reload={detail.reload}
      remote={detail.remote}
      diagram={
        detail.remote.status === 'ready' && diagramVersion ? (
          <CatalogWorkflowDiagram
            key={`${environmentId}:${workflowId}:${diagramVersion}`}
            workflowId={workflowId}
            workflowVersionId={diagramVersion}
            active={detail.remote.data.activeVersion !== null}
          />
        ) : undefined
      }
    />
  );
}
