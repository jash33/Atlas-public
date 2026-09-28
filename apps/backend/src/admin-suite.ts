import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { matchesBearerToken } from './bearer-authorization.js';
import type { PlanningAuthorizer } from './planning-authorization.js';
import type {
  WorkflowApprovalAuthorizer,
  WorkflowRepairAuthorizer,
} from './workflow-authorization.js';

export const roleSchema = z.enum(['author', 'operator', 'admin']);
export type Role = z.infer<typeof roleSchema>;

export const rbacActionSchema = z.enum([
  'view-organization',
  'annotate-capability',
  'connect-capability-source',
  'draft-workflow',
  'start-workflow-run',
  'approve-capability-safety',
  'activate-workflow',
  'cancel-manual-review-run',
  'retry-failed-step',
  'replay-failed-step',
  'approve-migration',
  'rollback-migration',
  'manage-organization',
]);
export type RbacAction = z.infer<typeof rbacActionSchema>;

const roleActions: Readonly<Record<Role, ReadonlySet<RbacAction>>> = {
  author: new Set([
    'view-organization',
    'annotate-capability',
    'draft-workflow',
    'start-workflow-run',
  ]),
  operator: new Set([
    'view-organization',
    'annotate-capability',
    'cancel-manual-review-run',
    'retry-failed-step',
    'replay-failed-step',
  ]),
  admin: new Set(rbacActionSchema.options),
};

export function roleAllowsAction(role: Role, action: RbacAction): boolean {
  return roleActions[role]?.has(action) ?? false;
}

export interface MembershipActor {
  readonly actorId: string;
  readonly role: Role;
}

export interface MembershipAuthorizer {
  authorize(request: {
    authorizationHeader: string | undefined;
    organizationId: string;
    action: RbacAction;
  }): Promise<MembershipActor | null>;
}

export function createMembershipAuthorizer(
  pool: Pick<Pool, 'query'>,
  credentials: readonly { token: string; userId: string }[],
): MembershipAuthorizer {
  return {
    async authorize(request) {
      const credential = credentials.find(({ token }) =>
        matchesBearerToken(request.authorizationHeader, token),
      );
      if (!credential) return null;
      const result = await pool.query<{ role: Role }>(
        `SELECT role FROM organization_memberships
         WHERE organization_id = $1 AND user_id = $2`,
        [request.organizationId, credential.userId],
      );
      const role = result.rows[0]?.role;
      if (!role || !roleAllowsAction(role, request.action)) return null;
      return { actorId: credential.userId, role };
    },
  };
}

const planningScopeSchema = z.object({ organizationId: z.string().min(1) }).passthrough();

export function createPlanningMembershipAuthorizer(
  membershipAuthorizer: MembershipAuthorizer,
): PlanningAuthorizer {
  return {
    async authorize(request) {
      const scope = planningScopeSchema.safeParse(request.body);
      if (!scope.success) return null;
      const actor = await membershipAuthorizer.authorize({
        authorizationHeader: request.authorizationHeader,
        organizationId: scope.data.organizationId,
        action: 'draft-workflow',
      });
      return actor?.role === 'author' || actor?.role === 'admin' ? actor.role : null;
    },
  };
}

export function createApprovalMembershipAuthorizer(
  membershipAuthorizer: MembershipAuthorizer,
): WorkflowApprovalAuthorizer {
  return {
    async authorize(request) {
      const actor = await membershipAuthorizer.authorize({
        ...request,
        action: 'activate-workflow',
      });
      return actor?.role === 'admin' ? { actorId: actor.actorId, role: 'admin' } : null;
    },
  };
}

export function createRepairMembershipAuthorizer(
  membershipAuthorizer: MembershipAuthorizer,
): WorkflowRepairAuthorizer {
  return {
    async authorize(request) {
      const action: RbacAction =
        request.action === 'retry_step'
          ? 'retry-failed-step'
          : request.action === 'resume_run'
            ? 'replay-failed-step'
            : request.action === 'cancel_run'
              ? 'cancel-manual-review-run'
              : 'manage-organization';
      const actor = await membershipAuthorizer.authorize({ ...request, action });
      return actor?.role === 'operator' || actor?.role === 'admin'
        ? { actorId: actor.actorId, role: actor.role }
        : null;
    },
  };
}

const bootstrapSchema = z.object({
  organization: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
  users: z
    .array(
      z
        .object({
          id: z.string().min(1),
          email: z.email(),
          name: z.string().min(1),
          role: roleSchema,
        })
        .strict(),
    )
    .min(1),
});

export async function bootstrapMvpAdminSuite(pool: Pool, input: z.input<typeof bootstrapSchema>) {
  const bootstrap = bootstrapSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO organizations (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [bootstrap.organization.id, bootstrap.organization.name],
    );
    for (const user of bootstrap.users) {
      await client.query(
        `INSERT INTO users (id, email, name) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
        [user.id, user.email, user.name],
      );
      await client.query(
        `INSERT INTO organization_memberships (organization_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, user_id) DO NOTHING`,
        [bootstrap.organization.id, user.id, user.role],
      );
    }
    await client.query(
      `INSERT INTO teams (organization_id, id, name) VALUES ($1, 'team_atlas', 'Atlas')
       ON CONFLICT (organization_id, id) DO UPDATE SET name = EXCLUDED.name`,
      [bootstrap.organization.id],
    );
    for (const user of bootstrap.users) {
      await client.query(
        `INSERT INTO team_memberships (organization_id, team_id, user_id)
         VALUES ($1, 'team_atlas', $2) ON CONFLICT DO NOTHING`,
        [bootstrap.organization.id, user.id],
      );
    }
    await client.query(
      `INSERT INTO environments (organization_id, id, name, kind) VALUES
         ($1, 'development', 'Development', 'development'),
         ($1, 'production', 'Production', 'production')
       ON CONFLICT (organization_id, id) DO NOTHING`,
      [bootstrap.organization.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

interface AdminSuiteRows {
  organization: { id: string; name: string; settings: Record<string, unknown> };
  users: Array<{ id: string; email: string; name: string; role: Role }>;
  teams: Array<{ id: string; name: string; userIds: string[] }>;
  environments: Array<{ id: string; name: string; kind: 'development' | 'production' }>;
  secretReferences: Array<{
    alias: string;
    environmentId: string;
    description: string;
    valueLocation: 'worker';
    updatedBy: string;
    updatedAt: string;
  }>;
  workerDeclarations: Array<{
    environmentId: string;
    workerId: string;
    supportedIrVersions: { minimum: number; maximum: number };
    declaredAt: string;
  }>;
  capabilityHostPolicies: CapabilityHostPolicy[];
  capabilities: Array<{
    capabilityIdentityId: string;
    capabilityVersionId: string;
    serviceId: string;
    operationId: string;
  }>;
}

interface CapabilityHostPolicy {
  capabilityIdentityId: string;
  capabilityVersionId: string;
  serviceId: string;
  operationId: string;
  environmentId: string;
  hostname: string;
  allowRedirects: boolean;
  approvedBy: string;
  approvedAt: string;
}

export async function readAdminSuite(
  pool: Pool,
  organizationId: string,
): Promise<AdminSuiteRows | undefined> {
  const organizationResult = await pool.query<{
    id: string;
    name: string;
    settings: Record<string, unknown>;
  }>('SELECT id, name, settings FROM organizations WHERE id = $1', [organizationId]);
  const organization = organizationResult.rows[0];
  if (!organization) return undefined;
  const [users, teams, environments, secretReferences, workers, hostPolicies, capabilities] =
    await Promise.all([
      pool.query<{ id: string; email: string; name: string; role: Role }>(
        `SELECT users.id, users.email, users.name, membership.role
       FROM organization_memberships membership
       JOIN users ON users.id = membership.user_id
       WHERE membership.organization_id = $1 ORDER BY users.id`,
        [organizationId],
      ),
      pool.query<{ id: string; name: string; user_ids: string[] }>(
        `SELECT team.id, team.name,
              COALESCE(array_agg(member.user_id ORDER BY member.user_id)
                FILTER (WHERE member.user_id IS NOT NULL), '{}') AS user_ids
       FROM teams team LEFT JOIN team_memberships member
         ON member.organization_id = team.organization_id AND member.team_id = team.id
       WHERE team.organization_id = $1 GROUP BY team.id, team.name ORDER BY team.id`,
        [organizationId],
      ),
      pool.query<{ id: string; name: string; kind: 'development' | 'production' }>(
        `SELECT id, name, kind FROM environments WHERE organization_id = $1 ORDER BY id`,
        [organizationId],
      ),
      pool.query<{
        alias: string;
        environment_id: string;
        description: string;
        updated_by: string;
        updated_at: Date;
      }>(
        `SELECT alias, environment_id, description, updated_by, updated_at
       FROM secret_references WHERE organization_id = $1 ORDER BY environment_id, alias`,
        [organizationId],
      ),
      pool.query<{
        environment_id: string;
        worker_id: string;
        minimum_ir_version: number;
        maximum_ir_version: number;
        declared_at: Date;
      }>(
        `SELECT environment_id, worker_id, minimum_ir_version, maximum_ir_version, declared_at
       FROM environment_workers WHERE organization_id = $1
       ORDER BY environment_id, worker_id`,
        [organizationId],
      ),
      pool.query<{
        capability_identity_id: string;
        capability_version_id: string;
        service_id: string;
        operation_id: string;
        environment_id: string;
        hostname: string;
        allow_redirects: boolean;
        approved_by: string;
        approved_at: Date;
      }>(
        `SELECT policy.capability_identity_id, head.capability_version_id,
              identity.service_id, identity.operation_id, policy.environment_id,
              policy.hostname, policy.allow_redirects, policy.approved_by, policy.approved_at
       FROM capability_host_policies policy
       JOIN capability_identities identity ON identity.id = policy.capability_identity_id
       JOIN capability_identity_heads head
         ON head.organization_id = policy.organization_id
         AND head.capability_identity_id = policy.capability_identity_id
       WHERE policy.organization_id = $1 AND policy.revoked_at IS NULL
       ORDER BY policy.environment_id, identity.service_id, identity.operation_id, policy.hostname`,
        [organizationId],
      ),
      pool.query<{
        capability_identity_id: string;
        capability_version_id: string;
        service_id: string;
        operation_id: string;
      }>(
        `SELECT identity.id AS capability_identity_id, head.capability_version_id,
              identity.service_id, identity.operation_id
       FROM capability_identity_heads head
       JOIN capability_identities identity ON identity.id = head.capability_identity_id
       WHERE head.organization_id = $1
       ORDER BY identity.service_id, identity.operation_id`,
        [organizationId],
      ),
    ]);
  return {
    organization: { id: organization.id, name: organization.name, settings: organization.settings },
    users: users.rows,
    teams: teams.rows.map((team) => ({ id: team.id, name: team.name, userIds: team.user_ids })),
    environments: environments.rows,
    secretReferences: secretReferences.rows.map((reference) => ({
      alias: reference.alias,
      environmentId: reference.environment_id,
      description: reference.description,
      valueLocation: 'worker',
      updatedBy: reference.updated_by,
      updatedAt: reference.updated_at.toISOString(),
    })),
    workerDeclarations: workers.rows.map((worker) => ({
      environmentId: worker.environment_id,
      workerId: worker.worker_id,
      supportedIrVersions: {
        minimum: worker.minimum_ir_version,
        maximum: worker.maximum_ir_version,
      },
      declaredAt: worker.declared_at.toISOString(),
    })),
    capabilityHostPolicies: hostPolicies.rows.map(mapCapabilityHostPolicy),
    capabilities: capabilities.rows.map((capability) => ({
      capabilityIdentityId: String(capability.capability_identity_id),
      capabilityVersionId: capability.capability_version_id.trim(),
      serviceId: capability.service_id,
      operationId: capability.operation_id,
    })),
  };
}

function mapCapabilityHostPolicy(policy: {
  capability_identity_id: string;
  capability_version_id: string;
  service_id: string;
  operation_id: string;
  environment_id: string;
  hostname: string;
  allow_redirects: boolean;
  approved_by: string;
  approved_at: Date;
}): CapabilityHostPolicy {
  return {
    capabilityIdentityId: policy.capability_identity_id,
    capabilityVersionId: policy.capability_version_id.trim(),
    serviceId: policy.service_id,
    operationId: policy.operation_id,
    environmentId: policy.environment_id,
    hostname: policy.hostname,
    allowRedirects: policy.allow_redirects,
    approvedBy: policy.approved_by,
    approvedAt: policy.approved_at.toISOString(),
  };
}

export const organizationSettingsSchema = z
  .object({
    displayName: z.string().trim().min(1),
    defaultEnvironmentId: z.string().min(1),
  })
  .strict();

export async function updateOrganizationSettings(
  pool: Pool,
  organizationId: string,
  settings: z.infer<typeof organizationSettingsSchema>,
  actorId: string,
) {
  return withTransaction(pool, async (client) => {
    const environment = await client.query(
      'SELECT 1 FROM environments WHERE organization_id = $1 AND id = $2',
      [organizationId, settings.defaultEnvironmentId],
    );
    if (!environment.rows[0]) return undefined;
    const result = await client.query<{ settings: z.infer<typeof organizationSettingsSchema> }>(
      `UPDATE organizations SET settings = $2 WHERE id = $1 RETURNING settings`,
      [organizationId, settings],
    );
    if (!result.rows[0]) return undefined;
    await recordAdminAudit(client, {
      organizationId,
      environmentId: null,
      eventType: 'organization-settings',
      subjectId: organizationId,
      actorId,
      details: settings,
    });
    return result.rows[0].settings;
  });
}

export const secretReferenceSchema = z.object({ description: z.string().trim().max(500) }).strict();

export const capabilityHostPolicySchema = z.object({ allowRedirects: z.boolean() }).strict();

export const capabilityHostPolicyRouteSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    capabilityIdentityId: z.string().regex(/^\d+$/),
    hostname: z
      .string()
      .trim()
      .min(1)
      .max(253)
      .regex(
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i,
      ),
  })
  .strict();

export const membershipUpdateSchema = z.object({ role: roleSchema }).strict();
export const capabilitySafetyApprovalSchema = z
  .object({ organizationId: z.string().min(1) })
  .strict();

export async function approveCapabilitySafety(
  pool: Pool,
  organizationId: string,
  capabilityVersionId: string,
  actorId: string,
) {
  return withTransaction(pool, async (client) => {
    const version = await client.query<{ manifest_annotation_id: string | null }>(
      `SELECT manifest_annotation_id FROM capability_versions
       WHERE organization_id = $1 AND capability_version_id = $2`,
      [organizationId, capabilityVersionId],
    );
    const annotationId = version.rows[0]?.manifest_annotation_id;
    if (!annotationId) return undefined;
    await client.query(
      `INSERT INTO manifest_annotation_approvals
        (organization_id, manifest_annotation_id, approved_by, revoked_at)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (organization_id, manifest_annotation_id) DO UPDATE
         SET approved_by = EXCLUDED.approved_by, approved_at = current_timestamp,
             revoked_at = NULL`,
      [organizationId, annotationId, actorId],
    );
    const result = await client.query<{ approved_at: Date }>(
      `INSERT INTO capability_approvals
        (organization_id, capability_version_id, approved_by, revoked_at)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (organization_id, capability_version_id) DO UPDATE
         SET approved_by = EXCLUDED.approved_by, approved_at = current_timestamp,
             revoked_at = NULL
       RETURNING approved_at`,
      [organizationId, capabilityVersionId, actorId],
    );
    const approval = result.rows[0]!;
    await recordAdminAudit(client, {
      organizationId,
      environmentId: null,
      eventType: 'capability-safety-approval',
      subjectId: capabilityVersionId,
      actorId,
      details: { manifestAnnotationId: annotationId },
    });
    return {
      capabilityVersionId,
      approvedBy: actorId,
      approvedAt: approval.approved_at.toISOString(),
    };
  });
}

export class LastOrganizationAdmin extends Error {}
export class MembershipAdminRequired extends Error {}

export async function updateMembershipRole(
  pool: Pool,
  organizationId: string,
  userId: string,
  role: Role,
  actorId: string,
  protectLastAdmin = false,
) {
  return withTransaction(pool, async (client) => {
    if (protectLastAdmin) {
      await client.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [organizationId]);
      const actor = await client.query(
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 AND role = 'admin'",
        [organizationId, actorId],
      );
      if (!actor.rowCount) throw new MembershipAdminRequired('Administrator access is required.');
      if (role !== 'admin') {
        const admins = await client.query<{ user_id: string }>(
          "SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND role = 'admin'",
          [organizationId],
        );
        if (admins.rows.length === 1 && admins.rows[0]?.user_id === userId) {
          throw new LastOrganizationAdmin(
            'Assign another administrator before changing this role.',
          );
        }
      }
    }
    const result = await client.query<{ user_id: string; role: Role }>(
      `UPDATE organization_memberships SET role = $3, updated_at = current_timestamp
       WHERE organization_id = $1 AND user_id = $2 RETURNING user_id, role`,
      [organizationId, userId, role],
    );
    const membership = result.rows[0];
    if (!membership) return undefined;
    await recordAdminAudit(client, {
      organizationId,
      environmentId: null,
      eventType: 'membership',
      subjectId: userId,
      actorId,
      details: { role },
    });
    return { userId: membership.user_id, role: membership.role };
  });
}

export async function upsertSecretReference(
  pool: Pool,
  input: {
    organizationId: string;
    environmentId: string;
    alias: string;
    description: string;
    actorId: string;
  },
) {
  return withTransaction(pool, async (client) => {
    const environment = await client.query(
      'SELECT 1 FROM environments WHERE organization_id = $1 AND id = $2',
      [input.organizationId, input.environmentId],
    );
    if (!environment.rows[0]) return undefined;
    const result = await client.query<{
      alias: string;
      environment_id: string;
      description: string;
      updated_by: string;
      updated_at: Date;
    }>(
      `INSERT INTO secret_references
      (organization_id, environment_id, alias, description, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (organization_id, environment_id, alias) DO UPDATE
       SET description = EXCLUDED.description, updated_by = EXCLUDED.updated_by,
           updated_at = current_timestamp
     RETURNING alias, environment_id, description, updated_by, updated_at`,
      [input.organizationId, input.environmentId, input.alias, input.description, input.actorId],
    );
    const reference = result.rows[0];
    if (!reference) return undefined;
    await recordAdminAudit(client, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      eventType: 'secret-reference',
      subjectId: input.alias,
      actorId: input.actorId,
      details: { description: input.description },
    });
    return {
      alias: reference.alias,
      environmentId: reference.environment_id,
      description: reference.description,
      valueLocation: 'worker' as const,
      updatedBy: reference.updated_by,
      updatedAt: reference.updated_at.toISOString(),
    };
  });
}

export async function upsertCapabilityHostPolicy(
  pool: Pool,
  input: {
    organizationId: string;
    environmentId: string;
    capabilityIdentityId: string;
    hostname: string;
    allowRedirects: boolean;
    actorId: string;
  },
) {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{
      capability_identity_id: string;
      capability_version_id: string;
      service_id: string;
      operation_id: string;
      environment_id: string;
      hostname: string;
      allow_redirects: boolean;
      approved_by: string;
      approved_at: Date;
    }>(
      `INSERT INTO capability_host_policies
        (organization_id, capability_identity_id, environment_id, hostname,
         allow_redirects, approved_by, approved_at, revoked_at)
       SELECT $1, identity.id, environment.id, $4, $5, $6, current_timestamp, NULL
       FROM capability_identities identity
       JOIN environments environment ON environment.organization_id = identity.organization_id
       WHERE identity.organization_id = $1 AND identity.id = $3 AND environment.id = $2
       ON CONFLICT (organization_id, capability_identity_id, environment_id, hostname) DO UPDATE
         SET allow_redirects = EXCLUDED.allow_redirects, approved_by = EXCLUDED.approved_by,
             approved_at = current_timestamp, revoked_at = NULL
       RETURNING capability_identity_id, environment_id, hostname, allow_redirects,
         approved_by, approved_at,
         (SELECT capability_version_id FROM capability_identity_heads head
          WHERE head.organization_id = capability_host_policies.organization_id
            AND head.capability_identity_id = capability_host_policies.capability_identity_id),
         (SELECT service_id FROM capability_identities identity
          WHERE identity.id = capability_host_policies.capability_identity_id),
         (SELECT operation_id FROM capability_identities identity
          WHERE identity.id = capability_host_policies.capability_identity_id)`,
      [
        input.organizationId,
        input.environmentId,
        input.capabilityIdentityId,
        input.hostname,
        input.allowRedirects,
        input.actorId,
      ],
    );
    const policy = result.rows[0];
    if (!policy?.capability_version_id) return undefined;
    await recordAdminAudit(client, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      eventType: 'capability-host-policy',
      subjectId: `${input.capabilityIdentityId}:${input.hostname}`,
      actorId: input.actorId,
      details: {
        action: 'granted',
        capabilityIdentityId: input.capabilityIdentityId,
        hostname: input.hostname,
        allowRedirects: input.allowRedirects,
      },
    });
    return mapCapabilityHostPolicy(policy);
  });
}

export async function revokeCapabilityHostPolicy(
  pool: Pool,
  input: {
    organizationId: string;
    environmentId: string;
    capabilityIdentityId: string;
    hostname: string;
    actorId: string;
  },
) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `UPDATE capability_host_policies SET revoked_at = current_timestamp
       WHERE organization_id = $1 AND environment_id = $2
         AND capability_identity_id = $3 AND hostname = $4 AND revoked_at IS NULL
       RETURNING 1`,
      [input.organizationId, input.environmentId, input.capabilityIdentityId, input.hostname],
    );
    if (!result.rows[0]) return false;
    await recordAdminAudit(client, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      eventType: 'capability-host-policy',
      subjectId: `${input.capabilityIdentityId}:${input.hostname}`,
      actorId: input.actorId,
      details: {
        action: 'revoked',
        capabilityIdentityId: input.capabilityIdentityId,
        hostname: input.hostname,
      },
    });
    return true;
  });
}

interface AdminAuditEvent {
  organizationId: string;
  environmentId: string | null;
  eventType:
    | 'organization-settings'
    | 'secret-reference'
    | 'membership'
    | 'capability-safety-approval'
    | 'capability-host-policy';
  subjectId: string;
  actorId: string;
  details: Record<string, unknown>;
}

async function recordAdminAudit(pool: Pick<Pool, 'query'>, event: AdminAuditEvent) {
  await pool.query(
    `INSERT INTO audit_entries
      (organization_id, environment_id, event_type, subject_type, subject_id, actor_id, details)
     VALUES ($1, $2, $3, $3, $4, $5, $6)`,
    [
      event.organizationId,
      event.environmentId,
      event.eventType,
      event.subjectId,
      event.actorId,
      { ...event.details, outcome: 'succeeded' },
    ],
  );
}

async function withTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
