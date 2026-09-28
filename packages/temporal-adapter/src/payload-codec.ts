import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { DataConverter, Payload, PayloadCodec } from '@temporalio/common';

const encryptedEncoding = new TextEncoder().encode('binary/encrypted');
const algorithm = 'aes-256-gcm';
const initializationVectorLength = 12;
const authenticationTagLength = 16;
const encryptedDataConverterBrand = Symbol('atlas.encrypted-data-converter');

export type EncryptedDataConverter = DataConverter & {
  readonly [encryptedDataConverterBrand]: true;
};

export function createEncryptedDataConverter(base64Key: string): EncryptedDataConverter {
  return {
    [encryptedDataConverterBrand]: true,
    payloadCodecs: [createAesGcmPayloadCodec(base64Key)],
  };
}

export function assertEncryptedDataConverter(
  dataConverter: DataConverter,
): asserts dataConverter is EncryptedDataConverter {
  if (!(encryptedDataConverterBrand in dataConverter)) {
    throw new TypeError('Generic Temporal interpreter requires Atlas encrypted history');
  }
}

interface SerializedPayload {
  readonly metadata: Readonly<Record<string, string>>;
  readonly data: string | null;
}

export function createAesGcmPayloadCodec(base64Key: string): PayloadCodec {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) {
    throw new Error('Temporal payload encryption key must decode to 32 bytes');
  }

  return {
    async encode(payloads) {
      return payloads.map((payload) => encryptPayload(key, payload));
    },
    async decode(payloads) {
      return payloads.map((payload) => decryptPayload(key, payload));
    },
  };
}

function encryptPayload(key: Buffer, payload: Payload): Payload {
  const initializationVector = randomBytes(initializationVectorLength);
  const cipher = createCipheriv(algorithm, key, initializationVector);
  const plaintext = Buffer.from(JSON.stringify(serializePayload(payload)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    metadata: { encoding: encryptedEncoding },
    data: Buffer.concat([initializationVector, cipher.getAuthTag(), ciphertext]),
  };
}

function decryptPayload(key: Buffer, payload: Payload): Payload {
  if (
    new TextDecoder().decode(payload.metadata?.encoding ?? new Uint8Array()) !== 'binary/encrypted'
  ) {
    throw new Error('Temporal payload is not customer-encrypted');
  }
  const encrypted = Buffer.from(payload.data ?? new Uint8Array());
  if (encrypted.length <= initializationVectorLength + authenticationTagLength) {
    throw new Error('Temporal encrypted payload is truncated');
  }
  const initializationVector = encrypted.subarray(0, initializationVectorLength);
  const authenticationTag = encrypted.subarray(
    initializationVectorLength,
    initializationVectorLength + authenticationTagLength,
  );
  const ciphertext = encrypted.subarray(initializationVectorLength + authenticationTagLength);
  const decipher = createDecipheriv(algorithm, key, initializationVector);
  decipher.setAuthTag(authenticationTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return deserializePayload(parseSerializedPayload(plaintext.toString('utf8')));
}

function parseSerializedPayload(json: string): SerializedPayload {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || !('metadata' in value) || !('data' in value)) {
    throw new Error('Temporal encrypted payload has an invalid shape');
  }
  const { metadata, data } = value;
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    !Object.values(metadata).every((entry) => typeof entry === 'string') ||
    (data !== null && typeof data !== 'string')
  ) {
    throw new Error('Temporal encrypted payload has an invalid shape');
  }
  return { metadata: { ...metadata }, data };
}

function serializePayload(payload: Payload): SerializedPayload {
  return {
    metadata: Object.fromEntries(
      Object.entries(payload.metadata ?? {}).map(([key, value]) => [
        key,
        Buffer.from(value ?? new Uint8Array()).toString('base64'),
      ]),
    ),
    data: payload.data == null ? null : Buffer.from(payload.data).toString('base64'),
  };
}

function deserializePayload(payload: SerializedPayload): Payload {
  return {
    metadata: Object.fromEntries(
      Object.entries(payload.metadata).map(([key, value]) => [
        key,
        new Uint8Array(Buffer.from(value, 'base64')),
      ]),
    ),
    data: payload.data === null ? null : new Uint8Array(Buffer.from(payload.data, 'base64')),
  };
}
