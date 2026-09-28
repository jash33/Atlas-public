import { useMemo, useState } from 'react';

import { formatRelativeTime } from '../home/summaries.js';
import { RemoteView } from '../shell/RemoteView.js';
import { parseHashParameter, runDetailHash } from '../shell/router.js';
import { useConsoleSession } from '../shell/session.js';
import {
  buildActivityObjects,
  describeActor,
  activityDetailDefinitions,
  type ActivityObject,
  type ActivityObjectKind,
  type AuditEntry,
} from './activity.js';
import { useActivityHistory } from './data.js';

const kindLabels: Record<ActivityObjectKind, string> = {
  workflow: 'Workflow',
  'capability-source': 'Capability source',
  'capability-version': 'Capability version',
  run: 'Run',
  migration: 'Migration',
  membership: 'Membership',
  person: 'Person',
};

function detailHash(
  surface: 'workflows' | 'capabilities' | 'settings',
  key: string,
  value: string,
) {
  return `#/${surface}?${new URLSearchParams({ [key]: value })}`;
}

function subjectHash(entry: AuditEntry): string | null {
  if (entry.subjectType === 'workflow-version') {
    return detailHash('workflows', 'workflowVersionId', entry.subjectId);
  }
  if (entry.subjectType === 'workflow-run') return runDetailHash(entry.subjectId);
  if (entry.subjectType === 'migration-candidate') {
    return detailHash('workflows', 'migrationCandidateId', entry.subjectId);
  }
  if (
    entry.subjectType === 'capability-version' ||
    entry.subjectType === 'capability-safety-approval'
  ) {
    return detailHash('capabilities', 'capabilityVersionId', entry.subjectId);
  }
  if (
    ['membership', 'organization-settings', 'secret-reference', 'capability-host-policy'].includes(
      entry.subjectType,
    )
  ) {
    return detailHash('settings', 'subjectId', entry.subjectId);
  }
  return null;
}

interface EvidenceLink {
  key: string;
  label: string;
  href: string;
}

function evidenceLinks(entry: AuditEntry): EvidenceLink[] {
  const links = activityDetailDefinitions.flatMap((definition) => {
    const value = entry.details[definition.detail];
    return typeof value === 'string' &&
      value.length > 0 &&
      definition.surface &&
      definition.parameter
      ? [
          {
            key: `${definition.detail}:${value}`,
            label: definition.label,
            href: detailHash(definition.surface, definition.parameter, value),
          },
        ]
      : [];
  });
  const runId = entry.details.runId;
  if (typeof runId === 'string' && runId.length > 0) {
    links.push({ key: `run:${runId}`, label: 'Run', href: runDetailHash(runId) });
  }
  return links;
}

function selectObject(object: ActivityObject, setSelectedKey: (key: string) => void) {
  setSelectedKey(object.key);
  const query = new URLSearchParams({ object: object.key });
  window.history.replaceState({}, '', `#/activity?${query}`);
}

function EventCard({ entry }: { entry: AuditEntry }) {
  const actor = describeActor(entry);
  const link = subjectHash(entry);
  const links = evidenceLinks(entry);
  const details =
    Object.keys(entry.details).length > 0 ? JSON.stringify(entry.details, null, 2) : null;
  return (
    <li className="act-event">
      <div className="act-event-rail" aria-hidden="true">
        <span />
        <i />
      </div>
      <article>
        <header>
          <div>
            <span className={`act-event-type act-event-${entry.eventType}`}>
              {entry.eventType.replaceAll('-', ' ')}
            </span>
            <h3>{entry.subjectName ?? entry.subjectId}</h3>
          </div>
          <time dateTime={entry.recordedAt} title={new Date(entry.recordedAt).toLocaleString()}>
            {formatRelativeTime(entry.recordedAt)}
          </time>
        </header>
        <dl className="act-event-facts">
          <div>
            <dt>Subject</dt>
            <dd>
              {link ? (
                <a href={link}>
                  {entry.subjectType} / {entry.subjectId}
                </a>
              ) : (
                <code>
                  {entry.subjectType} / {entry.subjectId}
                </code>
              )}
            </dd>
          </div>
          <div>
            <dt>Actor</dt>
            <dd>
              <span className={`act-actor act-actor-${actor.kind}`}>
                {actor.label}
                <small>{actor.kind}</small>
              </span>
            </dd>
          </div>
          <div>
            <dt>Environment</dt>
            <dd>{entry.environmentId ?? 'Organization-wide'}</dd>
          </div>
          <div>
            <dt>Recorded</dt>
            <dd>{new Date(entry.recordedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Event ID</dt>
            <dd>
              <code>{entry.id}</code>
            </dd>
          </div>
        </dl>
        {links.length > 0 && (
          <nav className="act-evidence-links" aria-label="Related object surfaces">
            {links.map((item) => (
              <a href={item.href} key={item.key}>
                {item.label} →
              </a>
            ))}
          </nav>
        )}
        <details className="act-details" open>
          <summary>Structured details</summary>
          {details ? <pre>{details}</pre> : <p>No additional structured details were recorded.</p>}
        </details>
        <div className="act-entry-seal">
          <span aria-hidden="true">◇</span>
          <strong>Immutable record</strong>
          <small>This entry cannot be edited or deleted.</small>
        </div>
      </article>
    </li>
  );
}

function ObjectHistory({ entries }: { entries: AuditEntry[] }) {
  const objects = useMemo(() => buildActivityObjects(entries), [entries]);
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState(() =>
    parseHashParameter(window.location.hash, 'object'),
  );
  const query = search.trim().toLocaleLowerCase();
  const visible = query
    ? objects.filter((object) =>
        `${kindLabels[object.kind]} ${object.label} ${object.id}`
          .toLocaleLowerCase()
          .includes(query),
      )
    : objects;
  const selected = objects.find((object) => object.key === selectedKey) ?? visible[0] ?? objects[0];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const selectedEntries =
    selected?.eventIds.flatMap((id) => {
      const item = entriesById.get(id);
      return item ? [item] : [];
    }) ?? [];

  if (objects.length === 0) {
    return (
      <div className="act-empty">
        <strong>No object history is recorded yet.</strong>
        <span>
          Lifecycle events appear here after Atlas records a workflow, capability version, run,
          migration, membership, or person action.
        </span>
      </div>
    );
  }
  return (
    <div className="act-layout">
      <aside className="act-picker">
        <label>
          <span>Find an object</span>
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Name, ID, or type…"
            type="search"
            value={search}
          />
        </label>
        <div className="act-picker-heading">
          <strong>{query ? 'Search results' : 'Recently active'}</strong>
          <small>
            {visible.length} object{visible.length === 1 ? '' : 's'}
          </small>
        </div>
        <div className="act-object-list">
          {visible.map((object) => (
            <button
              aria-pressed={selected?.key === object.key}
              className={
                selected?.key === object.key ? 'act-object act-object-selected' : 'act-object'
              }
              key={object.key}
              onClick={() => selectObject(object, setSelectedKey)}
              type="button"
            >
              <span className={`act-object-mark act-object-${object.kind}`}>
                {kindLabels[object.kind].slice(0, 1)}
              </span>
              <span>
                <strong>{object.label}</strong>
                <small>
                  {kindLabels[object.kind]} · {object.id}
                </small>
              </span>
              <b>{object.eventIds.length}</b>
            </button>
          ))}
          {visible.length === 0 && <p className="act-no-results">No matching objects.</p>}
        </div>
      </aside>
      <section className="act-history">
        <header className="act-object-summary">
          <div>
            <span className={`act-object-mark act-object-${selected!.kind}`}>
              {kindLabels[selected!.kind].slice(0, 1)}
            </span>
            <div>
              <p>{kindLabels[selected!.kind]} history</p>
              <h2>{selected!.label}</h2>
              <code>{selected!.id}</code>
            </div>
          </div>
          <span className="act-count">
            {selectedEntries.length} immutable event{selectedEntries.length === 1 ? '' : 's'}
          </span>
        </header>
        <div className="act-order">
          <span>Recorded order</span>
          <strong>Newest recorded first</strong>
        </div>
        <ol className="act-timeline">
          {selectedEntries.map((entry) => (
            <EventCard entry={entry} key={entry.id} />
          ))}
        </ol>
      </section>
    </div>
  );
}

export function ActivityPage() {
  const { organizationId, environmentId } = useConsoleSession();
  const history = useActivityHistory(organizationId, environmentId);
  return (
    <div className="act">
      <header className="act-heading">
        <div>
          <p>Append-only object history</p>
          <h1>Activity</h1>
          <span>
            Follow one object through its recorded lifecycle and inspect the evidence behind every
            event.
          </span>
        </div>
        <div className="act-immutable">
          <span aria-hidden="true">◇</span>
          <div>
            <strong>Immutable by design</strong>
            <small>There is no update or delete path for history records.</small>
          </div>
        </div>
      </header>
      <RemoteView remote={history.remote} reload={history.reload}>
        {(entries) => <ObjectHistory entries={entries} />}
      </RemoteView>
    </div>
  );
}
