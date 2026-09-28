import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';

import { loadBackendConfig } from './config.js';
import { loadCustomerAuthConfig } from './customer-auth.js';
import { createCustomerPasswordAuth } from './customer-password-auth.js';
import { customerAuthScope } from './customer-sso-provider.js';

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function setCustomerPasswordFromCommandLine(): Promise<void> {
  const auth = loadCustomerAuthConfig();
  if (!auth) throw new Error('Customer authentication must be enabled');
  const userId = requiredArgument('--user-id');
  const username = requiredArgument('--username');
  const passwordFile = resolve(requiredArgument('--password-file'));
  const password = readFileSync(passwordFile, 'utf8').replace(/[\r\n]+$/, '');
  const pool = new Pool({ connectionString: loadBackendConfig().databaseUrl });
  try {
    await createCustomerPasswordAuth(pool, {
      organizationId: auth.organizationId,
      authScope: customerAuthScope(auth),
      sessionMaxAgeSeconds: auth.sessionMaxAgeSeconds,
    }).setPassword({ userId, username, password });
    console.log(`Password sign-in enabled for ${username}.`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setCustomerPasswordFromCommandLine().catch(() => {
    console.error('Password sign-in could not be configured. Check the user, file, and database.');
    process.exitCode = 1;
  });
}
