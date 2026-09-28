import canonicalize from 'canonicalize';

import {
  decodeAtlasBase64Url,
  type AtlasBundleVerificationKey,
  type AtlasBundleVerificationOptions,
} from './atlas-bundle.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const sha256Pattern = /^[a-f0-9]{64}$/;

export interface AtlasTrustRootAuthority {
  readonly keyId: string;
  readonly algorithm: 'Ed25519';
  readonly publicKey: CryptoKey;
}

export interface AtlasTrustSetV1 {
  readonly formatVersion: 'atlas-trust-set/v1';
  readonly version: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly keys: readonly AtlasSerializedTrustKey[];
  readonly revokedKeyIds: readonly string[];
  readonly revokedArtifactIds: readonly string[];
  readonly signature: AtlasRootSignature;
}

export interface AtlasSerializedTrustKey {
  readonly keyId: string;
  readonly algorithm: 'Ed25519';
  readonly publicKey: string;
  readonly organizationIds: readonly string[];
  readonly environmentIds: readonly string[];
  readonly notBefore: string;
  readonly notAfter: string;
  readonly status: 'active' | 'retiring';
}

export interface AtlasTrustRootRotationV1 {
  readonly formatVersion: 'atlas-trust-root-rotation/v1';
  readonly previousKeyId: string;
  readonly newKeyId: string;
  readonly newPublicKey: string;
  readonly notBefore: string;
  readonly signature: AtlasRootSignature;
}

interface AtlasRootSignature {
  readonly keyId: string;
  readonly algorithm: 'Ed25519';
  readonly value: string;
}

export interface VerifiedAtlasTrustSet {
  readonly formatVersion: 'atlas-trust-set/v1';
  readonly version: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly verifiedByRootKeyId: string;
  readonly verification: AtlasBundleVerificationOptions;
}

export interface VerifyAtlasTrustSetUpdateOptions {
  readonly authority: AtlasTrustRootAuthority;
  readonly currentVersion: number;
  readonly now?: string;
}

export interface VerifyAtlasTrustSetBootstrapOptions {
  readonly authority: AtlasTrustRootAuthority;
  readonly now?: string;
}

export interface VerifyAtlasTrustRootRotationOptions {
  readonly currentAuthority: AtlasTrustRootAuthority;
  readonly operatorConfirmed: boolean;
  readonly now?: string;
}

export async function verifyAtlasTrustSetUpdate(
  bytes: Uint8Array | string,
  options: VerifyAtlasTrustSetUpdateOptions,
): Promise<VerifiedAtlasTrustSet> {
  if (!Number.isSafeInteger(options.currentVersion) || options.currentVersion < 0) {
    throw new TypeError('Current Atlas trust-set version is invalid');
  }
  return verifyAtlasTrustSetDocument(bytes, options);
}

export async function verifyAtlasTrustSetBootstrap(
  bytes: Uint8Array | string,
  options: VerifyAtlasTrustSetBootstrapOptions,
): Promise<VerifiedAtlasTrustSet> {
  return verifyAtlasTrustSetDocument(bytes, options);
}

async function verifyAtlasTrustSetDocument(
  bytes: Uint8Array | string,
  options: VerifyAtlasTrustSetBootstrapOptions & { readonly currentVersion?: number },
): Promise<VerifiedAtlasTrustSet> {
  assertAuthority(options.authority, 'provisioned trust root');
  const document = inspectCanonicalDocument(bytes, 'Atlas trust set');
  assertKeys(
    document,
    [
      'formatVersion',
      'version',
      'issuedAt',
      'expiresAt',
      'keys',
      'revokedKeyIds',
      'revokedArtifactIds',
      'signature',
    ],
    'Atlas trust set',
  );
  if (document.formatVersion !== 'atlas-trust-set/v1') {
    throw new TypeError('Unsupported Atlas trust-set format version');
  }
  if (!Number.isSafeInteger(document.version) || Number(document.version) < 0) {
    throw new TypeError('Atlas trust-set version is invalid');
  }
  const version = Number(document.version);
  if (options.currentVersion !== undefined && version <= options.currentVersion) {
    throw new TypeError('Atlas trust-set update must be newer than the accepted version');
  }
  const issuedAt = timestamp(document.issuedAt, 'Atlas trust-set issuedAt');
  const expiresAt = timestamp(document.expiresAt, 'Atlas trust-set expiresAt');
  if (issuedAt >= expiresAt) throw new TypeError('Atlas trust-set validity window is invalid');
  const nowText = options.now ?? new Date().toISOString();
  const now = timestamp(nowText, 'Atlas trust-set verification time');
  if (now < issuedAt) throw new TypeError('Atlas trust set is not yet valid');
  if (now > expiresAt) throw new TypeError('Atlas trust set is expired');

  const signature = parseRootSignature(document.signature, 'Atlas trust-set signature');
  if (
    signature.keyId !== options.authority.keyId ||
    signature.algorithm !== options.authority.algorithm
  ) {
    throw new TypeError('Atlas trust set is signed by an unknown root authority');
  }
  await verifyRootSignature(
    document,
    signature,
    'atlas-trust-set/v1',
    options.authority.publicKey,
    'Atlas trust-set',
  );

  if (!Array.isArray(document.keys)) throw new TypeError('Atlas trust-set keys are invalid');
  const keys = await Promise.all(document.keys.map(parseTrustKey));
  assertUnique(
    keys.map((key) => key.keyId),
    'Atlas trust set contains duplicate key IDs',
  );
  const revokedKeyIds = stringList(document.revokedKeyIds, 'revokedKeyIds');
  const revokedArtifactIds = stringList(document.revokedArtifactIds, 'revokedArtifactIds');
  if (revokedArtifactIds.some((artifactId) => !sha256Pattern.test(artifactId))) {
    throw new TypeError('Atlas trust-set revokedArtifactIds are invalid');
  }

  return {
    formatVersion: 'atlas-trust-set/v1',
    version,
    issuedAt: document.issuedAt as string,
    expiresAt: document.expiresAt as string,
    verifiedByRootKeyId: options.authority.keyId,
    verification: { keys, revokedKeyIds, revokedArtifactIds, now: nowText },
  };
}

export async function verifyAtlasTrustRootRotation(
  bytes: Uint8Array | string,
  options: VerifyAtlasTrustRootRotationOptions,
): Promise<AtlasTrustRootAuthority> {
  assertAuthority(options.currentAuthority, 'current trust root');
  const document = inspectCanonicalDocument(bytes, 'Atlas trust-root rotation');
  assertKeys(
    document,
    ['formatVersion', 'previousKeyId', 'newKeyId', 'newPublicKey', 'notBefore', 'signature'],
    'Atlas trust-root rotation',
  );
  if (document.formatVersion !== 'atlas-trust-root-rotation/v1') {
    throw new TypeError('Unsupported Atlas trust-root rotation format version');
  }
  text(document.previousKeyId, 'Atlas trust-root rotation previousKeyId');
  text(document.newKeyId, 'Atlas trust-root rotation newKeyId');
  if (document.previousKeyId !== options.currentAuthority.keyId) {
    throw new TypeError('Atlas trust-root rotation does not name the current root');
  }
  if (document.newKeyId === document.previousKeyId) {
    throw new TypeError('Atlas trust-root rotation must name a distinct new root');
  }
  if (!options.operatorConfirmed) {
    throw new TypeError('Atlas trust-root rotation requires operator confirmation');
  }
  const notBefore = timestamp(document.notBefore, 'Atlas trust-root rotation notBefore');
  const now = timestamp(
    options.now ?? new Date().toISOString(),
    'Atlas trust-root rotation verification time',
  );
  if (now < notBefore) throw new TypeError('Atlas trust-root rotation is not active yet');
  const signature = parseRootSignature(document.signature, 'Atlas trust-root rotation signature');
  if (
    signature.keyId !== options.currentAuthority.keyId ||
    signature.algorithm !== options.currentAuthority.algorithm
  ) {
    throw new TypeError('Atlas trust-root rotation is not signed by the current root');
  }
  await verifyRootSignature(
    document,
    signature,
    'atlas-trust-root-rotation/v1',
    options.currentAuthority.publicKey,
    'Atlas trust-root rotation',
  );
  text(document.newPublicKey, 'Atlas trust-root rotation newPublicKey');
  const publicKey = await importPublicKey(document.newPublicKey as string, 'trust-root rotation');
  return {
    keyId: document.newKeyId as string,
    algorithm: 'Ed25519',
    publicKey,
  };
}

async function parseTrustKey(value: unknown): Promise<AtlasBundleVerificationKey> {
  const key = record(value, 'Atlas trust-set key');
  assertKeys(
    key,
    [
      'keyId',
      'algorithm',
      'publicKey',
      'organizationIds',
      'environmentIds',
      'notBefore',
      'notAfter',
      'status',
    ],
    'Atlas trust-set key',
  );
  text(key.keyId, 'Atlas trust-set keyId');
  if (key.algorithm !== 'Ed25519') throw new TypeError('Atlas trust-set key algorithm is invalid');
  text(key.publicKey, 'Atlas trust-set publicKey');
  const organizationIds = stringList(key.organizationIds, 'organizationIds', false);
  const environmentIds = stringList(key.environmentIds, 'environmentIds', false);
  const notBefore = timestamp(key.notBefore, 'Atlas trust-set key notBefore');
  const notAfter = timestamp(key.notAfter, 'Atlas trust-set key notAfter');
  if (notBefore > notAfter) throw new TypeError('Atlas trust-set key window is invalid');
  if (key.status !== 'active' && key.status !== 'retiring') {
    throw new TypeError('Atlas trust-set key status is invalid');
  }
  return {
    keyId: key.keyId as string,
    algorithm: 'Ed25519',
    publicKey: await importPublicKey(key.publicKey as string, 'trust-set key'),
    organizationIds,
    environmentIds,
    notBefore: key.notBefore as string,
    notAfter: key.notAfter as string,
    status: key.status,
  };
}

async function importPublicKey(value: string, label: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('spki', decodeAtlasBase64Url(value), 'Ed25519', false, [
      'verify',
    ]);
  } catch {
    throw new TypeError(`Atlas ${label} public key is invalid`);
  }
}

function parseRootSignature(value: unknown, label: string): AtlasRootSignature {
  const signature = record(value, label);
  assertKeys(signature, ['keyId', 'algorithm', 'value'], label);
  text(signature.keyId, `${label}.keyId`);
  if (signature.algorithm !== 'Ed25519') throw new TypeError(`${label}.algorithm is invalid`);
  text(signature.value, `${label}.value`);
  const decoded = decodeAtlasBase64Url(signature.value as string);
  if (decoded.byteLength !== 64) throw new TypeError(`${label}.value is invalid`);
  return signature as unknown as AtlasRootSignature;
}

async function verifyRootSignature(
  document: Record<string, unknown>,
  signature: AtlasRootSignature,
  domain: string,
  publicKey: CryptoKey,
  label: string,
) {
  const signatureRecord = record(document.signature, `${label} signature`);
  const { value: _value, ...signedSignature } = signatureRecord;
  const projection = { ...document, signature: signedSignature };
  const json = canonicalize(projection);
  if (json === undefined) throw new TypeError(`${label} cannot be canonicalized`);
  const bytes = encoder.encode(`${domain}\0${json}`);
  const valid = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    decodeAtlasBase64Url(signature.value),
    bytes,
  );
  if (!valid) throw new TypeError(`${label} signature is invalid`);
}

function inspectCanonicalDocument(bytes: Uint8Array | string, label: string) {
  const supplied = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  let json: string;
  let value: unknown;
  try {
    json = decoder.decode(supplied);
    assertNoDuplicateJsonObjectNames(json, label);
    value = JSON.parse(json);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(label)) throw error;
    throw new TypeError(`${label} is not valid UTF-8 JSON`);
  }
  const document = record(value, label);
  const canonical = canonicalize(document);
  if (canonical === undefined || canonical !== json) {
    throw new TypeError(`${label} bytes are not canonical JCS`);
  }
  return document;
}

function assertAuthority(authority: AtlasTrustRootAuthority, label: string) {
  if (!authority || authority.algorithm !== 'Ed25519' || !authority.publicKey) {
    throw new TypeError(`Atlas ${label} is invalid`);
  }
  text(authority.keyId, `Atlas ${label} keyId`);
}

function stringList(value: unknown, label: string, allowEmpty = true): readonly string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new TypeError(`Atlas trust-set ${label} is invalid`);
  }
  const strings = value as string[];
  assertUnique(strings, `Atlas trust-set ${label} contains duplicate values`);
  if (strings.some((entry, index) => index > 0 && strings[index - 1]! > entry)) {
    throw new TypeError(`Atlas trust-set ${label} must be sorted`);
  }
  return [...strings];
}

function assertUnique(values: readonly string[], message: string) {
  if (new Set(values).size !== values.length) throw new TypeError(message);
}

function timestamp(value: unknown, label: string): bigint {
  text(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
    value as string,
  );
  if (!match) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]! ||
    Number(hourText) > 23 ||
    Number(minuteText) > 59 ||
    Number(secondText) > 59
  ) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  const wholeSecond = (value as string).replace(/(?:\.\d{1,9})?Z$/, 'Z');
  const parsed = Date.parse(wholeSecond);
  if (!Number.isFinite(parsed)) throw new TypeError(`${label} must be an RFC 3339 UTC timestamp`);
  return BigInt(parsed) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
}

function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is invalid`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  recordValue: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const actual = Object.keys(recordValue).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function assertNoDuplicateJsonObjectNames(json: string, label: string) {
  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(json[offset] ?? '')) offset += 1;
  };
  const parseString = () => {
    const start = offset;
    if (json[offset] !== '"') throw new TypeError(`${label} JSON string is invalid`);
    offset += 1;
    while (offset < json.length) {
      if (json[offset] === '\\') offset += 2;
      else if (json[offset] === '"') {
        offset += 1;
        return JSON.parse(json.slice(start, offset)) as string;
      } else offset += 1;
    }
    throw new TypeError(`${label} JSON string is unterminated`);
  };
  const parseValue = (): void => {
    whitespace();
    if (json[offset] === '{') {
      offset += 1;
      whitespace();
      const names = new Set<string>();
      if (json[offset] === '}') {
        offset += 1;
        return;
      }
      while (offset < json.length) {
        const name = parseString();
        if (names.has(name)) throw new TypeError(`${label} JSON contains duplicate name '${name}'`);
        names.add(name);
        whitespace();
        if (json[offset++] !== ':') throw new TypeError(`${label} JSON object is invalid`);
        parseValue();
        whitespace();
        if (json[offset] === '}') {
          offset += 1;
          return;
        }
        if (json[offset++] !== ',') throw new TypeError(`${label} JSON object is invalid`);
        whitespace();
      }
    } else if (json[offset] === '[') {
      offset += 1;
      whitespace();
      if (json[offset] === ']') {
        offset += 1;
        return;
      }
      while (offset < json.length) {
        parseValue();
        whitespace();
        if (json[offset] === ']') {
          offset += 1;
          return;
        }
        if (json[offset++] !== ',') throw new TypeError(`${label} JSON array is invalid`);
      }
    } else if (json[offset] === '"') parseString();
    else {
      const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        json.slice(offset),
      )?.[0];
      if (!primitive) throw new TypeError(`${label} JSON value is invalid`);
      offset += primitive.length;
    }
  };
  parseValue();
  whitespace();
  if (offset !== json.length) throw new TypeError(`${label} JSON has trailing content`);
}
