import { repositoryAnalysisState } from './RepositoryAnalysis.js';
import type { CatalogRepositoryConnection, CatalogSourceGroup } from './repository-sources.js';

function analysisState(connection: CatalogRepositoryConnection | undefined) {
  if (!connection) return null;
  return repositoryAnalysisState(
    {
      id: connection.id,
      repository: connection.repository,
      branches: connection.branches,
      last_error: connection.last_error ?? null,
      ...(connection.progress ? { progress: connection.progress } : {}),
      targets: connection.targets ?? [],
      candidates: connection.candidates ?? [],
    },
    Date.now(),
  );
}

export function RepositoryDetailsSidebar({
  source,
  connection,
  onViewAnalysis,
}: {
  source: CatalogSourceGroup;
  connection: CatalogRepositoryConnection | undefined;
  onViewAnalysis: () => void;
}) {
  const state = analysisState(connection);
  return (
    <aside aria-label="Repository details" className="cat-repository-sidebar">
      <header className="cat-repository-sidebar-heading">
        <div>
          <small>Repository</small>
          <h2>{source.label}</h2>
        </div>
      </header>
      <div className="cat-repository-sidebar-body">
        <span className={`cat-repository-state cat-repository-state-${state?.tone ?? 'idle'}`}>
          {state?.label ?? 'Not connected'}
        </span>
        <dl className="cat-repository-sidebar-fields">
          <div>
            <dt>Tracked branches</dt>
            <dd>{source.branches.join(', ') || 'None selected'}</dd>
          </div>
          <div>
            <dt>Capabilities</dt>
            <dd>{source.capabilities.length}</dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>
              {connection?.last_checked_at
                ? new Date(connection.last_checked_at).toLocaleString()
                : 'Not checked yet'}
            </dd>
          </div>
        </dl>
      </div>
      <footer className="cat-repository-sidebar-footer">
        <div className="cat-repository-sidebar-actions">
          <button
            className="cat-repository-sidebar-control cat-repository-sidebar-primary"
            disabled={!connection}
            onClick={onViewAnalysis}
            type="button"
          >
            View Analysis
          </button>
          {source.repository && (
            <a
              className="cat-repository-sidebar-control cat-repository-sidebar-secondary"
              href={source.repository}
              rel="noreferrer"
              target="_blank"
            >
              Open repository
            </a>
          )}
        </div>
      </footer>
    </aside>
  );
}
