import { AccessRequests } from './AccessRequests.js';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { demoTokenForRole } from '../config.js';
import { requestJson } from '../shell/api.js';
import { environmentLabels, useConsoleSession, type DemoRole } from '../shell/session.js';

interface AdminSuite {
  organization: { id: string; name: string; settings: Record<string, unknown> };
  users: Array<{ id: string; email: string; name: string; role: DemoRole }>;
  teams: Array<{ id: string; name: string; userIds: string[] }>;
  environments: Array<{ id: string; name: string; kind: 'development' | 'production' }>;
  secretReferences: Array<{
    alias: string;
    environmentId: string;
    description: string;
    valueLocation: 'worker';
    updatedBy: string;
    updatedAt: string;
  }>;
  workerDeclarations: Array<{
    environmentId: string;
    workerId: string;
    supportedIrVersions: { minimum: number; maximum: number };
    declaredAt: string;
  }>;
  capabilities: Array<{
    capabilityIdentityId: string;
    capabilityVersionId: string;
    serviceId: string;
    operationId: string;
  }>;
  capabilityHostPolicies: Array<{
    capabilityIdentityId: string;
    capabilityVersionId: string;
    serviceId: string;
    operationId: string;
    environmentId: string;
    hostname: string;
    allowRedirects: boolean;
    approvedBy: string;
    approvedAt: string;
  }>;
}

const roleLabels: Record<DemoRole, string> = {
  author: 'Author',
  admin: 'Admin',
  operator: 'Operator',
};

function bearer(token: string, json = false): HeadersInit {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

export function SettingsPage() {
  const { organizationId, environmentId, role, customerUser } = useConsoleSession();
  const token = demoTokenForRole(role);
  const editable = role === 'admin';
  const [suite, setSuite] = useState<AdminSuite>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [removeUserId, setRemoveUserId] = useState<string>();
  const [removing, setRemoving] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [defaultEnvironmentId, setDefaultEnvironmentId] = useState('development');
  const [aliasEnvironmentId, setAliasEnvironmentId] = useState(environmentId);
  const [alias, setAlias] = useState('');
  const [aliasDescription, setAliasDescription] = useState('');
  const [policyEnvironmentId, setPolicyEnvironmentId] = useState(environmentId);
  const [capabilityIdentityId, setCapabilityIdentityId] = useState('');
  const [hostname, setHostname] = useState('');
  const [allowRedirects, setAllowRedirects] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await requestJson<AdminSuite>(
        `/v1/organizations/${organizationId}/admin-suite`,
        { headers: bearer(token) },
        (status) => `Settings could not be loaded (${status})`,
      );
      setSuite(next);
      setDisplayName(
        typeof next.organization.settings.displayName === 'string'
          ? next.organization.settings.displayName
          : next.organization.name,
      );
      setDefaultEnvironmentId(
        typeof next.organization.settings.defaultEnvironmentId === 'string'
          ? next.organization.settings.defaultEnvironmentId
          : 'development',
      );
      setCapabilityIdentityId(
        (current) => current || next.capabilities[0]?.capabilityIdentityId || '',
      );
      setError(undefined);
    } catch (cause) {
      setSuite(undefined);
      setError(cause instanceof Error ? cause.message : 'Settings could not be loaded');
    }
  }, [organizationId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setAliasEnvironmentId(environmentId);
    setPolicyEnvironmentId(environmentId);
  }, [environmentId]);

  const teamByUser = useMemo(
    () =>
      new Map(
        suite?.teams.flatMap((team) => team.userIds.map((userId) => [userId, team.name] as const)),
      ),
    [suite],
  );

  async function mutate(path: string, init: RequestInit, success: string) {
    setMessage(undefined);
    setError(undefined);
    try {
      await requestJson(path, init, (status) => `Change was rejected by the server (${status})`);
      await load();
      setMessage(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change could not be saved');
    }
  }

  async function saveOrganization() {
    await mutate(
      `/v1/organizations/${organizationId}/settings`,
      {
        method: 'PATCH',
        headers: bearer(token, true),
        body: JSON.stringify({ displayName, defaultEnvironmentId }),
      },
      'Organization defaults saved and recorded in Activity.',
    );
  }

  async function changeRole(userId: string, nextRole: DemoRole) {
    await mutate(
      `/v1/organizations/${organizationId}/users/${userId}/membership`,
      {
        method: 'PUT',
        headers: bearer(token, true),
        body: JSON.stringify({ role: nextRole }),
      },
      'Membership changed and recorded in Activity.',
    );
  }

  async function removeAccess(userId: string) {
    setRemoving(true);
    await mutate(
      `/auth/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
      'Access removed and existing sessions ended.',
    );
    setRemoving(false);
    setRemoveUserId(undefined);
  }

  async function saveAlias() {
    await mutate(
      `/v1/organizations/${organizationId}/environments/${aliasEnvironmentId}/secret-references/${encodeURIComponent(alias.trim())}`,
      {
        method: 'PUT',
        headers: bearer(token, true),
        body: JSON.stringify({ description: aliasDescription }),
      },
      'Worker-held alias saved and recorded in Activity.',
    );
    setAlias('');
    setAliasDescription('');
  }

  async function saveHostPolicy() {
    await mutate(
      `/v1/organizations/${organizationId}/environments/${policyEnvironmentId}/capability-host-policies/${capabilityIdentityId}/${encodeURIComponent(hostname.trim())}`,
      {
        method: 'PUT',
        headers: bearer(token, true),
        body: JSON.stringify({ allowRedirects }),
      },
      'Execution-host policy granted and planner eligibility refreshed.',
    );
    setHostname('');
    setAllowRedirects(false);
  }

  async function revokeHostPolicy(policy: AdminSuite['capabilityHostPolicies'][number]) {
    await mutate(
      `/v1/organizations/${organizationId}/environments/${policy.environmentId}/capability-host-policies/${policy.capabilityIdentityId}/${encodeURIComponent(policy.hostname)}`,
      { method: 'DELETE', headers: bearer(token) },
      'Execution-host policy revoked and planner eligibility refreshed.',
    );
  }

  return (
    <div className="settings">
      <header className="settings-heading">
        <div>
          <p>{customerUser ? 'Administration' : 'Local administration'}</p>
          <h1>Settings</h1>
          <span>
            Organization defaults, memberships, execution environments, and worker-held references.
          </span>
        </div>
        <div className={editable ? 'settings-access settings-access-admin' : 'settings-access'}>
          <strong>{editable ? 'Admin access' : 'Read only'}</strong>
          <small>The server authorizes every change.</small>
        </div>
      </header>

      {customerUser && editable && <AccessRequests />}

      {error && (
        <div className="settings-alert settings-alert-error">
          <span>{error}</span>
          {!suite && <button onClick={() => void load()}>Retry</button>}
        </div>
      )}
      {message && <div className="settings-alert settings-alert-good">{message}</div>}
      {!suite && !error && <div className="settings-empty">Loading configuration workbook…</div>}

      {suite && (
        <section className="settings-workbook">
          <nav aria-label="Workbook sections" className="settings-tabs">
            <SettingsSectionLink target="settings-organization">Organization</SettingsSectionLink>
            <SettingsSectionLink target="settings-memberships">
              Memberships <b>{suite.users.length}</b>
            </SettingsSectionLink>
            <SettingsSectionLink target="settings-environments">
              Environments <b>{suite.environments.length}</b>
            </SettingsSectionLink>
            <SettingsSectionLink target="settings-secrets">
              Secret references <b>{suite.secretReferences.length}</b>
            </SettingsSectionLink>
            <SettingsSectionLink target="settings-hosts">
              Execution hosts <b>{suite.capabilityHostPolicies.length}</b>
            </SettingsSectionLink>
          </nav>

          <WorkbookSection
            description="Shared values used across the local Atlas organization."
            eyebrow="General"
            id="settings-organization"
            title="Organization defaults"
          >
            <div className="settings-fields">
              <label>
                <span>Display name</span>
                <input
                  disabled={!editable}
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName}
                />
              </label>
              <label>
                <span>Organization ID</span>
                <input disabled value={suite.organization.id} />
              </label>
              <label>
                <span>Default environment</span>
                <select
                  disabled={!editable}
                  onChange={(event) => setDefaultEnvironmentId(event.target.value)}
                  value={defaultEnvironmentId}
                >
                  {suite.environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={!editable || !displayName.trim()}
                onClick={() => void saveOrganization()}
              >
                Save organization
              </button>
            </div>
          </WorkbookSection>

          <WorkbookSection
            description="One explicit built-in role per organization member; Atlas is the only local team."
            eyebrow="Access"
            id="settings-memberships"
            title="Membership assignments"
          >
            <div className="settings-table settings-members">
              <div className="settings-table-head">
                <span>User</span>
                <span>Team</span>
                <span>Role</span>
              </div>
              {suite.users.map((user) => (
                <div className="settings-table-row" key={user.id}>
                  <span>
                    <strong>{user.name}</strong>
                    <small>{user.email}</small>
                  </span>
                  <span>{teamByUser.get(user.id) ?? '—'}</span>
                  <div>
                    <select
                      aria-label={`Role for ${user.name}`}
                      disabled={!editable}
                      onChange={(event) => void changeRole(user.id, event.target.value as DemoRole)}
                      value={user.role}
                    >
                      {Object.entries(roleLabels).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {customerUser &&
                      editable &&
                      (removeUserId === user.id ? (
                        <div>
                          <p>Remove access for {user.name}? Their active sessions will end.</p>
                          <button
                            type="button"
                            disabled={removing}
                            onClick={() => void removeAccess(user.id)}
                          >
                            Confirm removal
                          </button>
                          <button
                            type="button"
                            disabled={removing}
                            onClick={() => setRemoveUserId(undefined)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => setRemoveUserId(user.id)}>
                          Remove access
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          </WorkbookSection>

          <WorkbookSection
            description="Workers declare the environments they serve and the IR versions they can execute."
            eyebrow="Execution boundaries"
            id="settings-environments"
            title="Environment readiness"
          >
            <div className="settings-environments">
              {suite.environments.map((environment) => {
                const workers = suite.workerDeclarations.filter(
                  (worker) => worker.environmentId === environment.id,
                );
                return (
                  <article key={environment.id}>
                    <header>
                      <span className={`settings-env-mark settings-env-${environment.kind}`}>
                        {environment.kind === 'development' ? 'D' : 'P'}
                      </span>
                      <div>
                        <strong>{environment.name}</strong>
                        <code>{environment.id}</code>
                      </div>
                      <b>{workers.length ? `${workers.length} declared` : 'No worker declared'}</b>
                    </header>
                    {workers.length ? (
                      workers.map((worker) => (
                        <p key={worker.workerId}>
                          <code>{worker.workerId}</code>
                          <span>
                            IR {worker.supportedIrVersions.minimum}–
                            {worker.supportedIrVersions.maximum}
                          </span>
                        </p>
                      ))
                    ) : (
                      <p className="settings-muted">
                        Activation readiness is blocked until a worker declares support.
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
          </WorkbookSection>

          <WorkbookSection
            description="References only. Secret values stay behind the worker SecretProvider and never enter Atlas."
            eyebrow="Worker-held values"
            id="settings-secrets"
            title="Secret alias registry"
          >
            <div className="settings-trust">
              <strong>No secret-value field exists.</strong>
              <span>Only an environment, alias, and description are sent to the backend.</span>
            </div>
            <div className="settings-table settings-secrets">
              <div className="settings-table-head">
                <span>Alias</span>
                <span>Environment</span>
                <span>Description</span>
              </div>
              {suite.secretReferences.map((reference) => (
                <div
                  className="settings-table-row"
                  key={`${reference.environmentId}:${reference.alias}`}
                >
                  <code>{reference.alias}</code>
                  <span>
                    {environmentLabels[reference.environmentId as keyof typeof environmentLabels] ??
                      reference.environmentId}
                  </span>
                  <small>{reference.description || 'No description'}</small>
                </div>
              ))}
              {!suite.secretReferences.length && (
                <p className="settings-muted">No worker-held aliases are registered.</p>
              )}
            </div>
            <div className="settings-inline-form">
              <label>
                <span>Environment</span>
                <select
                  disabled={!editable}
                  onChange={(event) =>
                    setAliasEnvironmentId(event.target.value as typeof aliasEnvironmentId)
                  }
                  value={aliasEnvironmentId}
                >
                  {suite.environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Alias</span>
                <input
                  disabled={!editable}
                  onChange={(event) => setAlias(event.target.value)}
                  placeholder="worker-secret-alias"
                  value={alias}
                />
              </label>
              <label>
                <span>Description</span>
                <input
                  disabled={!editable}
                  onChange={(event) => setAliasDescription(event.target.value)}
                  placeholder="What the worker uses it for"
                  value={aliasDescription}
                />
              </label>
              <button disabled={!editable || !alias.trim()} onClick={() => void saveAlias()}>
                Save reference
              </button>
            </div>
          </WorkbookSection>

          <WorkbookSection
            description="Per-environment destinations that capability calls may reach. Changes immediately affect planner eligibility."
            eyebrow="Execution safety"
            id="settings-hosts"
            title="Execution-host allowlist"
          >
            <div className="settings-table settings-hosts">
              <div className="settings-table-head">
                <span>Capability</span>
                <span>Environment / host</span>
                <span>Approval</span>
                <span />
              </div>
              {suite.capabilityHostPolicies.map((policy) => (
                <div
                  className="settings-table-row"
                  key={`${policy.environmentId}:${policy.capabilityIdentityId}:${policy.hostname}`}
                >
                  <span>
                    <strong>
                      {policy.serviceId}.{policy.operationId}
                    </strong>
                    <small title={policy.capabilityVersionId}>
                      {policy.capabilityVersionId.slice(0, 10)}…
                    </small>
                  </span>
                  <span>
                    <strong>{policy.hostname}</strong>
                    <small>
                      {policy.environmentId} · redirects{' '}
                      {policy.allowRedirects ? 'allowed' : 'blocked'}
                    </small>
                  </span>
                  <span>
                    <strong>{policy.approvedBy}</strong>
                    <small>{new Date(policy.approvedAt).toLocaleString()}</small>
                  </span>
                  <button disabled={!editable} onClick={() => void revokeHostPolicy(policy)}>
                    Revoke
                  </button>
                </div>
              ))}
              {!suite.capabilityHostPolicies.length && (
                <p className="settings-muted">No execution-host policy covers a capability yet.</p>
              )}
            </div>
            <div className="settings-inline-form settings-policy-form">
              <label>
                <span>Environment</span>
                <select
                  disabled={!editable}
                  onChange={(event) =>
                    setPolicyEnvironmentId(event.target.value as typeof policyEnvironmentId)
                  }
                  value={policyEnvironmentId}
                >
                  {suite.environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Capability</span>
                <select
                  disabled={!editable}
                  onChange={(event) => setCapabilityIdentityId(event.target.value)}
                  value={capabilityIdentityId}
                >
                  {suite.capabilities.map((capability) => (
                    <option
                      key={capability.capabilityIdentityId}
                      value={capability.capabilityIdentityId}
                    >
                      {capability.serviceId}.{capability.operationId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Hostname</span>
                <input
                  disabled={!editable}
                  onChange={(event) => setHostname(event.target.value)}
                  placeholder="billing.internal"
                  value={hostname}
                />
              </label>
              <label className="settings-checkbox">
                <input
                  checked={allowRedirects}
                  disabled={!editable}
                  onChange={(event) => setAllowRedirects(event.target.checked)}
                  type="checkbox"
                />
                <span>Allow redirects</span>
              </label>
              <button
                disabled={!editable || !capabilityIdentityId || !hostname.trim()}
                onClick={() => void saveHostPolicy()}
              >
                Grant policy
              </button>
            </div>
          </WorkbookSection>

          <footer className="settings-footer">
            <span>Every supported change creates an attributable immutable Activity entry.</span>
            <a href="#/activity">Open Activity</a>
            <a href="#/usage">Open usage</a>
          </footer>
        </section>
      )}
    </div>
  );
}

function WorkbookSection({
  children,
  description,
  eyebrow,
  id,
  title,
}: {
  children: ReactNode;
  description: string;
  eyebrow: string;
  id: string;
  title: string;
}) {
  return (
    <section className="settings-section" id={id}>
      <div className="settings-section-intro">
        <p>{eyebrow}</p>
        <h2>{title}</h2>
        <span>{description}</span>
      </div>
      <div className="settings-section-content">{children}</div>
    </section>
  );
}

export function SettingsSectionLink({ target, children }: { target: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => document.getElementById(target)?.scrollIntoView({ block: 'start' })}
    >
      {children}
    </button>
  );
}
