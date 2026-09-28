import { useState, type ReactNode } from 'react';

import { demoTokenForRole } from '../config.js';
import { formatRelativeTime } from '../home/summaries.js';
import { type DemoRole } from '../shell/session.js';
import { CapabilityUserAnnotations } from './CapabilityUserAnnotations.js';
import { describeSelectionDenial, extractOperationSchemas, operationRoute } from './catalog.js';
import {
  approveCapabilityVersionSafety,
  type CapabilityInspection,
  type PlannerProjectionSummary,
} from './data.js';

type ChipTone = 'good' | 'warn' | 'bad' | 'quiet';

export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return (
    <span className={`home-chip home-chip-${tone}`}>
      <i />
      {children}
    </span>
  );
}

export function shortId(value: string): string {
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function InspectorSection({ kicker, children }: { kicker: string; children: ReactNode }) {
  return (
    <section className="cat-inspector-section">
      <p className="cat-kicker">{kicker}</p>
      {children}
    </section>
  );
}

export function InspectorGroup({
  title,
  summary,
  open = false,
  children,
}: {
  title: string;
  summary: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="cat-inspector-group" open={open}>
      <summary>
        <span>
          <strong>{title}</strong>
          <small>{summary}</small>
        </span>
      </summary>
      <div>{children}</div>
    </details>
  );
}

type ApproveState =
  | { phase: 'running' }
  | { phase: 'succeeded'; message: string }
  | { phase: 'failed'; message: string };

function SchemaEvidenceList({
  kind,
  fragment,
}: {
  kind: 'openapi' | 'asyncapi';
  fragment: Record<string, unknown>;
}) {
  const schemas = extractOperationSchemas(kind, fragment);
  if (schemas.length === 0) {
    return <small>This fragment carries no typed schemas.</small>;
  }
  return (
    <div className="cat-schemas">
      {schemas.map((evidence) => (
        <details key={evidence.label}>
          <summary>
            {evidence.label}
            {evidence.reference && <code>{evidence.reference}</code>}
          </summary>
          <pre>{JSON.stringify(evidence.schema, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}

function SafetyApproval({
  inspection,
  role,
  organizationId,
  onApproved,
}: {
  inspection: CapabilityInspection;
  role: DemoRole;
  organizationId: string;
  onApproved: () => void;
}) {
  const [approve, setApprove] = useState<ApproveState | null>(null);
  const { version, selection } = inspection;
  const approvability = selection?.approvability;
  const runApproval = async () => {
    setApprove({ phase: 'running' });
    try {
      const approval = await approveCapabilityVersionSafety(
        organizationId,
        version.capabilityVersionId,
        demoTokenForRole(role),
      );
      setApprove({
        phase: 'succeeded',
        message: `Approved by ${approval.approvedBy} · ${formatRelativeTime(approval.approvedAt)}`,
      });
      onApproved();
    } catch (error) {
      setApprove({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Safety approval failed',
      });
    }
  };
  if (!version.annotation) {
    return (
      <small>
        Approval requires an ingested safety annotation. Ingest an Atlas safety manifest for this
        operation first.
      </small>
    );
  }
  return (
    <>
      {version.approval ? (
        <p className="cat-approval-evidence">
          <Chip tone="good">Safety approved</Chip>
          <small>
            by {version.approval.approvedBy} · {formatRelativeTime(version.approval.approvedAt)}
          </small>
        </p>
      ) : (
        <p className="cat-approval-evidence">
          <Chip tone="warn">Not yet approved</Chip>
        </p>
      )}
      {approvability && !approvability.allowed && (
        <>
          <small>Blocked from approval until every readiness requirement holds:</small>
          <ul className="cat-denials">
            {approvability.denials.map((denial) => (
              <li key={denial}>{describeSelectionDenial(denial)}</li>
            ))}
          </ul>
        </>
      )}
      <button
        className="cat-secondary"
        disabled={role !== 'admin' || approve?.phase === 'running'}
        onClick={() => void runApproval()}
        title={
          role === 'admin'
            ? 'Record the admin safety approval for this exact capability version'
            : 'Only the Admin role may approve capability safety; the server enforces this'
        }
        type="button"
      >
        {approve?.phase === 'running'
          ? 'Approving…'
          : version.approval
            ? 'Re-approve safety annotation'
            : 'Approve safety annotation'}
      </button>
      {role !== 'admin' && (
        <small>
          The {role} role cannot approve safety annotations. Switch the demo role to Admin — the
          backend rejects non-admin tokens regardless of what the UI shows.
        </small>
      )}
      {approve && approve.phase !== 'running' && (
        <p
          className={
            approve.phase === 'succeeded'
              ? 'cat-submit-result cat-submit-good'
              : 'cat-submit-result cat-submit-bad'
          }
          role={approve.phase === 'succeeded' ? 'status' : 'alert'}
        >
          {approve.message}
        </p>
      )}
    </>
  );
}

export function Inspector({
  inspection,
  role,
  organizationId,
  plannerProjection,
  onApproved,
  onAnnotationsChanged,
  onSelectVersion,
  afterHero,
}: {
  inspection: CapabilityInspection;
  role: DemoRole;
  organizationId: string;
  plannerProjection: PlannerProjectionSummary | null;
  onApproved: () => void;
  onAnnotationsChanged: () => void;
  onSelectVersion: (capabilityVersionId: string) => void;
  afterHero?: ReactNode;
}) {
  const { version, selection, dependencies } = inspection;
  const provenance = version.provenance;
  return (
    <>
      <div className="cat-inspector-hero">
        <p className="cat-kicker">{version.identity.serviceId}</p>
        <h2>{version.identity.operationId}</h2>
        <code>{operationRoute({ identity: version.identity, fragment: version.fragment })}</code>
      </div>
      {version.observation && (
        <InspectorSection kicker="Environment observation">
          <Chip tone={version.observation.availability === 'available' ? 'good' : 'bad'}>
            {version.observation.availability === 'available' ? 'Available' : 'Removed'}
          </Chip>{' '}
          <Chip tone={version.observation.freshness === 'fresh' ? 'good' : 'warn'}>
            {version.observation.freshness === 'fresh' ? 'Fresh' : 'Stale'}
          </Chip>
          <small>
            Last observed {formatRelativeTime(version.observation.lastObservedAt)} ·{' '}
            {version.observation.reason}
          </small>
        </InspectorSection>
      )}
      {selection && (
        <InspectorSection kicker="Workflow availability">
          {selection.newCompilation.allowed ? (
            <Chip tone="good">Available for new workflows</Chip>
          ) : (
            <>
              <Chip tone="warn">Unavailable for new workflows</Chip>
              <ul className="cat-denials">
                {selection.newCompilation.denials.map((denial) => (
                  <li key={denial}>{describeSelectionDenial(denial)}</li>
                ))}
              </ul>
            </>
          )}
          {plannerProjection && (
            <small>
              {plannerProjection.capabilityVersionIds.has(version.capabilityVersionId)
                ? 'Included in workflow planning'
                : 'Not included in workflow planning'}{' '}
              · fingerprint <code>{shortId(plannerProjection.fingerprint)}</code>
            </small>
          )}
        </InspectorSection>
      )}
      <CapabilityUserAnnotations
        annotations={version.userAnnotations ?? []}
        bearerToken={demoTokenForRole(role)}
        capabilityIdentityId={version.capabilityIdentityId}
        onChanged={onAnnotationsChanged}
        organizationId={organizationId}
      />
      <InspectorGroup
        title="Safety"
        summary={version.approval ? 'Approved - ownership and safeguards' : 'Approval needed'}
        open={!version.approval || selection?.newCompilation.allowed === false}
      >
        <InspectorSection kicker="Safety manifest">
          {version.annotation ? (
            <dl className="cat-provenance">
              <div>
                <dt>Owner</dt>
                <dd>{version.annotation.owner}</dd>
              </div>
              <div>
                <dt>Idempotency field</dt>
                <dd>{version.annotation.idempotencyField ?? 'none'}</dd>
              </div>
              <div>
                <dt>Compensated by</dt>
                <dd>{version.annotation.compensatedBy?.operationId ?? 'none'}</dd>
              </div>
              <div>
                <dt>Irreversible after</dt>
                <dd>{version.annotation.irreversibleAfter ? 'yes' : 'no'}</dd>
              </div>
              <div>
                <dt>Secret alias</dt>
                <dd>{version.annotation.secretAlias ?? 'none'}</dd>
              </div>
            </dl>
          ) : (
            <>
              <Chip tone="warn">Annotation missing</Chip>
              <small>
                This capability stays discoverable but is excluded from workflow planning and safety
                approval until its annotation is ingested and approved.
              </small>
            </>
          )}
        </InspectorSection>
        <InspectorSection kicker="Safety approval">
          <SafetyApproval
            inspection={inspection}
            onApproved={onApproved}
            organizationId={organizationId}
            role={role}
          />
        </InspectorSection>
      </InspectorGroup>
      <InspectorGroup title="Inputs & outputs" summary="Request, response, and event schemas">
        <InspectorSection kicker="Typed schemas">
          <SchemaEvidenceList fragment={version.fragment} kind={version.identity.kind} />
        </InspectorSection>
      </InspectorGroup>
      <InspectorGroup
        title="Usage"
        summary={`${dependencies.length} workflow references / ${version.runtimeObservations.length} runtime observations`}
      >
        <InspectorSection kicker="Workflow dependencies">
          {dependencies.length === 0 ? (
            <small>No approved workflows use this capability version.</small>
          ) : (
            <ul className="cat-denials">
              {dependencies.map((dependency) => (
                <li key={`${dependency.workflowVersionId}:${dependency.stepId}`}>
                  <code>{dependency.workflowVersionId}</code> · step {dependency.stepId}
                </li>
              ))}
            </ul>
          )}
        </InspectorSection>
        <InspectorSection kicker="Runtime observations">
          {version.runtimeObservations.length === 0 ? (
            <small>No workflow runs have been recorded for this capability.</small>
          ) : (
            <dl className="cat-provenance">
              {version.runtimeObservations.map((observation) => (
                <div key={`${observation.runId}:${observation.stepId}:${observation.attempt}`}>
                  <dt>
                    {observation.status} in {observation.environmentId}
                  </dt>
                  <dd>
                    Run {observation.runId}, step {observation.stepId}, attempt{' '}
                    {observation.attempt} · {observation.durationMs} ms
                    {observation.failureType ? ` · ${observation.failureType}` : ''}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </InspectorSection>
      </InspectorGroup>
      <InspectorGroup
        title="Source & history"
        summary={`${version.identityVersions.length} versions / source evidence and discovery tools`}
      >
        <InspectorSection kicker="Version identity">
          <strong title={version.capabilityVersionId}>
            {shortId(version.capabilityVersionId)}
          </strong>{' '}
          <Chip tone={version.lifecycleStatus === 'current' ? 'good' : 'quiet'}>
            {version.lifecycleStatus}
          </Chip>
          <small>A fixed identifier for this version of the capability.</small>
        </InspectorSection>
        <InspectorSection kicker="Version history">
          {version.identityVersions.length <= 1 ? (
            <small>This is the only published version of this capability.</small>
          ) : (
            <ul className="cat-version-history">
              {version.identityVersions.map((identityVersion) => (
                <li key={identityVersion.capabilityVersionId}>
                  <button
                    className={
                      identityVersion.capabilityVersionId === version.capabilityVersionId
                        ? 'cat-version-row cat-selected'
                        : 'cat-version-row'
                    }
                    onClick={() => onSelectVersion(identityVersion.capabilityVersionId)}
                    type="button"
                  >
                    <code>{shortId(identityVersion.capabilityVersionId)}</code>
                    <Chip tone={identityVersion.lifecycleStatus === 'current' ? 'good' : 'quiet'}>
                      {identityVersion.lifecycleStatus}
                    </Chip>
                    <small>
                      {identityVersion.introducedBy.kind !== 'human-confirmed' ? (
                        <>
                          introduced @ <code>{identityVersion.introducedBy.commit}</code>
                        </>
                      ) : (
                        <>confirmed by {identityVersion.introducedBy.confirmedBy}</>
                      )}{' '}
                      · {formatRelativeTime(identityVersion.publishedAt)}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </InspectorSection>
        <InspectorSection kicker="Source">
          {provenance ? (
            <dl className="cat-provenance">
              {provenance.evidence.kind === 'atlas-generated' ? (
                <>
                  <div>
                    <dt>Evidence</dt>
                    <dd>
                      Atlas-generated from application code; reviewed by{' '}
                      {provenance.evidence.confirmedBy}
                    </dd>
                  </div>
                  <div>
                    <dt>Source commit</dt>
                    <dd>
                      <a
                        href={`${provenance.evidence.repository}/commit/${provenance.evidence.commit}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {provenance.evidence.commit}
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt>Supporting code</dt>
                    <dd>
                      {provenance.evidence.supportingCode?.map((entry, index) => (
                        <p key={index}>
                          {entry.path}:{entry.startLine}–{entry.endLine} · {entry.functionName}
                        </p>
                      )) ?? 'Available in the repository contract review.'}
                    </dd>
                  </div>
                </>
              ) : provenance.evidence.kind !== 'human-confirmed' ? (
                <>
                  <div>
                    <dt>
                      {provenance.evidence.kind === 'github'
                        ? 'Connected GitHub repository'
                        : 'Repository snapshot'}
                    </dt>
                    <dd>
                      <a
                        href={`${provenance.evidence.repository}/blob/${provenance.evidence.commit}/${provenance.evidence.path}`}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {provenance.evidence.repository}
                      </a>
                    </dd>
                  </div>
                  <div>
                    <dt>Commit</dt>
                    <dd>
                      <code>{provenance.evidence.commit}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Specification</dt>
                    <dd>{provenance.evidence.path}</dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt>Evidence</dt>
                    <dd>Human-confirmed private API · {provenance.evidence.label}</dd>
                  </div>
                  <div>
                    <dt>Confirmed by</dt>
                    <dd>{provenance.evidence.confirmedBy}</dd>
                  </div>
                  <div>
                    <dt>Confirmed at</dt>
                    <dd>{new Date(provenance.evidence.confirmedAt).toLocaleString()}</dd>
                  </div>
                </>
              )}
              {provenance.manifest ? (
                <div>
                  <dt>Safety manifest</dt>
                  <dd>
                    {provenance.manifest.evidence.kind === 'atlas-generated' ? (
                      <>Atlas-generated · {provenance.manifest.evidence.label}</>
                    ) : provenance.manifest.evidence.kind !== 'human-confirmed' ? (
                      <>
                        {provenance.manifest.evidence.path} @{' '}
                        <code>{provenance.manifest.evidence.commit}</code>
                      </>
                    ) : (
                      <>
                        Human-confirmed by {provenance.manifest.evidence.confirmedBy} ·{' '}
                        {provenance.manifest.evidence.label}
                      </>
                    )}
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>Safety manifest</dt>
                  <dd>None recorded</dd>
                </div>
              )}
            </dl>
          ) : (
            <small>No source recorded.</small>
          )}
          {version.provenanceHistory.length > 1 && (
            <small>
              Seen unchanged in {version.provenanceHistory.length} ingestions — unrelated document
              changes do not alter this immutable version.
            </small>
          )}
        </InspectorSection>
        {afterHero}
      </InspectorGroup>
    </>
  );
}
