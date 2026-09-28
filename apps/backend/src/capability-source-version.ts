import type { PoolClient } from 'pg';

import type { DiscoveredCapability, JsonObject } from './capability-documents.js';
import { canonicalJson, sha256 } from './capability-versioning.js';

/** Save source history only. Callers must separately establish any deployed observation. */
export async function saveSourceCapabilityVersion(
  client: Pick<PoolClient, 'query'>,
  input: {
    organizationId: string;
    identityId: string;
    sourceDocumentId: string;
    manifestSourceDocumentId: string | null;
    annotationId: string | null;
    annotationHash: string;
    capability: DiscoveredCapability;
    fragment?: JsonObject;
  },
) {
  const fragment = input.fragment ?? {
    identity: input.capability.identity,
    ...input.capability.fragment,
  };
  const fragmentHash = sha256(canonicalJson(fragment));
  const capabilityVersionId = sha256(fragmentHash + input.annotationHash);
  await client.query(
    `INSERT INTO capability_versions
    (organization_id, capability_version_id, capability_identity_id, source_document_id,
     manifest_annotation_id, capability_fragment_hash, capability_fragment)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id, capability_version_id) DO NOTHING`,
    [
      input.organizationId,
      capabilityVersionId,
      input.identityId,
      input.sourceDocumentId,
      input.annotationId,
      fragmentHash,
      fragment,
    ],
  );
  await client.query(
    `INSERT INTO capability_version_provenance
    (organization_id, capability_version_id, source_document_id, manifest_source_document_id)
    VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [
      input.organizationId,
      capabilityVersionId,
      input.sourceDocumentId,
      input.manifestSourceDocumentId,
    ],
  );
  return capabilityVersionId;
}
