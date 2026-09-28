import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { WorkflowSandboxTargetBindingWire } from '@atlas/demo-estate';
import { canonicalJson } from './capability-versioning.js';

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const jsonObject = z.record(z.string(), z.unknown());
const resourceControlInput = z
  .object({
    mode: z.enum(['replace', 'merge']),
    resources: z.array(
      z
        .object({
          service: z.string().min(1),
          collection: z.string().min(1),
          id: z.string().min(1),
          document: z.unknown(),
        })
        .strict(),
    ),
  })
  .strict();
const setupAssumption = z
  .object({
    path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).min(1),
    equals: z.unknown(),
  })
  .strict();
const controlPaths = z
  .object({
    resources: z.string().startsWith('/'),
    faults: z.string().startsWith('/'),
    observations: z.string().startsWith('/'),
  })
  .strict();

export const capabilitySandboxTargetSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    capabilityVersionId: z.string().min(1),
    targetKey: identifier,
    baseUrl: z.string().url(),
    healthPath: z.string().startsWith('/').default('/health'),
    controlPaths: controlPaths.default({
      resources: '/__control/resources',
      faults: '/__control/faults',
      observations: '/__control/observations',
    }),
    secretAlias: z.string().min(1).nullable().default(null),
  })
  .strict();

export const capabilityTestDataProfileSchema = z
  .object({
    organizationId: z.string().min(1),
    capabilityVersionId: z.string().min(1),
    profileKey: identifier,
    inputs: jsonObject,
    targetState: resourceControlInput,
    setupAssumptions: z.array(setupAssumption).min(1),
  })
  .strict();

export const sandboxTargetSelectionSchema = z
  .object({
    capabilityVersionId: z.string().min(1),
    targetKey: identifier,
    targetRevision: z.number().int().positive(),
    testDataProfileKey: identifier,
    testDataVersion: z.number().int().positive(),
  })
  .strict();

export type WorkflowSandboxTargetBinding = Readonly<WorkflowSandboxTargetBindingWire>;

export class InvalidSandboxTarget extends TypeError {}

const connectedSandboxSchema = z
  .object({
    healthPath: z.string().startsWith('/'),
    controlPaths,
    inputs: jsonObject,
    targetState: resourceControlInput,
    setupAssumptions: z.array(setupAssumption).min(1),
  })
  .strict();

/** A connected demo can publish explicit test controls; ordinary APIs have no implicit sandbox. */
export async function installConnectedSandboxTargets(
  client: Pick<PoolClient, 'query'>,
  input: {
    organizationId: string;
    environmentId: string;
    applicationUrl: string;
    capabilityVersionIds: readonly string[];
    metadata: unknown;
    actorId: string;
  },
) {
  if (input.metadata === undefined) return;
  const metadata = connectedSandboxSchema.parse(input.metadata);
  const url = parseTargetUrl(input.applicationUrl);
  for (const path of [metadata.healthPath, ...Object.values(metadata.controlPaths)]) {
    if (new URL(path, url).origin !== url.origin) {
      throw new InvalidSandboxTarget(
        'Connected sandbox controls must remain on the application origin',
      );
    }
  }
  for (const capabilityVersionId of input.capabilityVersionIds) {
    const parameters = [input.organizationId, capabilityVersionId, input.environmentId];
    const previous = await client.query<{
      base_url: string;
      health_path: string;
      control_paths: unknown;
      inputs: unknown;
      target_state: unknown;
      setup_assumptions: unknown;
    }>(
      `SELECT target.base_url, target.health_path, target.control_paths,
              profile.inputs, profile.target_state, profile.setup_assumptions
       FROM capability_sandbox_target_revisions target
       JOIN capability_test_data_profile_versions profile
         ON profile.organization_id = target.organization_id
        AND profile.capability_version_id = target.capability_version_id
        AND profile.profile_key = 'connected-source'
       WHERE target.organization_id = $1 AND target.capability_version_id = $2
         AND target.environment_id = $3 AND target.target_key = 'connected-source'
       ORDER BY target.revision DESC, profile.version DESC LIMIT 1`,
      parameters,
    );
    const current = previous.rows[0];
    if (
      current &&
      current.base_url === url.href.replace(/\/$/, '') &&
      current.health_path === metadata.healthPath &&
      canonicalJson(current.control_paths) === canonicalJson(metadata.controlPaths) &&
      canonicalJson(current.inputs) === canonicalJson(metadata.inputs) &&
      canonicalJson(current.target_state) === canonicalJson(metadata.targetState) &&
      canonicalJson(current.setup_assumptions) === canonicalJson(metadata.setupAssumptions)
    )
      continue;
    await client.query(
      `INSERT INTO capability_sandbox_target_revisions
        (organization_id, capability_version_id, environment_id, target_key, revision,
         base_url, hostname, health_path, control_paths, secret_alias, configured_by)
       SELECT $1, $2, $3, 'connected-source', COALESCE(MAX(revision), 0) + 1, $4, $5, $6, $7, NULL, $8
       FROM capability_sandbox_target_revisions
       WHERE organization_id = $1 AND capability_version_id = $2 AND target_key = 'connected-source'`,
      [
        ...parameters,
        url.href.replace(/\/$/, ''),
        url.hostname,
        metadata.healthPath,
        JSON.stringify(metadata.controlPaths),
        input.actorId,
      ],
    );
    await client.query(
      `INSERT INTO capability_test_data_profile_versions
        (organization_id, capability_version_id, profile_key, version, inputs, target_state,
         setup_assumptions, safe_for_non_production, configured_by)
       SELECT $1, $2, 'connected-source', COALESCE(MAX(version), 0) + 1, $3, $4, $5, true, $6
       FROM capability_test_data_profile_versions
       WHERE organization_id = $1 AND capability_version_id = $2 AND profile_key = 'connected-source'`,
      [
        input.organizationId,
        capabilityVersionId,
        JSON.stringify(metadata.inputs),
        JSON.stringify(metadata.targetState),
        JSON.stringify(metadata.setupAssumptions),
        input.actorId,
      ],
    );
  }
}

export async function defaultConnectedSandboxSelections(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  environmentId: string,
  capabilityVersionIds: readonly string[],
) {
  const result = await pool.query<{
    capability_version_id: string;
    target_revision: number;
    test_data_version: number;
  }>(
    `SELECT target.capability_version_id, max(target.revision) AS target_revision,
            max(profile.version) AS test_data_version
     FROM capability_sandbox_target_revisions target
     JOIN capability_test_data_profile_versions profile
       ON profile.organization_id = target.organization_id
      AND profile.capability_version_id = target.capability_version_id
      AND profile.profile_key = 'connected-source'
     WHERE target.organization_id = $1 AND target.environment_id = $2
       AND target.target_key = 'connected-source'
       AND target.capability_version_id = ANY($3::text[])
     GROUP BY target.capability_version_id`,
    [organizationId, environmentId, capabilityVersionIds],
  );
  return result.rows.map((row) => ({
    capabilityVersionId: row.capability_version_id.trim(),
    targetKey: 'connected-source',
    targetRevision: row.target_revision,
    testDataProfileKey: 'connected-source',
    testDataVersion: row.test_data_version,
  }));
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function parseTargetUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new InvalidSandboxTarget('Sandbox targets require credential-free HTTP(S) URLs');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

function sameOrigin(left: string, right: string | null) {
  if (!right) return false;
  try {
    return new URL(left).origin.toLowerCase() === new URL(right).origin.toLowerCase();
  } catch {
    return true;
  }
}

export async function configureCapabilitySandboxTarget(pool: Pool, raw: unknown, actorId: string) {
  const input = capabilitySandboxTargetSchema.parse(raw);
  const url = parseTargetUrl(input.baseUrl);
  return transaction(pool, async (client) => {
    const capability = await client.query<{
      source_type: unknown;
      environment_kind: string;
      execution_base_url: string | null;
    }>(
      `SELECT annotation.business_semantics ->> 'sourceType' AS source_type,
              environment.kind AS environment_kind,
              (SELECT execution.base_url FROM capability_execution_bindings execution
               WHERE execution.organization_id = version.organization_id
                 AND execution.environment_id = $3
                 AND execution.capability_identity_id = version.capability_identity_id) AS execution_base_url
       FROM capability_versions version
       JOIN manifest_annotations annotation ON annotation.id = version.manifest_annotation_id
       JOIN environments environment ON environment.organization_id = version.organization_id
         AND environment.id = $3
       WHERE version.organization_id = $1 AND version.capability_version_id = $2
       FOR UPDATE OF version`,
      [input.organizationId, input.capabilityVersionId, input.environmentId],
    );
    if (capability.rows[0]?.source_type !== 'internal') {
      throw new InvalidSandboxTarget('Only internal capabilities can use customer sandbox targets');
    }
    if (!['development', 'production'].includes(capability.rows[0].environment_kind)) {
      throw new InvalidSandboxTarget('Sandbox targets require a supported Atlas environment');
    }
    if (sameOrigin(url.href, capability.rows[0].execution_base_url)) {
      throw new InvalidSandboxTarget('Sandbox targets cannot use the environment runtime service');
    }
    if (input.secretAlias) {
      const reference = await client.query(
        `SELECT 1 FROM secret_references
         WHERE organization_id = $1 AND environment_id = $2 AND alias = $3`,
        [input.organizationId, input.environmentId, input.secretAlias],
      );
      if (!reference.rows[0]) {
        throw new InvalidSandboxTarget('Secret alias is not registered for the target environment');
      }
    }
    const allowedHost = await client.query(
      `SELECT 1
       FROM capability_versions version
       JOIN capability_host_policies policy
         ON policy.organization_id = version.organization_id
        AND policy.capability_identity_id = version.capability_identity_id
       WHERE version.organization_id = $1 AND version.capability_version_id = $2
         AND policy.environment_id = $3 AND policy.hostname = $4 AND policy.revoked_at IS NULL`,
      [input.organizationId, input.capabilityVersionId, input.environmentId, url.hostname],
    );
    if (!allowedHost.rows[0]) {
      throw new InvalidSandboxTarget('Sandbox target hostname is not allowed by capability policy');
    }
    const inserted = await client.query<{ revision: number; configured_at: Date }>(
      `INSERT INTO capability_sandbox_target_revisions
        (organization_id, capability_version_id, environment_id, target_key, revision,
         base_url, hostname, health_path, control_paths, secret_alias, configured_by)
       SELECT $1, $2, $3, $4, COALESCE(MAX(revision), 0) + 1, $5, $6, $7, $8, $9, $10
       FROM capability_sandbox_target_revisions
       WHERE organization_id = $1 AND capability_version_id = $2 AND target_key = $4
       RETURNING revision, configured_at`,
      [
        input.organizationId,
        input.capabilityVersionId,
        input.environmentId,
        input.targetKey,
        url.toString().replace(/\/$/, ''),
        url.hostname,
        input.healthPath,
        JSON.stringify(input.controlPaths),
        input.secretAlias,
        actorId,
      ],
    );
    return {
      ...input,
      baseUrl: url.toString().replace(/\/$/, ''),
      hostname: url.hostname,
      revision: inserted.rows[0]!.revision,
      configuredBy: actorId,
      configuredAt: inserted.rows[0]!.configured_at.toISOString(),
    };
  });
}

export async function configureCapabilityTestDataProfile(
  pool: Pool,
  raw: unknown,
  actorId: string,
) {
  const input = capabilityTestDataProfileSchema.parse(raw);
  return transaction(pool, async (client) => {
    const capability = await client.query(
      `SELECT 1 FROM capability_versions
       WHERE organization_id = $1 AND capability_version_id = $2
       FOR UPDATE`,
      [input.organizationId, input.capabilityVersionId],
    );
    if (!capability.rows[0]) throw new InvalidSandboxTarget('Capability version was not found');
    const inserted = await client.query<{ version: number; configured_at: Date }>(
      `INSERT INTO capability_test_data_profile_versions
        (organization_id, capability_version_id, profile_key, version, inputs, target_state,
         setup_assumptions, safe_for_non_production, configured_by)
       SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4, $5, $6, true, $7
       FROM capability_test_data_profile_versions
       WHERE organization_id = $1 AND capability_version_id = $2 AND profile_key = $3
       RETURNING version, configured_at`,
      [
        input.organizationId,
        input.capabilityVersionId,
        input.profileKey,
        JSON.stringify(input.inputs),
        JSON.stringify(input.targetState),
        JSON.stringify(input.setupAssumptions),
        actorId,
      ],
    );
    return {
      ...input,
      safeForNonProduction: true,
      version: inserted.rows[0]!.version,
      configuredBy: actorId,
      configuredAt: inserted.rows[0]!.configured_at.toISOString(),
    };
  });
}

export async function resolveSandboxTargetBindings(
  pool: Pick<Pool, 'query'>,
  organizationId: string,
  environmentId: string,
  selections: readonly z.infer<typeof sandboxTargetSelectionSchema>[],
): Promise<WorkflowSandboxTargetBinding[]> {
  const seen = new Set<string>();
  const bindings: WorkflowSandboxTargetBinding[] = [];
  for (const selection of selections) {
    if (seen.has(selection.capabilityVersionId)) {
      throw new InvalidSandboxTarget('A capability can select only one sandbox target');
    }
    seen.add(selection.capabilityVersionId);
    const result = await pool.query<{
      base_url: string;
      hostname: string;
      health_path: string;
      control_paths: WorkflowSandboxTargetBinding['controlPaths'];
      secret_alias: string | null;
      inputs: Record<string, unknown>;
      target_state: WorkflowSandboxTargetBinding['targetState'];
      setup_assumptions: WorkflowSandboxTargetBinding['setupAssumptions'];
      safe_for_non_production: boolean;
      host_allowed: boolean;
      secret_registered: boolean;
      execution_base_url: string | null;
      connected_development_sandbox: boolean;
    }>(
      `SELECT target.base_url, target.hostname, target.health_path, target.control_paths,
              target.secret_alias, profile.inputs, profile.target_state,
              profile.setup_assumptions, profile.safe_for_non_production,
              EXISTS (
                SELECT 1 FROM capability_versions version
                JOIN source_documents source ON source.id = version.source_document_id
                JOIN manifest_annotations annotation ON annotation.id = version.manifest_annotation_id
                JOIN environments environment ON environment.organization_id = version.organization_id
                  AND environment.id = target.environment_id
                WHERE version.organization_id = target.organization_id
                  AND version.capability_version_id = target.capability_version_id
                  AND environment.kind = 'development'
                  AND annotation.business_semantics ->> 'sourceType' = 'internal'
                  AND target.target_key = 'connected-source' AND profile.profile_key = 'connected-source'
                  AND source.document -> 'x-atlas-sandbox' = jsonb_build_object(
                    'healthPath', target.health_path, 'controlPaths', target.control_paths,
                    'inputs', profile.inputs, 'targetState', profile.target_state,
                    'setupAssumptions', profile.setup_assumptions)
              ) AS connected_development_sandbox,
              EXISTS (
                SELECT 1 FROM capability_versions version
                JOIN capability_host_policies policy
                  ON policy.organization_id = version.organization_id
                 AND policy.capability_identity_id = version.capability_identity_id
                WHERE version.organization_id = target.organization_id
                  AND version.capability_version_id = target.capability_version_id
                  AND policy.environment_id = target.environment_id
                  AND policy.hostname = target.hostname AND policy.revoked_at IS NULL
              ) AS host_allowed,
              (target.secret_alias IS NULL OR EXISTS (
                SELECT 1 FROM secret_references reference
                WHERE reference.organization_id = target.organization_id
                  AND reference.environment_id = target.environment_id
                  AND reference.alias = target.secret_alias
              )) AS secret_registered,
              (SELECT execution.base_url
               FROM capability_versions version
               JOIN capability_execution_bindings execution
                 ON execution.organization_id = version.organization_id
                AND execution.environment_id = target.environment_id
                AND execution.capability_identity_id = version.capability_identity_id
               WHERE version.organization_id = target.organization_id
                 AND version.capability_version_id = target.capability_version_id) AS execution_base_url
       FROM capability_sandbox_target_revisions target
       JOIN capability_test_data_profile_versions profile
         ON profile.organization_id = target.organization_id
        AND profile.capability_version_id = target.capability_version_id
       WHERE target.organization_id = $1 AND target.environment_id = $2
         AND target.capability_version_id = $3 AND target.target_key = $4
         AND target.revision = $5 AND profile.profile_key = $6 AND profile.version = $7`,
      [
        organizationId,
        environmentId,
        selection.capabilityVersionId,
        selection.targetKey,
        selection.targetRevision,
        selection.testDataProfileKey,
        selection.testDataVersion,
      ],
    );
    const row = result.rows[0];
    if (!row || !row.safe_for_non_production || !row.host_allowed || !row.secret_registered) {
      throw new InvalidSandboxTarget(
        'Sandbox target or test-data profile is missing or no longer valid',
      );
    }
    if (sameOrigin(row.base_url, row.execution_base_url) && !row.connected_development_sandbox) {
      throw new InvalidSandboxTarget('Sandbox targets cannot use the environment runtime service');
    }
    bindings.push({
      ...selection,
      baseUrl: row.base_url,
      hostname: row.hostname,
      healthPath: row.health_path,
      controlPaths: row.control_paths,
      secretAlias: row.secret_alias,
      inputs: row.inputs,
      targetState: row.target_state,
      setupAssumptions: row.setup_assumptions,
    });
  }
  return bindings;
}
