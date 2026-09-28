import { CustomerProfile } from './SignIn.js';
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';

import { ActivityPage } from '../activity/ActivityPage.js';
import { CapabilitiesPage } from '../capabilities/CapabilitiesPage.js';
import { ChangesPage } from '../changes/ChangesPage.js';
import { HomePage } from '../home/HomePage.js';
import { RunsPage } from '../runs/RunsPage.js';
import { SettingsPage } from '../settings/SettingsPage.js';
import { UsagePage } from '../usage/UsagePage.js';
import { WorkflowCatalogPage } from '../workflow-catalog/WorkflowCatalogPage.js';
import { WorkflowsPage } from '../workflows/WorkflowsPage.js';
import { useDismissibleDetails } from './dismissibleDetails.js';
import { NotificationCenter } from './NotificationCenter.js';
import { surfaceHash, useSurface, type Surface } from './router.js';
import {
  demoRoles,
  environmentColorOptions,
  environmentIds,
  environmentLabels,
  useConsoleSession,
  type DemoProfileDefinition,
  type DemoRole,
  type EnvironmentColors,
  type EnvironmentId,
} from './session.js';

const railItems: Array<{ surface: Surface; label: string; glyph: string }> = [
  { surface: 'home', label: 'Home', glyph: '⌂' },
  { surface: 'workflows', label: 'Create Workflow', glyph: '◇' },
  { surface: 'workflow-catalog', label: 'Workflow Catalog', glyph: '▦' },
  { surface: 'capabilities', label: 'Capabilities', glyph: '◎' },
  { surface: 'runs', label: 'Runs', glyph: '↯' },
  { surface: 'changes', label: 'Changes', glyph: '△' },
  { surface: 'activity', label: 'Activity', glyph: '≡' },
  { surface: 'usage', label: 'Usage', glyph: '#' },
  { surface: 'settings', label: 'Settings', glyph: '⚙' },
];

const roleLabels = { author: 'Author', admin: 'Admin', operator: 'Operator' } as const;

export function shouldKeepWorkflowsMounted(wasMounted: boolean, surface: Surface): boolean {
  return wasMounted || surface === 'workflows';
}

export function ProfileMenu({
  profile,
  role,
  setRole,
}: {
  profile: DemoProfileDefinition;
  role: DemoRole;
  setRole: (role: DemoRole) => void;
}) {
  return (
    <details className="profile-menu">
      <summary aria-label={`Demo profile, ${roleLabels[role]} role`} className="profile-trigger">
        <span aria-hidden="true" className="profile-avatar">
          UP
        </span>
        <span className="profile-trigger-copy">
          <strong>{profile.displayUser.name}</strong>
          <small>{roleLabels[role]}</small>
        </span>
      </summary>
      <section aria-label="Demo profile" className="profile-popover">
        <div className="profile-identity">
          <strong>{profile.displayUser.name}</strong>
          <span>{profile.displayUser.email}</span>
          <small>Active role: {roleLabels[role]}</small>
        </div>
        <span className="profile-role-label">Demo as</span>
        <div aria-label="Demo role" className="profile-role-options" role="group">
          {demoRoles.map((value) => (
            <button
              aria-pressed={role === value}
              key={value}
              onClick={() => setRole(value)}
              type="button"
            >
              {roleLabels[value]}
            </button>
          ))}
        </div>
        <small className="profile-note">The server still enforces every role.</small>
      </section>
    </details>
  );
}

function CommandRail({ active }: { active: Surface }) {
  return (
    <aside className="rail">
      <a className="rail-mark" href={surfaceHash('home')} aria-label="Atlas home">
        <span className="rail-glyph">A</span>
        <span className="rail-mark-name">Atlas</span>
      </a>
      <nav aria-label="Primary">
        {railItems.map((item) => (
          <a
            aria-current={active === item.surface ? 'page' : undefined}
            className={active === item.surface ? 'rail-item rail-item-active' : 'rail-item'}
            href={surfaceHash(item.surface)}
            key={item.surface}
          >
            <span aria-hidden="true" className="rail-icon">
              {item.glyph}
            </span>
            <span className="rail-label">{item.label}</span>
          </a>
        ))}
      </nav>
    </aside>
  );
}

export function EnvironmentColorEditor({
  colors,
  onSave,
}: {
  colors: EnvironmentColors;
  onSave: (colors: EnvironmentColors) => void;
}) {
  const [draft, setDraft] = useState(colors);
  useEffect(() => setDraft(colors), [colors]);

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave(draft);
    event.currentTarget.closest('details')?.removeAttribute('open');
  };

  return (
    <form className="environment-color-editor" onSubmit={save}>
      <header>
        <strong>Environment colors</strong>
        <small>Used in the environment picker and notification center.</small>
      </header>
      {environmentIds.map((environmentId) => (
        <fieldset key={environmentId}>
          <legend>{environmentLabels[environmentId]}</legend>
          <div className="environment-color-options">
            {environmentColorOptions.map((option) => (
              <label key={option.value}>
                <input
                  aria-label={`${environmentLabels[environmentId]}: ${option.label}`}
                  checked={draft[environmentId] === option.value}
                  name={`environment-color-${environmentId}`}
                  onChange={() =>
                    setDraft((current) => ({ ...current, [environmentId]: option.value }))
                  }
                  type="radio"
                  value={option.value}
                />
                <span
                  className="environment-color-swatch"
                  style={{ '--environment-swatch': option.value } as CSSProperties}
                >
                  {option.label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <button className="environment-color-save" type="submit">
        Save colors
      </button>
    </form>
  );
}

export function EnvironmentPicker({
  environmentId,
  onChange,
}: {
  environmentId: EnvironmentId;
  onChange: (environmentId: EnvironmentId) => void;
}) {
  const environmentSelectRef = useDismissibleDetails();
  const choose = (nextEnvironmentId: EnvironmentId, button: HTMLButtonElement) => {
    onChange(nextEnvironmentId);
    button.closest('details')?.removeAttribute('open');
  };

  return (
    <div className={`env-picker env-picker-${environmentId}`}>
      <span id="environment-picker-label">Environment</span>
      <details className="environment-select" ref={environmentSelectRef}>
        <summary
          aria-labelledby="environment-picker-label environment-picker-value"
          id="environment-picker-value"
        >
          {environmentLabels[environmentId]}
        </summary>
        <div aria-labelledby="environment-picker-label" role="menu">
          {environmentIds.map((id) => (
            <button
              aria-checked={environmentId === id}
              className={`environment-option-${id}`}
              key={id}
              onClick={(event) => choose(id, event.currentTarget)}
              role="menuitemradio"
              type="button"
            >
              {environmentLabels[id]}
              {environmentId === id && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </details>
    </div>
  );
}

export function environmentThemeStyles(colors: EnvironmentColors): CSSProperties {
  return {
    '--environment-development': colors.development,
    '--environment-development-soft': `color-mix(in srgb, ${colors.development} 12%, var(--paper))`,
    '--environment-development-hover': `color-mix(in srgb, ${colors.development} 20%, var(--paper))`,
    '--environment-production': colors['production'],
    '--environment-production-soft': `color-mix(in srgb, ${colors['production']} 12%, var(--paper))`,
    '--environment-production-hover': `color-mix(in srgb, ${colors['production']} 20%, var(--paper))`,
  } as CSSProperties;
}

function TopBar() {
  const {
    organizationId,
    customerUser,
    demoProfile,
    environmentId,
    environmentColors,
    setEnvironmentColors,
    setEnvironmentId,
    role,
    setRole,
  } = useConsoleSession();
  const environmentColorMenuRef = useDismissibleDetails();
  return (
    <header className="topbar">
      <div className="topbar-org">
        <small>Organization</small>
        <strong>{customerUser ? organizationId : demoProfile.organizationName}</strong>
      </div>
      <div className="topbar-controls">
        <div className={`environment-control environment-control-${environmentId}`}>
          <EnvironmentPicker environmentId={environmentId} onChange={setEnvironmentId} />
          <details className="environment-color-menu" ref={environmentColorMenuRef}>
            <summary aria-label="Edit environment colors" title="Edit environment colors">
              <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                <path
                  d="m4 20 4.25-1 10.5-10.5a2.12 2.12 0 0 0-3-3L5.25 16 4 20Zm10-13 3 3"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                />
              </svg>
            </summary>
            <EnvironmentColorEditor colors={environmentColors} onSave={setEnvironmentColors} />
          </details>
        </div>
        <NotificationCenter
          organizationId={organizationId}
          role={role}
          setEnvironmentId={setEnvironmentId}
        />
        {customerUser ? (
          <CustomerProfile user={customerUser} />
        ) : (
          <ProfileMenu profile={demoProfile} role={role} setRole={setRole} />
        )}
      </div>
    </header>
  );
}

export function AppShell() {
  const surface = useSurface();
  const { environmentColors, environmentId } = useConsoleSession();
  const [workflowsMounted, setWorkflowsMounted] = useState(surface === 'workflows');
  const environmentStyles = environmentThemeStyles(environmentColors);
  const showWorkflows = shouldKeepWorkflowsMounted(workflowsMounted, surface);

  useEffect(() => {
    setWorkflowsMounted((current) => shouldKeepWorkflowsMounted(current, surface));
  }, [surface]);

  return (
    <div className={`shell shell-env-${environmentId}`} style={environmentStyles}>
      <CommandRail active={surface} />
      <div className="shell-main">
        <TopBar />
        <main className="shell-content">
          {surface === 'home' && <HomePage />}
          {showWorkflows && (
            <div hidden={surface !== 'workflows'}>
              <WorkflowsPage />
            </div>
          )}
          {surface === 'workflow-catalog' && <WorkflowCatalogPage />}
          {surface === 'capabilities' && <CapabilitiesPage />}
          {surface === 'runs' && <RunsPage />}
          {surface === 'changes' && <ChangesPage />}
          {surface === 'activity' && <ActivityPage />}
          {surface === 'usage' && <UsagePage />}
          {surface === 'settings' && <SettingsPage />}
        </main>
      </div>
    </div>
  );
}
