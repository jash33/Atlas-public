import { readFileSync } from 'node:fs';

import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as oidc from 'openid-client';
import type { Pool } from 'pg';

import { roleSchema, type Role } from './admin-suite.js';
import {
  createCustomerEnrollment,
  CustomerEnrollmentError,
  type VerifiedCustomerIdentity,
} from './customer-enrollment.js';

import {
  customerAuthIssuer,
  customerAuthScope,
  customerSsoProviderBehavior,
  loadCustomerSsoProvider,
  type CustomerAuthConfig,
} from './customer-sso-provider.js';
import {
  createCustomerAuthToken,
  hashCustomerAuthToken,
  isCustomerAuthToken,
} from './customer-auth-token.js';
import { createCustomerPasswordAuth } from './customer-password-auth.js';
export {
  customerAuthIssuer,
  customerAuthScope,
  loadCustomerSsoProvider,
  type CustomerAuthConfig,
  type CustomerSsoProviderConfig,
} from './customer-sso-provider.js';

export function loadCustomerAuthConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CustomerAuthConfig | undefined {
  const mode = env.ATLAS_AUTH_MODE ?? 'demo';
  if (mode === 'demo') return undefined;
  if (mode !== 'customer') throw new Error('ATLAS_AUTH_MODE must be demo or customer');
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required in customer mode`);
    return value;
  };
  const providerConfig = loadCustomerSsoProvider(env);
  const origin = new URL(required('ATLAS_PUBLIC_ORIGIN'));
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('ATLAS_PUBLIC_ORIGIN must be an HTTPS origin without a path');
  }
  const sessionMaxAgeSeconds = Number(env.ATLAS_SESSION_MAX_AGE_SECONDS ?? 28800);
  if (
    !Number.isInteger(sessionMaxAgeSeconds) ||
    sessionMaxAgeSeconds < 60 ||
    sessionMaxAgeSeconds > 86400
  ) {
    throw new Error('ATLAS_SESSION_MAX_AGE_SECONDS must be between 60 and 86400');
  }
  if (env.ATLAS_SSO_CLIENT_SECRET && env.ATLAS_SSO_CLIENT_SECRET_FILE) {
    throw new Error('Set only one of ATLAS_SSO_CLIENT_SECRET and ATLAS_SSO_CLIENT_SECRET_FILE');
  }
  const clientSecret = env.ATLAS_SSO_CLIENT_SECRET_FILE
    ? readFileSync(env.ATLAS_SSO_CLIENT_SECRET_FILE, 'utf8').trim()
    : required('ATLAS_SSO_CLIENT_SECRET');
  if (!clientSecret) throw new Error('The SSO client secret must not be empty');
  return {
    ...providerConfig,
    clientId: required('ATLAS_SSO_CLIENT_ID'),
    clientSecret,
    organizationId: required('ATLAS_SSO_ORGANIZATION_ID'),
    publicOrigin: origin.origin,
    sessionMaxAgeSeconds,
  };
}

export interface CustomerActor {
  actorId: string;
  organizationId: string;
  role: Role;
  displayName: string;
}

interface LoginRequest {
  state: string;
  nonce: string;
  verifier: string;
}
export interface CustomerOidcProvider {
  authorizationUrl(request: LoginRequest): Promise<URL>;
  verify(url: URL, request: LoginRequest): Promise<VerifiedCustomerIdentity>;
}

export function createCustomerOidcProvider(config: CustomerAuthConfig): CustomerOidcProvider {
  const providerBehavior = customerSsoProviderBehavior(config);
  const issuer = providerBehavior.issuer;
  let discovery: Promise<oidc.Configuration> | undefined;
  const discover = () =>
    (discovery ??= oidc
      .discovery(
        new URL(issuer),
        config.clientId,
        config.clientSecret,
        config.provider === 'okta' ? oidc.ClientSecretBasic(config.clientSecret) : undefined,
        {
          execute: [oidc.enableNonRepudiationChecks],
        },
      )
      .catch((error: unknown) => {
        discovery = undefined;
        throw error;
      }));
  return {
    async authorizationUrl(request) {
      return oidc.buildAuthorizationUrl(await discover(), {
        redirect_uri: `${config.publicOrigin}/auth/callback`,
        scope: 'openid profile',
        response_type: 'code',
        code_challenge_method: 'S256',
        code_challenge: await oidc.calculatePKCECodeChallenge(request.verifier),
        state: request.state,
        nonce: request.nonce,
        ...providerBehavior.authorizationParameters,
      });
    },
    async verify(url, request) {
      const tokens = await oidc.authorizationCodeGrant(await discover(), url, {
        pkceCodeVerifier: request.verifier,
        expectedState: request.state,
        expectedNonce: request.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (
        !claims ||
        claims.iss !== issuer ||
        !claims.sub ||
        !providerBehavior.acceptsIdentity(claims)
      ) {
        throw new Error('The identity provider returned an unrecognized identity');
      }
      return {
        issuer: claims.iss,
        subject: claims.sub,
        scope: customerAuthScope(config),
        ...(typeof claims.name === 'string' ? { displayName: claims.name } : {}),
        ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      };
    },
  };
}

const sessionCookie = '__Host-atlas-session';
const loginCookie = '__Host-atlas-login';
const enrollmentCookie = '__Host-atlas-enrollment';
const cookieOptions = { secure: true, httpOnly: true, sameSite: 'Lax', path: '/' } as const;
const readSession = (request: Request) => {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1);
  return isCustomerAuthToken(value) ? value : undefined;
};

function isProviderConnectionFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (
    error instanceof oidc.ResponseBodyError ||
    error instanceof oidc.WWWAuthenticateChallengeError
  ) {
    return error.status >= 500;
  }
  if (error instanceof oidc.ClientError) {
    if (error.code === 'OAUTH_TIMEOUT' || error.code === 'OAUTH_ABORT') return true;
    return error.cause instanceof Response && error.cause.status >= 500;
  }
  return false;
}

export function createCustomerAuth(
  pool: Pick<Pool, 'query' | 'connect'>,
  config: CustomerAuthConfig,
  provider: CustomerOidcProvider = createCustomerOidcProvider(config),
) {
  const issuer = customerAuthIssuer(config);
  const enrollment = createCustomerEnrollment(pool, config);
  const passwords = createCustomerPasswordAuth(pool, {
    organizationId: config.organizationId,
    authScope: customerAuthScope(config),
    sessionMaxAgeSeconds: config.sessionMaxAgeSeconds,
  });
  const isTrustedRequest = (request: Request) =>
    request.headers.get('origin') === config.publicOrigin;
  const authenticate = async (request: Request): Promise<CustomerActor | null> => {
    const session = readSession(request);
    if (!session) return null;
    const result = await pool.query<CustomerActor>(
      `SELECT i.user_id AS "actorId", i.organization_id AS "organizationId",
              m.role, u.name AS "displayName"
       FROM customer_sessions s
       JOIN customer_sso_identities i USING (organization_id, issuer, subject)
       JOIN organization_memberships m ON m.organization_id = i.organization_id AND m.user_id = i.user_id
       JOIN users u ON u.id = i.user_id
       WHERE s.id_hash = $1 AND s.organization_id = $2 AND s.issuer = $3 AND s.auth_scope = $4 AND s.expires_at > now()`,
      [hashCustomerAuthToken(session), config.organizationId, issuer, customerAuthScope(config)],
    );
    const actor = result.rows[0];
    if (actor && roleSchema.safeParse(actor.role).success) return actor;
    return passwords.authenticate(session);
  };
  const environmentsBelongToOrganization = async (
    organizationId: string,
    environmentIds: readonly string[],
  ) => {
    const uniqueIds = [...new Set(environmentIds)];
    if (organizationId !== config.organizationId || uniqueIds.length === 0) return false;
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM environments WHERE organization_id = $1 AND id = ANY($2::text[])`,
      [organizationId, uniqueIds],
    );
    return new Set(result.rows.map(({ id }) => id)).size === uniqueIds.length;
  };
  const routes = new Hono();
  routes.use('/auth/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    await next();
  });
  routes.get('/auth/login', async (c) => {
    try {
      const request = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier: oidc.randomPKCECodeVerifier(),
      };
      const url = await provider.authorizationUrl(request);
      const id = createCustomerAuthToken();
      await pool.query('DELETE FROM customer_login_requests WHERE expires_at <= now()');
      await pool.query('DELETE FROM customer_sessions WHERE expires_at <= now()');
      await pool.query(
        `INSERT INTO customer_login_requests (id_hash, organization_id, state, nonce, verifier, client_id, auth_scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + interval '10 minutes')`,
        [
          hashCustomerAuthToken(id),
          config.organizationId,
          request.state,
          request.nonce,
          request.verifier,
          config.clientId,
          customerAuthScope(config),
        ],
      );
      setCookie(c, loginCookie, id, { ...cookieOptions, maxAge: 600 });
      return c.redirect(url.href);
    } catch {
      return c.json(
        {
          error:
            'Sign-in is temporarily unavailable. Try again or contact your Atlas administrator.',
        },
        503,
      );
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
      const oldSessionToken = readSession(c.req.raw);
      if (oldSessionToken) {
        await pool.query('DELETE FROM customer_sessions WHERE id_hash = $1', [
          hashCustomerAuthToken(oldSessionToken),
        ]);
        await passwords.revoke(oldSessionToken);
      }
      deleteCookie(c, enrollmentCookie, cookieOptions);
      setCookie(c, sessionCookie, result.token, {
        ...cookieOptions,
        maxAge: config.sessionMaxAgeSeconds,
      });
      return c.json({ user: result.user });
    } catch {
      return c.json({ error: 'Password sign-in is temporarily unavailable. Try again.' }, 503);
    }
  });
  routes.get('/auth/callback', async (c) => {
    const id = getCookie(c, loginCookie);
    try {
      if (!isCustomerAuthToken(id)) throw new Error('Missing sign-in request');
      const url = new URL(`${config.publicOrigin}/auth/callback`);
      url.search = new URL(c.req.url).search;
      const states = url.searchParams.getAll('state');
      if (states.length !== 1 || !states[0]) throw new Error('Invalid sign-in request');
      const result = await pool.query<LoginRequest>(
        `DELETE FROM customer_login_requests WHERE id_hash = $1 AND organization_id = $2
         AND auth_scope = $3 AND state = $4 AND expires_at > now() RETURNING state, nonce, verifier`,
        [hashCustomerAuthToken(id), config.organizationId, customerAuthScope(config), states[0]],
      );
      const request = result.rows[0];
      if (!request || url.searchParams.get('state') !== request.state)
        throw new Error('Invalid sign-in request');
      deleteCookie(c, loginCookie, cookieOptions);
      const oldSessionToken = readSession(c.req.raw);
      if (oldSessionToken)
        await pool.query('DELETE FROM customer_sessions WHERE id_hash = $1', [
          hashCustomerAuthToken(oldSessionToken),
        ]);
      deleteCookie(c, sessionCookie, cookieOptions);
      let identity: VerifiedCustomerIdentity;
      try {
        identity = await provider.verify(url, request);
      } catch (error) {
        if (isProviderConnectionFailure(error)) {
          return c.redirect(`${config.publicOrigin}/?login=unavailable`);
        }
        throw error;
      }
      if (identity.issuer !== issuer || identity.scope !== customerAuthScope(config))
        throw new Error('Wrong company');
      const session = createCustomerAuthToken();
      const inserted = await pool.query(
        `INSERT INTO customer_sessions (id_hash, organization_id, issuer, subject, client_id, auth_scope, expires_at)
         SELECT $1, organization_id, issuer, subject, $6, $7, now() + $5 * interval '1 second'
         FROM customer_sso_identities WHERE organization_id = $2 AND issuer = $3 AND subject = $4
         RETURNING id_hash`,
        [
          hashCustomerAuthToken(session),
          config.organizationId,
          issuer,
          identity.subject,
          config.sessionMaxAgeSeconds,
          config.clientId,
          customerAuthScope(config),
        ],
      );
      if (!inserted.rows.length) {
        const pending = await enrollment.request(identity);
        setCookie(c, enrollmentCookie, pending.browserToken, { ...cookieOptions, maxAge: 86400 });
        return c.redirect(`${config.publicOrigin}/`);
      }
      deleteCookie(c, enrollmentCookie, cookieOptions);
      setCookie(c, sessionCookie, session, {
        ...cookieOptions,
        maxAge: config.sessionMaxAgeSeconds,
      });
      return c.redirect(`${config.publicOrigin}/`);
    } catch {
      return c.redirect(`${config.publicOrigin}/?login=failed`);
    }
  });
  routes.get('/auth/session', async (c) => {
    try {
      const user = await authenticate(c.req.raw);
      const pending = user ? null : await enrollment.findForBrowser(getCookie(c, enrollmentCookie));
      return c.json({
        mode: 'customer',
        user,
        methods: { password: true, sso: true, demo: false },
        ...(pending ? { enrollment: pending } : {}),
      });
    } catch {
      return c.json({ error: 'Session verification is temporarily unavailable. Try again.' }, 503);
    }
  });
  routes.post('/auth/logout', async (c) => {
    if (!isTrustedRequest(c.req.raw))
      return c.json({ error: 'Request origin is not allowed' }, 403);
    try {
      const session = readSession(c.req.raw);
      if (session)
        await pool.query('DELETE FROM customer_sessions WHERE id_hash = $1', [
          hashCustomerAuthToken(session),
        ]);
      await passwords.revoke(session);
      const login = getCookie(c, loginCookie);
      if (login)
        await pool.query('DELETE FROM customer_login_requests WHERE id_hash = $1', [
          hashCustomerAuthToken(login),
        ]);
      await enrollment.forgetBrowser(getCookie(c, enrollmentCookie));
      deleteCookie(c, sessionCookie, cookieOptions);
      deleteCookie(c, loginCookie, cookieOptions);
      deleteCookie(c, enrollmentCookie, cookieOptions);
      return c.json({ ok: true });
    } catch {
      return c.json({ error: 'Sign-out is temporarily unavailable. Try again.' }, 503);
    }
  });
  routes.get('/auth/access-requests', async (c) => {
    try {
      const actor = await authenticate(c.req.raw);
      if (actor?.role !== 'admin')
        return c.json({ error: 'Administrator access is required.' }, 403);
      return c.json({ requests: await enrollment.list() });
    } catch {
      return c.json({ error: 'Access requests are temporarily unavailable. Try again.' }, 503);
    }
  });
  routes.delete('/auth/members/:userId', async (c) => {
    if (!isTrustedRequest(c.req.raw))
      return c.json({ error: 'Request origin is not allowed' }, 403);
    try {
      const actor = await authenticate(c.req.raw);
      if (actor?.role !== 'admin')
        return c.json({ error: 'Administrator access is required.' }, 403);
      await enrollment.removeMember(c.req.param('userId'), actor.actorId);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof CustomerEnrollmentError) return c.json({ error: error.message }, 409);
      return c.json({ error: 'Membership could not be removed. Try again.' }, 503);
    }
  });
  for (const decision of ['approve', 'reject'] as const) {
    routes.post(`/auth/access-requests/:id/${decision}`, async (c) => {
      if (!isTrustedRequest(c.req.raw))
        return c.json({ error: 'Request origin is not allowed' }, 403);
      try {
        const actor = await authenticate(c.req.raw);
        if (actor?.role !== 'admin')
          return c.json({ error: 'Administrator access is required.' }, 403);
        const role =
          decision === 'approve'
            ? roleSchema.safeParse((await c.req.json<{ role?: unknown }>()).role)
            : undefined;
        if (role && !role.success)
          return c.json({ error: 'Choose role author, operator or admin.' }, 400);
        const request = await enrollment.decide({
          requestId: c.req.param('id'),
          decision,
          ...(role?.success ? { role: role.data } : {}),
          operator: actor.actorId,
          authorizedActorId: actor.actorId,
          reason: 'Reviewed in the Atlas access requests page',
        });
        return c.json({ request });
      } catch (error) {
        if (error instanceof CustomerEnrollmentError) return c.json({ error: error.message }, 409);
        return c.json(
          { error: 'Access could not be updated. Check the request and try again.' },
          400,
        );
      }
    });
  }
  return { routes, authenticate, environmentsBelongToOrganization, isTrustedRequest, passwords };
}
