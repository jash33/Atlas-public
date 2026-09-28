exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE customer_password_credentials (
      organization_id text NOT NULL,
      username text NOT NULL,
      user_id text NOT NULL,
      password_salt text NOT NULL,
      password_hash text NOT NULL,
      scrypt_cost integer NOT NULL,
      scrypt_block_size integer NOT NULL,
      scrypt_parallelization integer NOT NULL,
      failed_attempts integer NOT NULL DEFAULT 0,
      locked_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, username),
      UNIQUE (organization_id, user_id),
      FOREIGN KEY (organization_id, user_id)
        REFERENCES organization_memberships (organization_id, user_id) ON DELETE CASCADE,
      CHECK (username = lower(username)),
      CHECK (failed_attempts >= 0)
    );

    CREATE TABLE customer_password_sessions (
      id_hash text PRIMARY KEY,
      organization_id text NOT NULL,
      user_id text NOT NULL,
      auth_scope text NOT NULL,
      expires_at timestamptz NOT NULL,
      FOREIGN KEY (organization_id, user_id)
        REFERENCES customer_password_credentials (organization_id, user_id) ON DELETE CASCADE
    );
    CREATE INDEX customer_password_sessions_expiry ON customer_password_sessions (expires_at);
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('customer_password_sessions');
  pgm.dropTable('customer_password_credentials');
};
