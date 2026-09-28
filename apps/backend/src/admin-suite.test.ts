import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import {
  bootstrapMvpAdminSuite,
  createMembershipAuthorizer,
  createRepairMembershipAuthorizer,
  rbacActionSchema,
  type RbacAction,
  type Role,
} from './admin-suite.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `admin_suite_test_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const credentials = [
  { token: 'author-token', userId: 'user_author' },
  { token: 'operator-token', userId: 'user_operator' },
  { token: 'admin-token', userId: 'user_admin' },
] as const;
let app: ReturnType<typeof createApp>;

async function observeCapabilityVersion(
  environmentId: string,
  capabilityIdentityId: string,
  capabilityVersionId: string,
) {
  await pool.query(
    `INSERT INTO environment_capability_observations
      (organization_id, environment_id, capability_identity_id, capability_version_id)
     VALUES ('org_atlas', $1, $2, $3)`,
    [environmentId, capabilityIdentityId, capabilityVersionId],
  );
  await pool.query(
    `INSERT INTO environment_capability_version_observations
      (organization_id, environment_id, capability_version_id)
     VALUES ('org_atlas', $1, $2)`,
    [environmentId, capabilityVersionId],
  );
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 39 });
  await bootstrapMvpAdminSuite(pool, {
    organization: { id: 'org_atlas', name: 'Atlas Demo' },
    users: [
      { id: 'user_author', email: 'author@atlas.local', name: 'Avery Author', role: 'author' },
      {
        id: 'user_operator',
        email: 'operator@atlas.local',
        name: 'Olivia Operator',
        role: 'operator',
      },
      { id: 'user_admin', email: 'admin@atlas.local', name: 'Amir Admin', role: 'admin' },
    ],
  });
  const authorizer = createMembershipAuthorizer(pool, credentials);
  app = createApp(pool, undefined, undefined, undefined, undefined, authorizer);
});

afterAll(async () => {
  await pool.end();
});

describe('membership-backed RBAC', () => {
  const allowed: Record<Role, readonly RbacAction[]> = {
    author: ['view-organization', 'annotate-capability', 'draft-workflow', 'start-workflow-run'],
    operator: [
      'view-organization',
      'annotate-capability',
      'cancel-manual-review-run',
      'retry-failed-step',
      'replay-failed-step',
    ],
    admin: rbacActionSchema.options,
  };
  const actions = rbacActionSchema.options;

  for (const [role, token] of [
    ['author', 'author-token'],
    ['operator', 'operator-token'],
    ['admin', 'admin-token'],
  ] as const) {
    it(`enforces every action for the ${role} membership`, async () => {
      const authorizer = createMembershipAuthorizer(pool, credentials);

      for (const action of actions) {
        const actor = await authorizer.authorize({
          authorizationHeader: `Bearer ${token}`,
          organizationId: 'org_atlas',
          action,
        });

        expect(actor !== null, `${role} / ${action}`).toBe(allowed[role].includes(action));
      }
    });
  }

  it('does not grant a role outside the requested organization', async () => {
    const authorizer = createMembershipAuthorizer(pool, credentials);

    await expect(
      authorizer.authorize({
        authorizationHeader: 'Bearer admin-token',
        organizationId: 'org_other',
        action: 'manage-organization',
      }),
    ).resolves.toBeNull();
  });

  it('does not treat general abandonment as manual-review cancellation', async () => {
    const authorizer = createRepairMembershipAuthorizer(
      createMembershipAuthorizer(pool, credentials),
    );

    await expect(
      authorizer.authorize({
        authorizationHeader: 'Bearer operator-token',
        organizationId: 'org_atlas',
        action: 'abandon_run',
      }),
    ).resolves.toBeNull();
    await expect(
      authorizer.authorize({
        authorizationHeader: 'Bearer operator-token',
        organizationId: 'org_atlas',
        action: 'cancel_run',
      }),
    ).resolves.toEqual({ actorId: 'user_operator', role: 'operator' });
  });
});

describe('MVP admin suite API', () => {
  it('returns the organization, users, teams, roles, and both required environments to an admin', async () => {
    const response = await app.request('/v1/organizations/org_atlas/admin-suite', {
      headers: { authorization: 'Bearer admin-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organization: { id: 'org_atlas', name: 'Atlas Demo', settings: {} },
      users: [
        { id: 'user_admin', role: 'admin' },
        { id: 'user_author', role: 'author' },
        { id: 'user_operator', role: 'operator' },
      ],
      teams: [
        {
          id: 'team_atlas',
          name: 'Atlas',
          userIds: ['user_admin', 'user_author', 'user_operator'],
        },
      ],
      environments: [
        { id: 'development', kind: 'development' },
        { id: 'production', kind: 'production' },
      ],
      secretReferences: [],
      workerDeclarations: [],
      capabilityHostPolicies: [],
      capabilities: [],
    });
  });

  it('lets every member inspect administration while keeping mutations admin-only', async () => {
    for (const token of ['author-token', 'operator-token']) {
      const response = await app.request('/v1/organizations/org_atlas/admin-suite', {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        organization: { id: string };
        users: Array<{ id: string; role: string }>;
      };
      expect(body.organization.id).toBe('org_atlas');
      expect(body.users).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'user_admin', role: 'admin' })]),
      );

      const mutation = await app.request('/v1/organizations/org_atlas/settings', {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ displayName: 'Forbidden', defaultEnvironmentId: 'development' }),
      });
      expect(mutation.status).toBe(403);
    }
  });

  it('exposes environment worker IR declarations as implemented backend data', async () => {
    await pool.query(
      `INSERT INTO environment_workers
        (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version)
       VALUES ('org_atlas', 'development', 'development/payment', 2, 2)`,
    );

    const response = await app.request('/v1/organizations/org_atlas/admin-suite', {
      headers: { authorization: 'Bearer author-token' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workerDeclarations: [
        {
          environmentId: 'development',
          workerId: 'development/payment',
          supportedIrVersions: { minimum: 2, maximum: 2 },
        },
      ],
    });
  });

  it('enforces capability safety approval at the HTTP boundary', async () => {
    for (const token of ['author-token', 'operator-token']) {
      const denied = await app.request('/v1/capability-versions/missing/safety-approval', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_atlas' }),
      });
      expect(denied.status).toBe(403);
    }

    const admin = await app.request('/v1/capability-versions/missing/safety-approval', {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_atlas' }),
    });
    expect(admin.status).toBe(404);
  });

  it('approves both the exact capability version and its attached safety annotation', async () => {
    const capabilityVersionId = 'c'.repeat(64);
    const source = await pool.query<{ id: string }>(
      `INSERT INTO source_documents
        (organization_id, service_id, format, document, document_hash, repository, commit_sha, path)
       VALUES ('org_atlas', 'billing', 'openapi', '{}', $1, 'https://example.test/billing',
         'abc123', 'openapi.json') RETURNING id`,
      ['a'.repeat(64)],
    );
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO capability_identities
        (organization_id, kind, service_id, operation_id)
       VALUES ('org_atlas', 'openapi', 'billing', 'charge') RETURNING id`,
    );
    const annotation = await pool.query<{ id: string }>(
      `INSERT INTO manifest_annotations
        (organization_id, capability_identity_id, annotation_hash, owner,
         business_semantics, irreversible_after)
       VALUES ('org_atlas', $1, $2, 'payments', '{}', false) RETURNING id`,
      [identity.rows[0]!.id, 'b'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO capability_versions
        (organization_id, capability_version_id, capability_identity_id, source_document_id,
         manifest_annotation_id, capability_fragment_hash, capability_fragment)
       VALUES ('org_atlas', $1, $2, $3, $4, $5, '{}')`,
      [
        capabilityVersionId,
        identity.rows[0]!.id,
        source.rows[0]!.id,
        annotation.rows[0]!.id,
        'd'.repeat(64),
      ],
    );
    await pool.query(
      `INSERT INTO capability_identity_heads
        (organization_id, capability_identity_id, capability_version_id)
       VALUES ('org_atlas', $1, $2)`,
      [identity.rows[0]!.id, capabilityVersionId],
    );
    await observeCapabilityVersion('production', identity.rows[0]!.id, capabilityVersionId);

    const approval = await app.request(
      `/v1/capability-versions/${capabilityVersionId}/safety-approval`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: 'org_atlas' }),
      },
    );
    expect(approval.status).toBe(201);

    const selection = await app.request(
      `/v1/capability-versions/${capabilityVersionId}/selection?organizationId=org_atlas`,
    );
    expect(selection.status).toBe(200);
    const selectionBody = (await selection.json()) as {
      newCompilation: { denials: string[] };
    };
    expect(selectionBody.newCompilation.denials).not.toContain('annotation-not-approved');
    expect(selectionBody.newCompilation.denials).not.toContain('capability-version-not-approved');
  });

  it('grants and revokes an attributed execution-host policy that changes planner eligibility', async () => {
    const capabilityVersionId = 'e'.repeat(64);
    const source = await pool.query<{ id: string }>(
      `INSERT INTO source_documents
        (organization_id, service_id, format, document, document_hash, repository, commit_sha, path)
       VALUES ('org_atlas', 'ledger', 'openapi', '{}', $1, 'https://example.test/ledger',
         'def456', 'openapi.json') RETURNING id`,
      ['f'.repeat(64)],
    );
    const identity = await pool.query<{ id: string }>(
      `INSERT INTO capability_identities
        (organization_id, kind, service_id, operation_id)
       VALUES ('org_atlas', 'openapi', 'ledger', 'recordPayment') RETURNING id`,
    );
    const annotation = await pool.query<{ id: string }>(
      `INSERT INTO manifest_annotations
        (organization_id, capability_identity_id, annotation_hash, owner,
         business_semantics, irreversible_after)
       VALUES ('org_atlas', $1, $2, 'payments', '{}', false) RETURNING id`,
      [identity.rows[0]!.id, '1'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO capability_versions
        (organization_id, capability_version_id, capability_identity_id, source_document_id,
         manifest_annotation_id, capability_fragment_hash, capability_fragment)
       VALUES ('org_atlas', $1, $2, $3, $4, $5, '{}')`,
      [
        capabilityVersionId,
        identity.rows[0]!.id,
        source.rows[0]!.id,
        annotation.rows[0]!.id,
        '2'.repeat(64),
      ],
    );
    await pool.query(
      `INSERT INTO capability_identity_heads
        (organization_id, capability_identity_id, capability_version_id)
       VALUES ('org_atlas', $1, $2)`,
      [identity.rows[0]!.id, capabilityVersionId],
    );
    await observeCapabilityVersion('development', identity.rows[0]!.id, capabilityVersionId);
    await app.request(`/v1/capability-versions/${capabilityVersionId}/safety-approval`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId: 'org_atlas' }),
    });

    for (const token of ['author-token', 'operator-token']) {
      const denied = await app.request(
        `/v1/organizations/org_atlas/environments/development/capability-host-policies/${identity.rows[0]!.id}/ledger.internal`,
        {
          method: 'PUT',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ allowRedirects: false }),
        },
      );
      expect(denied.status).toBe(403);
    }

    const granted = await app.request(
      `/v1/organizations/org_atlas/environments/development/capability-host-policies/${identity.rows[0]!.id}/ledger.internal`,
      {
        method: 'PUT',
        headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
        body: JSON.stringify({ allowRedirects: false }),
      },
    );
    expect(granted.status).toBe(200);
    await expect(granted.json()).resolves.toMatchObject({
      capabilityIdentityId: String(identity.rows[0]!.id),
      capabilityVersionId,
      environmentId: 'development',
      hostname: 'ledger.internal',
      allowRedirects: false,
      approvedBy: 'user_admin',
    });

    const eligible = await app.request(
      `/v1/capability-versions/${capabilityVersionId}/selection?organizationId=org_atlas&environmentId=development`,
    );
    expect(eligible.status).toBe(200);
    const eligibleBody = (await eligible.json()) as { newCompilation: { denials: string[] } };
    expect(eligibleBody.newCompilation.denials).not.toContain('missing-host-policy');

    const suite = await app.request('/v1/organizations/org_atlas/admin-suite', {
      headers: { authorization: 'Bearer operator-token' },
    });
    await expect(suite.json()).resolves.toMatchObject({
      capabilityHostPolicies: [
        {
          capabilityIdentityId: String(identity.rows[0]!.id),
          capabilityVersionId,
          serviceId: 'ledger',
          operationId: 'recordPayment',
          environmentId: 'development',
          hostname: 'ledger.internal',
          allowRedirects: false,
          approvedBy: 'user_admin',
        },
      ],
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          capabilityIdentityId: String(identity.rows[0]!.id),
          capabilityVersionId,
          serviceId: 'ledger',
          operationId: 'recordPayment',
        }),
      ]),
    });

    const revoked = await app.request(
      `/v1/organizations/org_atlas/environments/development/capability-host-policies/${identity.rows[0]!.id}/ledger.internal`,
      { method: 'DELETE', headers: { authorization: 'Bearer admin-token' } },
    );
    expect(revoked.status).toBe(204);

    const ineligible = await app.request(
      `/v1/capability-versions/${capabilityVersionId}/selection?organizationId=org_atlas&environmentId=development`,
    );
    const ineligibleBody = (await ineligible.json()) as { newCompilation: { denials: string[] } };
    expect(ineligibleBody.newCompilation.denials).toContain('missing-host-policy');

    const history = await app.request(
      '/v1/audit-entries?organizationId=org_atlas&environmentId=development',
    );
    const historyBody = (await history.json()) as {
      entries: Array<{ eventType: string; actorId: string | null; details: unknown }>;
    };
    expect(historyBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'capability-host-policy',
          actorId: 'user_admin',
          details: expect.objectContaining({ action: 'granted' }),
        }),
        expect.objectContaining({
          eventType: 'capability-host-policy',
          actorId: 'user_admin',
          details: expect.objectContaining({ action: 'revoked' }),
        }),
      ]),
    );
  });

  it('manages an alias without accepting or returning a worker-held secret value', async () => {
    const rejected = await app.request(
      '/v1/organizations/org_atlas/environments/development/secret-references/billing-api',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ description: 'Billing API credential', value: 'must-not-arrive' }),
      },
    );
    expect(rejected.status).toBe(400);

    const saved = await app.request(
      '/v1/organizations/org_atlas/environments/development/secret-references/billing-api',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ description: 'Billing API credential' }),
      },
    );

    expect(saved.status).toBe(200);
    const savedBody = await saved.json();
    expect(savedBody).toMatchObject({
      alias: 'billing-api',
      environmentId: 'development',
      description: 'Billing API credential',
      valueLocation: 'worker',
    });
    expect(savedBody).not.toHaveProperty('value');

    const suite = await app.request('/v1/organizations/org_atlas/admin-suite', {
      headers: { authorization: 'Bearer admin-token' },
    });
    const suiteBody = (await suite.json()) as { secretReferences: unknown[] };
    expect(suiteBody.secretReferences).toEqual([savedBody]);
  });

  it('updates settings and attributes the change in organization audit history', async () => {
    const response = await app.request('/v1/organizations/org_atlas/settings', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Atlas Payments', defaultEnvironmentId: 'development' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      displayName: 'Atlas Payments',
      defaultEnvironmentId: 'development',
    });

    const history = await app.request('/v1/audit-entries?organizationId=org_atlas', {
      headers: { authorization: 'Bearer admin-token' },
    });
    const body = (await history.json()) as {
      entries: Array<{
        eventType: string;
        actorId: string | null;
        details: Record<string, unknown>;
      }>;
    };
    expect(body.entries).toContainEqual(
      expect.objectContaining({
        eventType: 'organization-settings',
        actorId: 'user_admin',
        details: expect.objectContaining({ outcome: 'succeeded' }),
      }),
    );
  });

  it('rolls back an admin mutation when its audit entry cannot be recorded', async () => {
    await pool.query(`
      CREATE FUNCTION reject_test_admin_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'organization-settings' THEN
          RAISE EXCEPTION 'test audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_admin_audit
        BEFORE INSERT ON audit_entries
        FOR EACH ROW EXECUTE FUNCTION reject_test_admin_audit();
    `);
    const response = await app.request('/v1/organizations/org_atlas/settings', {
      method: 'PATCH',
      headers: {
        authorization: 'Bearer admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Must Roll Back', defaultEnvironmentId: 'development' }),
    });
    expect(response.status).toBe(500);
    await pool.query(`
      DROP TRIGGER reject_test_admin_audit ON audit_entries;
      DROP FUNCTION reject_test_admin_audit();
    `);

    const suite = await app.request('/v1/organizations/org_atlas/admin-suite', {
      headers: { authorization: 'Bearer admin-token' },
    });
    await expect(suite.json()).resolves.toMatchObject({
      organization: {
        settings: { displayName: 'Atlas Payments', defaultEnvironmentId: 'development' },
      },
    });
  });

  it('reassigns a role and applies it to the next server authorization decision', async () => {
    const changed = await app.request(
      '/v1/organizations/org_atlas/users/user_operator/membership',
      {
        method: 'PUT',
        headers: {
          authorization: 'Bearer admin-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ role: 'author' }),
      },
    );
    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toEqual({ userId: 'user_operator', role: 'author' });

    const authorizer = createMembershipAuthorizer(pool, credentials);
    await expect(
      authorizer.authorize({
        authorizationHeader: 'Bearer operator-token',
        organizationId: 'org_atlas',
        action: 'draft-workflow',
      }),
    ).resolves.toEqual({ actorId: 'user_operator', role: 'author' });
    await expect(
      authorizer.authorize({
        authorizationHeader: 'Bearer operator-token',
        organizationId: 'org_atlas',
        action: 'retry-failed-step',
      }),
    ).resolves.toBeNull();
    const audit = await pool.query<{ details: Record<string, unknown> }>(
      "SELECT details FROM audit_entries WHERE event_type='membership' AND subject_id='user_operator' ORDER BY id DESC LIMIT 1",
    );
    expect(audit.rows[0]?.details).toMatchObject({ role: 'author', outcome: 'succeeded' });
  });
});
