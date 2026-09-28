import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

import { roleSchema, type Role } from './admin-suite.js';
import {
  customerAuthIssuer,
  customerAuthScope,
  type CustomerAuthConfig,
} from './customer-sso-provider.js';
import {
  createCustomerAuthToken,
  hashCustomerAuthToken,
  isCustomerAuthToken,
} from './customer-auth-token.js';

export interface VerifiedCustomerIdentity {
  issuer: string;
  subject: string;
  scope: string;
  displayName?: string;
  email?: string;
}

export interface CustomerAccessRequest {
  id: string;
  displayName: string;
  email?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
}

interface RequestRow {
  approved_user_id: string | null;
  id: string;
  display_name: string;
  email: string | null;
  status: CustomerAccessRequest['status'];
  created_at: Date;
  issuer: string;
  subject: string;
}

export class CustomerEnrollmentError extends Error {}
const toAccessRequest = (row: RequestRow): CustomerAccessRequest => ({
  id: row.id,
  displayName: row.display_name,
  ...(row.email ? { email: row.email } : {}),
  status: row.status,
  createdAt: row.created_at.toISOString(),
});

export function createCustomerEnrollment(
  pool: Pick<Pool, 'query' | 'connect'>,
  config: CustomerAuthConfig,
) {
  const scope = customerAuthScope(config);
  const issuer = customerAuthIssuer(config);
  return {
    async request(identity: VerifiedCustomerIdentity) {
      if (identity.scope !== scope || identity.issuer !== issuer || !identity.subject) {
        throw new CustomerEnrollmentError(
          'The verified identity does not match this installation.',
        );
      }
      const browserToken = createCustomerAuthToken();
      const result = await pool.query<RequestRow>(
        `INSERT INTO customer_access_requests
         (id,organization_id,auth_scope,issuer,subject,display_name,email,browser_hash,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '24 hours')
         ON CONFLICT (auth_scope,issuer,subject) DO UPDATE SET
           id = CASE WHEN customer_access_requests.expires_at <= now() THEN EXCLUDED.id ELSE customer_access_requests.id END,
           status = CASE WHEN customer_access_requests.expires_at <= now() THEN 'pending' ELSE customer_access_requests.status END,
           created_at = CASE WHEN customer_access_requests.expires_at <= now() THEN now() ELSE customer_access_requests.created_at END,
           display_name = CASE WHEN customer_access_requests.expires_at <= now() THEN EXCLUDED.display_name ELSE customer_access_requests.display_name END,
           email = CASE WHEN customer_access_requests.expires_at <= now() THEN EXCLUDED.email ELSE customer_access_requests.email END,
           expires_at = CASE WHEN customer_access_requests.expires_at <= now() THEN EXCLUDED.expires_at ELSE customer_access_requests.expires_at END,
           browser_hash = EXCLUDED.browser_hash
         RETURNING *`,
        [
          randomUUID(),
          config.organizationId,
          scope,
          issuer,
          identity.subject,
          identity.displayName?.slice(0, 512) || 'Company user',
          identity.email?.slice(0, 320) || null,
          hashCustomerAuthToken(browserToken),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new CustomerEnrollmentError('Could not create an access request.');
      return { request: toAccessRequest(row), browserToken };
    },
    async findForBrowser(browserToken: string | undefined): Promise<CustomerAccessRequest | null> {
      if (!isCustomerAuthToken(browserToken)) return null;
      const result = await pool.query<RequestRow>(
        `SELECT * FROM customer_access_requests WHERE browser_hash=$1 AND organization_id=$2
         AND auth_scope=$3 AND expires_at > now()`,
        [hashCustomerAuthToken(browserToken), config.organizationId, scope],
      );
      return result.rows[0] ? toAccessRequest(result.rows[0]) : null;
    },
    async forgetBrowser(browserToken: string | undefined) {
      if (!isCustomerAuthToken(browserToken)) return;
      await pool.query(
        'UPDATE customer_access_requests SET browser_hash=$2 WHERE browser_hash=$1',
        [hashCustomerAuthToken(browserToken), hashCustomerAuthToken(createCustomerAuthToken())],
      );
    },
    async list(): Promise<CustomerAccessRequest[]> {
      const result = await pool.query<RequestRow>(
        `SELECT * FROM customer_access_requests WHERE organization_id=$1 AND auth_scope=$2
         AND expires_at > now() ORDER BY (status = 'pending') DESC, created_at ASC LIMIT 100`,
        [config.organizationId, scope],
      );
      return result.rows.map(toAccessRequest);
    },
    async removeMember(userId: string, authorizedActorId: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [
          config.organizationId,
        ]);
        const admin = await client.query(
          "SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 AND role='admin'",
          [config.organizationId, authorizedActorId],
        );
        if (!admin.rowCount) throw new CustomerEnrollmentError('Administrator access is required.');
        const member = await client.query<{ role: Role }>(
          'SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2',
          [config.organizationId, userId],
        );
        if (!member.rows[0])
          throw new CustomerEnrollmentError('The user does not belong to this organization.');
        if (member.rows[0].role === 'admin') {
          const others = await client.query(
            "SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND role='admin' AND user_id<>$2",
            [config.organizationId, userId],
          );
          if (!others.rowCount)
            throw new CustomerEnrollmentError(
              'Add another administrator before removing the last administrator.',
            );
        }
        await client.query(
          'DELETE FROM organization_memberships WHERE organization_id=$1 AND user_id=$2',
          [config.organizationId, userId],
        );
        await client.query(
          "UPDATE customer_access_requests SET status='rejected',expires_at=now() WHERE organization_id=$1 AND approved_user_id=$2",
          [config.organizationId, userId],
        );
        await client.query(
          `INSERT INTO audit_entries (organization_id,event_type,subject_type,subject_id,details)
          VALUES ($1,'membership','user',$2,$3::jsonb)`,
          [
            config.organizationId,
            userId,
            JSON.stringify({
              action: 'remove-member',
              outcome: 'succeeded',
              operator: authorizedActorId,
              source: 'customer-console',
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
    },
    async decide(change: {
      requestId: string;
      decision: 'approve' | 'reject';
      role?: Role;
      operator: string;
      reason: string;
      existingUserId?: string;
      authorizedActorId?: string;
    }): Promise<CustomerAccessRequest> {
      if (!change.requestId.trim() || !change.operator.trim() || !change.reason.trim()) {
        throw new CustomerEnrollmentError('Request, operator and reason are required.');
      }
      if (change.decision === 'approve' && !roleSchema.safeParse(change.role).success) {
        throw new CustomerEnrollmentError('Choose role author, operator or admin.');
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM organizations WHERE id=$1 FOR UPDATE', [
          config.organizationId,
        ]);
        if (change.authorizedActorId) {
          const admin = await client.query(
            "SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id=$2 AND role='admin'",
            [config.organizationId, change.authorizedActorId],
          );
          if (!admin.rowCount)
            throw new CustomerEnrollmentError('Administrator access is required.');
        }
        const found = await client.query<RequestRow>(
          `SELECT * FROM customer_access_requests WHERE id=$1 AND organization_id=$2 AND auth_scope=$3
           AND issuer=$4 AND expires_at > now() FOR UPDATE`,
          [change.requestId, config.organizationId, scope, issuer],
        );
        const row = found.rows[0];
        if (!row || row.status !== 'pending')
          throw new CustomerEnrollmentError(
            'The request is unavailable, expired or already decided.',
          );
        let userId: string | undefined;
        if (change.decision === 'approve') {
          const bound = await client.query(
            'SELECT user_id FROM customer_sso_identities WHERE organization_id=$1 AND issuer=$2 AND subject=$3',
            [config.organizationId, issuer, row.subject],
          );
          if (bound.rowCount)
            throw new CustomerEnrollmentError('This identity already has access.');
          userId = change.existingUserId ?? row.approved_user_id ?? `user_${randomUUID()}`;
          if (change.existingUserId) {
            const member = await client.query<{ role: Role }>(
              'SELECT role FROM organization_memberships WHERE organization_id=$1 AND user_id=$2',
              [config.organizationId, userId],
            );
            if (!member.rowCount)
              throw new CustomerEnrollmentError(
                'The recovery user must already belong to this organization.',
              );
            if (member.rows[0]?.role === 'admin' && change.role !== 'admin') {
              const others = await client.query(
                "SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND role='admin' AND user_id<>$2",
                [config.organizationId, userId],
              );
              if (!others.rowCount)
                throw new CustomerEnrollmentError(
                  'Add another administrator before changing the last administrator role.',
                );
            }
            await client.query(
              'DELETE FROM customer_sso_identities WHERE organization_id=$1 AND user_id=$2',
              [config.organizationId, userId],
            );
            await client.query(
              "UPDATE customer_access_requests SET approved_user_id=NULL,status='rejected',expires_at=now() WHERE organization_id=$1 AND approved_user_id=$2 AND id<>$3",
              [config.organizationId, userId, row.id],
            );
          } else if (row.approved_user_id) {
            const existing = await client.query(
              'SELECT user_id FROM organization_memberships WHERE organization_id=$1 AND user_id=$2',
              [config.organizationId, userId],
            );
            if (existing.rowCount)
              throw new CustomerEnrollmentError(
                'This user already has access through another identity. Use explicit account recovery.',
              );
          } else {
            await client.query('INSERT INTO users (id,email,name) VALUES ($1,$2,$3)', [
              userId,
              row.email ?? `${userId}@sso.invalid`,
              row.display_name,
            ]);
          }
          await client.query(
            `INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ($1,$2,$3)
            ON CONFLICT (organization_id,user_id) DO UPDATE SET role=EXCLUDED.role, updated_at=now()`,
            [config.organizationId, userId, change.role],
          );
          await client.query(
            'INSERT INTO customer_sso_identities (organization_id,issuer,subject,user_id) VALUES ($1,$2,$3,$4)',
            [config.organizationId, issuer, row.subject, userId],
          );
        }
        const updated = await client.query<RequestRow>(
          'UPDATE customer_access_requests SET status=$2, decided_at=now(), approved_user_id=COALESCE($3,approved_user_id) WHERE id=$1 RETURNING *',
          [row.id, change.decision === 'approve' ? 'approved' : 'rejected', userId ?? null],
        );
        await client.query(
          `INSERT INTO audit_entries (organization_id,event_type,subject_type,subject_id,details)
          VALUES ($1,'membership','access-request',$2,$3::jsonb)`,
          [
            config.organizationId,
            row.id,
            JSON.stringify({
              action: `${change.decision}-access-request`,
              outcome: 'succeeded',
              role: change.role,
              userId,
              operator: change.operator,
              reason: change.reason,
              recovery: Boolean(change.existingUserId),
              source: change.authorizedActorId ? 'customer-console' : 'customer-sso-admin',
            }),
          ],
        );
        await client.query('COMMIT');
        return toAccessRequest(updated.rows[0]!);
      } catch (error) {
        await client.query('ROLLBACK');
        if (error instanceof CustomerEnrollmentError) throw error;
        throw new CustomerEnrollmentError(
          'Access could not be updated. Check for an existing account or contact the installation operator.',
        );
      } finally {
        client.release();
      }
    },
  };
}
