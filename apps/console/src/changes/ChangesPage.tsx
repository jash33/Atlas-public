import { useState, type ReactNode } from 'react';

import { demoTokenForRole } from '../config.js';
import { formatRelativeTime } from '../home/summaries.js';
import { RemoteView } from '../shell/RemoteView.js';
import { useConsoleSession } from '../shell/session.js';
import { SourceUpdateTreeView } from '../source-update-tree/SourceUpdateTreeView.js';
import { capabilityBlastRadiusHash } from '../capabilities/capability-map-route.js';
import {
  buildChangeItems,
  capabilityDetailHash,
  changeClassificationCopy,
  changeClassifications,
  contractClassificationScope,
  countChangeItemsByClassification,
  migrationReviewHash,
  presentFieldChange,
  workflowDetailHash,
  type ChangeClassification,
  type ChangeItem,
} from './changes.js';
import {
  createMigrationCandidate,
  readProjectionFingerprint,
  useChangeDiscoveries,
} from './data.js';
import {
  presentChangeDiscoveries,
  treeMatchesFilter,
  type ChangeTreeEntry,
} from './presentation.js';

function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-5)}` : value;
}

function migrationVersionId(sourceWorkflowVersionId: string, toCapabilityVersionId: string) {
  return `${sourceWorkflowVersionId}-migrate-${toCapabilityVersionId.slice(0, 8)}-${Date.now()}`;
}

function SummaryCard({
  classification,
  count,
  active,
  onSelect,
}: {
  classification: ChangeClassification;
  count: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`chg-summary chg-tone-${classification}${active ? ' chg-summary-active' : ''}`}
      onClick={onSelect}
      type="button"
    >
      <small>{changeClassificationCopy[classification].label}</small>
      <strong>{count}</strong>
      <span>{changeClassificationCopy[classification].summary}</span>
    </button>
  );
}

function EvidenceLabel({ item }: { item: ChangeItem }) {
  return item.evidenceKind === 'runtime-rejection' ? (
    <div className="chg-evidence-kind chg-runtime">
      <strong>Runtime schema-drift rejection</strong>
      <span>
        The customer worker reported the rejected step and approved capability pin. Atlas does not
        inspect or receive the unredacted payload.
      </span>
    </div>
  ) : (
    <div className="chg-evidence-kind">
      <strong>Discovered schema/version change</strong>
      <span>
        Structural evidence came from the registered machine-readable source, not runtime payload
        traffic.
      </span>
    </div>
  );
}

function ChangeCard({ item }: { item: ChangeItem }) {
  const { organizationId, environmentId, role } = useConsoleSession();
  const [creatingFor, setCreatingFor] = useState<string>();
  const [message, setMessage] = useState<string>();
  const canCreate = role === 'author' || role === 'admin';

  async function createCandidate(workflowVersionId: string) {
    if (!canCreate || !item.fromCapabilityVersionId || !item.toCapabilityVersionId) return;
    setCreatingFor(workflowVersionId);
    setMessage(undefined);
    try {
      const projectionFingerprint = await readProjectionFingerprint(organizationId, environmentId);
      const result = await createMigrationCandidate({
        organizationId,
        environmentId,
        sourceWorkflowVersionId: workflowVersionId,
        workflowVersionId: migrationVersionId(workflowVersionId, item.toCapabilityVersionId),
        fromCapabilityVersionId: item.fromCapabilityVersionId,
        toCapabilityVersionId: item.toCapabilityVersionId,
        projectionFingerprint,
        bearerToken: demoTokenForRole(role),
      });
      window.location.hash = migrationReviewHash(result.candidateId);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Migration candidate could not be created',
      );
    } finally {
      setCreatingFor(undefined);
    }
  }

  return (
    <article className={`chg-card chg-tone-${item.classification}`}>
      <header>
        <div>
          <div className="chg-title-line">
            <span className="chg-severity">
              {changeClassificationCopy[item.classification].label}
            </span>
            <h2>{item.serviceId}</h2>
          </div>
          <p>
            {item.trigger.replaceAll('-', ' ')} · {formatRelativeTime(item.discoveredAt)}
          </p>
        </div>
        <span className="chg-environment">{environmentId}</span>
      </header>

      <EvidenceLabel item={item} />
      {item.runtimeStepId && (
        <div className="chg-runtime-step">
          <small>Worker-reported rejected step</small>
          <code>{item.runtimeStepId}</code>
        </div>
      )}

      <div className="chg-intake">
        <strong>
          {item.intakeBehavior === 'quarantined'
            ? 'New intake quarantined'
            : item.intakeBehavior === 'old-pin-open'
              ? 'Intake open on old approved pin'
              : item.intakeBehavior === 'unaffected'
                ? `No approved workflow affected in ${environmentId}`
                : 'Awaiting source rediscovery'}
        </strong>
        <span>
          {item.intakeBehavior === 'unaffected'
            ? 'The capability changed, but no workflow approved in the selected environment pins this version.'
            : changeClassificationCopy[item.classification].summary}
        </span>
      </div>

      {item.fromCapabilityVersionId && item.toCapabilityVersionId && (
        <div className="chg-pin-pair">
          <a href={capabilityDetailHash(item.fromCapabilityVersionId)}>
            <small>Approved pin</small>
            <code title={item.fromCapabilityVersionId}>
              {shortId(item.fromCapabilityVersionId)}
            </code>
          </a>
          <span>→</span>
          <a href={capabilityDetailHash(item.toCapabilityVersionId)}>
            <small>Discovered version</small>
            <code title={item.toCapabilityVersionId}>{shortId(item.toCapabilityVersionId)}</code>
          </a>
        </div>
      )}
      {item.fromCapabilityVersionId && !item.toCapabilityVersionId && (
        <a className="chg-runtime-pin" href={capabilityDetailHash(item.fromCapabilityVersionId)}>
          <small>Rejected approved pin</small>
          <code title={item.fromCapabilityVersionId}>{shortId(item.fromCapabilityVersionId)}</code>
        </a>
      )}

      <details className="chg-blast" open={item.classification === 'breaking'}>
        <summary>
          Blast radius · {item.affectedWorkflows.length} workflow step
          {item.affectedWorkflows.length === 1 ? '' : 's'}
        </summary>
        <div className="chg-evidence-grid">
          <section>
            <h3>Field-level evidence</h3>
            {item.fieldChanges.length === 0 ? (
              <p>No source diff is established yet.</p>
            ) : (
              <ul className="chg-fields">
                {item.fieldChanges.map((field, index) => {
                  const diff = presentFieldChange(field);
                  return (
                    <li key={`${field.kind}:${field.path}:${index}`}>
                      <div className="chg-field-heading">
                        <strong>{diff.title}</strong>
                        <code>{diff.field}</code>
                      </div>
                      <div className="chg-field-diff" aria-label={`${diff.title}: ${diff.field}`}>
                        <span>
                          <small>Before</small>
                          <b>{diff.before}</b>
                        </span>
                        <i aria-hidden="true">→</i>
                        <span>
                          <small>After</small>
                          <b>{diff.after}</b>
                        </span>
                      </div>
                      <details className="chg-raw-path">
                        <summary>Raw schema path</summary>
                        {field.fromPath && <code>{field.fromPath} → </code>}
                        <code>{field.path}</code>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <section>
            <h3>Affected workflows and steps</h3>
            {item.affectedWorkflows.length === 0 ? (
              <p>
                {item.evidenceKind === 'runtime-rejection'
                  ? 'The rejected step is recorded, but it did not join to an approved workflow in this environment.'
                  : 'No affected workflow has been established from version evidence.'}
              </p>
            ) : (
              <ul className="chg-workflows">
                {item.affectedWorkflows.map((workflow) => (
                  <li key={`${workflow.workflowVersionId}:${workflow.stepId}`}>
                    <div>
                      <a href={workflowDetailHash(workflow.workflowVersionId)}>
                        {workflow.workflowVersionId}
                      </a>
                      <code>{workflow.stepId}</code>
                    </div>
                    {item.toCapabilityVersionId ? (
                      <button
                        disabled={!canCreate || creatingFor !== undefined}
                        onClick={() => void createCandidate(workflow.workflowVersionId)}
                        type="button"
                      >
                        {creatingFor === workflow.workflowVersionId
                          ? 'Generating…'
                          : 'Create migration candidate'}
                      </button>
                    ) : (
                      <span className="chg-awaiting-diff">Awaiting source diff</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </details>
      {!canCreate && item.toCapabilityVersionId && item.affectedWorkflows.length > 0 && (
        <p className="chg-role-note">
          Switch to Author or Admin to create a candidate. Approval and activation remain Admin-only
          and server-enforced.
        </p>
      )}
      {message && <p className="chg-error">{message}</p>}
    </article>
  );
}

function SourceUpdateTreeCard({ entry }: { entry: ChangeTreeEntry }) {
  const { environmentId } = useConsoleSession();
  return (
    <article className="chg-source-tree">
      <header>
        <p className="chg-kicker">Blast radius</p>
        <h2>Source update is not fully compatible</h2>
        <p>
          {entry.trigger.replaceAll('-', ' ')} · {formatRelativeTime(entry.discoveredAt)}
        </p>
      </header>
      <a
        className="chg-blast-link"
        href={capabilityBlastRadiusHash(environmentId, entry.discoveryId)}
      >
        View blast radius
      </a>
      <SourceUpdateTreeView tree={entry.tree} />
    </article>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="chg-empty">{children}</div>;
}

export function ChangesPage() {
  const { organizationId, environmentId } = useConsoleSession();
  const discoveries = useChangeDiscoveries(organizationId, environmentId);
  const [filter, setFilter] = useState<ChangeClassification | 'all'>('all');

  return (
    <div className="chg">
      <header className="chg-heading">
        <div>
          <p className="chg-kicker">Change Triage Desk</p>
          <h1>Capability changes</h1>
          <p>
            {contractClassificationScope} Migration candidates continue through ordinary Workflow
            Review.
          </p>
        </div>
        <div className="chg-context">
          <small>Selected environment</small>
          <strong>{environmentId}</strong>
        </div>
      </header>

      <RemoteView remote={discoveries.remote} reload={discoveries.reload}>
        {(details) => {
          const items = buildChangeItems(details);
          const counts = countChangeItemsByClassification(items);
          const presented = presentChangeDiscoveries(details);
          const visibleTrees = presented.trees.filter((entry) => treeMatchesFilter(entry, filter));
          const visibleItems =
            filter === 'all'
              ? presented.listItems
              : presented.listItems.filter((item) => item.classification === filter);
          const visibleCount = visibleTrees.length + visibleItems.length;
          return (
            <>
              <section className="chg-summaries" aria-label="Change severity summary">
                {changeClassifications.map((classification) => (
                  <SummaryCard
                    active={filter === classification}
                    classification={classification}
                    count={counts[classification]}
                    key={classification}
                    onSelect={() => setFilter(filter === classification ? 'all' : classification)}
                  />
                ))}
              </section>
              <div className="chg-list-heading">
                <strong>
                  {visibleCount} triage item{visibleCount === 1 ? '' : 's'} ·{' '}
                  {visibleItems.filter((item) => item.environmentAffected).length +
                    visibleTrees.length}{' '}
                  affect {environmentId}
                </strong>
                {filter !== 'all' && (
                  <button onClick={() => setFilter('all')} type="button">
                    Clear filter
                  </button>
                )}
              </div>
              <section className="chg-list">
                {visibleCount === 0 ? (
                  <EmptyState>
                    <strong>No {filter === 'all' ? '' : `${filter} `}changes to triage.</strong>
                    <span>
                      Run source discovery or wait for a repository push, daily poll, or worker
                      signal.
                    </span>
                  </EmptyState>
                ) : (
                  <>
                    {visibleTrees.map((entry) => (
                      <SourceUpdateTreeCard entry={entry} key={entry.discoveryId} />
                    ))}
                    {visibleItems.map((item) => (
                      <ChangeCard item={item} key={item.id} />
                    ))}
                  </>
                )}
              </section>
            </>
          );
        }}
      </RemoteView>
    </div>
  );
}
