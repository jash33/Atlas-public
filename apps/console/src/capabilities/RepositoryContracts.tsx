import { useCallback, useEffect, useRef, useState } from 'react';

import { requestJson } from '../shell/api.js';
import { environmentLabels, type EnvironmentId } from '../shell/session.js';
import {
  RepositoryAnalysis,
  RepositoryLoading,
  repositoryAnalysisState,
  type RepositoryProgress,
} from './RepositoryAnalysis.js';
import './repository-contracts.css';

type Document = Record<string, unknown>;
interface Evidence {
  operationId: string;
  path: string;
  functionName: string;
  startLine: number;
  endLine: number;
  role: string;
  quote: string;
}
interface ServiceDocument {
  serviceId: string;
  sourceRoot?: string;
  openapi: Document;
  arazzo: Document | null;
  evidence: Evidence[];
  unresolvedQuestions: string[];
  supportingDocuments?: Array<{ path: string; sha: string; verificationNotes: string }>;
}
interface CandidateSummary {
  id: string;
  branch: string;
  commit_sha: string;
  kind: string;
  status: string;
  candidate_hash: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}
interface Candidate extends CandidateSummary {
  repository: string;
  documents: ServiceDocument[];
  changes: Array<{
    serviceId: string;
    operationId: string;
    classification: string;
    changes: string[];
    previous: Document;
    next: Document;
    affectedWorkflows: Array<{ workflowVersionId: string; stepId: string }>;
  }>;
}
interface Connection {
  id: string;
  repository: string;
  branches: string[];
  last_error: string | null;
  last_checked_at?: string | null;
  next_check_at: string;
  progress?: Partial<RepositoryProgress>;
  notify_environment_id?: string | null;
  targets: Array<{
    target_key: string;
    last_successful_commit: string | null;
    last_successful_at: string | null;
    last_error: string | null;
  }>;
  candidates: CandidateSummary[];
}
interface CatalogService {
  connectionId: string;
  branch: string;
  serviceId: string;
  openapi: Document;
  arazzo: Document | null;
  capabilityVersions: Record<string, string>;
  repository: string;
  commit: string;
  reviewedBy: string;
  acceptedAt: string;
}
interface RepositoryData {
  configured: boolean;
  connections: Connection[];
  catalog: CatalogService[];
}
interface AnalysisRun {
  id: string;
  target_key: string;
  commit_sha: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  diagnostics: string[];
  candidate_id: string | null;
  progress?: Partial<RepositoryProgress>;
}
interface Props {
  organizationId: string;
  environmentId?: EnvironmentId;
  bearerToken: string;
  canManage: boolean;
  onClose?: () => void;
  showConnect?: boolean;
  initialConnectionId?: string | null;
}

export function repositoryFreshness(target: Connection['targets'][number], now = Date.now()) {
  if (target.last_error)
    return target.last_successful_at
      ? 'Check failed — last successful result retained'
      : 'Check failed before the first successful analysis';
  if (!target.last_successful_at) return 'Awaiting first successful check';
  return now - Date.parse(target.last_successful_at) > 2 * 60 * 60_000
    ? 'Out of date'
    : 'Checked recently';
}
const record = (value: unknown): Document =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Document) : {};
function operations(document: Document) {
  return Object.entries(record(document.paths)).flatMap(([path, item]) =>
    Object.entries(record(item)).flatMap(([method, value]) => {
      const operation = record(value);
      return typeof operation.operationId === 'string'
        ? [{ path, method, operation, id: operation.operationId }]
        : [];
    }),
  );
}
function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return (
    <details>
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
function ContractDocuments({
  service,
}: {
  service: Pick<ServiceDocument, 'serviceId' | 'sourceRoot' | 'openapi' | 'arazzo'>;
}) {
  return (
    <section className="repository-service" aria-label={`${service.serviceId} contracts`}>
      <h3>{service.serviceId}</h3>
      {service.sourceRoot && (
        <p>
          Found in <code>{service.sourceRoot}</code>
        </p>
      )}
      <div className="repository-actions">
        <a
          download={`${service.serviceId}-openapi.json`}
          href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(service.openapi, null, 2))}`}
        >
          Download OpenAPI
        </a>
        {service.arazzo && (
          <a
            download={`${service.serviceId}-arazzo.json`}
            href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(service.arazzo, null, 2))}`}
          >
            Download Arazzo
          </a>
        )}
      </div>
      {operations(service.openapi).map(({ id, path, method, operation }) => (
        <details key={id}>
          <summary>
            <strong>{id}</strong>{' '}
            <span>
              {method.toUpperCase()} {path}
            </span>
          </summary>
          {typeof operation.summary === 'string' && <p>{operation.summary}</p>}
          {typeof operation.description === 'string' && <p>{operation.description}</p>}
          <JsonDetails
            label="Request parameters and body"
            value={{
              parameters: operation.parameters ?? [],
              requestBody: operation.requestBody ?? null,
            }}
          />
          <JsonDetails label="Responses and errors" value={operation.responses} />
        </details>
      ))}
      <JsonDetails label="Complete OpenAPI document" value={service.openapi} />
      {service.arazzo ? (
        <JsonDetails label="Arazzo sequences and data mappings" value={service.arazzo} />
      ) : (
        <p>No supported operation sequences were identified.</p>
      )}
    </section>
  );
}

export function RepositoryContracts({
  organizationId,
  environmentId,
  bearerToken,
  canManage,
  onClose,
  showConnect = false,
  initialConnectionId = null,
}: Props) {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/repositories`;
  const [data, setData] = useState<RepositoryData | null>(null);
  const [failure, setFailure] = useState('');
  const [refreshFailure, setRefreshFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [connecting, setConnecting] = useState(showConnect);
  const [selectedConnectionId, setSelectedConnectionId] = useState(initialConnectionId);
  const [repository, setRepository] = useState('');
  const [branches, setBranches] = useState('');
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [questionsReviewed, setQuestionsReviewed] = useState(false);
  const [history, setHistory] = useState<AnalysisRun[] | null>(null);
  const [historyPage, setHistoryPage] = useState<{
    connectionId: string;
    before: string | null;
  } | null>(null);
  const readSequence = useRef(0);
  const reviewSection = useRef<HTMLElement>(null);
  const repositoryList = useRef<HTMLElement>(null);
  const analysisSection = useRef<HTMLElement>(null);
  const connection = data?.connections.find((entry) => entry.id === selectedConnectionId);
  const visibleConnectionId = connection?.id;
  useEffect(() => {
    setSelectedConnectionId(initialConnectionId);
    setCandidate(null);
    setHistory(null);
  }, [initialConnectionId, organizationId]);
  useEffect(() => {
    if (visibleConnectionId) {
      analysisSection.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      analysisSection.current?.focus({ preventScroll: true });
    }
  }, [visibleConnectionId]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++readSequence.current;
      let next: RepositoryData;
      try {
        next = await requestJson<RepositoryData>(base, {
          headers: { authorization: `Bearer ${bearerToken}` },
          signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
        });
      } catch (error) {
        if (sequence !== readSequence.current || signal?.aborted) return;
        if (error instanceof Error && error.name === 'TimeoutError')
          throw new Error('Atlas did not respond. Trying again for updates.');
        throw error;
      }
      if (sequence !== readSequence.current || signal?.aborted) return;
      setData(next);
      setRefreshFailure('');
    },
    [base, bearerToken],
  );
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setCandidate(null);
    setHistory(null);
    setRefreshFailure('');
    const poll = async () => {
      try {
        await load(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted)
          setRefreshFailure(
            error instanceof Error ? error.message : 'Unable to load repository updates',
          );
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load]);
  useEffect(() => {
    if (candidate) {
      reviewSection.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      reviewSection.current?.focus({ preventScroll: true });
    }
  }, [candidate]);
  const refresh = () =>
    void load().catch((error: unknown) =>
      setRefreshFailure(
        error instanceof Error ? error.message : 'Unable to refresh repository updates',
      ),
    );
  async function perform(work: () => Promise<void>, repositoryUrl = connection?.repository) {
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      await work();
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Repository request failed';
      setFailure(
        repositoryUrl ? `${repositoryUrl.replace('https://github.com/', '')}: ${message}` : message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function post<T = unknown>(path: string, body: unknown) {
    return requestJson<T>(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function showHistory(connectionId: string, before?: string) {
    const result = await requestJson<{ runs: AnalysisRun[]; nextBefore: string | null }>(
      `${base}/${connectionId}/history${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      { headers: { authorization: `Bearer ${bearerToken}` } },
    );
    setHistory((current) => (before ? [...(current ?? []), ...result.runs] : result.runs));
    setHistoryPage({ connectionId, before: result.nextBefore });
  }
  function selectCandidate(id: string) {
    void perform(async () => {
      setCandidate(
        await requestJson<Candidate>(`${base}/candidates/${id}`, {
          headers: { authorization: `Bearer ${bearerToken}` },
        }),
      );
      setQuestionsReviewed(false);
    });
  }
  function selectConnection(id: string | null) {
    setSelectedConnectionId(id);
    setCandidate(null);
    setHistory(null);
    setHistoryPage(null);
    setQuestionsReviewed(false);
    setFailure('');
    setNotice('');
    if (!id) {
      repositoryList.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      repositoryList.current?.focus({ preventScroll: true });
    }
  }
  return (
    <section className="repository-contracts" aria-label="Repository contracts">
      <header className="cat-heading">
        <div>
          <p className="repository-eyebrow">Capabilities / Source connections</p>
          <h1>Repository contracts</h1>
          <p>Manage your repositories and review the API contracts found in their code.</p>
        </div>
        {onClose && (
          <button className="cat-secondary" type="button" onClick={onClose}>
            Back to catalog
          </button>
        )}
      </header>
      <p className="repository-explanation">
        These contracts describe your source code. You review them before anything enters the
        catalog. Deployment confirmation is configured separately.
      </p>
      {failure && (
        <div role="alert" className="repository-alert repository-tone-error">
          <span className="repository-alert-icon" aria-hidden="true">
            !
          </span>
          <div>
            <h3>Repository request failed</h3>
            <p>{failure}</p>
          </div>
        </div>
      )}
      {refreshFailure && (
        <div role="alert" className="repository-alert repository-tone-warning">
          <span className="repository-alert-icon" aria-hidden="true">
            !
          </span>
          <div>
            <h3>{data ? 'Live updates interrupted' : 'Couldn’t load repositories'}</h3>
            <p>{refreshFailure}</p>
            <button className="cat-secondary" type="button" onClick={refresh}>
              Refresh updates
            </button>
          </div>
        </div>
      )}
      {notice && (
        <div className="repository-notice" role="status">
          {notice}
        </div>
      )}
      <section
        className="repository-overview"
        aria-label="Connected repositories"
        ref={repositoryList}
        tabIndex={-1}
      >
        <div className="repository-list-heading">
          <div>
            <h2>Connected repositories {data && <span>{data.connections.length}</span>}</h2>
            <p>
              Choose a repository to view its saved progress and actions. Checks run automatically.
            </p>
          </div>
          {canManage && (
            <button
              className="cat-secondary"
              type="button"
              onClick={() => setConnecting(!connecting)}
            >
              {connecting ? 'Hide connection form' : 'Connect a public GitHub repository'}
            </button>
          )}
        </div>
        {!data && !refreshFailure && <RepositoryLoading />}
        {data && !data.connections.length && (
          <p className="repository-empty-list">No repositories connected yet.</p>
        )}
        {!!data?.connections.length && (
          <ul className="repository-list">
            {data.connections.map((entry) => {
              const name = entry.repository.replace('https://github.com/', '');
              const status = repositoryAnalysisState(entry, Date.now(), !!refreshFailure);
              const selected = entry.id === selectedConnectionId;
              return (
                <li key={entry.id} className={selected ? 'repository-list-selected' : ''}>
                  <div className="repository-list-source">
                    <a href={entry.repository} target="_blank" rel="noreferrer">
                      {name}
                    </a>
                    <span>{entry.repository}</span>
                  </div>
                  <div className="repository-list-branches">
                    <small>Tracking</small>
                    <span>{entry.branches.join(', ')}</span>
                  </div>
                  <div className="repository-list-status">
                    <span className={`repository-status repository-tone-${status.tone}`}>
                      {status.status === 'failed' ? 'Needs attention' : status.label}
                    </span>
                    <small>
                      {entry.last_checked_at
                        ? `Last checked ${new Date(entry.last_checked_at).toLocaleString()}`
                        : 'No completed check yet'}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="cat-secondary"
                    aria-label={`View analysis for ${name}`}
                    aria-pressed={selected}
                    aria-controls={selected ? 'repository-analysis-details' : undefined}
                    disabled={busy}
                    onClick={() => selectConnection(entry.id)}
                  >
                    {selected ? 'Viewing analysis' : 'View analysis'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {connecting && canManage && (
        <form
          className="repository-connect"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const result = await post<{ connectionId: string }>('', {
                repository,
                branches: branches
                  .split(',')
                  .map((branch) => branch.trim())
                  .filter(Boolean),
              });
              selectConnection(result.connectionId);
              setConnecting(false);
              setNotice(
                'Repository connected. Initial analysis is queued; review the result here before accepting any capabilities.',
              );
            }, repository);
          }}
        >
          <label>
            Public GitHub repository
            <input
              type="url"
              required
              placeholder="https://github.com/owner/repository"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
            />
          </label>
          <label>
            Branches to track
            <input
              required
              placeholder="main, release"
              value={branches}
              onChange={(event) => setBranches(event.target.value)}
            />
            <small>Only these branches and pull requests targeting them are checked.</small>
          </label>
          <p>
            Atlas finds the API services and their source code automatically. Review what it finds
            before accepting the contracts.
          </p>
          {data && !data.configured && (
            <p>The backend needs an OpenAI key and model before it can analyze source code.</p>
          )}
          <button type="submit" className="cat-primary" disabled={busy || !data?.configured}>
            Connect and analyze
          </button>
        </form>
      )}
      {data && connection && (
        <section
          id="repository-analysis-details"
          ref={analysisSection}
          tabIndex={-1}
          aria-label={`${connection.repository.replace('https://github.com/', '')} analysis details`}
        >
          <RepositoryAnalysis
            key={connection.id}
            connection={connection}
            disconnected={!!refreshFailure}
            busy={busy}
            onRefresh={refresh}
            onReview={selectCandidate}
            onClose={() => selectConnection(null)}
          >
            {!!connection.targets.length && (
              <details className="repository-targets">
                <summary>Branch and pull request checks</summary>
                {connection.targets.map((target) => (
                  <p key={target.target_key}>
                    <strong>{target.target_key}</strong> · {repositoryFreshness(target)}
                    {target.last_successful_at &&
                      ` · ${new Date(target.last_successful_at).toLocaleString()}`}
                    {target.last_error && <span> · {target.last_error}</span>}
                  </p>
                ))}
              </details>
            )}
            <div className="repository-actions">
              {canManage && (
                <button
                  type="button"
                  className="cat-secondary"
                  disabled={busy || !data.configured}
                  onClick={() =>
                    void perform(async () => {
                      await post(`/${connection.id}/check`, {});
                      setNotice('Repository check requested. Progress will appear here.');
                    })
                  }
                >
                  {connection.progress?.status === 'failed' || connection.last_error
                    ? 'Retry analysis'
                    : 'Check for updates'}
                </button>
              )}
              <button
                type="button"
                className="cat-secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await showHistory(connection.id);
                  })
                }
              >
                Analysis history
              </button>
            </div>
            {canManage && (
              <section
                className="repository-ingestion"
                aria-label="Ingest new capabilities or revise descriptions"
              >
                <div>
                  <h3>Ingest new capabilities or revise descriptions</h3>
                  <p>
                    A new ingestion proposes the full definitions for human review. Use this to add
                    operations or explicitly revise approved descriptions.
                  </p>
                </div>
                <button
                  type="button"
                  className="cat-secondary"
                  disabled={busy || !data.configured}
                  onClick={() =>
                    void perform(async () => {
                      await post(`/${connection.id}/ingest`, {});
                      setNotice(
                        'New ingestion queued. Review and accept the proposed definitions before they enter the catalog.',
                      );
                    })
                  }
                >
                  Start a new ingestion
                </button>
              </section>
            )}
            {canManage && environmentId && (
              <label className="repository-notifications">
                <input
                  type="checkbox"
                  checked={connection.notify_environment_id === environmentId}
                  disabled={busy}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void perform(async () => {
                      await post(`/${connection.id}/notifications`, {
                        environmentId: enabled ? environmentId : null,
                      });
                    });
                  }}
                />
                <span>
                  Notify my team about new contracts or failed checks
                  <small>
                    Shown in the {environmentLabels[environmentId]} notification center.
                  </small>
                </span>
              </label>
            )}
            <ul className="repository-candidates">
              {connection.candidates.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="cat-secondary"
                    disabled={busy}
                    onClick={() => selectCandidate(entry.id)}
                  >
                    {entry.kind === 'preview'
                      ? 'Pull request preview'
                      : entry.kind === 'initial'
                        ? 'Initial ingestion'
                        : 'Contract update'}{' '}
                    · {entry.branch} · {entry.commit_sha.slice(0, 8)} · {entry.status}
                  </button>
                  {entry.reviewed_by && <small> Reviewed by {entry.reviewed_by}</small>}
                </li>
              ))}
            </ul>
          </RepositoryAnalysis>
        </section>
      )}
      {history && (
        <section aria-label="Analysis history">
          <h2>Analysis history</h2>
          <button type="button" onClick={() => setHistory(null)}>
            Close history
          </button>
          <ul>
            {history.map((run) => (
              <li key={run.id}>
                {run.target_key} · {run.commit_sha.slice(0, 8) || 'Fetch'} · {run.status} ·{' '}
                {new Date(run.started_at).toLocaleString()}
                {run.diagnostics.map((diagnostic, index) => (
                  <p key={index}>{diagnostic}</p>
                ))}
                {!!run.progress?.activity?.length && (
                  <details>
                    <summary>Progress from this attempt</summary>
                    <ol className="repository-history-updates">
                      {run.progress.activity.map((event, index) => (
                        <li key={`${event.at}:${index}`}>
                          <time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time>{' '}
                          {event.message}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {run.candidate_id && (
                  <button
                    type="button"
                    className="cat-secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        setCandidate(
                          await requestJson<Candidate>(`${base}/candidates/${run.candidate_id}`, {
                            headers: { authorization: `Bearer ${bearerToken}` },
                          }),
                        );
                        setQuestionsReviewed(false);
                      })
                    }
                  >
                    View saved candidate
                  </button>
                )}
              </li>
            ))}
          </ul>
          {historyPage?.before && (
            <button
              type="button"
              className="cat-secondary"
              disabled={busy}
              onClick={() =>
                void perform(() => showHistory(historyPage.connectionId, historyPage.before!))
              }
            >
              Load earlier checks
            </button>
          )}
        </section>
      )}
      {candidate && (
        <section
          className="repository-review"
          aria-label="Review repository candidate"
          tabIndex={-1}
          ref={reviewSection}
        >
          <h2>
            {candidate.kind === 'preview' ? 'Pull request preview' : 'Review proposed contracts'}
          </h2>
          <p>
            {candidate.branch} ·{' '}
            <a
              href={`${candidate.repository}/commit/${candidate.commit_sha}`}
              target="_blank"
              rel="noreferrer"
            >
              {candidate.commit_sha.slice(0, 12)}
            </a>{' '}
            · {candidate.status}
          </p>
          {candidate.kind === 'preview' && (
            <p>Pull requests are previews. They cannot publish capabilities.</p>
          )}
          {candidate.kind === 'periodic' && (
            <p>
              This update contains request and response changes. Approved descriptions and Arazzo
              sequences are preserved.
            </p>
          )}
          {candidate.changes.map((change) => (
            <section key={`${change.serviceId}:${change.operationId}`}>
              <h3>
                {change.operationId} · {change.classification}
              </h3>
              <JsonDetails
                label="Previously accepted request and responses"
                value={change.previous}
              />
              <JsonDetails label="Proposed request and responses" value={change.next} />
              <ul>
                {change.changes.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
              <p>
                Potentially affected workflow steps:{' '}
                {change.affectedWorkflows.length
                  ? change.affectedWorkflows
                      .map((workflow) => `${workflow.workflowVersionId} / ${workflow.stepId}`)
                      .join(', ')
                  : 'None found'}
              </p>
            </section>
          ))}
          {candidate.documents.map((service) => (
            <div key={service.serviceId}>
              <ContractDocuments service={service} />
              {!!service.supportingDocuments?.length && (
                <details>
                  <summary>Supporting repository documents</summary>
                  <ul>
                    {service.supportingDocuments.map((document, index) => (
                      <li key={index}>
                        <a
                          href={`${candidate.repository}/blob/${candidate.commit_sha}/${document.path.split('/').map(encodeURIComponent).join('/')}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {document.path}
                        </a>
                        <p>Analysis notes: {document.verificationNotes}</p>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <details>
                <summary>Supporting code</summary>
                <ul>
                  {service.evidence.map((entry, index) => (
                    <li key={index}>
                      <a
                        href={`${candidate.repository}/blob/${candidate.commit_sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}#L${entry.startLine}-L${entry.endLine}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {entry.path}:{entry.startLine}–{entry.endLine}
                      </a>{' '}
                      · {entry.functionName} · {entry.role}
                      <pre>{entry.quote}</pre>
                    </li>
                  ))}
                </ul>
              </details>
              {service.unresolvedQuestions.length > 0 && (
                <div>
                  <h3>Unresolved questions</h3>
                  <ul>
                    {service.unresolvedQuestions.map((question, index) => (
                      <li key={index}>{question}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
          {candidate.documents.some((service) => service.unresolvedQuestions.length > 0) && (
            <label>
              <input
                type="checkbox"
                checked={questionsReviewed}
                onChange={(event) => setQuestionsReviewed(event.target.checked)}
              />{' '}
              I have reviewed the unresolved questions.
            </label>
          )}
          <div className="repository-actions">
            {canManage && candidate.status === 'review' && candidate.kind !== 'preview' && (
              <>
                <button
                  type="button"
                  className="cat-primary"
                  disabled={
                    busy ||
                    (candidate.documents.some(
                      (service) => service.unresolvedQuestions.length > 0,
                    ) &&
                      !questionsReviewed)
                  }
                  onClick={() =>
                    void perform(async () => {
                      await post(`/candidates/${candidate.id}/accept`, {
                        candidateHash: candidate.candidate_hash,
                        acknowledgeQuestions: questionsReviewed,
                      });
                      setCandidate(null);
                      setNotice(
                        'Contracts accepted into the catalog. Deployed versions and live workflows remain governed by separate environment confirmation.',
                      );
                    })
                  }
                >
                  Accept these contracts
                </button>
                <button
                  type="button"
                  className="cat-secondary"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await post(`/candidates/${candidate.id}/reject`, {
                        candidateHash: candidate.candidate_hash,
                        acknowledgeQuestions: false,
                      });
                      setCandidate(null);
                      setNotice('Candidate rejected. Accepted contracts are retained.');
                    })
                  }
                >
                  Reject candidate
                </button>
              </>
            )}
            <button type="button" className="cat-secondary" onClick={() => setCandidate(null)}>
              Close review
            </button>
          </div>
        </section>
      )}
      <section aria-label="Accepted repository capabilities">
        <h2>Accepted repository capabilities</h2>
        {!data?.catalog.length && <p>No repository contracts have been accepted yet.</p>}
        {data?.catalog.map((service) => (
          <article key={`${service.connectionId}:${service.branch}:${service.serviceId}`}>
            <p>
              {service.branch} · accepted by {service.reviewedBy} ·{' '}
              {new Date(service.acceptedAt).toLocaleString()}
            </p>
            <ContractDocuments service={service} />
            <JsonDetails label="Saved capability versions" value={service.capabilityVersions} />
          </article>
        ))}
      </section>
    </section>
  );
}
