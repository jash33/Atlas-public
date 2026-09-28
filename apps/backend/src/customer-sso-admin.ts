import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import {
  customerAuthIssuer,
  customerSsoProviderBehavior,
  loadCustomerSsoProvider,
} from './customer-sso-provider.js';
import { loadCustomerAuthConfig } from './customer-auth.js';
import { createCustomerEnrollment } from './customer-enrollment.js';
import type { CustomerAuthConfig, CustomerSsoProviderConfig } from './customer-sso-provider.js';
import type { Role } from './admin-suite.js';

export async function approveCustomerAccessRequest(
  pool: Pool,
  config: CustomerAuthConfig,
  change: {
    requestId: string;
    role: Role;
    operator: string;
    reason: string;
    existingUserId?: string;
  },
) {
  return createCustomerEnrollment(pool, config).decide({ ...change, decision: 'approve' });
}

export interface CustomerAdminChange {
  action: 'provision-admin' | 'provision-user' | 'recover-admin' | 'revoke-sessions';
  role?: 'author' | 'operator' | 'admin';
  organizationId: string;
  provider: CustomerSsoProviderConfig;
  userId: string;
  subject?: string;
  email?: string;
  name?: string;
  operator: string;
  reason: string;
}

export function validateCustomerAdminChange(change: CustomerAdminChange) {
  for (const value of [change.organizationId, change.userId, change.operator, change.reason]) {
    if (!value.trim()) throw new Error('Organization, user, operator, and reason are required.');
  }
  validateAdminProvider(change.provider);
  if (change.action !== 'revoke-sessions' && !change.subject?.trim()) {
    throw new Error('A verified ID token subject is required.');
  }
  if (change.action === 'provision-user' && !change.role) throw new Error('Choose a user role.');
  if (change.email !== undefined || change.name !== undefined) {
    if (!change.email?.trim() || !change.name?.trim()) {
      throw new Error('Creating a user requires both email and name.');
    }
  }
}

function validateAdminProvider(provider: CustomerSsoProviderConfig) {
  return loadCustomerSsoProvider({
    ATLAS_SSO_PROVIDER: provider.provider,
    ATLAS_SSO_TENANT_ID: provider.provider === 'entra' ? provider.tenantId : undefined,
    ATLAS_SSO_GOOGLE_DOMAIN: provider.provider === 'google' ? provider.hostedDomain : undefined,
    ATLAS_SSO_OKTA_ISSUER: provider.provider === 'okta' ? provider.issuer : undefined,
  });
}

// This command requires database operator access. It is never called by the web server.
export async function changeCustomerAdmin(pool: Pool, change: CustomerAdminChange) {
  validateCustomerAdminChange(change);
  const provider = validateAdminProvider(change.provider);
  const providerBehavior = customerSsoProviderBehavior(provider);
  const issuer = customerAuthIssuer(provider);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const organization = await client.query(
      'SELECT id FROM organizations WHERE id = $1 FOR UPDATE',
      [change.organizationId],
    );
    if (!organization.rowCount) throw new Error('Organization does not exist.');
    const user = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [
      change.userId,
    ]);
    if (!user.rowCount) {
      if (change.action === 'revoke-sessions' || !change.email || !change.name) {
        throw new Error('User does not exist; provide email and name to create one.');
      }
      await client.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [
        change.userId,
        change.email,
        change.name,
      ]);
    } else if (change.email !== undefined || change.name !== undefined) {
      throw new Error('User already exists; omit email and name.');
    }
    if (change.action !== 'revoke-sessions') {
      const binding = await client.query<{ user_id: string }>(
        'SELECT user_id FROM customer_sso_identities WHERE organization_id = $1 AND issuer = $2 AND subject = $3 FOR UPDATE',
        [change.organizationId, issuer, change.subject],
      );
      if (binding.rows[0] && binding.rows[0].user_id !== change.userId) {
        throw new Error('This identity is already bound to another user.');
      }
      await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
        [
          change.organizationId,
          change.userId,
          change.action === 'provision-user' ? change.role : 'admin',
        ],
      );
    }
    await client.query(
      `DELETE FROM customer_sessions s USING customer_sso_identities i
       WHERE s.organization_id = i.organization_id AND s.issuer = i.issuer AND s.subject = i.subject
         AND i.organization_id = $1 AND i.user_id = $2`,
      [change.organizationId, change.userId],
    );
    if (change.action === 'recover-admin') {
      await client.query(
        'DELETE FROM customer_sso_identities WHERE organization_id = $1 AND user_id = $2',
        [change.organizationId, change.userId],
      );
      await client.query(
        `UPDATE customer_access_requests SET approved_user_id = NULL, status = 'rejected', expires_at = now()
         WHERE organization_id = $1 AND approved_user_id = $2`,
        [change.organizationId, change.userId],
      );
    }
    if (change.action !== 'revoke-sessions') {
      const inserted = await client.query(
        `INSERT INTO customer_sso_identities (organization_id, issuer, subject, user_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, issuer, subject) DO UPDATE SET user_id = EXCLUDED.user_id
         WHERE customer_sso_identities.user_id = EXCLUDED.user_id RETURNING user_id`,
        [change.organizationId, issuer, change.subject, change.userId],
      );
      if (!inserted.rowCount) throw new Error('This identity is already bound to another user.');
    }
    await client.query(
      `INSERT INTO audit_entries (organization_id, event_type, subject_type, subject_id, details)
       VALUES ($1, 'membership', 'user', $2, $3::jsonb)`,
      [
        change.organizationId,
        change.userId,
        JSON.stringify({
          action: change.action,
          role:
            change.action === 'provision-user'
              ? change.role
              : change.action === 'revoke-sessions'
                ? undefined
                : 'admin',
          operator: change.operator,
          reason: change.reason,
          issuer,
          ...providerBehavior.auditDetails,
          source: 'customer-sso-admin',
          sessionsRevoked: true,
        }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      action: { type: 'string' },
      request: { type: 'string' },
      role: { type: 'string' },
      organization: { type: 'string' },
      tenant: { type: 'string' },
      provider: { type: 'string' },
      issuer: { type: 'string' },
      'google-domain': { type: 'string' },
      'user-id': { type: 'string' },
      subject: { type: 'string' },
      email: { type: 'string' },
      name: { type: 'string' },
      operator: { type: 'string' },
      reason: { type: 'string' },
    },
  });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be explicitly set.');
  if (values.action === 'approve-request') {
    const config = loadCustomerAuthConfig();
    if (!config)
      throw new Error('Customer authentication must be configured before approving a request.');
    if (values.role !== 'author' && values.role !== 'operator' && values.role !== 'admin') {
      throw new Error('Choose role author, operator or admin.');
    }
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const request = await approveCustomerAccessRequest(pool, config, {
        requestId: values.request ?? '',
        role: values.role,
        operator: values.operator ?? '',
        reason: values.reason ?? '',
        ...(values['user-id'] ? { existingUserId: values['user-id'] } : {}),
      });
      console.info(`Access request ${request.id} approved. The user can sign in again.`);
    } finally {
      await pool.end();
    }
    return;
  }
  if (
    values.action !== 'provision-admin' &&
    values.action !== 'provision-user' &&
    values.action !== 'recover-admin' &&
    values.action !== 'revoke-sessions'
  ) {
    throw new Error(
      'Choose --action provision-admin, provision-user, recover-admin, or revoke-sessions.',
    );
  }
  if (
    values.role !== undefined &&
    values.role !== 'author' &&
    values.role !== 'operator' &&
    values.role !== 'admin'
  )
    throw new Error('Choose role author, operator, or admin.');
  if (
    values.provider !== undefined &&
    values.provider !== 'entra' &&
    values.provider !== 'google' &&
    values.provider !== 'okta'
  ) {
    throw new Error('Choose provider entra, google, or okta.');
  }
  const provider = loadCustomerSsoProvider({
    ATLAS_SSO_PROVIDER: values.provider ?? 'entra',
    ATLAS_SSO_TENANT_ID: values.tenant,
    ATLAS_SSO_GOOGLE_DOMAIN: values['google-domain'],
    ATLAS_SSO_OKTA_ISSUER: values.issuer,
  });
  const change: CustomerAdminChange = {
    action: values.action,
    organizationId: values.organization ?? '',
    provider,
    userId: values['user-id'] ?? '',
    operator: values.operator ?? '',
    reason: values.reason ?? '',
    ...(values.subject !== undefined ? { subject: values.subject } : {}),
    ...(values.email !== undefined ? { email: values.email } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    ...(values.role !== undefined ? { role: values.role } : {}),
  };
  validateCustomerAdminChange(change);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await changeCustomerAdmin(pool, change);
    console.info('Customer access updated and existing sessions revoked.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Database errors can contain credentials or customer data; keep terminal output private by default.
    console.error(
      'Customer access update failed. Check arguments, database access, existing identity bindings, and migrations.',
    );
    process.exitCode = 1;
  });
}
