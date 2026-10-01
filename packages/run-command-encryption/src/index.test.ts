import { constants, createPublicKey, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { describe, expect, it } from 'vite-plus/test';
import {
  decryptRunCommandPayload,
  encryptRunCommandPayload,
  encryptedRunCommandPattern,
} from './index.js';

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
});
const publicKey = pair.publicKey.toString('base64');
const privateKey = pair.privateKey.toString('base64');

describe('run command envelopes', () => {
  it.each([178, 179, 65536])('round trips a JSON input with %i characters', async (length) => {
    const payload = { notes: 'x'.repeat(length), nested: { name: '注文' } };
    const encrypted = await encryptRunCommandPayload(publicKey, payload);
    expect(encrypted).toMatch(encryptedRunCommandPattern);
    expect(encrypted).not.toContain(payload.notes);
    await expect(decryptRunCommandPayload(privateKey, encrypted)).resolves.toEqual(payload);
    expect(await encryptRunCommandPayload(publicKey, payload)).not.toBe(encrypted);
  });

  it.each(['key', 'iv', 'data'])('rejects tampering with %s', async (field) => {
    const encrypted = await encryptRunCommandPayload(publicKey, { order: 'private-order' });
    const prefix = 'rsa-aes-gcm:v1:';
    const envelope = JSON.parse(
      Buffer.from(encrypted.slice(prefix.length), 'base64').toString(),
    ) as Record<string, string>;
    const bytes = Buffer.from(envelope[field]!, 'base64');
    bytes[bytes.length - 1]! ^= 1;
    envelope[field] = bytes.toString('base64');
    const tampered = prefix + Buffer.from(JSON.stringify(envelope)).toString('base64');
    await expect(decryptRunCommandPayload(privateKey, tampered)).rejects.toMatchObject({
      name: 'OperationError',
    });
  });

  it('rejects a different worker key and unknown formats', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const encrypted = await encryptRunCommandPayload(publicKey, { order: 'private-order' });
    await expect(
      decryptRunCommandPayload(
        other.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        encrypted,
      ),
    ).rejects.toMatchObject({ name: 'OperationError' });
    await expect(
      decryptRunCommandPayload(privateKey, encrypted.replace('v1:', 'v2:')),
    ).rejects.toThrow('Invalid encrypted run command');
  });

  it('reads already queued RSA-only commands', async () => {
    const payload = { paymentId: 'old-queued-payment' };
    const legacy =
      'rsa-oaep:' +
      publicEncrypt(
        {
          key: createPublicKey({ key: pair.publicKey, format: 'der', type: 'spki' }),
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(JSON.stringify(payload)),
      ).toString('base64');
    await expect(decryptRunCommandPayload(privateKey, legacy)).resolves.toEqual(payload);
  });
});
