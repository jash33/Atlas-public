exports.up = (pgm) => {
  pgm.sql('DROP INDEX capability_identity_unique');
  pgm.sql(`
    CREATE TEMP TABLE async_identity_merge ON COMMIT DROP AS
    SELECT id AS duplicate_id,
      min(id) OVER (
        PARTITION BY organization_id, channel_address, message_key
      ) AS keeper_id
    FROM capability_identities
    WHERE kind = 'asyncapi';
    DELETE FROM async_identity_merge WHERE duplicate_id = keeper_id;

    UPDATE manifest_annotations annotation
    SET annotation_hash = md5(annotation.annotation_hash::text || annotation.id::text) ||
      md5(annotation.id::text || annotation.annotation_hash::text)
    FROM async_identity_merge merge
    WHERE annotation.capability_identity_id = merge.duplicate_id;
    UPDATE manifest_annotations annotation
    SET capability_identity_id = merge.keeper_id
    FROM async_identity_merge merge
    WHERE annotation.capability_identity_id = merge.duplicate_id;
    UPDATE manifest_annotations annotation
    SET compensated_by_identity_id = merge.keeper_id
    FROM async_identity_merge merge
    WHERE annotation.compensated_by_identity_id = merge.duplicate_id;

    UPDATE capability_versions version
    SET capability_identity_id = merge.keeper_id
    FROM async_identity_merge merge
    WHERE version.capability_identity_id = merge.duplicate_id;
    UPDATE compatibility_diffs diff
    SET capability_identity_id = merge.keeper_id
    FROM async_identity_merge merge
    WHERE diff.capability_identity_id = merge.duplicate_id;

    INSERT INTO environment_capability_observations
      (organization_id, environment_id, capability_identity_id, capability_version_id,
       observed_at, availability_status, freshness_status, status_reason, status_changed_at,
       source_resolution_status)
    SELECT DISTINCT ON (observation.organization_id, observation.environment_id, merge.keeper_id)
      observation.organization_id, observation.environment_id, merge.keeper_id,
      observation.capability_version_id, observation.observed_at,
      observation.availability_status, observation.freshness_status, observation.status_reason,
      observation.status_changed_at, observation.source_resolution_status
    FROM environment_capability_observations observation
    JOIN async_identity_merge merge ON merge.duplicate_id = observation.capability_identity_id
    ORDER BY observation.organization_id, observation.environment_id, merge.keeper_id,
      observation.observed_at DESC
    ON CONFLICT (organization_id, environment_id, capability_identity_id) DO UPDATE
    SET capability_version_id = EXCLUDED.capability_version_id,
      observed_at = EXCLUDED.observed_at,
      availability_status = EXCLUDED.availability_status,
      freshness_status = EXCLUDED.freshness_status,
      status_reason = EXCLUDED.status_reason,
      status_changed_at = EXCLUDED.status_changed_at,
      source_resolution_status = EXCLUDED.source_resolution_status
    WHERE EXCLUDED.observed_at >= environment_capability_observations.observed_at;
    DELETE FROM environment_capability_observations observation
    USING async_identity_merge merge
    WHERE observation.capability_identity_id = merge.duplicate_id;

    INSERT INTO environment_capability_source_claims
      (organization_id, environment_id, capability_identity_id, source_key,
       capability_version_id, source_document_id, active, observed_at)
    SELECT DISTINCT ON (
      claim.organization_id, claim.environment_id, merge.keeper_id, claim.source_key
    ) claim.organization_id, claim.environment_id, merge.keeper_id, claim.source_key,
      claim.capability_version_id, claim.source_document_id, claim.active, claim.observed_at
    FROM environment_capability_source_claims claim
    JOIN async_identity_merge merge ON merge.duplicate_id = claim.capability_identity_id
    ORDER BY claim.organization_id, claim.environment_id, merge.keeper_id, claim.source_key,
      claim.observed_at DESC
    ON CONFLICT (organization_id, environment_id, capability_identity_id, source_key) DO UPDATE
    SET capability_version_id = EXCLUDED.capability_version_id,
      source_document_id = EXCLUDED.source_document_id,
      active = EXCLUDED.active, observed_at = EXCLUDED.observed_at
    WHERE EXCLUDED.observed_at >= environment_capability_source_claims.observed_at;
    DELETE FROM environment_capability_source_claims claim
    USING async_identity_merge merge
    WHERE claim.capability_identity_id = merge.duplicate_id;

    INSERT INTO environment_capability_source_authorities
      (organization_id, environment_id, capability_identity_id, source_key,
       designated_by, designated_at)
    SELECT DISTINCT ON (authority.organization_id, authority.environment_id, merge.keeper_id)
      authority.organization_id, authority.environment_id, merge.keeper_id,
      authority.source_key, authority.designated_by, authority.designated_at
    FROM environment_capability_source_authorities authority
    JOIN async_identity_merge merge ON merge.duplicate_id = authority.capability_identity_id
    ORDER BY authority.organization_id, authority.environment_id, merge.keeper_id,
      authority.designated_at DESC
    ON CONFLICT (organization_id, environment_id, capability_identity_id) DO UPDATE
    SET source_key = EXCLUDED.source_key, designated_by = EXCLUDED.designated_by,
      designated_at = EXCLUDED.designated_at
    WHERE EXCLUDED.designated_at >= environment_capability_source_authorities.designated_at;
    DELETE FROM environment_capability_source_authorities authority
    USING async_identity_merge merge
    WHERE authority.capability_identity_id = merge.duplicate_id;

    INSERT INTO capability_host_policies
      (organization_id, capability_identity_id, environment_id, hostname,
       approved_by, approved_at, revoked_at)
    SELECT DISTINCT ON (
      policy.organization_id, merge.keeper_id, policy.environment_id, policy.hostname
    ) policy.organization_id, merge.keeper_id, policy.environment_id, policy.hostname,
      policy.approved_by, policy.approved_at, policy.revoked_at
    FROM capability_host_policies policy
    JOIN async_identity_merge merge ON merge.duplicate_id = policy.capability_identity_id
    ORDER BY policy.organization_id, merge.keeper_id, policy.environment_id, policy.hostname,
      policy.approved_at DESC
    ON CONFLICT (organization_id, capability_identity_id, environment_id, hostname) DO UPDATE
    SET approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
      revoked_at = EXCLUDED.revoked_at
    WHERE EXCLUDED.approved_at >= capability_host_policies.approved_at;
    DELETE FROM capability_host_policies policy
    USING async_identity_merge merge
    WHERE policy.capability_identity_id = merge.duplicate_id;

    DELETE FROM capability_identity_heads head
    USING async_identity_merge merge
    WHERE head.capability_identity_id = merge.duplicate_id;
    INSERT INTO capability_identity_heads
      (organization_id, capability_identity_id, capability_version_id)
    SELECT DISTINCT ON (version.organization_id, merge.keeper_id)
      version.organization_id, merge.keeper_id, version.capability_version_id
    FROM async_identity_merge merge
    JOIN capability_versions version ON version.capability_identity_id = merge.keeper_id
    ORDER BY version.organization_id, merge.keeper_id,
      version.published_at DESC, version.capability_version_id DESC
    ON CONFLICT (organization_id, capability_identity_id) DO UPDATE
    SET capability_version_id = EXCLUDED.capability_version_id;

    DELETE FROM capability_identities identity
    USING async_identity_merge merge
    WHERE identity.id = merge.duplicate_id;
  `);
  pgm.sql(`CREATE UNIQUE INDEX capability_http_identity_unique
    ON capability_identities (organization_id, service_id, operation_id)
    WHERE kind = 'openapi'`);
  pgm.sql(`CREATE UNIQUE INDEX capability_event_identity_unique
    ON capability_identities (organization_id, channel_address, message_key)
    WHERE kind = 'asyncapi'`);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX capability_event_identity_unique');
  pgm.sql('DROP INDEX capability_http_identity_unique');
  pgm.sql(`CREATE UNIQUE INDEX capability_identity_unique
    ON capability_identities (
      organization_id, kind, service_id, operation_id,
      COALESCE(channel_address, ''), COALESCE(message_key, '')
    )`);
};
