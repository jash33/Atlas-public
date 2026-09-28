import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

const domainName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type CustomerSsoProviderConfig =
  | { provider: 'entra'; tenantId: string }
  | { provider: 'google'; hostedDomain: string }
  | { provider: 'okta'; issuer: string };

export type CustomerAuthConfig = CustomerSsoProviderConfig & {
  clientId: string;
  clientSecret: string;
  organizationId: string;
  publicOrigin: string;
  sessionMaxAgeSeconds: number;
};

export interface CustomerSsoProviderBehavior {
  issuer: string;
  authorizationParameters: Readonly<Record<string, string>>;
  acceptsIdentity: (claims: Readonly<Record<string, unknown>>) => boolean;
  auditDetails: Readonly<Record<string, string>>;
  scopeRestriction: string | null;
}

export function loadCustomerSsoProvider(
  env: Readonly<Record<string, string | undefined>>,
): CustomerSsoProviderConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for the selected SSO provider`);
    return value;
  };
  const provider = env.ATLAS_SSO_PROVIDER ?? 'entra';
  const restrictions = {
    entra: 'ATLAS_SSO_TENANT_ID',
    google: 'ATLAS_SSO_GOOGLE_DOMAIN',
    okta: 'ATLAS_SSO_OKTA_ISSUER',
  };
  for (const [owner, name] of Object.entries(restrictions)) {
    if (owner !== provider && env[name]?.trim()) {
      throw new Error(`${name} must not be set when ATLAS_SSO_PROVIDER is ${provider}`);
    }
  }
  switch (provider) {
    case 'entra': {
      const tenantId = required('ATLAS_SSO_TENANT_ID').toLowerCase();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(tenantId)) {
        throw new Error('ATLAS_SSO_TENANT_ID must be one Microsoft Entra tenant ID');
      }
      return { provider, tenantId };
    }
    case 'google': {
      const hostedDomain = required('ATLAS_SSO_GOOGLE_DOMAIN').toLowerCase();
      if (hostedDomain.length > 253 || !domainName.test(hostedDomain)) {
        throw new Error('ATLAS_SSO_GOOGLE_DOMAIN must be one Google Workspace domain');
      }
      return { provider, hostedDomain };
    }
    case 'okta': {
      const issuer = new URL(required('ATLAS_SSO_OKTA_ISSUER'));
      if (
        issuer.protocol !== 'https:' ||
        issuer.username ||
        issuer.password ||
        issuer.port ||
        isIP(issuer.hostname) ||
        issuer.hostname.length > 253 ||
        !domainName.test(issuer.hostname) ||
        issuer.hostname.endsWith('.localhost') ||
        issuer.hostname.endsWith('.local') ||
        issuer.pathname !== '/' ||
        issuer.search ||
        issuer.hash
      ) {
        throw new Error(
          'ATLAS_SSO_OKTA_ISSUER must be the HTTPS Okta organization origin without a path',
        );
      }
      return { provider, issuer: issuer.origin };
    }
    default:
      throw new Error('ATLAS_SSO_PROVIDER must be entra, google or okta');
  }
}

export function customerAuthIssuer(config: CustomerSsoProviderConfig): string {
  return customerSsoProviderBehavior(config).issuer;
}

export function customerSsoProviderBehavior(
  config: CustomerSsoProviderConfig,
): CustomerSsoProviderBehavior {
  switch (config.provider) {
    case 'entra':
      return {
        issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
        authorizationParameters: {},
        acceptsIdentity: (claims) => claims.tid === config.tenantId,
        auditDetails: { provider: config.provider },
        scopeRestriction: null,
      };
    case 'google':
      return {
        issuer: 'https://accounts.google.com',
        authorizationParameters: { hd: config.hostedDomain },
        acceptsIdentity: (claims) => claims.hd === config.hostedDomain,
        auditDetails: { provider: config.provider, hostedDomain: config.hostedDomain },
        scopeRestriction: config.hostedDomain,
      };
    case 'okta':
      return {
        issuer: config.issuer,
        authorizationParameters: {},
        acceptsIdentity: () => true,
        auditDetails: { provider: config.provider },
        scopeRestriction: null,
      };
  }
}

export function customerAuthScope(config: CustomerAuthConfig): string {
  const providerBehavior = customerSsoProviderBehavior(config);
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.provider,
        providerBehavior.issuer,
        config.clientId,
        config.organizationId,
        providerBehavior.scopeRestriction,
        config.publicOrigin,
        config.sessionMaxAgeSeconds,
      ]),
    )
    .digest('hex');
}
