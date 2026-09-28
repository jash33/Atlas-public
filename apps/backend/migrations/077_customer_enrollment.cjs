exports.up = (pgm) => {
  pgm.sql(`CREATE TABLE customer_access_requests (
    id text PRIMARY KEY,
    organization_id text NOT NULL REFERENCES organizations ON DELETE CASCADE,
    auth_scope text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    display_name text NOT NULL,
    email text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    browser_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    decided_at timestamptz,
    approved_user_id text REFERENCES users ON DELETE SET NULL,
    UNIQUE (auth_scope, issuer, subject)
  );
  CREATE INDEX customer_access_requests_organization ON customer_access_requests (organization_id, created_at);
  CREATE INDEX customer_access_requests_expiry ON customer_access_requests (expires_at);`);
};

exports.down = (pgm) => pgm.dropTable('customer_access_requests');
