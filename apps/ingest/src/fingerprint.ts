import { createHash } from 'node:crypto';

import canonicalize from 'canonicalize';

import type { JsonValue } from '@atlas/workflow-ir';

/** Stable SHA-256 of the canonical JSON payload, independent of encryption ciphertext. */
export function fingerprintPayload(payload: JsonValue): string {
  const canonical = canonicalize(payload);
  if (canonical === undefined) {
    throw new TypeError('Payload cannot be canonicalized');
  }
  return createHash('sha256').update(canonical).digest('hex');
}
