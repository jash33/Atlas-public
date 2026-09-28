import { constants, createPublicKey, publicEncrypt } from 'node:crypto';

import type { JsonValue } from '@atlas/workflow-ir';

const rsaPrefix = 'rsa-oaep:';

/** Encrypt plaintext workflow input to the worker's run-command public key (SPKI DER, base64). */
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
