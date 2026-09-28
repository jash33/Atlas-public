import type { CustomerUser } from './SignIn.js';
import { createContext, useContext, useState, type ReactNode } from 'react';
import {
  demoProfileIds,
  demoProfiles,
  type DemoProfileDefinition,
  type DemoProfileId,
} from '@atlas/demo-estate';

export const environmentIds = ['development', 'production'] as const;
export type EnvironmentId = (typeof environmentIds)[number];

// TODO(#148-transition-removal): remove browser-state translation after the local rename window.
const retiredEnvironmentId = 'production-like';

export const environmentLabels: Record<EnvironmentId, string> = {
  development: 'Development',
  production: 'Production',
};

export type EnvironmentColors = Record<EnvironmentId, string>;
type StoredEnvironmentColors = Partial<EnvironmentColors> & {
  'production-like'?: string;
};

export const environmentColorOptions = [
  { label: 'Violet', value: '#7556a8' },
  { label: 'Teal', value: '#277d86' },
  { label: 'Cerulean', value: '#256d9b' },
  { label: 'Magenta', value: '#8f416f' },
  { label: 'Navy', value: '#3d4f75' },
  { label: 'Graphite', value: '#55534d' },
] as const;

export const defaultEnvironmentColors: EnvironmentColors = {
  development: '#7556a8',
  production: '#277d86',
};

export const demoRoles = ['author', 'admin', 'operator'] as const;
export type DemoRole = (typeof demoRoles)[number];

export { demoProfileIds, demoProfiles as demoProfileDetails };
export type { DemoProfileDefinition, DemoProfileId };

export interface ConsoleSession {
  customerUser?: CustomerUser;
  organizationId: string;
  demoProfileId: DemoProfileId;
  demoProfile: DemoProfileDefinition;
  environmentId: EnvironmentId;
  setEnvironmentId: (environmentId: EnvironmentId) => void;
  environmentColors: EnvironmentColors;
  setEnvironmentColors: (colors: EnvironmentColors) => void;
  role: DemoRole;
  setRole: (role: DemoRole) => void;
}

export const environmentStorageKey = 'atlas.console.environment';
export const environmentColorsStorageKey = 'atlas.console.environment-colors';
const roleStorageKey = 'atlas.console.role';

const allowedEnvironmentColors = new Set(environmentColorOptions.map(({ value }) => value));

export function readStoredEnvironmentColors(): EnvironmentColors {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(environmentColorsStorageKey) ?? 'null',
    ) as StoredEnvironmentColors | null;
    const production = parsed?.production ?? parsed?.[retiredEnvironmentId];
    if (
      parsed &&
      allowedEnvironmentColors.has(
        parsed.development as (typeof environmentColorOptions)[number]['value'],
      ) &&
      allowedEnvironmentColors.has(production as (typeof environmentColorOptions)[number]['value'])
    ) {
      const colors = {
        development: parsed.development!,
        production: production!,
      };
      if (!('production' in parsed)) writeStoredEnvironmentColors(colors);
      return colors;
    }
  } catch {
    // Fall through to the defaults when storage is unavailable or malformed.
  }
  return defaultEnvironmentColors;
}

export function writeStoredEnvironmentColors(colors: EnvironmentColors) {
  try {
    window.localStorage.setItem(environmentColorsStorageKey, JSON.stringify(colors));
  } catch {
    // Session state still works without persistence.
  }
}

export function readStored<T extends string>(key: string, values: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return values.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Session state still works without persistence.
  }
}

export function readInitialEnvironment(): EnvironmentId {
  try {
    const current = new URL(window.location.href);
    const hashQuery = current.hash.split('?', 2)[1];
    const linked =
      (hashQuery ? new URLSearchParams(hashQuery).get('environmentId') : null) ??
      current.searchParams.get('environmentId');
    if (environmentIds.includes(linked as EnvironmentId)) {
      writeStored(environmentStorageKey, linked!);
      return linked as EnvironmentId;
    }

    const stored = window.localStorage.getItem(environmentStorageKey);
    if (stored === retiredEnvironmentId) {
      writeStored(environmentStorageKey, 'production');
      return 'production';
    }
    if (environmentIds.includes(stored as EnvironmentId)) return stored as EnvironmentId;
  } catch {
    // Fall through to the default when storage is unavailable.
  }
  return 'development';
}

function linkedValue(name: string): string | null {
  const current = new URL(window.location.href);
  const hashQuery = current.hash.split('?', 2)[1];
  return (
    current.searchParams.get(name) ?? (hashQuery ? new URLSearchParams(hashQuery).get(name) : null)
  );
}

export function readInitialDemoProfile(
  defaultProfile: DemoProfileId = demoProfileIds.includes(
    import.meta.env.VITE_ATLAS_DEMO_PROFILE as DemoProfileId,
  )
    ? (import.meta.env.VITE_ATLAS_DEMO_PROFILE as DemoProfileId)
    : 'sample',
): DemoProfileId {
  try {
    const linked = linkedValue('demoProfile');
    return demoProfileIds.includes(linked as DemoProfileId)
      ? (linked as DemoProfileId)
      : defaultProfile;
  } catch {
    return defaultProfile;
  }
}

export function readInitialRole(): DemoRole {
  try {
    const linked = linkedValue('role');
    if (demoRoles.includes(linked as DemoRole)) {
      writeStored(roleStorageKey, linked!);
      return linked as DemoRole;
    }
  } catch {
    // Fall through to the saved role when location is unavailable.
  }
  return readStored(roleStorageKey, demoRoles, 'author');
}

export function canonicalizeRetiredEnvironmentUrl(): void {
  try {
    const current = new URL(window.location.href);
    let changed = false;
    if (current.searchParams.get('environmentId') === retiredEnvironmentId) {
      current.searchParams.set('environmentId', 'production');
      changed = true;
    }

    const [hashPath, hashQuery] = current.hash.split('?', 2);
    if (hashQuery) {
      const parameters = new URLSearchParams(hashQuery);
      if (parameters.get('environmentId') === retiredEnvironmentId) {
        parameters.set('environmentId', 'production');
        current.hash = `${hashPath}?${parameters}`;
        changed = true;
      }
    }

    if (changed) window.history.replaceState(null, '', current.href);
  } catch {
    // Navigation remains usable when location or history is unavailable.
  }
}

const SessionContext = createContext<ConsoleSession | undefined>(undefined);

export function SessionProvider({
  children,
  customerUser,
  initialDemoRole,
  useDemoProfile = false,
}: {
  children: ReactNode;
  customerUser?: CustomerUser;
  initialDemoRole?: DemoRole;
  useDemoProfile?: boolean;
}) {
  const [demoProfileId] = useState(() =>
    customerUser && !useDemoProfile ? 'sample' : readInitialDemoProfile(),
  );
  const demoProfile = demoProfiles[demoProfileId];
  const [environmentId, setEnvironmentState] = useState<EnvironmentId>(() => {
    canonicalizeRetiredEnvironmentUrl();
    return readInitialEnvironment();
  });
  const [environmentColors, setEnvironmentColorsState] = useState<EnvironmentColors>(
    readStoredEnvironmentColors,
  );
  const [role, setRoleState] = useState<DemoRole>(
    () => customerUser?.role ?? initialDemoRole ?? readInitialRole(),
  );

  const session: ConsoleSession = {
    ...(customerUser ? { customerUser } : {}),
    organizationId: customerUser?.organizationId ?? 'org_atlas',
    demoProfileId,
    demoProfile,
    environmentId,
    environmentColors,
    setEnvironmentId: (next) => {
      setEnvironmentState(next);
      writeStored(environmentStorageKey, next);
    },
    setEnvironmentColors: (next) => {
      setEnvironmentColorsState(next);
      writeStoredEnvironmentColors(next);
    },
    role: customerUser?.role ?? role,
    setRole: (next) => {
      if (customerUser) return;
      setRoleState(next);
      writeStored(roleStorageKey, next);
    },
  };

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useConsoleSession(): ConsoleSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useConsoleSession requires a SessionProvider');
  return session;
}
