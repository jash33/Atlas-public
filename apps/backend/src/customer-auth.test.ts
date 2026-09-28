import { generateKeyPairSync, sign } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCustomerAuth,
  customerAuthIssuer,
  customerAuthScope,
  loadCustomerSsoProvider,
  createCustomerOidcProvider,
  loadCustomerAuthConfig,
  type CustomerAuthConfig,
  type CustomerOidcProvider,
} from './customer-auth.js';

const config: CustomerAuthConfig = {
  provider: 'entra',
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: 'atlas-client',
  clientSecret: 'test-secret',
  organizationId: 'customer',
  publicOrigin: 'https://atlas.example',
  sessionMaxAgeSeconds: 3600,
};
const issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
const request = { state: 'expected-state', nonce: 'expected-nonce', verifier: 'a'.repeat(43) };
const callback = new URL(
  `${config.publicOrigin}/auth/callback?code=one-use-code&state=${request.state}`,
);
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockProviderResponse(
  changes: Record<string, unknown> = {},
  forged = false,
  selectedConfig: CustomerAuthConfig = config,
) {
  const issuer = customerAuthIssuer(selectedConfig);
  const claims = {
    iss: issuer,
    aud: selectedConfig.clientId,
    sub: 'directory-subject',
    ...(selectedConfig.provider === 'entra' ? { tid: selectedConfig.tenantId } : {}),
    ...(selectedConfig.provider === 'google' ? { hd: selectedConfig.hostedDomain } : {}),
    nonce: request.nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    ...changes,
  };
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${body}`;
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(input),
    forged ? otherKeys.privateKey : keys.privateKey,
  ).toString('base64url');
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const href = url instanceof Request ? url.url : url.toString();
    if (href.includes('.well-known'))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/keys`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    if (href.endsWith('/keys'))
      return Response.json({
        keys: [
          {
            ...keys.publicKey.export({ format: 'jwk' }),
            kid: 'test-key',
            alg: 'RS256',
            use: 'sig',
          },
        ],
      });
    if (href.endsWith('/token')) {
      if (selectedConfig.provider === 'okta') {
        const authorization = new Headers(init?.headers).get('authorization') ?? '';
        const credentials = Buffer.from(authorization.slice(6), 'base64')
          .toString()
          .split(':')
          .map(decodeURIComponent);
        if (
          !authorization.startsWith('Basic ') ||
          !(init?.body instanceof URLSearchParams) ||
          init.body.has('client_secret') ||
          credentials[0] !== selectedConfig.clientId ||
          credentials[1] !== selectedConfig.clientSecret
        ) {
          return Response.json({ error: 'invalid_client' }, { status: 401 });
        }
      }
      return Response.json({
        access_token: 'unused-access-token',
        token_type: 'Bearer',
        id_token: `${input}.${signature}`,
      });
    }
    throw new Error('Unexpected provider URL');
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('customer OIDC verification', () => {
  it('takes enrollment profile details only from a verified signed identity token', async () => {
    mockProviderResponse({ name: 'Verified Customer', email: 'customer@example.com' });
    await expect(
      createCustomerOidcProvider(config).verify(callback, request),
    ).resolves.toMatchObject({
      displayName: 'Verified Customer',
      email: 'customer@example.com',
      subject: 'directory-subject',
    });
    mockProviderResponse({ name: 'Forged Customer', email: 'admin@example.com' }, true);
    await expect(createCustomerOidcProvider(config).verify(callback, request)).rejects.toThrow(
      /.+/,
    );
  });
  it('verifies a signed response for the configured company, app and request', async () => {
    mockProviderResponse();
    const provider = createCustomerOidcProvider(config);
    const url = await provider.authorizationUrl(request);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe(request.nonce);
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('redirect_uri')).toBe(`${config.publicOrigin}/auth/callback`);
    await expect(provider.verify(callback, request)).resolves.toEqual({
      issuer,
      subject: 'directory-subject',
      scope: customerAuthScope(config),
    });
  });
  it.each([
    ['wrong issuer', { iss: 'https://wrong.example' }],
    ['wrong app', { aud: 'another-app' }],
    ['expired token', { exp: 1 }],
    ['missing expiry', { exp: undefined }],
    ['wrong authorized party', { aud: [config.clientId, 'other-app'], azp: 'other-app' }],
    ['wrong nonce', { nonce: 'another-request' }],
    ['wrong company', { tid: 'another-company' }],
  ])('rejects %s', async (_label, changes) => {
    mockProviderResponse(changes);
    await expect(createCustomerOidcProvider(config).verify(callback, request)).rejects.toThrow(
      /.+/,
    );
  });
  it('rejects a forged signature', async () => {
    mockProviderResponse({}, true);
    await expect(createCustomerOidcProvider(config).verify(callback, request)).rejects.toThrow(
      /.+/,
    );
  });
  it('rejects a mismatched state before exchanging a code', async () => {
    const fetch = mockProviderResponse();
    await expect(
      createCustomerOidcProvider(config).verify(new URL(`${callback}&state=forged`), request),
    ).rejects.toThrow(/.+/);
    expect(
      fetch.mock.calls.some(([url]) =>
        (url instanceof Request ? url.url : url.toString()).endsWith('/token'),
      ),
    ).toBe(false);
  });
});

const googleConfig: CustomerAuthConfig = {
  ...config,
  provider: 'google',
  hostedDomain: 'customer.example',
};
const oktaConfig: CustomerAuthConfig = {
  ...config,
  provider: 'okta',
  issuer: 'https://customer.okta.com',
};

describe.each([googleConfig, oktaConfig])('$provider OIDC', (selectedConfig) => {
  it('verifies the selected provider and preserves code, nonce, state and PKCE protections', async () => {
    mockProviderResponse({}, false, selectedConfig);
    const provider = createCustomerOidcProvider(selectedConfig);
    const url = await provider.authorizationUrl(request);
    expect(url.origin).toBe(customerAuthIssuer(selectedConfig));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe(request.nonce);
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('hd')).toBe(
      selectedConfig.provider === 'google' ? selectedConfig.hostedDomain : null,
    );
    await expect(provider.verify(callback, request)).resolves.toEqual({
      issuer: customerAuthIssuer(selectedConfig),
      subject: 'directory-subject',
      scope: customerAuthScope(selectedConfig),
    });
  });
  it.each([
    ['issuer', { iss: 'https://other-company.okta.com' }],
    ['audience', { aud: 'other-app' }],
    ['expiry', { exp: 1 }],
    ['nonce', { nonce: 'other-login' }],
  ])('rejects the wrong %s', async (_label, changes) => {
    mockProviderResponse(changes, false, selectedConfig);
    await expect(
      createCustomerOidcProvider(selectedConfig).verify(callback, request),
    ).rejects.toThrow(/.+/);
  });
  it('rejects forged signatures', async () => {
    mockProviderResponse({}, true, selectedConfig);
    await expect(
      createCustomerOidcProvider(selectedConfig).verify(callback, request),
    ).rejects.toThrow(/.+/);
  });
  it('rejects an unsolicited response before exchanging the code', async () => {
    const fetch = mockProviderResponse({}, false, selectedConfig);
    await expect(
      createCustomerOidcProvider(selectedConfig).verify(
        new URL(`${callback}&state=other`),
        request,
      ),
    ).rejects.toThrow(/.+/);
    expect(fetch.mock.calls).toHaveLength(1);
  });
});

describe('Google Workspace company boundary', () => {
  it.each([
    ['consumer account', { hd: undefined, email: 'person@customer.example', email_verified: true }],
    ['another company', { hd: 'other.example', email: 'person@customer.example' }],
    ['subdomain', { hd: 'division.customer.example' }],
  ])('rejects %s without trusting email suffixes', async (_label, changes) => {
    mockProviderResponse(changes, false, googleConfig);
    await expect(
      createCustomerOidcProvider(googleConfig).verify(callback, request),
    ).rejects.toThrow('unrecognized identity');
  });
});

describe('provider configuration', () => {
  it('defaults existing installations to Entra', () => {
    expect(loadCustomerSsoProvider({ ATLAS_SSO_TENANT_ID: config.tenantId })).toEqual({
      provider: 'entra',
      tenantId: config.tenantId,
    });
  });
  it('normalizes one Workspace domain and one Okta org issuer', () => {
    expect(
      loadCustomerSsoProvider({
        ATLAS_SSO_PROVIDER: 'google',
        ATLAS_SSO_GOOGLE_DOMAIN: 'Customer.Example',
      }),
    ).toEqual({ provider: 'google', hostedDomain: 'customer.example' });
    expect(
      loadCustomerSsoProvider({
        ATLAS_SSO_PROVIDER: 'okta',
        ATLAS_SSO_OKTA_ISSUER: 'https://customer.okta.com/',
      }),
    ).toEqual({ provider: 'okta', issuer: 'https://customer.okta.com' });
  });
  it.each([
    { ATLAS_SSO_PROVIDER: 'google' },
    { ATLAS_SSO_PROVIDER: 'google', ATLAS_SSO_GOOGLE_DOMAIN: '*' },
    { ATLAS_SSO_PROVIDER: 'google', ATLAS_SSO_GOOGLE_DOMAIN: 'https://customer.example' },
    { ATLAS_SSO_PROVIDER: 'entra,google' },
    {
      ATLAS_SSO_PROVIDER: 'google',
      ATLAS_SSO_GOOGLE_DOMAIN: 'customer.example',
      ATLAS_SSO_TENANT_ID: config.tenantId,
    },
    { ATLAS_SSO_PROVIDER: 'okta', ATLAS_SSO_OKTA_ISSUER: 'http://customer.okta.com' },
    { ATLAS_SSO_PROVIDER: 'okta', ATLAS_SSO_OKTA_ISSUER: 'https://127.0.0.1' },
    { ATLAS_SSO_PROVIDER: 'okta', ATLAS_SSO_OKTA_ISSUER: 'https://[::1]' },
    { ATLAS_SSO_PROVIDER: 'okta', ATLAS_SSO_OKTA_ISSUER: 'https://localhost' },
    { ATLAS_SSO_PROVIDER: 'okta', ATLAS_SSO_OKTA_ISSUER: 'https://id.localhost' },
    { ATLAS_SSO_PROVIDER: 'okta', ATLAS_SSO_OKTA_ISSUER: 'https://customer.okta.com:8443' },
    {
      ATLAS_SSO_PROVIDER: 'okta',
      ATLAS_SSO_OKTA_ISSUER: 'https://customer.okta.com/oauth2/default',
    },
    {
      ATLAS_SSO_PROVIDER: 'okta',
      ATLAS_SSO_OKTA_ISSUER: 'https://user:password@customer.okta.com',
    },
    { ATLAS_SSO_PROVIDER: 'okta', ATLAS_SSO_OKTA_ISSUER: 'https://customer.okta.com?issuer=other' },
  ])('rejects incomplete or ambiguous settings: %j', (env) => {
    expect(() => loadCustomerSsoProvider(env)).toThrow(/.+/);
  });
  it('changes the session scope when provider, company, app, origin or lifetime changes', () => {
    const original = customerAuthScope(googleConfig);
    for (const changed of [
      config,
      oktaConfig,
      { ...googleConfig, hostedDomain: 'other.example' },
      { ...googleConfig, clientId: 'other-app' },
      { ...googleConfig, organizationId: 'other-org' },
      { ...googleConfig, publicOrigin: 'https://other.example' },
      { ...googleConfig, sessionMaxAgeSeconds: 60 },
    ])
      expect(customerAuthScope(changed)).not.toBe(original);
    expect(customerAuthScope({ ...googleConfig, clientSecret: 'rotated-secret' })).toBe(original);
  });
});

describe('customer sessions', () => {
  const result = (rows: object[] = []) => ({
    rows,
    command: '',
    rowCount: rows.length,
    oid: 0,
    fields: [],
  });
  it.each(['', '?state=forged', '?state=one&state=two'])(
    'does not log out or consume a legitimate sign-in for an unsolicited callback %s',
    async (search) => {
      const pool = new Pool();
      const query = vi.spyOn(pool, 'query').mockImplementation(async () => result());
      const auth = createCustomerAuth(pool, config);
      const response = await auth.routes.request(`${config.publicOrigin}/auth/callback${search}`, {
        headers: {
          cookie: `__Host-atlas-session=${'a'.repeat(43)}; __Host-atlas-login=${'b'.repeat(43)}`,
        },
      });
      expect(response.headers.get('location')).toContain('login=failed');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(
        query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM customer_sessions')),
      ).toBe(false);
      const conditionalDelete = [
        expect.stringContaining('AND state = $4'),
        [expect.any(String), config.organizationId, customerAuthScope(config), 'forged'],
      ];
      expect(query.mock.calls).toEqual(search === '?state=forged' ? [conditionalDelete] : []);
    },
  );
  it('rejects forged and expired sessions and checks current membership with installation scope', async () => {
    const pool = new Pool();
    const query = vi.spyOn(pool, 'query').mockImplementation(async () => result());
    const auth = createCustomerAuth(pool, config);
    expect(
      await auth.authenticate(
        new Request(config.publicOrigin, { headers: { cookie: '__Host-atlas-session=forged' } }),
      ),
    ).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(
      await auth.authenticate(
        new Request(config.publicOrigin, {
          headers: { cookie: `__Host-atlas-session=${'a'.repeat(43)}` },
        }),
      ),
    ).toBeNull();
    expect(query.mock.calls[0]?.[0]).toContain('s.expires_at > now()');
    expect(query.mock.calls[0]?.[0]).toContain('JOIN organization_memberships');
    expect(query.mock.calls[0]?.[1]).toEqual([
      expect.any(String),
      config.organizationId,
      issuer,
      customerAuthScope(config),
    ]);
  });
  it('consumes a browser-bound login once, issues protected cookies, and rejects callback replay', async () => {
    const pool = new Pool();
    const query = vi.spyOn(pool, 'query');
    query.mockImplementation(async () => result());
    const verify = vi.fn<CustomerOidcProvider['verify']>().mockResolvedValue({
      issuer,
      subject: 'directory-subject',
      scope: customerAuthScope(config),
    });
    const auth = createCustomerAuth(pool, config, {
      authorizationUrl: async () => new URL(`${issuer}/authorize`),
      verify,
    });
    const login = await auth.routes.request(`${config.publicOrigin}/auth/login`);
    expect(login.status).toBe(302);
    const loginSetCookie = login.headers.get('set-cookie')!;
    expect(loginSetCookie).toContain('HttpOnly');
    expect(loginSetCookie).toContain('Secure');
    expect(loginSetCookie).toContain('SameSite=Lax');
    const cookie = loginSetCookie.split(';')[0]!;
    query
      .mockImplementationOnce(async () => result([request]))
      .mockImplementationOnce(async () => result([{ id_hash: 'stored-hash' }]));
    const response = await auth.routes.request(callback, { headers: { cookie } });
    expect(response.headers.get('location')).toBe(`${config.publicOrigin}/`);
    expect(response.headers.get('set-cookie')).toContain('__Host-atlas-session=');
    expect(verify).toHaveBeenCalledOnce();
    const replay = await auth.routes.request(callback, { headers: { cookie } });
    expect(replay.headers.get('location')).toBe(`${config.publicOrigin}/?login=failed`);
    expect(verify).toHaveBeenCalledOnce();
  });
  it('requires the configured origin for logout and revokes sessions and pending sign-ins', async () => {
    const pool = new Pool();
    const query = vi.spyOn(pool, 'query').mockImplementation(async () => result());
    const auth = createCustomerAuth(pool, config);
    const cookie = `__Host-atlas-session=${'a'.repeat(43)}; __Host-atlas-login=${'b'.repeat(43)}`;
    expect(
      (
        await auth.routes.request('/auth/logout', {
          method: 'POST',
          headers: { cookie, origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    expect(query).not.toHaveBeenCalled();
    const response = await auth.routes.request('/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: config.publicOrigin },
    });
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(3);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
  it('shows a safe retry message during provider outage', async () => {
    const pool = new Pool();
    const auth = createCustomerAuth(pool, config, {
      authorizationUrl: async () => {
        throw new Error('secret details');
      },
      verify: async () => {
        throw new Error('secret details');
      },
    });
    const response = await auth.routes.request('/auth/login');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret details');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('distinguishes a callback provider outage from a rejected account', async () => {
    const pool = new Pool();
    vi.spyOn(pool, 'query').mockImplementation(async () => result([request]));
    const auth = createCustomerAuth(pool, config, {
      authorizationUrl: async () => new URL(`${issuer}/authorize`),
      verify: async () => {
        throw new TypeError('token endpoint secret details');
      },
    });
    const response = await auth.routes.request(callback, {
      headers: { cookie: `__Host-atlas-login=${'b'.repeat(43)}` },
    });
    expect(response.headers.get('location')).toBe(`${config.publicOrigin}/?login=unavailable`);
    expect(response.headers.get('location')).not.toContain('secret details');
  });
});

describe('customer configuration', () => {
  it('fails closed for misspelled modes and incomplete customer configuration', () => {
    expect(loadCustomerAuthConfig({})).toBeUndefined();
    expect(() => loadCustomerAuthConfig({ ATLAS_AUTH_MODE: 'customre' })).toThrow(/.+/);
    expect(() => loadCustomerAuthConfig({ ATLAS_AUTH_MODE: 'customer' })).toThrow(/.+/);
  });
});
