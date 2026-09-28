import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Pool } from 'pg';

import { createCustomerPasswordAuth } from './customer-password-auth.js';
import { isCustomerAuthToken } from './customer-auth-token.js';

const sessionCookie = 'atlas-demo-session';
const cookieOptions = { httpOnly: true, sameSite: 'Lax', path: '/' } as const;
const localOrigin = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

const readSession = (request: Request) => {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1);
  return isCustomerAuthToken(value) ? value : undefined;
};

export function createDemoAuth(pool: Pick<Pool, 'query'>, organizationId: string) {
  const sessionMaxAgeSeconds = 28_800;
  const passwords = createCustomerPasswordAuth(pool, {
    organizationId,
    authScope: 'atlas-local-demo',
    sessionMaxAgeSeconds,
  });
  const isTrustedRequest = (request: Request) =>
    localOrigin.test(request.headers.get('origin') ?? '');
  const routes = new Hono();
  routes.use('/auth/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  routes.get('/auth/session', async (c) => {
    try {
      return c.json({
        mode: 'demo',
        user: await passwords.authenticate(readSession(c.req.raw)),
        methods: { password: true, sso: false, demo: true },
      });
    } catch {
      return c.json({ error: 'Session verification is temporarily unavailable. Try again.' }, 503);
    }
  });
  routes.post('/auth/password', async (c) => {
    if (!isTrustedRequest(c.req.raw))
      return c.json({ error: 'Request origin is not allowed' }, 403);
    try {
      const body = await c.req.json<{ username?: unknown; password?: unknown }>();
      if (typeof body.username !== 'string' || typeof body.password !== 'string') {
        return c.json({ error: 'invalid-credentials' }, 400);
      }
      const result = await passwords.signIn(body.username, body.password);
      if (!result) {
        return c.json(
          {
            error: 'invalid-credentials',
            message: 'The username or password is incorrect.',
          },
          401,
        );
      }
      const existing = readSession(c.req.raw);
      await passwords.revoke(existing);
      setCookie(c, sessionCookie, result.token, { ...cookieOptions, maxAge: sessionMaxAgeSeconds });
      return c.json({ user: result.user });
    } catch {
      return c.json({ error: 'Password sign-in is temporarily unavailable. Try again.' }, 503);
    }
  });
  routes.post('/auth/logout', async (c) => {
    if (!isTrustedRequest(c.req.raw))
      return c.json({ error: 'Request origin is not allowed' }, 403);
    try {
      await passwords.revoke(readSession(c.req.raw));
      deleteCookie(c, sessionCookie, cookieOptions);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'Sign-out is temporarily unavailable. Try again.' }, 503);
    }
  });
  return { routes, passwords };
}
