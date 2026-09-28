import { describe, expect, it } from 'vite-plus/test';

import {
  assertEncryptedDataConverter,
  createAesGcmPayloadCodec,
  createEncryptedDataConverter,
} from './payload-codec.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

describe('customer-side Temporal payload encryption', () => {
  it('encrypts payload data before it crosses the Temporal boundary and restores it locally', async () => {
    const codec = createAesGcmPayloadCodec(Buffer.alloc(32, 7).toString('base64'));
    const plaintext = 'paymentId=pay_sensitive';
    const payload = {
      metadata: { encoding: textEncoder.encode('json/plain') },
      data: textEncoder.encode(plaintext),
    };

    const [encrypted] = await codec.encode([payload]);

    expect(textDecoder.decode(encrypted!.data!)).not.toContain(plaintext);
    expect(textDecoder.decode(encrypted!.metadata!.encoding!)).toBe('binary/encrypted');
    await expect(codec.decode([encrypted!])).resolves.toEqual([payload]);
  });

  it('rejects a key that is not 256 bits', () => {
    expect(() => createAesGcmPayloadCodec(Buffer.alloc(16).toString('base64'))).toThrow(
      'Temporal payload encryption key must decode to 32 bytes',
    );
  });

  it('brands only Atlas-created encrypted data converters for the generic interpreter', () => {
    expect(() => assertEncryptedDataConverter({})).toThrow(
      'Generic Temporal interpreter requires Atlas encrypted history',
    );
    expect(() =>
      assertEncryptedDataConverter(
        createEncryptedDataConverter(Buffer.alloc(32, 7).toString('base64')),
      ),
    ).not.toThrow();
  });

  it('rejects ciphertext that fails AES-GCM authentication', async () => {
    const codec = createAesGcmPayloadCodec(Buffer.alloc(32, 7).toString('base64'));
    const [encrypted] = await codec.encode([{ data: textEncoder.encode('sensitive') }]);
    const tampered = new Uint8Array(encrypted!.data!);
    tampered[tampered.length - 1]! ^= 1;

    await expect(codec.decode([{ ...encrypted!, data: tampered }])).rejects.toThrow(
      'Unsupported state or unable to authenticate data',
    );
  });
});
