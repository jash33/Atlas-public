import { useState, type ReactNode } from 'react';

import { changeClassificationCopy, changeClassificationTone } from '../changes/changes.js';
import { RemoteView } from '../shell/RemoteView.js';
import { surfaceHash, type Surface } from '../shell/router.js';
import { environmentLabels, useConsoleSession } from '../shell/session.js';
import {
  useAttentionRuns,
  useAuditEntries,
  useCapabilities,
  useDriftEvidence,
  useWorkflowVersions,
} from './data.js';
import {
  readHomeWidgetIds,
  toggleHomeWidget,
  writeHomeWidgetIds,
  type HomeWidgetId,
} from './preferences.js';
import {
  formatRelativeTime,
  summarizeCapabilityHealth,
  summarizeDrift,
  summarizeReviewAttention,
  summarizeRunAttention,
  type DriftSeverity,
} from './summaries.js';

const widgetOptions: Array<{
  id: HomeWidgetId;
  eyebrow: string;
  title: string;
  detail: string;
  glyph: string;
}> = [
  {
    id: 'environment',
    eyebrow: 'System pulse',
    title: 'Environment',
    detail: 'Sources, annotations, and runs needing attention.',
    glyph: '01',
  },
  {
    id: 'reviews',
    eyebrow: 'Governance',
    title: 'Reviews',
    detail: 'Current workflow and approval readiness.',
    glyph: '02',
  },
  {
    id: 'runs',
    eyebrow: 'Operations',
    title: 'Runs',
    detail: 'Parked and review-required executions.',
    glyph: '03',
  },
  {
    id: 'drift',
    eyebrow: 'Change',
    title: 'Drift',
    detail: 'Contract severity and affected workflows.',
    glyph: '04',
  },
  {
    id: 'capabilities',
    eyebrow: 'Ground truth',
    title: 'Capabilities',
    detail: 'Connected services and safety coverage.',
    glyph: '05',
  },
  {
    id: 'activity',
    eyebrow: 'Lifecycle',
    title: 'Activity',
    detail: 'Recent attributable system decisions.',
    glyph: '06',
  },
  {
    id: 'configuration',
    eyebrow: 'Administration',
    title: 'Configuration',
    detail: 'Memberships, workers, aliases, and hosts.',
    glyph: '07',
  },
];

function readBrowserHomeWidgetIds(): HomeWidgetId[] {
  try {
    return readHomeWidgetIds(window.localStorage);
  } catch {
    return [];
  }
}

function writeBrowserHomeWidgetIds(widgetIds: HomeWidgetId[]) {
  try {
    writeHomeWidgetIds(window.localStorage, widgetIds);
  } catch {
    // The current selection still works when browser persistence is unavailable.
  }
}

type ChipTone = 'good' | 'warn' | 'bad' | 'quiet';

const driftTone: Record<DriftSeverity, ChipTone> = {
  ...changeClassificationTone,
  unknown: 'quiet',
};

const driftLabel: Record<DriftSeverity, string> = {
  breaking: changeClassificationCopy.breaking.label,
  conditional: changeClassificationCopy.conditional.label,
  metadata: changeClassificationCopy.metadata.label,
  compatible: changeClassificationCopy.compatible.label,
  unknown: 'Unknown',
};

function Tone({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span className={`home-chip home-chip-${tone}`}>
      <i />
      {children}
    </span>
  );
}

function Widget({
  kicker,
  title,
  surface,
  linkLabel,
  onRemove,
  wide = false,
  children,
}: {
  kicker: string;
  title: string;
  surface?: Surface;
  linkLabel?: string;
  onRemove: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`home-widget${wide ? ' home-widget-wide' : ''}`}>
      <header>
        <div>
          <p className="home-kicker">{kicker}</p>
          <h2>{title}</h2>
        </div>
        <div className="home-widget-actions">
          {surface && linkLabel && (
            <a className="home-widget-link" href={surfaceHash(surface)}>
              {linkLabel} <span aria-hidden="true">→</span>
            </a>
          )}
          <button aria-label={`Remove ${title} widget`} onClick={onRemove} type="button">
            ×
          </button>
        </div>
      </header>
      {children}
    </section>
  );
}

function StripItem({
  label,
  value,
  detail,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className="home-strip-item">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function AtlasSignalMap() {
  return (
    <div className="home-signal-map" aria-hidden="true">
      <span className="home-signal-grid" />
      <span className="home-signal-orbit home-signal-orbit-outer" />
      <span className="home-signal-orbit home-signal-orbit-inner" />
      <span className="home-signal-core">
        <i>A</i>
        <small>ATLAS</small>
      </span>
      <span className="home-signal-node home-signal-intent">
        <i /> WORKFLOWS
      </span>
      <span className="home-signal-node home-signal-capability">
        <i /> CAPABILITIES
      </span>
      <span className="home-signal-node home-signal-artifact">
        <i /> CONTRACTS
      </span>
      <span className="home-signal-node home-signal-runtime">
        <i /> DURABILITY
      </span>
    </div>
  );
}

function Welcome({ onCustomize }: { onCustomize: () => void }) {
  return (
    <section className="home-welcome">
      <button
        aria-controls="home-widget-picker"
        aria-expanded={false}
        className="home-customize-trigger"
        onClick={onCustomize}
        type="button"
      >
        Customize home <span aria-hidden="true">＋</span>
      </button>
      <div className="home-welcome-copy">
        <h1>
          Ship reliable integrations.
          <br />
          <em>Keep them working</em> as APIs change.
        </h1>
        <p className="home-welcome-intro">
          Atlas transforms natural-language integration requests into typed, testable workflows
          grounded in your existing APIs, and alerts you of contract changes before they break
          production.
        </p>
        <div className="home-welcome-actions">
          <a className="home-primary-action" href={surfaceHash('workflows')}>
            Compose a workflow <span aria-hidden="true">→</span>
          </a>
          <a className="home-secondary-action" href={surfaceHash('capabilities')}>
            Explore capabilities
          </a>
        </div>
      </div>
      <AtlasSignalMap />
    </section>
  );
}

function WidgetPicker({
  selectedWidgetIds,
  onToggle,
  onClose,
}: {
  selectedWidgetIds: HomeWidgetId[];
  onToggle: (widgetId: HomeWidgetId) => void;
  onClose: () => void;
}) {
  return (
    <section
      className="home-widget-picker"
      id="home-widget-picker"
      aria-label="Customize Home widgets"
    >
      <header>
        <div>
          <p className="home-kicker">Personal signal deck</p>
          <h2>Choose what Home should monitor</h2>
          <p>Selections stay in this browser. Start empty and add only what earns the space.</p>
        </div>
        <button aria-label="Close widget picker" onClick={onClose} type="button">
          Done
        </button>
      </header>
      <div className="home-widget-options">
        {widgetOptions.map((option) => {
          const selected = selectedWidgetIds.includes(option.id);
          return (
            <button
              aria-pressed={selected}
              className={
                selected ? 'home-widget-option home-widget-option-selected' : 'home-widget-option'
              }
              key={option.id}
              onClick={() => onToggle(option.id)}
              type="button"
            >
              <span className="home-widget-option-glyph">{option.glyph}</span>
              <span>
                <small>{option.eyebrow}</small>
                <strong>{option.title}</strong>
                <em>{option.detail}</em>
              </span>
              <i aria-hidden="true">{selected ? '✓' : '+'}</i>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function DashboardWidgets({
  selectedWidgetIds,
  onRemove,
}: {
  selectedWidgetIds: HomeWidgetId[];
  onRemove: (widgetId: HomeWidgetId) => void;
}) {
  const { organizationId, environmentId, role } = useConsoleSession();
  const capabilities = useCapabilities(organizationId, environmentId);
  const drift = useDriftEvidence(organizationId, environmentId);
  const runs = useAttentionRuns(organizationId, environmentId);
  const versions = useWorkflowVersions(organizationId, environmentId);
  const audit = useAuditEntries(organizationId, environmentId);
  const health =
    capabilities.remote.status === 'ready' && drift.remote.status === 'ready'
      ? summarizeCapabilityHealth(capabilities.remote.data, drift.remote.data.discoveries)
      : null;

  return (
    <div className="home-grid">
      {selectedWidgetIds.includes('environment') && (
        <Widget
          kicker="System pulse"
          title="Environment"
          onRemove={() => onRemove('environment')}
          wide
        >
          <section className="home-strip" aria-label="Environment health">
            <StripItem
              label="Environment"
              value={
                <Tone tone={environmentId === 'development' ? 'good' : 'warn'}>
                  {environmentLabels[environmentId]}
                </Tone>
              }
            />
            <StripItem
              label="Sources"
              value={health ? health.services.length : '—'}
              detail={
                health?.latestDiscovery
                  ? `Last discovery ${formatRelativeTime(health.latestDiscovery.discoveredAt)}`
                  : 'No discoveries yet'
              }
            />
            <StripItem
              label="Capabilities"
              value={health ? `${health.annotatedCapabilities}/${health.totalCapabilities}` : '—'}
              detail={
                health && health.missingAnnotation > 0
                  ? `${health.missingAnnotation} awaiting safety annotation`
                  : 'Safety annotations complete'
              }
            />
            <StripItem
              label="Attention runs"
              value={runs.remote.status === 'ready' ? runs.remote.data.length : '—'}
              detail={`in ${environmentId}`}
            />
          </section>
        </Widget>
      )}

      {selectedWidgetIds.includes('reviews') && (
        <Widget
          kicker="Governance"
          title="Review & approvals"
          surface="workflows"
          linkLabel="Open workflows"
          onRemove={() => onRemove('reviews')}
        >
          <RemoteView remote={versions.remote} reload={versions.reload}>
            {(versionList) => {
              const summary = summarizeReviewAttention(
                versionList,
                capabilities.remote.status === 'ready' ? capabilities.remote.data : [],
              );
              if (!summary.currentVersion) {
                return (
                  <p className="home-empty">
                    No approved workflow versions in {environmentId} yet.
                  </p>
                );
              }
              return (
                <ul className="home-facts">
                  <li>
                    <strong>{summary.currentVersion.workflowVersionId}</strong>
                    <small>
                      Active version · approved by {summary.currentVersion.approvedBy}{' '}
                      {formatRelativeTime(summary.currentVersion.approvedAt)}
                    </small>
                  </li>
                  <li>
                    <strong>{summary.totalVersions}</strong>
                    <small>immutable approved versions</small>
                  </li>
                  <li>
                    <strong>
                      {capabilities.remote.status === 'ready'
                        ? summary.capabilitiesAwaitingAnnotation
                        : '—'}
                    </strong>
                    <small>capabilities awaiting safety annotation</small>
                  </li>
                </ul>
              );
            }}
          </RemoteView>
        </Widget>
      )}

      {selectedWidgetIds.includes('runs') && (
        <Widget
          kicker="Operations"
          title="Run attention"
          surface="runs"
          linkLabel="Open runs"
          onRemove={() => onRemove('runs')}
        >
          <RemoteView remote={runs.remote} reload={runs.reload}>
            {(runList) => {
              const summary = summarizeRunAttention(runList);
              if (summary.total === 0) {
                return <p className="home-empty">No runs need attention in {environmentId}.</p>;
              }
              return (
                <>
                  <div className="home-counts">
                    <Tone tone="bad">{summary.counts.repair_required} repair required</Tone>
                    <Tone tone="warn">{summary.counts.manual_review} manual review</Tone>
                    <Tone tone="quiet">{summary.counts.validation_failed} validation failed</Tone>
                  </div>
                  {summary.mostRecent && (
                    <p className="home-detail">
                      Most recent: <strong>{summary.mostRecent.paymentId}</strong> ·{' '}
                      {formatRelativeTime(summary.mostRecent.startedAt)}
                    </p>
                  )}
                </>
              );
            }}
          </RemoteView>
        </Widget>
      )}

      {selectedWidgetIds.includes('drift') && (
        <Widget
          kicker="Across environments"
          title="Capability drift"
          surface="changes"
          linkLabel="Open changes"
          onRemove={() => onRemove('drift')}
        >
          <RemoteView remote={drift.remote} reload={drift.reload}>
            {({ discoveries, details }) => {
              const summary = summarizeDrift(details);
              return (
                <>
                  <div className="home-counts">
                    <Tone tone={driftTone[summary.severity]}>{driftLabel[summary.severity]}</Tone>
                    {summary.severity === 'unknown' && (
                      <p className="home-detail">No discovery evidence recorded yet.</p>
                    )}
                  </div>
                  {summary.severity !== 'unknown' && (
                    <ul className="home-facts">
                      <li>
                        <strong>
                          {summary.counts.breaking} / {summary.counts.conditional} /{' '}
                          {summary.counts.metadata} / {summary.counts.compatible}
                        </strong>
                        <small>
                          incompatible / review / metadata / compatible contract changes
                        </small>
                      </li>
                      <li>
                        <strong>{summary.affectedWorkflowVersionCount}</strong>
                        <small>workflow versions in the blast radius</small>
                      </li>
                      {summary.latestChange && (
                        <li>
                          <strong>{summary.latestChange.serviceId}</strong>
                          <small>
                            latest {summary.latestChange.classification} change ·{' '}
                            {formatRelativeTime(summary.latestChange.discoveredAt)}
                          </small>
                        </li>
                      )}
                    </ul>
                  )}
                  {discoveries.length > details.length && (
                    <p className="home-detail">
                      Based on the {details.length} most recent of {discoveries.length} discoveries.
                    </p>
                  )}
                </>
              );
            }}
          </RemoteView>
        </Widget>
      )}

      {selectedWidgetIds.includes('capabilities') && (
        <Widget
          kicker="Ground truth"
          title="Sources & capabilities"
          surface="capabilities"
          linkLabel="Open capabilities"
          onRemove={() => onRemove('capabilities')}
        >
          <RemoteView remote={capabilities.remote} reload={capabilities.reload}>
            {(catalog) => {
              const summary = summarizeCapabilityHealth(
                catalog,
                drift.remote.status === 'ready' ? drift.remote.data.discoveries : [],
              );
              if (summary.totalCapabilities === 0) {
                return <p className="home-empty">No capabilities have been ingested yet.</p>;
              }
              return (
                <ul className="home-services">
                  {summary.services.map((service) => (
                    <li key={service.serviceId}>
                      <span className="home-monogram" aria-hidden="true">
                        {service.serviceId.slice(0, 1).toUpperCase()}
                      </span>
                      <div>
                        <strong>{service.serviceId}</strong>
                        <small>
                          {service.capabilityCount} capabilit
                          {service.capabilityCount === 1 ? 'y' : 'ies'}
                        </small>
                      </div>
                      {service.annotatedCount === service.capabilityCount ? (
                        <Tone tone="good">Annotated</Tone>
                      ) : (
                        <Tone tone="warn">
                          {service.capabilityCount - service.annotatedCount} unannotated
                        </Tone>
                      )}
                    </li>
                  ))}
                </ul>
              );
            }}
          </RemoteView>
        </Widget>
      )}

      {selectedWidgetIds.includes('activity') && (
        <Widget
          kicker="Lifecycle"
          title="Recent activity"
          surface="activity"
          linkLabel="Open activity"
          onRemove={() => onRemove('activity')}
        >
          <RemoteView remote={audit.remote} reload={audit.reload}>
            {(entries) => {
              if (entries.length === 0) {
                return <p className="home-empty">No lifecycle events recorded yet.</p>;
              }
              return (
                <ul className="home-activity">
                  {entries.slice(0, 6).map((entry) => (
                    <li key={entry.id}>
                      <div>
                        <strong>{entry.eventType.replaceAll('-', ' ')}</strong>
                        <small>
                          {entry.actorId ?? 'Atlas'} · {entry.subjectType}{' '}
                          <code>{entry.subjectId}</code>
                        </small>
                      </div>
                      <time dateTime={entry.recordedAt}>
                        {formatRelativeTime(entry.recordedAt)}
                      </time>
                    </li>
                  ))}
                </ul>
              );
            }}
          </RemoteView>
        </Widget>
      )}

      {selectedWidgetIds.includes('configuration') && (
        <Widget
          kicker="Administration"
          title="Configuration"
          surface="settings"
          linkLabel="Open settings"
          onRemove={() => onRemove('configuration')}
        >
          <ul className="home-facts">
            <li>
              <strong>Organization & memberships</strong>
              <small>{role === 'admin' ? 'Admin edits enabled' : 'View-only for this role'}</small>
            </li>
            <li>
              <strong>Worker readiness</strong>
              <small>IR support declarations by environment</small>
            </li>
            <li>
              <strong>Secret aliases & execution hosts</strong>
              <small>References and allowlist policy only; no secret values</small>
            </li>
          </ul>
        </Widget>
      )}
    </div>
  );
}

export function HomePage() {
  const [selectedWidgetIds, setSelectedWidgetIds] =
    useState<HomeWidgetId[]>(readBrowserHomeWidgetIds);
  const [customizing, setCustomizing] = useState(false);
  const [showingWelcome, setShowingWelcome] = useState(true);

  function setWidgets(nextWidgetIds: HomeWidgetId[]) {
    setSelectedWidgetIds(nextWidgetIds);
    writeBrowserHomeWidgetIds(nextWidgetIds);
  }

  function toggleWidget(widgetId: HomeWidgetId) {
    setWidgets(toggleHomeWidget(selectedWidgetIds, widgetId));
  }

  return (
    <div
      className={
        customizing || (!showingWelcome && selectedWidgetIds.length > 0)
          ? 'home home-workspace'
          : 'home'
      }
    >
      {customizing ? (
        <WidgetPicker
          selectedWidgetIds={selectedWidgetIds}
          onToggle={toggleWidget}
          onClose={() => setCustomizing(false)}
        />
      ) : !showingWelcome && selectedWidgetIds.length > 0 ? (
        <section className="home-dashboard" aria-label="Personal Home widgets">
          <div className="home-dashboard-toolbar">
            <button
              aria-controls="home-widget-picker"
              aria-expanded={false}
              onClick={() => setCustomizing(true)}
              type="button"
            >
              Edit widgets <span aria-hidden="true">＋</span>
            </button>
            <button onClick={() => setShowingWelcome(true)} type="button">
              Default home
            </button>
          </div>
          <DashboardWidgets selectedWidgetIds={selectedWidgetIds} onRemove={toggleWidget} />
        </section>
      ) : (
        <Welcome
          onCustomize={() => {
            setShowingWelcome(false);
            setCustomizing(true);
          }}
        />
      )}
    </div>
  );
}
