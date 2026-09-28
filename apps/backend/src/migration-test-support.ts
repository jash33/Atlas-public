import { readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const migrationsDirectory = resolve('apps/backend/migrations');

export function migrationCountAfter(migrationName: string) {
  return readdirSync(migrationsDirectory).filter(
    (file) => file.endsWith('.cjs') && basename(file, '.cjs') > migrationName,
  ).length;
}
