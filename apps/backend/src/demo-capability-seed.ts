import {
  demoCapabilitySources,
  demoExecutionHostname,
  demoEstateRevision,
  type DemoCapabilitySource,
  type ThirdPartyDemoMode,
} from '@atlas/demo-estate';
import { Pool } from 'pg';

import { discoverCapabilities } from './capability-ingestion.js';
import { loadBackendConfig } from './config.js';
import { seedDemoEnvironmentPolicies } from './demo-environment-policy.js';
import { usesSampleDemoData } from './demo-profile.js';

const organizationId = 'org_atlas';
const repository = 'https://github.com/jash33/Atlas-public';
const commit = demoEstateRevision;
const sourceBaseUrl = 'http://mock-specs:4100';
const environments = ['development', 'production'];

async function hasCurrentDemoRegistration(
  pool: Pool,
  source: DemoCapabilitySource,
  environmentId: string,
) {
  const operationIds = source.annotations.map(({ capability }) => capability.operationId);
  const result = await pool.query<{ registered: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM capability_source_registrations registration
       WHERE registration.organization_id = $1 AND registration.service_id = $2
         AND registration.environment_id = $4
         AND registration.discovery_input #>> '{source,commit}' = $3
         AND (
           SELECT count(*)
           FROM environment_capability_observations head
           JOIN capability_identities identity ON identity.id = head.capability_identity_id
           JOIN capability_versions version
             ON version.organization_id = head.organization_id
            AND version.capability_version_id = head.capability_version_id
           JOIN source_documents document ON document.id = version.source_document_id
           WHERE head.organization_id = registration.organization_id
             AND head.environment_id = registration.environment_id
             AND identity.service_id = registration.service_id
             AND identity.operation_id = ANY($5)
             AND document.commit_sha = $3
         ) = $6
     ) AS registered`,
    [
      organizationId,
      source.serviceId,
      demoEstateRevision,
      environmentId,
      operationIds,
      operationIds.length,
    ],
  );
  return result.rows[0]?.registered === true;
}

function discoveryInput(
  source: DemoCapabilitySource,
  environmentId: string,
  document: Record<string, unknown>,
) {
  return {
    organizationId,
    serviceId: source.serviceId,
    trigger: 'repository-push',
    environmentId,
    source: {
      format: source.format,
      document,
      url: `${sourceBaseUrl}/specs/${source.specFile}`,
      repository,
      commit,
      path: `apps/mock-services/specs/${source.specFile}`,
    },
    manifest: {
      source: {
        repository,
        commit,
        path: `apps/mock-services/manifests/${source.serviceId}.atlas.json`,
      },
      annotations: source.annotations,
    },
  };
}

async function discoverMissingSources(pool: Pool) {
  for (const source of demoCapabilitySources) {
    const response = await fetch(`${sourceBaseUrl}/specs/${source.specFile}`);
    if (!response.ok) {
      throw new Error(`Could not load demo capability source ${source.specFile}`);
    }
    const document = (await response.json()) as Record<string, unknown>;
    for (const environmentId of environments) {
      if (await hasCurrentDemoRegistration(pool, source, environmentId)) continue;
      await discoverCapabilities(pool, discoveryInput(source, environmentId, document));
    }
  }
}

async function approveDemoEstate(pool: Pool, modes: Readonly<Record<string, ThirdPartyDemoMode>>) {
  const serviceIds = demoCapabilitySources.map(({ serviceId }) => serviceId);
  await pool.query('BEGIN');
  try {
    await pool.query(
      `INSERT INTO manifest_annotation_approvals
        (organization_id, manifest_annotation_id, approved_by)
       SELECT DISTINCT version.organization_id, version.manifest_annotation_id, 'atlas-admin'
       FROM environment_capability_observations head
       JOIN capability_versions version
         ON version.organization_id = head.organization_id
        AND version.capability_version_id = head.capability_version_id
       JOIN capability_identities identity ON identity.id = version.capability_identity_id
       WHERE version.organization_id = $1
         AND identity.service_id = ANY($2)
         AND version.manifest_annotation_id IS NOT NULL
       ON CONFLICT (organization_id, manifest_annotation_id) DO UPDATE
       SET revoked_at = NULL`,
      [organizationId, serviceIds],
    );
    await pool.query(
      `INSERT INTO capability_approvals
       (organization_id, capability_version_id, approved_by)
       SELECT DISTINCT head.organization_id, head.capability_version_id, 'atlas-admin'
       FROM environment_capability_observations head
       JOIN capability_identities identity ON identity.id = head.capability_identity_id
       WHERE head.organization_id = $1 AND identity.service_id = ANY($2)
       ON CONFLICT (organization_id, capability_version_id) DO UPDATE
       SET revoked_at = NULL`,
      [organizationId, serviceIds],
    );
    for (const source of demoCapabilitySources) {
      for (const environmentId of environments) {
        await pool.query(
          `INSERT INTO capability_host_policies
          (organization_id, capability_identity_id, environment_id, hostname, approved_by)
         SELECT head.organization_id, head.capability_identity_id, $3, $4, 'atlas-admin'
         FROM environment_capability_observations head
         JOIN capability_identities identity ON identity.id = head.capability_identity_id
         WHERE head.organization_id = $1 AND identity.service_id = $2
           AND head.environment_id = $3
         ON CONFLICT (organization_id, capability_identity_id, environment_id, hostname)
         DO UPDATE SET revoked_at = NULL`,
          [
            organizationId,
            source.serviceId,
            environmentId,
            demoExecutionHostname(source, modes[source.serviceId] ?? 'contract-faithful-rehearsal'),
          ],
        );
      }
    }
    await seedDemoEnvironmentPolicies(pool, organizationId, environments);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

const config = loadBackendConfig();
if (usesSampleDemoData(config.demoProfile)) {
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await discoverMissingSources(pool);
    await approveDemoEstate(pool, {
      stripe: config.stripeDemoMode,
      slack: config.slackDemoMode,
      hubspot: config.hubspotDemoMode,
    });
  } finally {
    await pool.end();
  }
}
