import { resolve } from 'node:path';

import { runner } from 'node-pg-migrate';

import { loadBackendConfig } from './config.js';

const config = loadBackendConfig();

await runner({
  databaseUrl: config.databaseUrl,
  dir: resolve('migrations'),
  direction: 'up',
  migrationsTable: 'atlas_migrations',
});
