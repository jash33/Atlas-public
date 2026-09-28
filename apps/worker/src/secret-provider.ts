import { readFile } from 'node:fs/promises';

import type { SecretProvider } from '@atlas/runtime-ports';

export function createConfigFileSecretProvider(path: string): SecretProvider {
  let secretsPromise: Promise<Readonly<Record<string, string>>> | undefined;

  return {
    async getSecret(alias) {
      const secrets = await (secretsPromise ??= loadSecrets(path));
      const value = secrets[alias];
      if (value === undefined) throw new Error(`Secret alias '${alias}' was not found`);
      return value;
    },
  };
}

async function loadSecrets(path: string): Promise<Readonly<Record<string, string>>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Worker secret config must be a JSON object');
  }
  for (const [alias, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Secret alias '${alias}' must contain a non-empty string`);
    }
  }
  return parsed as Readonly<Record<string, string>>;
}
