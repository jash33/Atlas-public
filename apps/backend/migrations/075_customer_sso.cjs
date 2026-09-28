exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE customer_sso_identities (
      organization_id text NOT NULL,
      issuer text NOT NULL,
      subject text NOT NULL,
      user_id text NOT NULL,
      PRIMARY KEY (organization_id, issuer, subject),
      FOREIGN KEY (organization_id, user_id)
        REFERENCES organization_memberships (organization_id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE customer_sessions (
      id_hash text PRIMARY KEY,
      client_id text NOT NULL,
      organization_id text NOT NULL,
      issuer text NOT NULL,
      subject text NOT NULL,
      expires_at timestamptz NOT NULL,
      FOREIGN KEY (organization_id, issuer, subject)
        REFERENCES customer_sso_identities ON DELETE CASCADE
    );
    CREATE INDEX customer_sessions_expiry ON customer_sessions (expires_at);
    CREATE TABLE customer_login_requests (
      id_hash text PRIMARY KEY,
      client_id text NOT NULL,
      organization_id text NOT NULL REFERENCES organizations ON DELETE CASCADE,
      state text NOT NULL,
      nonce text NOT NULL,
      verifier text NOT NULL,
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX customer_login_requests_expiry ON customer_login_requests (expires_at);
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('customer_login_requests');
  pgm.dropTable('customer_sessions');
  pgm.dropTable('customer_sso_identities');
};
