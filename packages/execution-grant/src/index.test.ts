import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vite-plus/test';

import {
  ExecutionGrantRejected,
  generateExecutionGrantKeyPair,
  issueExecutionGrant,
  verifyExecutionGrant,
} from './index.js';

describe('Production ExecutionGrant scope', () => {
  it('verifies the canonical identity and rejects Development or the retired identity', async () => {
    const keys = await generateExecutionGrantKeyPair();
    const claims = {
      organizationId: 'org_atlas',
      environmentId: 'production',
      runId: 'run_production',
      workflowVersionId: 'invoice@1',
      irHash: 'a'.repeat(64),
      approvedCapabilityVersionIds: ['billing.invoice@1'],
      approvedHostnames: ['billing.internal', 'payments.internal', 'billing.internal'],
    };
    const grant = await issueExecutionGrant(keys.privateKey, claims);
    expect(grant.approvedHostnames).toEqual(['billing.internal', 'payments.internal']);
    const expected = {
      ...claims,
      requiredCapabilityVersionIds: claims.approvedCapabilityVersionIds,
    };

    await expect(verifyExecutionGrant(keys.publicKey, grant, expected)).resolves.toBeUndefined();
    await expect(
      verifyExecutionGrant(keys.publicKey, grant, { ...expected, environmentId: 'development' }),
    ).rejects.toBeInstanceOf(ExecutionGrantRejected);
    await expect(
      verifyExecutionGrant(keys.publicKey, grant, {
        ...expected,
        environmentId: 'production-like',
      }),
    ).rejects.toBeInstanceOf(ExecutionGrantRejected);
    await expect(
      verifyExecutionGrant(
        keys.publicKey,
        {
          ...grant,
          approvedHostnames: ['metadata.google.internal'],
        },
        expected,
      ),
    ).rejects.toBeInstanceOf(ExecutionGrantRejected);
  });

  it('verifies grants issued before approved hostnames were added', async () => {
    const keys = await generateExecutionGrantKeyPair();
    const claims = {
      organizationId: 'org_atlas',
      environmentId: 'production',
      runId: 'run_in_flight',
      workflowVersionId: 'invoice@1',
      irHash: 'a'.repeat(64),
      approvedCapabilityVersionIds: ['billing.invoice@1'],
    };
    const privateKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      base64UrlToBytes(keys.privateKey),
      'Ed25519',
      false,
      ['sign'],
    );
    const signature = await globalThis.crypto.subtle.sign(
      'Ed25519',
      privateKey,
      new TextEncoder().encode(canonicalize(claims)!),
    );

    await expect(
      verifyExecutionGrant(
        keys.publicKey,
        {
          ...claims,
          signatureAlgorithm: 'Ed25519',
          signature: bytesToBase64Url(signature),
        },
        {
          ...claims,
          requiredCapabilityVersionIds: claims.approvedCapabilityVersionIds,
        },
      ),
    ).resolves.toBeUndefined();
  });
});

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
