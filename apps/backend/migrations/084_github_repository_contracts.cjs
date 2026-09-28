exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE github_repository_connections (
      id uuid PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
      repository text NOT NULL, branches text[] NOT NULL CHECK (cardinality(branches) > 0),
      services jsonb NOT NULL, created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      next_check_at timestamptz NOT NULL DEFAULT now(),
      last_checked_at timestamptz, last_error text,
      enabled boolean NOT NULL DEFAULT true,
      ingestion_requested boolean NOT NULL DEFAULT false, ingestion_generation integer NOT NULL DEFAULT 0,
      UNIQUE (organization_id, repository)
    );
    CREATE TABLE repository_analysis_runs (
      id bigserial PRIMARY KEY, connection_id uuid NOT NULL REFERENCES github_repository_connections(id),
      target_key text NOT NULL, branch text NOT NULL, pull_request integer,
      commit_sha text NOT NULL, base_commit_sha text NOT NULL DEFAULT '', baseline_hash text NOT NULL,
      extractor_version text NOT NULL, model text NOT NULL, prompt_version text NOT NULL,
      ingestion_generation integer NOT NULL DEFAULT 0,
      status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'outdated')),
      attempt integer NOT NULL DEFAULT 1, started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz, retry_at timestamptz, generated_documents jsonb,
      document_hash char(64), request_response_hash char(64),
      diagnostics jsonb NOT NULL DEFAULT '[]',
      UNIQUE (connection_id, target_key, commit_sha, base_commit_sha, baseline_hash, extractor_version, model, prompt_version, ingestion_generation)
    );
    CREATE TABLE repository_contract_candidates (
      id uuid PRIMARY KEY, run_id bigint NOT NULL UNIQUE REFERENCES repository_analysis_runs(id),
      connection_id uuid NOT NULL REFERENCES github_repository_connections(id),
      branch text NOT NULL, commit_sha text NOT NULL, base_commit_sha text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('initial', 'periodic', 'preview')),
      status text NOT NULL CHECK (status IN ('review', 'preview', 'accepted', 'rejected', 'superseded')),
      candidate_hash char(64) NOT NULL, request_response_hash char(64) NOT NULL,
      baseline_hash text NOT NULL, documents jsonb NOT NULL, changes jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), reviewed_by text, reviewed_at timestamptz,
      CHECK ((status IN ('accepted', 'rejected')) = (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
    );
    CREATE TABLE repository_analysis_targets (
      connection_id uuid NOT NULL REFERENCES github_repository_connections(id), target_key text NOT NULL,
      last_successful_run_id bigint REFERENCES repository_analysis_runs(id), last_successful_commit text,
      last_successful_at timestamptz, last_attempt_at timestamptz, last_error text,
      PRIMARY KEY (connection_id, target_key)
    );
    CREATE TABLE repository_accepted_contracts (
      connection_id uuid NOT NULL REFERENCES github_repository_connections(id), branch text NOT NULL,
      service_id text NOT NULL, candidate_id uuid NOT NULL REFERENCES repository_contract_candidates(id),
      openapi jsonb NOT NULL, arazzo jsonb, structured_contract jsonb NOT NULL, descriptions jsonb NOT NULL,
      capability_versions jsonb NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (connection_id, branch, service_id)
    );
    CREATE TABLE repository_operation_dependencies (
      run_id bigint NOT NULL REFERENCES repository_analysis_runs(id), service_id text NOT NULL,
      operation_id text NOT NULL, path text NOT NULL, function_name text NOT NULL,
      start_line integer NOT NULL CHECK (start_line > 0), end_line integer NOT NULL CHECK (end_line >= start_line),
      blob_sha text NOT NULL, role text NOT NULL,
      PRIMARY KEY (run_id, service_id, operation_id, path, start_line, end_line)
    );
    CREATE TABLE capability_architecture_versions (
      id bigserial PRIMARY KEY, organization_id text NOT NULL REFERENCES organizations(id),
      source_key text NOT NULL, service_id text NOT NULL, document_hash char(64) NOT NULL,
      document_yaml text NOT NULL, source_url text NOT NULL, commit_sha text,
      capability_versions jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (organization_id, source_key, service_id, document_hash)
    );
    CREATE TABLE capability_architecture_selections (
      organization_id text NOT NULL REFERENCES organizations(id), scope text NOT NULL,
      service_id text NOT NULL, source_key text NOT NULL,
      version_id bigint NOT NULL REFERENCES capability_architecture_versions(id),
      PRIMARY KEY (organization_id, scope, service_id, source_key)
    );
    INSERT INTO capability_architecture_versions
      (organization_id, source_key, service_id, document_hash, document_yaml, source_url)
    SELECT organization_id, 'document:' || source_url, service_id, document_hash, document_yaml, source_url
      FROM capability_architectures ON CONFLICT DO NOTHING;
    INSERT INTO capability_architecture_selections
      (organization_id, scope, service_id, source_key, version_id)
    SELECT old.organization_id, old.environment_id, old.service_id, version.source_key, version.id
      FROM capability_architectures old JOIN capability_architecture_versions version
      ON version.organization_id = old.organization_id AND version.source_key = 'document:' || old.source_url
      AND version.service_id = old.service_id AND version.document_hash = old.document_hash;

    ALTER TABLE source_documents ADD COLUMN generated_candidate_id uuid REFERENCES repository_contract_candidates(id);
    ALTER TABLE source_documents DROP CONSTRAINT source_documents_evidence_shape;
    ALTER TABLE source_documents ADD CONSTRAINT source_documents_evidence_shape CHECK (
      (evidence_kind IN ('repository', 'github') AND repository IS NOT NULL AND commit_sha IS NOT NULL AND path IS NOT NULL
       AND evidence_label IS NULL AND confirmed_by IS NULL AND confirmed_at IS NULL AND generated_candidate_id IS NULL)
      OR (evidence_kind = 'human-confirmed' AND repository IS NULL AND commit_sha IS NULL AND path IS NULL
       AND evidence_label IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND generated_candidate_id IS NULL)
      OR (evidence_kind = 'atlas-generated' AND repository IS NOT NULL AND commit_sha IS NOT NULL AND path IS NULL
       AND evidence_label IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND generated_candidate_id IS NOT NULL)
    );
  `);
};

exports.down = () => {
  throw new Error(
    'Repository review history must be retained; restore a backup to undo this migration',
  );
};
