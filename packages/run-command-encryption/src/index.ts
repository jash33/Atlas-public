const envelopePrefix = 'rsa-aes-gcm:v1:';
const legacyPrefix = 'rsa-oaep:';
const authenticatedContext = new TextEncoder().encode('atlas.run-command.v1');

export const encryptedRunCommandPattern = /^(?:rsa-oaep:|rsa-aes-gcm:v1:)[A-Za-z0-9+/]+={0,2}$/;

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** Encrypt JSON with a fresh AES key; RSA wraps only that small key. Works in browsers and Node. */
export async function encryptRunCommandPayload(
  publicKey: string,
  payload: unknown,
): Promise<string> {
  const json = JSON.stringify(payload);
  if (json === undefined) throw new TypeError('Run input must be JSON');
  const recipient = await crypto.subtle.importKey(
    'spki',
    decode(publicKey),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: authenticatedContext, tagLength: 128 },
    key,
    new TextEncoder().encode(json),
  );
  const wrapped = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    recipient,
    await crypto.subtle.exportKey('raw', key),
  );
  return (
    envelopePrefix +
    encode(
      new TextEncoder().encode(
        JSON.stringify({
          key: encode(new Uint8Array(wrapped)),
          iv: encode(iv),
          data: encode(new Uint8Array(data)),
        }),
      ),
    )
  );
}

/** Old queued RSA-only commands remain readable during rollout. */
export async function decryptRunCommandPayload(
  privateKey: string,
  encrypted: string,
): Promise<unknown> {
  if (!encryptedRunCommandPattern.test(encrypted)) throw new Error('Invalid encrypted run command');
  const recipient = await crypto.subtle.importKey(
    'pkcs8',
    decode(privateKey),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['decrypt'],
  );
  if (encrypted.startsWith(legacyPrefix)) {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'RSA-OAEP' },
      recipient,
      decode(encrypted.slice(legacyPrefix.length)),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  }
  const envelope: unknown = JSON.parse(
    new TextDecoder().decode(decode(encrypted.slice(envelopePrefix.length))),
  );
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    Object.keys(envelope).length !== 3 ||
    !('key' in envelope) ||
    typeof envelope.key !== 'string' ||
    !('iv' in envelope) ||
    typeof envelope.iv !== 'string' ||
    !('data' in envelope) ||
    typeof envelope.data !== 'string'
  ) {
    throw new Error('Invalid encrypted run command envelope');
  }
  const iv = decode(envelope.iv);
  const data = decode(envelope.data);
  if (iv.length !== 12 || data.length <= 16)
    throw new Error('Invalid encrypted run command envelope');
  const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, recipient, decode(envelope.key));
  if (rawKey.byteLength !== 32) throw new Error('Invalid run command encryption key');
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: authenticatedContext, tagLength: 128 },
    key,
    data,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}
