import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import type { JsonValue } from '@atlas/workflow-ir';

const initializationVectorLength = 12;
const authenticationTagLength = 16;
const rsaPrefix = 'rsa-oaep:';

export interface RunCommandEncryptionKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

export async function ensureRunCommandEncryptionKeyPair(
  secretConfigPath: string,
): Promise<RunCommandEncryptionKeyPair> {
  const secrets = JSON.parse(await readFile(secretConfigPath, 'utf8')) as Record<string, unknown>;
  if (
    typeof secrets.runCommandEncryptionPublicKey === 'string' &&
    typeof secrets.runCommandEncryptionPrivateKey === 'string'
  ) {
    return {
      publicKey: secrets.runCommandEncryptionPublicKey,
      privateKey: secrets.runCommandEncryptionPrivateKey,
    };
  }
  const generated = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const pair = {
    publicKey: generated.publicKey.toString('base64'),
    privateKey: generated.privateKey.toString('base64'),
  };
  await writeFile(
    secretConfigPath,
    JSON.stringify({
      ...secrets,
      runCommandEncryptionPublicKey: pair.publicKey,
      runCommandEncryptionPrivateKey: pair.privateKey,
    }),
    { mode: 0o600 },
  );
  return pair;
}

export function encryptRunCommandPayload(publicKey: string, payload: JsonValue): string {
  return `${rsaPrefix}${publicEncrypt(
    {
      key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(JSON.stringify(payload), 'utf8'),
  ).toString('base64')}`;
}

export function decryptRunCommandPayload(privateKey: string, encryptedPayload: string): unknown {
  if (!encryptedPayload.startsWith(rsaPrefix)) {
    throw new Error('Run command payload does not use worker public-key encryption');
  }
  const plaintext = privateDecrypt(
    {
      key: createPrivateKey({
        key: Buffer.from(privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(encryptedPayload.slice(rsaPrefix.length), 'base64'),
  );
  return JSON.parse(plaintext.toString('utf8')) as unknown;
}

export function createRunCommandPayloadCipher(base64Key: string) {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('Run command encryption key must decode to 32 bytes');
  return {
    encrypt(payload: JsonValue) {
      const initializationVector = randomBytes(initializationVectorLength);
      const cipher = createCipheriv('aes-256-gcm', key, initializationVector);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), 'utf8'),
        cipher.final(),
      ]);
      return Buffer.concat([initializationVector, cipher.getAuthTag(), ciphertext]).toString(
        'base64',
      );
    },
    decrypt(encryptedPayload: string) {
      const encrypted = Buffer.from(encryptedPayload, 'base64');
      if (encrypted.length <= initializationVectorLength + authenticationTagLength) {
        throw new Error('Encrypted run command is truncated');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        encrypted.subarray(0, initializationVectorLength),
      );
      decipher.setAuthTag(
        encrypted.subarray(
          initializationVectorLength,
          initializationVectorLength + authenticationTagLength,
        ),
      );
      const plaintext = Buffer.concat([
        decipher.update(encrypted.subarray(initializationVectorLength + authenticationTagLength)),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    },
  };
}
