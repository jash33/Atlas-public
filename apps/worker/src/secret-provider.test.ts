import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import { createConfigFileSecretProvider } from './secret-provider.js';

describe('config-file SecretProvider', () => {
  it('resolves a worker-held secret by alias', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-worker-secrets-'));
    const path = join(directory, 'secrets.json');
    await writeFile(path, JSON.stringify({ temporalPayloadEncryptionKey: 'customer-key' }));

    const provider = createConfigFileSecretProvider(path);

    await expect(provider.getSecret('temporalPayloadEncryptionKey')).resolves.toBe('customer-key');
  });

  it('fails closed when an alias is absent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-worker-secrets-'));
    const path = join(directory, 'secrets.json');
    await writeFile(path, '{}');

    const provider = createConfigFileSecretProvider(path);

    await expect(provider.getSecret('missing')).rejects.toThrow(
      "Secret alias 'missing' was not found",
    );
  });
});
