import { DeleteCapability } from './DeleteCapability.js';
import { useState } from 'react';

import { changeClassificationCopy, changeClassificationTone } from '../changes/changes.js';
import { demoTokenForRole } from '../config.js';
import { formatRelativeTime, type CapabilityDiscovery } from '../home/summaries.js';
import { RemoteView } from '../shell/RemoteView.js';
import { parseHashParameter, useLocationHash } from '../shell/router.js';
import { useConsoleSession, type EnvironmentId } from '../shell/session.js';
import {
  formatLabels,
  capabilityComparisonLabels,
  isCapabilityDifference,
  operationRoute,
  sourceEvidenceLabel,
  type CatalogCapabilityDetail,
  type ServiceGroup,
} from './catalog.js';
import { ConnectSourcePanel } from './ConnectSourcePanel.js';
import { RepositoryContracts } from './RepositoryContracts.js';
import { RepositoryDetailsSidebar } from './RepositoryDetailsSidebar.js';
import {
  repositoryAnalysisSidebarPrototypeEnabled,
  RepositoryAnalysisSidebarPrototype,
} from './RepositoryAnalysisSidebar.prototype.js';
import { RepositorySourceTree } from './RepositorySourceTree.js';
import { groupCatalogSources } from './repository-sources.js';
import { CapabilityArchitecturePage } from './CapabilityArchitecture.js';
import { CapabilityMapPage, CapabilityTabs, capabilityViewFromHash } from './CapabilityMap.js';
import { CapabilityMonitoringPanel } from './CapabilityMonitoringPanel.js';
import { EvidenceMonitoringPrototype } from './evidence/EvidenceMonitoringPrototype.js';
import {
  rerunRegisteredSource,
  setCapabilitySourceAuthority,
  useCatalogCapabilities,
  useCatalogRepositories,
  useDiscoveryDetail,
  useServiceDiscoveries,
  useSourceRegistrations,
  type DiscoveryResult,
} from './data.js';
import { FailedReingestOutcome, presentFailedReingest } from './reingest.js';
import { Chip, InspectorSection, shortId } from './OperationEvidence.js';
import { OperationEvidenceDrawer } from './OperationEvidenceDrawer.js';

const triggerLabels: Record<string, string> = {
  'repository-push': 'Repository push',
  'daily-poll': 'Backstop poll',
  'run-drift': 'Run drift signal',
};

interface LinkedNotificationNotice {
  title: string;
  message: string;
  nextAction: string | null;
  severity: 'info' | 'warning' | 'critical';
}

export function capabilityNotificationNoticeFromHash(
  hash: string,
): LinkedNotificationNotice | null {
  const title = parseHashParameter(hash, 'noticeTitle');
  const message = parseHashParameter(hash, 'noticeMessage');
  const severity = parseHashParameter(hash, 'noticeSeverity');
  if (!title || !message || !['info', 'warning', 'critical'].includes(severity ?? '')) return null;
  return {
    title,
    message,
    nextAction: parseHashParameter(hash, 'noticeNextAction'),
    severity: severity as LinkedNotificationNotice['severity'],
  };
}

export function findNotificationLinkedCapability(
  catalog: readonly CatalogCapabilityDetail[],
  capabilityIdentityId: string | null,
  capabilityLabel: string | null,
): CatalogCapabilityDetail | null {
  return (
    catalog.find(
      (capability) =>
        capabilityIdentityId !== null && capability.capabilityIdentityId === capabilityIdentityId,
    ) ??
    catalog.find(
      (capability) =>
        capabilityLabel !== null && capability.identity.operationId === capabilityLabel,
    ) ??
    null
  );
}

type RediscoverState =
  | { phase: 'running'; serviceId: string }
  | { phase: 'succeeded'; serviceId: string; result: DiscoveryResult }
  | { phase: 'failed'; serviceId: string; message: string };

export function repositoryContractsHash(
  environmentId: EnvironmentId,
  connectionId?: string,
): string {
  const parameters = new URLSearchParams({
    view: 'repositories',
    environmentId,
    ...(connectionId ? { repositoryConnection: connectionId } : {}),
  });
  return `#/capabilities?${parameters}`;
}

export function toggleExpandedService(
  expandedServices: ReadonlySet<string>,
  serviceId: string,
): ReadonlySet<string> {
  const next = new Set(expandedServices);
  if (next.has(serviceId)) next.delete(serviceId);
  else next.add(serviceId);
  return next;
}

function matchesSearch(capability: CatalogCapabilityDetail, search: string): boolean {
  if (!search) return true;
  const haystack = [
    capability.identity.operationId,
    capability.identity.serviceId,
    operationRoute(capability),
    capability.annotation?.owner ?? '',
    ...(capability.userAnnotations ?? []).map(({ body }) => body),
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function isVisibleCapability(
  capability: CatalogCapabilityDetail,
  search: string,
  differenceOnly: boolean,
) {
  return (
    matchesSearch(capability, search) && (!differenceOnly || isCapabilityDifference(capability))
  );
}

function DiscoveryChanges({
  organizationId,
  environmentId,
  discoveryId,
}: {
  organizationId: string;
  environmentId: string;
  discoveryId: string;
}) {
  const detail = useDiscoveryDetail(organizationId, environmentId, discoveryId);
  return (
    <div className="cat-history-detail">
      <RemoteView remote={detail.remote} reload={detail.reload}>
        {(discovery) => {
          if (!discovery || discovery.changes.length === 0) {
            return <p className="cat-empty">No capability changes in this discovery.</p>;
          }
          return (
            <ul>
              {discovery.changes.map((change) => (
                <li key={`${change.fromCapabilityVersionId}:${change.toCapabilityVersionId}`}>
                  <Chip tone={changeClassificationTone[change.classification]}>
                    {changeClassificationCopy[change.classification].label}
                  </Chip>
                  <code>
                    {shortId(change.fromCapabilityVersionId)} →{' '}
                    {change.toCapabilityVersionId
                      ? shortId(change.toCapabilityVersionId)
                      : 'removed'}
                  </code>
                  <small>
                    {change.affectedWorkflows.length} workflow dependenc
                    {change.affectedWorkflows.length === 1 ? 'y' : 'ies'} affected
                  </small>
                </li>
              ))}
            </ul>
          );
        }}
      </RemoteView>
    </div>
  );
}

function DiscoveryHistory({
  organizationId,
  environmentId,
  discoveries,
  serviceId,
}: {
  organizationId: string;
  environmentId: string;
  discoveries: CapabilityDiscovery[];
  serviceId: string | null;
}) {
  const [openDiscoveryId, setOpenDiscoveryId] = useState<string | null>(null);
  const scoped = discoveries
    .filter((discovery) => serviceId === null || discovery.serviceId === serviceId)
    .sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt))
    .slice(0, 8);
  return (
    <section className="cat-history" aria-label="Discovery history">
      <div className="cat-pane-heading">
        <span>Discovery history</span>
        <strong>{scoped.length ? `latest ${scoped.length}` : 'empty'}</strong>
      </div>
      {scoped.length === 0 ? (
        <p className="cat-empty">
          No discoveries recorded{serviceId ? ` for ${serviceId}` : ''} yet.
        </p>
      ) : (
        <ul>
          {scoped.map((discovery) => (
            <li key={discovery.discoveryId}>
              <button
                aria-expanded={openDiscoveryId === discovery.discoveryId}
                className="cat-history-row"
                onClick={() =>
                  setOpenDiscoveryId(
                    openDiscoveryId === discovery.discoveryId ? null : discovery.discoveryId,
                  )
                }
                type="button"
              >
                <strong>{triggerLabels[discovery.trigger] ?? discovery.trigger}</strong>
                <small>
                  {discovery.serviceId} · discovery #{discovery.discoveryId}
                </small>
                <time dateTime={discovery.discoveredAt}>
                  {formatRelativeTime(discovery.discoveredAt)}
                </time>
              </button>
              {openDiscoveryId === discovery.discoveryId && (
                <DiscoveryChanges
                  discoveryId={discovery.discoveryId}
                  environmentId={environmentId}
                  organizationId={organizationId}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function OperationList({
  services,
  selectedService,
  selectedVersionId,
  search,
  differenceOnly = false,
  onSelectCapability,
}: {
  services: ServiceGroup[];
  selectedService: string | null;
  selectedVersionId: string | null;
  search: string;
  differenceOnly?: boolean;
  onSelectCapability: (capabilityVersionId: string) => void;
}) {
  const [expandedServices, setExpandedServices] = useState<ReadonlySet<string>>(
    () => new Set(selectedService ? [selectedService] : []),
  );
  const scoped = selectedService
    ? services.filter((service) => service.serviceId === selectedService)
    : services;
  const visibleCount = scoped.reduce(
    (sum, service) =>
      sum +
      service.documents.reduce(
        (documentSum, document) =>
          documentSum +
          document.operations.filter((operation) =>
            isVisibleCapability(operation, search, differenceOnly),
          ).length,
        0,
      ),
    0,
  );
  return (
    <section className="cat-list" aria-label="Discovered operations">
      <div className="cat-pane-heading">
        <span>{selectedService ? `${selectedService} / operations` : 'All operations'}</span>
        <strong>
          {visibleCount} result{visibleCount === 1 ? '' : 's'}
        </strong>
      </div>
      {scoped.map((service) => {
        const operations = service.documents.flatMap((document) =>
          document.operations.filter((operation) =>
            isVisibleCapability(operation, search, differenceOnly),
          ),
        );
        const childrenId = `capability-service-${encodeURIComponent(service.serviceId)}`;
        const isExpanded = expandedServices.has(service.serviceId);
        return (
          <div className="cat-service" key={service.serviceId}>
            <button
              aria-controls={childrenId}
              aria-expanded={isExpanded}
              className="cat-service-heading"
              onClick={() =>
                setExpandedServices((current) => toggleExpandedService(current, service.serviceId))
              }
              type="button"
            >
              <span aria-hidden="true" className="cat-service-mark">
                {service.serviceId.slice(0, 1).toUpperCase()}
              </span>
              <div className="cat-service-title">
                <span className="cat-entity-label">Service group</span>
                <strong>{service.serviceId}</strong>
                <small>{service.kinds.map((kind) => formatLabels[kind]).join(' · ')}</small>
              </div>
              <span className="cat-service-count">
                {service.operationCount} operation{service.operationCount === 1 ? '' : 's'} ·{' '}
                {service.annotatedCount} annotated
              </span>
              <span aria-hidden="true" className="cat-service-chevron" />
            </button>
            {isExpanded && (
              <div className="cat-service-children" id={childrenId}>
                <div className="cat-operation-list-heading">Operations</div>
                {operations.map((operation) => (
                  <button
                    className={
                      operation.capabilityVersionId === selectedVersionId
                        ? 'cat-operation cat-selected'
                        : 'cat-operation'
                    }
                    key={operation.capabilityVersionId}
                    onClick={() => onSelectCapability(operation.capabilityVersionId)}
                    type="button"
                  >
                    <div>
                      <span className="cat-entity-label">Operation</span>
                      <strong>{operation.identity.operationId}</strong>
                      <code>{operationRoute(operation)}</code>
                    </div>
                    <span className="cat-operation-meta">
                      <span className="cat-operation-owner">
                        <small>Owner</small>
                        {operation.annotation?.owner ?? '—'}
                      </span>
                      {operation.annotation ? (
                        <Chip tone="good">Annotated</Chip>
                      ) : (
                        <Chip tone="warn">Annotation missing</Chip>
                      )}
                      {operation.observation.availability === 'removed' && (
                        <Chip tone="bad">Removed</Chip>
                      )}
                      {operation.observation.freshness === 'stale' && (
                        <Chip tone="warn">Stale</Chip>
                      )}
                      {operation.sourceResolution?.status === 'conflicting' && (
                        <Chip tone="bad">Conflicting sources</Chip>
                      )}
                      {operation.comparison && (
                        <Chip tone={operation.comparison.state === 'matching' ? 'good' : 'warn'}>
                          {capabilityComparisonLabels[operation.comparison.state]}
                        </Chip>
                      )}
                    </span>
                    {operation.sourceResolution?.status === 'conflicting' && (
                      <span className="cat-operation-conflict">
                        {operation.sourceResolution.claims.map((claim) => (
                          <small key={claim.sourceKey}>
                            {sourceEvidenceLabel(claim.provenance.evidence)} ·{' '}
                            <code>{shortId(claim.capabilityVersionId)}</code>
                          </small>
                        ))}
                      </span>
                    )}
                    <span className="cat-operation-action">
                      View details <span aria-hidden="true">→</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

export function CapabilityComparison({ capability }: { capability: CatalogCapabilityDetail }) {
  const comparison = capability.comparison;
  if (!comparison) return null;
  const sides = [
    ['Development', comparison.development],
    ['Production', comparison.production],
  ] as const;
  return (
    <InspectorSection kicker="Environment comparison">
      <p className="cat-drawer-copy">
        <Chip tone={comparison.state === 'matching' ? 'good' : 'warn'}>
          {capabilityComparisonLabels[comparison.state]}
        </Chip>{' '}
        Atlas correlates this logical capability across environments; each side keeps its own
        current observation.
      </p>
      <div className="cat-comparison-grid">
        {sides.map(([label, side]) => (
          <section key={label}>
            <h4>{label}</h4>
            {side ? (
              <>
                <small>
                  Version <code>{shortId(side.capabilityVersionId)}</code> ·{' '}
                  {side.observation.availability} · {side.observation.freshness}
                </small>
                <strong>Declared contract</strong>
                <pre>{JSON.stringify(side.fragment, null, 2)}</pre>
                <strong>Atlas metadata</strong>
                <pre>{JSON.stringify(side.annotation, null, 2)}</pre>
              </>
            ) : (
              <p className="cat-empty">No observation in this environment.</p>
            )}
          </section>
        ))}
      </div>
    </InspectorSection>
  );
}

function DiscoveryTools({
  serviceId,
  environmentId,
  registered,
  rediscover,
  onRediscover,
  onSimulatePush,
}: {
  serviceId: string;
  environmentId: EnvironmentId;
  registered: boolean;
  rediscover: RediscoverState | null;
  onRediscover: () => void;
  onSimulatePush: () => void;
}) {
  const busy = rediscover?.phase === 'running' && rediscover.serviceId === serviceId;
  const result = rediscover?.serviceId === serviceId ? rediscover : null;
  const succeeded = result?.phase === 'succeeded' ? result.result : null;
  const presented = succeeded ? presentFailedReingest(serviceId, succeeded) : null;
  return (
    <InspectorSection kicker="Service discovery">
      <p className="cat-drawer-copy">
        Refresh <strong>{serviceId}</strong> from its registered source when its API definition
        changes.
      </p>
      <div className="cat-drawer-actions">
        <button className="cat-secondary" onClick={onSimulatePush} type="button">
          Simulate source update
        </button>
        <button
          className="cat-secondary"
          disabled={!registered || busy}
          onClick={onRediscover}
          title={
            registered
              ? 'Manually run the scheduled poll against the registered source input'
              : 'This service has no registered discovery input yet'
          }
          type="button"
        >
          {busy ? 'Polling…' : 'Run scheduled poll'}
        </button>
      </div>
      {succeeded && presented && (
        <FailedReingestOutcome
          compatibleSummary={`${triggerLabels[succeeded.trigger] ?? succeeded.trigger}: ${presented.summary}`}
          environmentId={environmentId}
          result={succeeded}
          serviceId={serviceId}
        />
      )}
      {result?.phase === 'failed' && (
        <p className="cat-submit-result cat-submit-bad" role="alert">
          {result.message}
        </p>
      )}
    </InspectorSection>
  );
}

function SourceConflictControls({
  capability,
  environmentId,
  organizationId,
  bearerToken,
  canManage,
  onChanged,
}: {
  capability: CatalogCapabilityDetail;
  environmentId: string;
  organizationId: string;
  bearerToken: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const resolution = capability.sourceResolution;
  if (!resolution || resolution.status === 'uncontested') return null;
  const changeSourceAuthority = async (sourceKey: string | null) => {
    if (!capability.capabilityIdentityId) return;
    setSaving(sourceKey ?? 'clear');
    setFailure(null);
    try {
      await setCapabilitySourceAuthority(
        organizationId,
        environmentId,
        capability.capabilityIdentityId,
        sourceKey,
        bearerToken,
      );
      onChanged();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Authority change failed');
    } finally {
      setSaving(null);
    }
  };
  return (
    <InspectorSection kicker="Source authority">
      <p className="cat-drawer-copy">
        {resolution.status === 'conflicting'
          ? 'Conflicting sources claim different current contracts. This capability is excluded from planning.'
          : 'An Admin-designated source currently resolves this conflict.'}
      </p>
      <ul className="cat-history-detail">
        {resolution.claims.map((claim) => (
          <li key={claim.sourceKey}>
            <strong>{sourceEvidenceLabel(claim.provenance.evidence)}</strong>{' '}
            <code>{shortId(claim.capabilityVersionId)}</code>
            {resolution.authoritativeSourceKey === claim.sourceKey && (
              <Chip tone="good">Authoritative</Chip>
            )}
            {canManage && resolution.authoritativeSourceKey !== claim.sourceKey && (
              <button
                className="cat-secondary"
                disabled={saving !== null}
                onClick={() => void changeSourceAuthority(claim.sourceKey)}
                type="button"
              >
                Designate authoritative
              </button>
            )}
          </li>
        ))}
      </ul>
      {canManage && resolution.authoritativeSourceKey && (
        <button
          className="cat-secondary"
          disabled={saving !== null}
          onClick={() => void changeSourceAuthority(null)}
          type="button"
        >
          Clear authority
        </button>
      )}
      {failure && <p role="alert">{failure}</p>}
    </InspectorSection>
  );
}

function CapabilityCatalogPage() {
  const { organizationId, environmentId, role, demoProfileId } = useConsoleSession();
  const canConnect = role === 'admin';
  const locationHash = useLocationHash();
  const sourceBearerToken = demoTokenForRole(role);
  const capabilities = useCatalogCapabilities(organizationId, environmentId);
  const repositories = useCatalogRepositories(organizationId, sourceBearerToken);
  const discoveries = useServiceDiscoveries(organizationId, environmentId);
  const registrations = useSourceRegistrations(organizationId, environmentId, sourceBearerToken);
  const linkedCapabilityIdentityId = parseHashParameter(locationHash, 'capability');
  const linkedCapabilityLabel = parseHashParameter(locationHash, 'capabilityLabel');
  const linkedNotificationNotice = capabilityNotificationNoticeFromHash(locationHash);
  const linkedVersionId = parseHashParameter(locationHash, 'capabilityVersionId');
  const [dismissedRoute, setDismissedRoute] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(null);
  const [repositorySidebarKey, setRepositorySidebarKey] = useState<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(() => {
    return parseHashParameter(locationHash, 'capabilityVersionId');
  });
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectServiceId, setConnectServiceId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [differenceOnly, setDifferenceOnly] = useState(
    () => parseHashParameter(locationHash, 'comparison') === 'different',
  );
  const [rediscover, setRediscover] = useState<RediscoverState | null>(null);

  const reloadAll = () => {
    capabilities.reload();
    discoveries.reload();
    registrations.reload();
    repositories.reload();
  };

  const startRediscover = async (serviceId: string) => {
    setRediscover({ phase: 'running', serviceId });
    try {
      const result = await rerunRegisteredSource(
        organizationId,
        environmentId,
        serviceId,
        sourceBearerToken,
      );
      setRediscover({
        phase: 'succeeded',
        serviceId,
        result,
      });
      reloadAll();
    } catch (error) {
      setRediscover({
        phase: 'failed',
        serviceId,
        message: error instanceof Error ? error.message : 'Rediscovery failed',
      });
    }
  };

  const simulatePush = (serviceId: string) => {
    if (!canConnect) return;
    setConnectServiceId(serviceId);
    setConnectOpen(true);
  };

  const openBlankConnect = () => {
    if (!canConnect) return;
    setConnectServiceId(null);
    setConnectOpen(true);
  };

  if (connectOpen) {
    return (
      <div className="capability-view-content">
        <ConnectSourcePanel
          bearerToken={sourceBearerToken}
          demoProfile={demoProfileId}
          environmentId={environmentId}
          initialServiceId={connectServiceId}
          key={connectServiceId ?? 'blank'}
          onClose={() => {
            setConnectOpen(false);
            reloadAll();
          }}
          onDiscovered={reloadAll}
          organizationId={organizationId}
        />
      </div>
    );
  }

  return (
    <div className="capability-view-content">
      <header className="cat-heading">
        <div>
          <h1>Capability catalog</h1>
          <p className="cat-intro">
            Choose a repository, then a service group to explore its capabilities and safety state.
          </p>
        </div>
        <div className="cat-heading-actions">
          <label className="cat-difference-filter">
            <input
              checked={differenceOnly}
              onChange={(event) => setDifferenceOnly(event.target.checked)}
              type="checkbox"
            />
            Differences only
          </label>
          <label className="cat-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search capabilities"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search capabilities…"
              value={search}
            />
          </label>
          <button
            className="cat-primary"
            disabled={!canConnect}
            title={!canConnect ? 'Ask an admin to connect sources' : undefined}
            onClick={openBlankConnect}
            type="button"
          >
            ＋ Connect source
          </button>
        </div>
      </header>
      <RemoteView remote={capabilities.remote} reload={capabilities.reload}>
        {(catalog) => {
          const sources = groupCatalogSources(
            catalog,
            repositories.remote.status === 'ready' ? repositories.remote.data : [],
          );
          const linkedCapability = findNotificationLinkedCapability(
            catalog,
            linkedCapabilityIdentityId,
            linkedCapabilityLabel,
          );
          const routeCapability =
            linkedCapability ??
            catalog.find((capability) => capability.capabilityVersionId === linkedVersionId) ??
            null;
          const routeIsDismissed = dismissedRoute === locationHash;
          const routeSource = routeCapability
            ? sources.find((source) =>
                source.capabilities.some(
                  (entry) => entry.capabilityVersionId === routeCapability.capabilityVersionId,
                ),
              )
            : undefined;
          const activeSourceKey =
            !routeIsDismissed && routeSource ? routeSource.key : selectedSourceKey;
          const activeSource = sources.find((source) => source.key === activeSourceKey);
          const repositorySidebarSource = sources.find(
            (source) => source.key === repositorySidebarKey && source.repository,
          );
          const repositorySidebarConnection = repositorySidebarSource?.connectionId
            ? repositories.remote.status === 'ready'
              ? repositories.remote.data.find(
                  (connection) => connection.id === repositorySidebarSource.connectionId,
                )
              : undefined
            : undefined;
          const repositorySidebarPrototypeEnabled = repositoryAnalysisSidebarPrototypeEnabled();
          const activeVersionId =
            !routeIsDismissed && routeCapability
              ? routeCapability.capabilityVersionId
              : selectedVersionId;
          const activeService =
            !routeIsDismissed && routeCapability
              ? routeCapability.identity.serviceId
              : selectedService;
          const selectVersion = (capabilityVersionId: string | null) => {
            setDismissedRoute(locationHash);
            setSelectedSourceKey(activeSourceKey);
            setSelectedService(activeService);
            setSelectedVersionId(capabilityVersionId);
            if (capabilityVersionId) setRepositorySidebarKey(null);
          };
          const discoveryList =
            discoveries.remote.status === 'ready' ? discoveries.remote.data : [];
          const registrationList =
            registrations.remote.status === 'ready' ? registrations.remote.data : [];
          const latest = [...discoveryList].sort((left, right) =>
            right.discoveredAt.localeCompare(left.discoveredAt),
          )[0];
          const hasRepositories = sources.some((source) => source.repository);
          const emptyTitle = activeSource
            ? 'No capabilities in this catalog yet'
            : sources.length
              ? hasRepositories
                ? 'Choose a repository'
                : 'Choose a source'
              : repositories.remote.status === 'loading'
                ? 'Loading repositories…'
                : repositories.remote.status === 'error'
                  ? 'Repository list unavailable'
                  : 'Connect your first repository';
          const emptyDescription = activeSource
            ? 'Open analysis and ingestion for this repository’s source contracts and saved results.'
            : sources.length
              ? `Select a ${hasRepositories ? 'repository' : 'source'} on the left, then explore its service groups.`
              : repositories.remote.status === 'loading'
                ? 'Getting your connected repositories and saved capabilities.'
                : repositories.remote.status === 'error'
                  ? 'Retry loading repositories from the Sources sidebar.'
                  : 'Connect a repository to find its API services and review their capabilities.';
          return (
            <div className="cat-explorer">
              <RepositorySourceTree
                key={organizationId}
                onSelect={(sourceKey, serviceId) => {
                  setDismissedRoute(locationHash);
                  setSelectedSourceKey(sourceKey);
                  setSelectedService(serviceId);
                  setSelectedVersionId(null);
                  const selectedSource = sources.find((source) => source.key === sourceKey);
                  setRepositorySidebarKey(
                    serviceId === null && selectedSource?.repository ? sourceKey : null,
                  );
                }}
                selectedSourceKey={activeSourceKey}
                selectedService={activeService}
                sources={sources}
              >
                {repositories.remote.status === 'loading' && (
                  <p className="cat-tree-empty" role="status">
                    Loading repositories…
                  </p>
                )}
                {repositories.remote.status === 'error' && (
                  <div className="cat-tree-error" role="alert">
                    <p>Couldn’t load connected repositories.</p>
                    <button className="cat-secondary" type="button" onClick={repositories.reload}>
                      Retry loading repositories
                    </button>
                  </div>
                )}
                {!sources.length && repositories.remote.status === 'ready' && (
                  <p className="cat-tree-empty">No repositories connected yet.</p>
                )}
                <div className="cat-tree-foot">
                  <small>Last discovery</small>
                  <strong>
                    {latest
                      ? `${triggerLabels[latest.trigger] ?? latest.trigger} · ${formatRelativeTime(latest.discoveredAt)}`
                      : 'None recorded yet'}
                  </strong>
                </div>
              </RepositorySourceTree>
              <div className="cat-source-content">
                {activeSource && (
                  <header className="cat-repository-context">
                    <div>
                      <small>{activeSource.repository ? 'Repository' : 'Source'}</small>
                      <h2>{activeSource.label}</h2>
                      <p>
                        {activeSource.repository ??
                          'These imports do not have a repository recorded.'}
                      </p>
                      <p>
                        {activeSource.branches.length
                          ? `Tracking ${activeSource.branches.join(', ')} · `
                          : ''}
                        {activeSource.capabilities.length} capabilities
                      </p>
                    </div>
                    {activeSource.connectionId && (
                      <button
                        className="cat-secondary"
                        type="button"
                        onClick={() => {
                          selectVersion(null);
                          setRepositorySidebarKey(activeSource.key);
                        }}
                      >
                        Repository details
                      </button>
                    )}
                  </header>
                )}
                {activeSource?.services.length ? (
                  <OperationList
                    key={`${activeSource.key}:${activeService ?? ''}`}
                    differenceOnly={differenceOnly}
                    onSelectCapability={selectVersion}
                    search={search}
                    selectedService={activeService}
                    selectedVersionId={activeVersionId}
                    services={activeSource.services}
                  />
                ) : (
                  <div className="cat-onboarding">
                    <h2>{emptyTitle}</h2>
                    <p>{emptyDescription}</p>
                    {!sources.length && repositories.remote.status === 'ready' && canConnect && (
                      <button className="cat-primary" onClick={openBlankConnect} type="button">
                        Connect repository
                      </button>
                    )}
                  </div>
                )}
              </div>
              {activeVersionId !== null && (
                <OperationEvidenceDrawer
                  afterHero={(serviceId) => {
                    const selectedCapability = catalog.find(
                      (candidate) => candidate.capabilityVersionId === activeVersionId,
                    );
                    return (
                      <>
                        {selectedCapability && (
                          <>
                            <CapabilityComparison capability={selectedCapability} />
                            {role === 'admin' &&
                              selectedCapability.capabilityIdentityId &&
                              selectedCapability.comparison?.[
                                environmentId === 'development' ? 'development' : 'production'
                              ] && (
                                <DeleteCapability
                                  key={`${environmentId}:${selectedCapability.capabilityIdentityId}`}
                                  organizationId={organizationId}
                                  environmentId={environmentId}
                                  capabilityIdentityId={selectedCapability.capabilityIdentityId}
                                  name={selectedCapability.identity.operationId}
                                  bearerToken={sourceBearerToken}
                                  onDeleted={() => {
                                    selectVersion(null);
                                    reloadAll();
                                  }}
                                />
                              )}
                            {(environmentId === 'development'
                              ? selectedCapability.comparison?.development
                              : selectedCapability.comparison?.production) && (
                              <SourceConflictControls
                                bearerToken={sourceBearerToken}
                                canManage={role === 'admin'}
                                capability={selectedCapability}
                                environmentId={environmentId}
                                onChanged={reloadAll}
                                organizationId={organizationId}
                              />
                            )}
                          </>
                        )}
                        {(environmentId === 'development'
                          ? selectedCapability?.comparison?.development
                          : selectedCapability?.comparison?.production) && (
                          <DiscoveryTools
                            environmentId={environmentId}
                            onRediscover={() => void startRediscover(serviceId)}
                            onSimulatePush={() => {
                              selectVersion(null);
                              simulatePush(serviceId);
                            }}
                            rediscover={rediscover}
                            registered={registrationList.some(
                              (entry) => entry.serviceId === serviceId,
                            )}
                            serviceId={serviceId}
                          />
                        )}
                      </>
                    );
                  }}
                  capabilityVersionId={activeVersionId}
                  environmentId={
                    catalog.find((candidate) => candidate.capabilityVersionId === activeVersionId)
                      ?.comparison?.[environmentId === 'development' ? 'development' : 'production']
                      ? environmentId
                      : environmentId === 'development'
                        ? 'production'
                        : 'development'
                  }
                  onClose={() => selectVersion(null)}
                  onSelectVersion={selectVersion}
                  organizationId={organizationId}
                  role={role}
                  topContent={
                    linkedNotificationNotice &&
                    linkedCapability?.capabilityVersionId === activeVersionId ? (
                      <aside
                        className={`cat-notification-notice cat-notification-notice-${linkedNotificationNotice.severity}`}
                        role="status"
                      >
                        <span>From notifications</span>
                        <strong>{linkedNotificationNotice.title}</strong>
                        <p>{linkedNotificationNotice.message}</p>
                        {linkedNotificationNotice.nextAction && (
                          <small>Next action: {linkedNotificationNotice.nextAction}</small>
                        )}
                      </aside>
                    ) : undefined
                  }
                >
                  {(serviceId) => (
                    <DiscoveryHistory
                      discoveries={discoveryList}
                      environmentId={environmentId}
                      organizationId={organizationId}
                      serviceId={serviceId}
                    />
                  )}
                </OperationEvidenceDrawer>
              )}
              {!repositorySidebarPrototypeEnabled && repositorySidebarSource && (
                <RepositoryDetailsSidebar
                  connection={repositorySidebarConnection}
                  onViewAnalysis={() => {
                    if (!repositorySidebarSource.connectionId) return;
                    const hash = repositoryContractsHash(
                      environmentId,
                      repositorySidebarSource.connectionId,
                    );
                    window.history.pushState(null, '', hash);
                    window.dispatchEvent(new HashChangeEvent('hashchange'));
                  }}
                  source={repositorySidebarSource}
                />
              )}
              {repositorySidebarPrototypeEnabled && (
                <RepositoryAnalysisSidebarPrototype
                  connection={repositorySidebarConnection}
                  onViewAnalysis={() => {
                    if (!repositorySidebarSource?.connectionId) return;
                    const hash = repositoryContractsHash(
                      environmentId,
                      repositorySidebarSource.connectionId,
                    );
                    window.history.pushState(null, '', hash);
                    window.dispatchEvent(new HashChangeEvent('hashchange'));
                  }}
                  source={repositorySidebarSource}
                />
              )}
            </div>
          );
        }}
      </RemoteView>
    </div>
  );
}

export function CapabilitiesPage() {
  const locationHash = useLocationHash();
  const { organizationId, environmentId, role } = useConsoleSession();
  const view = capabilityViewFromHash(locationHash);
  return (
    <div className="cat">
      <CapabilityTabs active={view} environmentId={environmentId} />
      {view === 'repositories' ? (
        <RepositoryContracts
          bearerToken={demoTokenForRole(role)}
          canManage={role === 'admin'}
          environmentId={environmentId}
          initialConnectionId={parseHashParameter(locationHash, 'repositoryConnection')}
          organizationId={organizationId}
        />
      ) : view === 'evidence' ? (
        <>
          <section className="ec-demo-monitoring" aria-labelledby="burger-town-monitoring-title">
            <header className="ec-heading">
              <div>
                <h2 id="burger-town-monitoring-title">Burger Town monitoring</h2>
                <p>Poll Burger Town API endpoints for changes during the demo.</p>
              </div>
              <span className="ec-preview">Demo only</span>
            </header>
            <CapabilityMonitoringPanel
              bearerToken={demoTokenForRole(role)}
              environmentId={environmentId}
              organizationId={organizationId}
            />
          </section>
          <EvidenceMonitoringPrototype />
        </>
      ) : view === 'map' ? (
        <CapabilityMapPage />
      ) : view === 'architecture' ? (
        <CapabilityArchitecturePage />
      ) : (
        <CapabilityCatalogPage />
      )}
    </div>
  );
}
