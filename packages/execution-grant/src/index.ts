import canonicalize from 'canonicalize';
import { z } from 'zod';

const identifierSchema = z.string().min(1);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);

const legacyExecutionGrantClaimsSchema = z.strictObject({
  organizationId: identifierSchema,
  environmentId: identifierSchema,
  runId: identifierSchema,
  workflowVersionId: identifierSchema,
  irHash: sha256HexSchema,
  approvedCapabilityVersionIds: z.array(identifierSchema),
});

export const executionGrantClaimsSchema = legacyExecutionGrantClaimsSchema.extend({
  approvedHostnames: z.array(z.string().min(1)),
});

export const executionGrantSchema = legacyExecutionGrantClaimsSchema.extend({
  approvedHostnames: z.array(z.string().min(1)).optional(),
  signatureAlgorithm: z.literal('Ed25519'),
  signature: z.string().min(1),
});

export interface ExecutionGrantClaims {
  readonly organizationId: string;
  readonly environmentId: string;
  readonly runId: string;
  readonly workflowVersionId: string;
  readonly irHash: string;
  readonly approvedCapabilityVersionIds: readonly string[];
  readonly approvedHostnames: readonly string[];
}
type VerifiableExecutionGrantClaims = Omit<ExecutionGrantClaims, 'approvedHostnames'> & {
  readonly approvedHostnames?: readonly string[];
};
export type ExecutionGrant = z.infer<typeof executionGrantSchema>;

export interface ExecutionGrantKeyPair {
  readonly privateKey: string;
  readonly publicKey: string;
}

export interface ExecutionGrantExpectations {
  readonly organizationId: string;
  readonly environmentId: string;
  readonly runId: string;
  readonly workflowVersionId: string;
  readonly irHash: string;
  readonly requiredCapabilityVersionIds: readonly string[];
}

export class ExecutionGrantRejected extends Error {
  constructor(reason: string) {
    super(`ExecutionGrant rejected: ${reason}`);
    this.name = 'ExecutionGrantRejected';
  }
}

export async function generateExecutionGrantKeyPair(): Promise<ExecutionGrantKeyPair> {
  const { privateKey, publicKey } = (await globalThis.crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    privateKey: bytesToBase64Url(await globalThis.crypto.subtle.exportKey('pkcs8', privateKey)),
    publicKey: bytesToBase64Url(await globalThis.crypto.subtle.exportKey('spki', publicKey)),
  };
}

export async function issueExecutionGrant(
  signingPrivateKey: string,
  claims: ExecutionGrantClaims,
): Promise<ExecutionGrant> {
  const parsedClaims = normalizedClaims(claims);
  const privateKey = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    base64UrlToBytes(signingPrivateKey),
    'Ed25519',
    false,
    ['sign'],
  );
  const signature = await globalThis.crypto.subtle.sign(
    'Ed25519',
    privateKey,
    signingMaterial(parsedClaims),
  );
  return executionGrantSchema.parse({
    ...parsedClaims,
    signatureAlgorithm: 'Ed25519',
    signature: bytesToBase64Url(signature),
  });
}

export async function verifyExecutionGrant(
  verificationPublicKey: string,
  grant: ExecutionGrant,
  expected: ExecutionGrantExpectations,
): Promise<void> {
  const parsedGrant = executionGrantSchema.safeParse(grant);
  if (!parsedGrant.success) throw new ExecutionGrantRejected('invalid shape');

  const { signature } = parsedGrant.data;
  const claims: VerifiableExecutionGrantClaims = {
    organizationId: parsedGrant.data.organizationId,
    environmentId: parsedGrant.data.environmentId,
    runId: parsedGrant.data.runId,
    workflowVersionId: parsedGrant.data.workflowVersionId,
    irHash: parsedGrant.data.irHash,
    approvedCapabilityVersionIds: parsedGrant.data.approvedCapabilityVersionIds,
    ...(parsedGrant.data.approvedHostnames
      ? { approvedHostnames: parsedGrant.data.approvedHostnames }
      : {}),
  };
  const publicKey = await globalThis.crypto.subtle.importKey(
    'spki',
    base64UrlToBytes(verificationPublicKey),
    'Ed25519',
    false,
    ['verify'],
  );
  const signatureValid = await globalThis.crypto.subtle.verify(
    'Ed25519',
    publicKey,
    base64UrlToBytes(signature),
    signingMaterial(claims),
  );
  if (!signatureValid) throw new ExecutionGrantRejected('signature invalid');

  assertEqual('organization', claims.organizationId, expected.organizationId);
  assertEqual('environment', claims.environmentId, expected.environmentId);
  assertEqual('run id', claims.runId, expected.runId);
  assertEqual('workflow version', claims.workflowVersionId, expected.workflowVersionId);
  assertEqual('irHash', claims.irHash, expected.irHash);

  const approved = sortedUnique(claims.approvedCapabilityVersionIds);
  const required = sortedUnique(expected.requiredCapabilityVersionIds);
  if (approved.length !== required.length || approved.some((id, index) => id !== required[index])) {
    throw new ExecutionGrantRejected('approved capability version set does not match the IR');
  }
}

function normalizedClaims(claims: ExecutionGrantClaims): ExecutionGrantClaims {
  const parsed = executionGrantClaimsSchema.parse(claims);
  return {
    ...parsed,
    approvedCapabilityVersionIds: sortedUnique(parsed.approvedCapabilityVersionIds),
    approvedHostnames: sortedUnique(
      parsed.approvedHostnames.map((hostname) => hostname.toLowerCase()),
    ),
  };
}

function signingMaterial(claims: VerifiableExecutionGrantClaims): Uint8Array<ArrayBuffer> {
  const json = canonicalize(claims);
  if (json === undefined)
    throw new TypeError('ExecutionGrant cannot be represented as canonical JSON');
  return new TextEncoder().encode(json);
}

function bytesToBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function assertEqual(label: string, actual: string, expected: string): void {
  if (actual !== expected) {
    throw new ExecutionGrantRejected(`${label} '${actual}' does not match '${expected}'`);
  }
}
