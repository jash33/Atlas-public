import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';

import {
  verifyAtlasTrustRootRotation,
  verifyAtlasTrustSetBootstrap,
  verifyAtlasTrustSetUpdate,
  type AtlasTrustRootAuthority,
  type AtlasTrustRootRotationV1,
  type AtlasTrustSetV1,
} from './index.js';

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

async function keyPair() {
  return (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
}

async function exportedPublicKey(publicKey: CryptoKey) {
  return base64Url(new Uint8Array(await crypto.subtle.exportKey('spki', publicKey)));
}

async function signDocument<T extends { signature: { value: string } }>(
  domain: string,
  document: T,
  privateKey: CryptoKey,
): Promise<T> {
  const { value: _value, ...signature } = document.signature;
  const projection = { ...document, signature };
  const content = canonicalize(projection)!;
  const signed = encoder.encode(`${domain}\0${content}`);
  const value = base64Url(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, signed)));
  return { ...document, signature: { ...document.signature, value } };
}

async function fixture() {
  const root = await keyPair();
  const oldBundleKey = await keyPair();
  const newBundleKey = await keyPair();
  const authority: AtlasTrustRootAuthority = {
    keyId: 'customer-root-2026',
    algorithm: 'Ed25519',
    publicKey: root.publicKey,
  };
  const unsigned: AtlasTrustSetV1 = {
    formatVersion: 'atlas-trust-set/v1',
    version: 12,
    issuedAt: '2026-08-19T12:00:00Z',
    expiresAt: '2026-08-20T12:00:00Z',
    keys: [
      {
        keyId: 'bundle-old',
        algorithm: 'Ed25519',
        publicKey: await exportedPublicKey(oldBundleKey.publicKey),
        organizationIds: ['org_atlas'],
        environmentIds: ['production'],
        notBefore: '2026-08-01T00:00:00Z',
        notAfter: '2026-08-19T18:00:00Z',
        status: 'retiring',
      },
      {
        keyId: 'bundle-new',
        algorithm: 'Ed25519',
        publicKey: await exportedPublicKey(newBundleKey.publicKey),
        organizationIds: ['org_atlas'],
        environmentIds: ['production'],
        notBefore: '2026-08-19T12:00:00Z',
        notAfter: '2026-09-19T00:00:00Z',
        status: 'active',
      },
    ],
    revokedKeyIds: [],
    revokedArtifactIds: [],
    signature: { keyId: authority.keyId, algorithm: 'Ed25519', value: '' },
  };
  const document = await signDocument('atlas-trust-set/v1', unsigned, root.privateKey);
  return { authority, document, root, oldBundleKey, newBundleKey };
}

describe('root-signed Atlas trust-set updates', () => {
  it('accepts a newer canonical update from the explicitly provisioned root', async () => {
    const { authority, document } = await fixture();
    const accepted = await verifyAtlasTrustSetUpdate(canonicalize(document)!, {
      authority,
      currentVersion: 11,
      now: '2026-08-19T12:30:00Z',
    });

    expect(accepted.version).toBe(12);
    expect(accepted.verifiedByRootKeyId).toBe(authority.keyId);
    expect(
      accepted.verification.keys.map(({ keyId, status, notAfter }) => ({
        keyId,
        status,
        notAfter,
      })),
    ).toEqual([
      { keyId: 'bundle-old', status: 'retiring', notAfter: '2026-08-19T18:00:00Z' },
      { keyId: 'bundle-new', status: 'active', notAfter: '2026-09-19T00:00:00Z' },
    ]);
    expect(accepted.verification.now).toBe('2026-08-19T12:30:00Z');
    await expect(
      verifyAtlasTrustSetBootstrap(canonicalize(document)!, {
        authority,
        now: '2026-08-19T12:30:00Z',
      }),
    ).resolves.toMatchObject({ version: 12 });
  });

  it('fails closed for unknown roots, rollback or replay, and invalid trust-set windows', async () => {
    const { authority, document, root } = await fixture();

    await expect(
      verifyAtlasTrustSetUpdate(canonicalize(document)!, {
        authority: { ...authority, keyId: 'unknown-root' },
        currentVersion: 11,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('root');
    await expect(
      verifyAtlasTrustSetUpdate(canonicalize(document)!, {
        authority,
        currentVersion: 12,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('newer');
    await expect(
      verifyAtlasTrustSetUpdate(canonicalize(document)!, {
        authority,
        currentVersion: 13,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('newer');
    await expect(
      verifyAtlasTrustSetUpdate(canonicalize(document)!, {
        authority,
        currentVersion: 11,
        now: '2026-08-20T12:00:00.001Z',
      }),
    ).rejects.toThrow('expired');
    await expect(
      verifyAtlasTrustSetUpdate(canonicalize(document)!, {
        authority,
        currentVersion: 11,
        now: '2026-08-19T11:59:59Z',
      }),
    ).rejects.toThrow('not yet valid');
    const impossibleDate = await signDocument(
      'atlas-trust-set/v1',
      { ...document, expiresAt: '2026-02-30T12:00:00Z' },
      root.privateKey,
    );
    await expect(
      verifyAtlasTrustSetUpdate(canonicalize(impossibleDate)!, {
        authority,
        currentVersion: 11,
        now: '2026-02-20T12:00:00Z',
      }),
    ).rejects.toThrow('RFC 3339');
  });

  it('rejects tampered, non-canonical, malformed, and private-key-bearing updates', async () => {
    const { authority, document, root } = await fixture();
    const tampered = { ...document, version: 13 };
    await expect(
      verifyAtlasTrustSetUpdate(canonicalize(tampered)!, {
        authority,
        currentVersion: 11,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('signature');
    await expect(
      verifyAtlasTrustSetUpdate(` ${canonicalize(document)!}`, {
        authority,
        currentVersion: 11,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('canonical');
    await expect(
      verifyAtlasTrustSetUpdate(
        canonicalize({ ...document, privateKey: 'must-never-be-accepted' })!,
        { authority, currentVersion: 11, now: '2026-08-19T12:30:00Z' },
      ),
    ).rejects.toThrow('unknown or missing');
    const duplicateKey = await signDocument(
      'atlas-trust-set/v1',
      { ...document, keys: [document.keys[0]!, document.keys[0]!] },
      root.privateKey,
    );
    await expect(
      verifyAtlasTrustSetUpdate(canonicalize(duplicateKey)!, {
        authority,
        currentVersion: 11,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('duplicate');
  });
});

describe('Atlas trust-root rotation', () => {
  it('requires the current root signature and explicit provisioning-channel confirmation', async () => {
    const { authority, root } = await fixture();
    const replacement = await keyPair();
    const unsigned: AtlasTrustRootRotationV1 = {
      formatVersion: 'atlas-trust-root-rotation/v1',
      previousKeyId: authority.keyId,
      newKeyId: 'customer-root-2027',
      newPublicKey: await exportedPublicKey(replacement.publicKey),
      notBefore: '2026-08-19T12:00:00Z',
      signature: { keyId: authority.keyId, algorithm: 'Ed25519', value: '' },
    };
    const document = await signDocument('atlas-trust-root-rotation/v1', unsigned, root.privateKey);

    await expect(
      verifyAtlasTrustRootRotation(canonicalize(document)!, {
        currentAuthority: authority,
        operatorConfirmed: false,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('operator confirmation');
    const rotated = await verifyAtlasTrustRootRotation(canonicalize(document)!, {
      currentAuthority: authority,
      operatorConfirmed: true,
      now: '2026-08-19T12:30:00Z',
    });
    expect(rotated.keyId).toBe('customer-root-2027');
    const proof = encoder.encode('root-rotation-proof');
    const proofSignature = await crypto.subtle.sign('Ed25519', replacement.privateKey, proof);
    await expect(
      crypto.subtle.verify('Ed25519', rotated.publicKey, proofSignature, proof),
    ).resolves.toBe(true);
  });

  it('rejects rotations signed by an unknown previous root or activated early', async () => {
    const { authority, root } = await fixture();
    const replacement = await keyPair();
    const unsigned: AtlasTrustRootRotationV1 = {
      formatVersion: 'atlas-trust-root-rotation/v1',
      previousKeyId: 'unknown-root',
      newKeyId: 'customer-root-2027',
      newPublicKey: await exportedPublicKey(replacement.publicKey),
      notBefore: '2026-08-20T00:00:00Z',
      signature: { keyId: 'unknown-root', algorithm: 'Ed25519', value: '' },
    };
    const document = await signDocument('atlas-trust-root-rotation/v1', unsigned, root.privateKey);
    await expect(
      verifyAtlasTrustRootRotation(canonicalize(document)!, {
        currentAuthority: authority,
        operatorConfirmed: true,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('current root');

    const knownRootDocument = await signDocument(
      'atlas-trust-root-rotation/v1',
      {
        ...unsigned,
        previousKeyId: authority.keyId,
        signature: { ...unsigned.signature, keyId: authority.keyId },
      },
      root.privateKey,
    );
    await expect(
      verifyAtlasTrustRootRotation(canonicalize(knownRootDocument)!, {
        currentAuthority: authority,
        operatorConfirmed: true,
        now: '2026-08-19T12:30:00Z',
      }),
    ).rejects.toThrow('not active');
  });
});
