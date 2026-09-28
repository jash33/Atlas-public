exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE draft_requests (
    id uuid PRIMARY KEY,
    actor_id text NOT NULL,
    organization_id text NOT NULL,
    environment_id text NOT NULL,
    request_hash text NOT NULL,
    state jsonb NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT now()
  )`);
};

exports.down = (pgm) => pgm.dropTable('draft_requests');
