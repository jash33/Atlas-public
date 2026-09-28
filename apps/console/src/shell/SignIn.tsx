import { accessRequestSchema, type AccessRequest } from '../settings/access-requests.js';
import { useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';

import { consoleConfig, customerAuth } from '../config.js';
import { sessionExpiredEvent } from './api.js';
import { SessionProvider } from './session.js';

const customerUserSchema = z.object({
  actorId: z.string().min(1),
  organizationId: z.string().min(1),
  role: z.enum(['admin', 'author', 'operator']),
  displayName: z.string().optional(),
});
export type CustomerUser = z.infer<typeof customerUserSchema>;
const authMethodsSchema = z.object({
  password: z.boolean(),
  sso: z.boolean(),
  demo: z.boolean(),
});
type AuthMethods = z.infer<typeof authMethodsSchema>;
const sessionSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('demo'),
    user: customerUserSchema.nullable().optional(),
    methods: authMethodsSchema.optional(),
  }),
  z.object({
    mode: z.literal('customer'),
    user: customerUserSchema.nullable(),
    enrollment: accessRequestSchema.optional(),
    methods: authMethodsSchema.optional(),
  }),
]);
type ServerSession = z.infer<typeof sessionSchema>;

export async function loadSession(signal?: AbortSignal): Promise<ServerSession> {
  let response: Response;
  try {
    response = await fetch(`${consoleConfig.backendUrl}/auth/session`, {
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });
  } catch {
    throw new Error('Unable to check your sign-in. Please try again.');
  }
  if (!response.ok) throw new Error('Unable to check your sign-in. Please try again.');
  const session = sessionSchema.parse(await response.json());
  if ((session.mode === 'customer') !== customerAuth) {
    throw new Error(
      'Console sign-in configuration does not match the server. Contact your administrator.',
    );
  }
  return session;
}

const defaultMethods = (demo: boolean): AuthMethods => ({
  password: true,
  sso: !demo,
  demo,
});

async function passwordSignIn(username: string, password: string): Promise<ServerSession> {
  let response: Response;
  try {
    response = await fetch(`${consoleConfig.backendUrl}/auth/password`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch {
    throw new Error('Password sign-in is unavailable. Please try again.');
  }
  const body = (await response.json().catch(() => undefined)) as { message?: unknown } | undefined;
  if (!response.ok) {
    throw new Error(
      typeof body?.message === 'string' ? body.message : 'The username or password is incorrect.',
    );
  }
  return loadSession();
}

type LoginFailure = 'rejected' | 'unavailable';

export function loginFailureFromSearch(search: string): LoginFailure | undefined {
  const login = new URLSearchParams(search).get('login');
  return login === 'unavailable' ? 'unavailable' : login === 'failed' ? 'rejected' : undefined;
}

export function SignInPage({
  demo,
  error,
  loginFailure,
  methods = defaultMethods(Boolean(demo)),
  onDemoSignIn,
  onPasswordSignIn = passwordSignIn,
}: {
  demo?: boolean;
  error?: string;
  loginFailure?: LoginFailure;
  methods?: AuthMethods;
  onDemoSignIn?: () => void;
  onPasswordSignIn?: (username: string, password: string) => Promise<unknown>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  return (
    <main className="sign-in-page">
      <section className="sign-in-card">
        <p>Atlas</p>
        <h1>Sign in to your workspace</h1>
        {error ? (
          <p role="alert">{error}</p>
        ) : loginFailure === 'unavailable' ? (
          <p role="alert">
            Company sign-in is temporarily unavailable. Try again. If the problem continues, contact
            your Atlas administrator.
          </p>
        ) : loginFailure === 'rejected' ? (
          <p role="alert">
            Sign-in was not completed or this account does not have access to Atlas. Try again with
            your work account, or contact your administrator.
          </p>
        ) : (
          <p>
            {demo
              ? 'Use your Atlas account or continue with the local demo.'
              : 'Use your Atlas account or your company SSO.'}
          </p>
        )}
        {error ? (
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        ) : (
          <>
            {methods.password && (
              <form
                className="sign-in-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSubmitting(true);
                  setPasswordError(undefined);
                  void onPasswordSignIn(username, password)
                    .catch((failure: unknown) => {
                      setPasswordError(
                        failure instanceof Error ? failure.message : 'Unable to sign in.',
                      );
                    })
                    .finally(() => setSubmitting(false));
                }}
              >
                <label>
                  <span>Username</span>
                  <input
                    autoComplete="username"
                    disabled={submitting}
                    name="username"
                    onChange={(event) => setUsername(event.target.value)}
                    required
                    value={username}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    autoComplete="current-password"
                    disabled={submitting}
                    name="password"
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    type="password"
                    value={password}
                  />
                </label>
                {passwordError && <p role="alert">{passwordError}</p>}
                <button disabled={submitting} type="submit">
                  {submitting ? 'Signing in...' : 'Sign in'}
                </button>
              </form>
            )}
            <div className="sign-in-divider" aria-hidden="true">
              <span>or</span>
            </div>
            <div className="sign-in-options">
              {methods.sso ? (
                <a href={`${consoleConfig.backendUrl}/auth/login`}>Continue with SSO</a>
              ) : (
                <button disabled title="SSO has not been configured" type="button">
                  Continue with SSO
                </button>
              )}
              {methods.demo && (
                <button className="sign-in-demo" type="button" onClick={onDemoSignIn}>
                  Continue to demo
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export function SignIn({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<ServerSession>();
  const [error, setError] = useState<string>();
  const [demoAccess, setDemoAccess] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void loadSession(controller.signal)
      .then(setSession)
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : 'Unable to sign in.');
      });
    const expire = () =>
      setSession((current) => ({
        mode: current?.mode ?? (customerAuth ? 'customer' : 'demo'),
        user: null,
        methods: current?.methods ?? defaultMethods(!customerAuth),
      }));
    window.addEventListener(sessionExpiredEvent, expire);
    return () => {
      controller.abort();
      window.removeEventListener(sessionExpiredEvent, expire);
    };
  }, []);
  if (error) return <SignInPage error={error} />;
  if (!session)
    return (
      <main className="sign-in-page" role="status">
        Checking your sign-in…
      </main>
    );
  if (session.mode === 'customer') {
    if (!session.user && session.enrollment)
      return <EnrollmentPage enrollment={session.enrollment} />;
    if (!session.user) {
      const loginFailure = loginFailureFromSearch(window.location.search);
      return (
        <SignInPage
          {...(loginFailure ? { loginFailure } : {})}
          methods={session.methods ?? defaultMethods(false)}
          onPasswordSignIn={async (username, password) => {
            setSession(await passwordSignIn(username, password));
          }}
        />
      );
    }
    return <SessionProvider customerUser={session.user}>{children}</SessionProvider>;
  }
  if (session.user) {
    return (
      <SessionProvider customerUser={session.user} useDemoProfile>
        {children}
      </SessionProvider>
    );
  }
  if (demoAccess) return <SessionProvider initialDemoRole="admin">{children}</SessionProvider>;
  return (
    <SignInPage
      demo
      methods={session.methods ?? defaultMethods(true)}
      onDemoSignIn={() => setDemoAccess(true)}
      onPasswordSignIn={async (username, password) => {
        setSession(await passwordSignIn(username, password));
      }}
    />
  );
}

export async function logout(): Promise<void> {
  const response = await fetch(`${consoleConfig.backendUrl}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!response.ok) throw new Error('Unable to sign out. Please try again.');
  window.location.reload();
}

export function CustomerProfile({ user }: { user: CustomerUser }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  return (
    <details className="profile-menu">
      <summary className="profile-trigger" aria-label="Your account">
        <span className="profile-trigger-copy">
          <strong>{user.displayName ?? user.actorId}</strong>
          <small>{roleLabel(user.role)}</small>
        </span>
      </summary>
      <section className="profile-popover" aria-label="Your account">
        <p>{user.displayName ?? user.actorId}</p>
        <p>Verified role: {roleLabel(user.role)}</p>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            void logout().catch((failure: unknown) => {
              setError(failure instanceof Error ? failure.message : 'Unable to sign out.');
              setPending(false);
            });
          }}
        >
          {pending ? 'Signing out…' : 'Sign out'}
        </button>
        {error && <p role="alert">{error}</p>}
      </section>
    </details>
  );
}

function roleLabel(role: CustomerUser['role']): string {
  return role[0]!.toUpperCase() + role.slice(1);
}

export function EnrollmentPage({ enrollment }: { enrollment: AccessRequest }) {
  return (
    <main className="sign-in-page">
      <section className="sign-in-card">
        <p>Atlas</p>
        <h1>
          {enrollment.status === 'approved'
            ? 'Your access is approved'
            : enrollment.status === 'rejected'
              ? 'Access request declined'
              : 'Waiting for access approval'}
        </h1>
        <p>Signed in with your work account:</p>
        <strong>{enrollment.displayName}</strong>
        {enrollment.email && <p>{enrollment.email}</p>}
        {enrollment.status === 'pending' && (
          <p>
            Share this request reference with your Atlas administrator. If you are setting up the
            first admin, share it with the person managing your Atlas installation.
          </p>
        )}
        {enrollment.status === 'rejected' && (
          <p>Contact your Atlas administrator if you believe you should have access.</p>
        )}
        <p>
          Request reference: <code>{enrollment.id}</code>
        </p>
        {enrollment.status === 'approved' ? (
          <>
            <p>Sign in again to open your workspace.</p>
            <a href="/auth/login">Sign in to Atlas</a>
          </>
        ) : (
          <button type="button" onClick={() => window.location.reload()}>
            Refresh status
          </button>
        )}
      </section>
    </main>
  );
}
