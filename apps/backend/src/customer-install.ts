import { fileURLToPath, pathToFileURL } from 'node:url';

import { runner } from 'node-pg-migrate';
import { Pool } from 'pg';
import { z } from 'zod';

import { loadBackendConfig } from './config.js';
import { loadCustomerAuthConfig } from './customer-auth.js';

const organizationSchema = z.object({
  organizationId: z.string().trim().min(1).max(200),
  organizationName: z.string().trim().min(1).max(200),
});

export async function initializeCustomerOrganization(
  pool: Pool,
  input: z.input<typeof organizationSchema>,
) {
  const { organizationId, organizationName } = organizationSchema.parse(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [organizationId, organizationName],
    );
    await client.query(
      `INSERT INTO environments (organization_id, id, name, kind) VALUES
       ($1, 'development', 'Development', 'development'),
       ($1, 'production', 'Production', 'production')
       ON CONFLICT (organization_id, id) DO NOTHING`,
      [organizationId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const auth = loadCustomerAuthConfig();
  if (!auth) throw new Error('Customer installation requires ATLAS_AUTH_MODE=customer');
  const organization = organizationSchema.parse({
    organizationId: auth.organizationId,
    organizationName: process.env.ATLAS_ORGANIZATION_NAME,
  });
  const config = loadBackendConfig();
  await runner({
    databaseUrl: config.databaseUrl,
    dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
    direction: 'up',
    migrationsTable: 'atlas_migrations',
    advisoryLockMode: 'wait',
    log: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    await initializeCustomerOrganization(pool, organization);
    console.info(
      'Customer database is ready. Start Atlas, sign in, and approve the first administrator request using the operator command.',
    );
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      'Customer installation failed. Check the customer settings, organization name, database connection, and migration permissions. No user or administrator is created by this command.',
    );
    process.exitCode = 1;
  });
}
