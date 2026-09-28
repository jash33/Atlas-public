import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { CustomerProfile, loadSession, loginFailureFromSearch, SignInPage } from './SignIn.js';
import { describeApiFailure } from './api.js';
import { SessionProvider, useConsoleSession } from './session.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('customer sign-in', () => {
  it('offers password and SSO sign-in without demo access', () => {
    const html = renderToStaticMarkup(createElement(SignInPage));
    expect(html).toContain('href="http://localhost:4000/auth/login"');
    expect(html).toContain('Continue with SSO');
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain('Continue to demo');
    expect(html).not.toContain('local demo');
  });

  it('offers password and one-step demo access while explaining unavailable SSO', () => {
    const html = renderToStaticMarkup(createElement(SignInPage, { demo: true }));
    expect(html).toContain('Continue to demo');
    expect(html).toContain('class="sign-in-demo"');
    expect(html).not.toContain('Local account:');
    expect(html).not.toContain('ATLAS_DEMO_ADMIN_PASSWORD');
    expect(html).toContain('name="username"');
    expect(html).toContain('Continue with SSO');
    expect(html).toContain('SSO has not been configured');
    expect(html).not.toContain('/auth/login');
  });

  it('starts one-step demo access with the administrator role', () => {
    function Identity() {
      const session = useConsoleSession();
      return createElement('p', null, `${session.organizationId}:${session.role}`);
    }
    const html = renderToStaticMarkup(
      createElement(SessionProvider, {
        initialDemoRole: 'admin',
        // createElement keeps this test file usable without JSX.
        // oxlint-disable-next-line react/no-children-prop
        children: createElement(Identity),
      }),
    );
    expect(html).toContain('org_atlas:admin');
  });

  it('explains rejected sign-in and lets the user start a fresh login', () => {
    const html = renderToStaticMarkup(createElement(SignInPage, { loginFailure: 'rejected' }));
    expect(html).toContain('does not have access');
    expect(html).toContain('contact your administrator');
    expect(html).toContain('href="http://localhost:4000/auth/login"');
  });

  it('explains a company sign-in outage without blaming the account', () => {
    const html = renderToStaticMarkup(createElement(SignInPage, { loginFailure: 'unavailable' }));
    expect(html).toContain('temporarily unavailable');
    expect(html).toContain('Try again');
    expect(html).not.toContain('does not have access');
    expect(loginFailureFromSearch('?login=unavailable')).toBe('unavailable');
    expect(loginFailureFromSearch('?login=failed')).toBe('rejected');
  });

  it('shows the assigned identity and role without a role switch', () => {
    const html = renderToStaticMarkup(
      createElement(CustomerProfile, {
        user: {
          actorId: 'actor_123',
          organizationId: 'org_customer',
          role: 'operator',
          displayName: 'Morgan',
        },
      }),
    );
    expect(html).toContain('Morgan');
    expect(html).toContain('Verified role: Operator');
    expect(html).toContain('Sign out');
    expect(html).not.toContain('Demo as');
    expect(html).not.toContain('Admin');
  });

  it('turns access denials into useful messages', () => {
    expect(describeApiFailure(403, { error: 'permission-denied' })).toContain(
      'role does not allow this action',
    );
    expect(
      describeApiFailure(403, {
        error: 'environment-access-rejected',
        message: 'This environment does not belong to your Atlas organization.',
      }),
    ).toContain('environment does not belong');
  });

  it('ignores URL and stored roles for a customer session', () => {
    vi.stubGlobal('window', {
      location: { href: 'http://localhost/?role=admin&demoProfile=burger-town' },
      localStorage: {
        getItem: () => 'admin',
        setItem: vi.fn<(key: string, value: string) => void>(),
      },
    });
    function Identity() {
      const session = useConsoleSession();
      session.setRole('admin');
      return createElement('p', null, `${session.organizationId}:${session.role}`);
    }
    const html = renderToStaticMarkup(
      createElement(SessionProvider, {
        customerUser: { actorId: 'actor_123', organizationId: 'org_customer', role: 'operator' },
        // createElement keeps this test file usable without JSX.
        // oxlint-disable-next-line react/no-children-prop
        children: createElement(Identity),
      }),
    );
    expect(html).toContain('org_customer:operator');
  });

  it('uses the cookie and removes bearer headers from customer requests', async () => {
    vi.stubEnv('VITE_ATLAS_AUTH_MODE', 'customer');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const { consoleFetch } = await import('./api.js');
    await consoleFetch('/v1/example', {
      headers: { authorization: 'Bearer demo', 'content-type': 'application/json' },
    });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe('same-origin');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('returns to sign-in when a customer session expires', async () => {
    vi.stubEnv('VITE_ATLAS_AUTH_MODE', 'customer');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 })),
    );
    const dispatchEvent = vi.fn<(event: Event) => boolean>();
    vi.stubGlobal('window', { dispatchEvent });
    const { consoleFetch, sessionExpiredEvent } = await import('./api.js');
    await consoleFetch('/v1/example');
    expect(dispatchEvent.mock.calls[0]![0].type).toBe(sessionExpiredEvent);
  });

  it('replaces browser fetch errors with a useful sign-in message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    await expect(loadSession()).rejects.toThrow('Unable to check your sign-in. Please try again.');
  });

  it('rejects a demo server for a customer build', async () => {
    vi.stubEnv('VITE_ATLAS_AUTH_MODE', 'customer');
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ mode: 'demo' }))),
    );
    const { loadSession } = await import('./SignIn.js');
    await expect(loadSession()).rejects.toThrow('does not match');
  });

  it('logs out with a same-origin POST before reloading', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const reload = vi.fn<() => void>();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', { location: { reload } });
    const { logout } = await import('./SignIn.js');
    await logout();
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:4000/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
    expect(reload).toHaveBeenCalledOnce();
  });
});
