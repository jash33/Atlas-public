import { decryptRunCommandPayload } from '@atlas/run-command-encryption';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import { encryptRunCommandPayload } from './encrypt.js';

describe('gateway input encryption', () => {
  it('accepts ordinary inputs larger than an RSA block', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    const encrypted = await encryptRunCommandPayload(publicKey.toString('base64'), {
      notes: 'Customer order details '.repeat(1000),
    });
    expect(encrypted).not.toContain('Customer order details');
    await expect(
      decryptRunCommandPayload(privateKey.toString('base64'), encrypted),
    ).resolves.toEqual({ notes: 'Customer order details '.repeat(1000) });
  });
});
