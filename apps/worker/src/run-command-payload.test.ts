import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

import {
  createRunCommandPayloadCipher,
  decryptRunCommandPayload,
  encryptRunCommandPayload,
  ensureRunCommandEncryptionKeyPair,
} from './run-command-payload.js';

describe('customer-side run command encryption', () => {
  it('encrypts console input to a worker-owned public key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-run-command-'));
    const path = join(directory, 'secrets.json');
    await writeFile(path, JSON.stringify({ existing: 'secret' }));
    try {
      const first = await ensureRunCommandEncryptionKeyPair(path);
      const second = await ensureRunCommandEncryptionKeyPair(path);
      const encrypted = await encryptRunCommandPayload(first.publicKey, {
        paymentId: 'payment_demo_001',
      });

      expect(encrypted).not.toContain('payment_demo_001');
      expect(await decryptRunCommandPayload(first.privateKey, encrypted)).toEqual({
        paymentId: 'payment_demo_001',
      });
      expect(second).toEqual(first);
      await expect(readFile(path, 'utf8')).resolves.toContain('existing');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('decrypts JSON before applying the pinned workflow input schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-run-command-'));
    const path = join(directory, 'secrets.json');
    await writeFile(path, '{}');
    try {
      const pair = await ensureRunCommandEncryptionKeyPair(path);
      const encrypted = await encryptRunCommandPayload(pair.publicKey, {});

      expect(await decryptRunCommandPayload(pair.privateKey, encrypted)).toEqual({});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('round-trips a payment payload without exposing plaintext in the envelope', () => {
    const cipher = createRunCommandPayloadCipher(Buffer.alloc(32, 3).toString('base64'));
    const encrypted = cipher.encrypt({ paymentId: 'pay_sensitive' });

    expect(Buffer.from(encrypted, 'base64').toString('utf8')).not.toContain('pay_sensitive');
    expect(cipher.decrypt(encrypted)).toEqual({ paymentId: 'pay_sensitive' });
  });

  it('rejects tampered ciphertext', () => {
    const cipher = createRunCommandPayloadCipher(Buffer.alloc(32, 3).toString('base64'));
    const encrypted = Buffer.from(cipher.encrypt({ paymentId: 'pay_1' }), 'base64');
    encrypted[encrypted.length - 1]! ^= 1;

    expect(() => cipher.decrypt(encrypted.toString('base64'))).toThrow(
      'Unsupported state or unable to authenticate data',
    );
  });
});
