import { resolve } from 'node:path';

import { runner } from 'node-pg-migrate';

interface TestDatabaseMigrationOptions {
  readonly lockValue?: number;
  readonly schema?: string;
}

const defaultTestDatabaseUrl = 'postgresql://atlas@localhost:5432/atlas_test';

export function resolveTestDatabaseUrl(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const databaseUrl = environment.ATLAS_TEST_DATABASE_URL ?? defaultTestDatabaseUrl;
  const databaseName = new URL(databaseUrl).pathname.replace(/^\/+/, '');
  if (databaseName === 'atlas') {
    throw new Error('Backend tests must not use the development database "atlas"');
  }
  return databaseUrl;
}

export async function migrateTestDatabase(
  databaseUrl: string,
  options: TestDatabaseMigrationOptions = {},
): Promise<void> {
  await runner({
    databaseUrl,
    ...(options.schema
      ? {
          schema: options.schema,
          migrationsSchema: options.schema,
          createSchema: true,
          createMigrationsSchema: true,
        }
      : {}),
    ...(options.lockValue === undefined ? {} : { lockValue: options.lockValue }),
    dir: resolve('apps/backend/migrations'),
    direction: 'up',
    migrationsTable: 'atlas_migrations',
    advisoryLockMode: 'wait',
  });
}
