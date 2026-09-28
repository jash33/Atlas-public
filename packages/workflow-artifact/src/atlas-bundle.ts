import canonicalize from 'canonicalize';

import {
  versionedCompiledWorkflowVersionSchema,
  objectSchemaSchema,
  retryPolicySchema,
  valueReferenceSchema,
  visitTransformationExpression,
  workflowStepExpressions,
  type ObjectSchema,
  type ResponseSchema,
} from '@atlas/workflow-ir';

import { verifyTemporalWorkflowArtifact, type TemporalWorkflowArtifactManifest } from './index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const domain = encoder.encode('atlas-bundle/v1\0');
const sha256Pattern = /^[a-f0-9]{64}$/;
const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

export interface AtlasBundleSigner {
  readonly keyId: string;
  readonly algorithm: 'Ed25519';
  sign(content: Uint8Array): Promise<Uint8Array>;
}

export interface AtlasBundleV1 {
  readonly formatVersion: 'atlas-bundle/v1';
  readonly artifactId: string;
  readonly manifest: {
    readonly workflowVersionId: string;
    readonly irHash: string;
    readonly target: { readonly runtime: 'temporal'; readonly irVersion: number };
    readonly bindings: {
      readonly organizationId: string;
      readonly environmentId: string;
      readonly capabilityVersionIds: readonly string[];
    };
  };
  readonly compiledPlan: TemporalWorkflowArtifactManifest;
  readonly schemas: {
    readonly dialect: 'atlas-workflow-schema/v1';
    readonly input?: ObjectSchema;
    readonly stepOutputs: Readonly<Record<string, ResponseSchema>>;
  };
  readonly provenance: {
    readonly sourceFormatVersion: 'atlas-source/v1';
    readonly sourceSha256: string;
    readonly compiler: {
      readonly name: 'atlas-workflow-compiler';
      readonly version: string;
    };
    readonly compiledAt: string;
  };
  readonly approval: {
    readonly policyVersion: string;
    readonly projectionFingerprint: string;
    readonly sandboxSuiteFingerprint: string;
    readonly approvedBy: string;
    readonly approvedAt: string;
  };
  readonly signature: {
    readonly keyId: string;
    readonly algorithm: 'Ed25519';
    readonly signedAt: string;
    readonly value: string;
  };
}

export interface AtlasBundleCompileInput {
  readonly environmentId: string;
  readonly compiledPlan: TemporalWorkflowArtifactManifest;
  readonly provenance: AtlasBundleV1['provenance'];
  readonly approval: AtlasBundleV1['approval'];
  readonly signedAt: string;
  readonly contentPolicy?: {
    readonly literalClassifications: ReadonlyArray<{
      readonly stepId: string;
      readonly argument: string;
      readonly classification: 'public' | 'internal' | 'confidential' | 'secret' | 'restricted';
    }>;
  };
}

export interface AtlasBundleVerificationKey {
  readonly keyId: string;
  readonly algorithm: 'Ed25519';
  readonly publicKey: CryptoKey;
  readonly organizationIds: readonly string[];
  readonly environmentIds: readonly string[];
  readonly notBefore: string;
  readonly notAfter: string;
  readonly status: 'active' | 'retiring';
}

export interface AtlasBundleVerificationOptions {
  readonly keys: readonly AtlasBundleVerificationKey[];
  readonly revokedKeyIds?: readonly string[];
  readonly revokedArtifactIds?: readonly string[];
  readonly now?: string;
}

export interface AtlasBundleParseLimits {
  readonly maximumBytes?: number;
  readonly maximumNestingDepth?: number;
  readonly maximumObjectMembers?: number;
}

function canonicalBytes(value: unknown): Uint8Array {
  const json = canonicalize(value);
  if (json === undefined) throw new TypeError('Atlas bundle content cannot be canonicalized');
  return encoder.encode(json);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

function base64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeAtlasBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!base64UrlPattern.test(value) || value.includes('=')) {
    throw new TypeError('Atlas bundle signature is not unpadded base64url');
  }
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  if (base64Url(bytes) !== value) {
    throw new TypeError('Atlas bundle signature is not canonical base64url');
  }
  return bytes;
}

function withoutSignatureValue(bundle: AtlasBundleV1) {
  const { value: _value, ...signature } = bundle.signature;
  return { ...bundle, signature };
}

function identityContent(bundle: AtlasBundleV1) {
  const { artifactId: _artifactId, ...content } = withoutSignatureValue(bundle);
  return content;
}

function assertKeys(record: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} contains unknown or missing fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertText(value: unknown, label: string) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is invalid`);
}

function timestamp(value: unknown, label: string): bigint {
  assertText(value, label);
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
    Number(secondText) > 60 ||
    (Number(secondText) === 60 &&
      (Number(hourText) !== 23 ||
        Number(minuteText) !== 59 ||
        !((month === 6 && day === 30) || (month === 12 && day === 31))))
  ) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  const leapSecond = Number(secondText) === 60;
  const wholeSecond = (value as string).replace(/(?:\.\d{1,9})?Z$/, 'Z');
  const parsed = leapSecond
    ? Date.parse(wholeSecond.replace(':60', ':59')) + 1_000
    : Date.parse(wholeSecond);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  return BigInt(parsed) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
}

function normalizedCapabilityPins(plan: TemporalWorkflowArtifactManifest): string[] {
  return [...new Set(plan.workflow.executionRequirements.requiredCapabilityVersionIds)].sort();
}

function assertNoDuplicateJsonObjectNames(json: string) {
  let offset = 0;
  const whitespace = () => {
    while (/\s/.test(json[offset] ?? '')) offset += 1;
  };
  const string = () => {
    const start = offset;
    if (json[offset] !== '"') throw new TypeError('Atlas bundle JSON string is invalid');
    offset += 1;
    while (offset < json.length) {
      if (json[offset] === '\\') {
        offset += 2;
      } else if (json[offset] === '"') {
        offset += 1;
        return JSON.parse(json.slice(start, offset)) as string;
      } else {
        offset += 1;
      }
    }
    throw new TypeError('Atlas bundle JSON string is unterminated');
  };
  const value = (): void => {
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
        const name = string();
        if (names.has(name))
          throw new TypeError(`Atlas bundle JSON contains duplicate name '${name}'`);
        names.add(name);
        whitespace();
        if (json[offset] !== ':') throw new TypeError('Atlas bundle JSON object is invalid');
        offset += 1;
        value();
        whitespace();
        if (json[offset] === '}') {
          offset += 1;
          return;
        }
        if (json[offset] !== ',') throw new TypeError('Atlas bundle JSON object is invalid');
        offset += 1;
        whitespace();
      }
      throw new TypeError('Atlas bundle JSON object is unterminated');
    }
    if (json[offset] === '[') {
      offset += 1;
      whitespace();
      if (json[offset] === ']') {
        offset += 1;
        return;
      }
      while (offset < json.length) {
        value();
        whitespace();
        if (json[offset] === ']') {
          offset += 1;
          return;
        }
        if (json[offset] !== ',') throw new TypeError('Atlas bundle JSON array is invalid');
        offset += 1;
      }
      throw new TypeError('Atlas bundle JSON array is unterminated');
    }
    if (json[offset] === '"') {
      string();
      return;
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      json.slice(offset),
    )?.[0];
    if (!primitive) throw new TypeError('Atlas bundle JSON value is invalid');
    offset += primitive.length;
  };
  value();
  whitespace();
  if (offset !== json.length) throw new TypeError('Atlas bundle JSON has trailing content');
}

function assertCompiledPlanShape(value: unknown) {
  const plan = record(value, 'compiledPlan');
  assertKeys(
    plan,
    [
      'formatVersion',
      'artifactId',
      'workflowVersionId',
      'irHash',
      'target',
      'evidence',
      'execution',
      'workflow',
    ],
    'compiledPlan',
  );
  if (
    plan.formatVersion !== 'atlas-temporal-artifact/v1' ||
    typeof plan.artifactId !== 'string' ||
    !sha256Pattern.test(plan.artifactId) ||
    typeof plan.workflowVersionId !== 'string' ||
    !plan.workflowVersionId ||
    typeof plan.irHash !== 'string' ||
    !sha256Pattern.test(plan.irHash)
  ) {
    throw new TypeError('compiledPlan identity or format version is invalid');
  }
  const target = record(plan.target, 'compiledPlan.target');
  assertKeys(target, ['runtime', 'workflowType', 'irVersion'], 'compiledPlan.target');
  if (
    target.runtime !== 'temporal' ||
    target.workflowType !== 'interpretCompiledWorkflow' ||
    !Number.isInteger(target.irVersion) ||
    Number(target.irVersion) < 1
  ) {
    throw new TypeError('compiledPlan.target is invalid');
  }
  const evidence = record(plan.evidence, 'compiledPlan.evidence');
  assertKeys(evidence, ['sandboxSuiteFingerprint'], 'compiledPlan.evidence');
  if (
    typeof evidence.sandboxSuiteFingerprint !== 'string' ||
    !sha256Pattern.test(evidence.sandboxSuiteFingerprint)
  ) {
    throw new TypeError('compiledPlan.evidence is invalid');
  }
  const execution = record(plan.execution, 'compiledPlan.execution');
  assertKeys(execution, ['ordering', 'observability', 'steps'], 'compiledPlan.execution');
  const ordering = record(execution.ordering, 'compiledPlan.execution.ordering');
  assertKeys(ordering, ['mode', 'scope'], 'compiledPlan.execution.ordering');
  if (ordering.mode !== 'sequential' || ordering.scope !== 'workflow-run') {
    throw new TypeError('compiledPlan.execution.ordering is invalid');
  }
  const observability = record(execution.observability, 'compiledPlan.execution.observability');
  assertKeys(
    observability,
    ['stepAttempts', 'durations', 'payloads'],
    'compiledPlan.execution.observability',
  );
  if (
    observability.stepAttempts !== true ||
    observability.durations !== true ||
    observability.payloads !== 'redacted'
  ) {
    throw new TypeError('compiledPlan.execution.observability is invalid');
  }
  if (!Array.isArray(execution.steps))
    throw new TypeError('compiledPlan.execution.steps is invalid');
  for (const step of execution.steps) {
    const configured = record(step, 'compiledPlan.execution step');
    assertKeys(
      configured,
      ['stepId', 'capabilityVersionId', 'retryPolicy', 'idempotency', 'secretReference'],
      'compiledPlan.execution step',
    );
    assertText(configured.stepId, 'compiledPlan.execution step.stepId');
    assertText(configured.capabilityVersionId, 'compiledPlan.execution step.capabilityVersionId');
    if (
      configured.retryPolicy !== null &&
      !retryPolicySchema.safeParse(configured.retryPolicy).success
    ) {
      throw new TypeError('compiledPlan.execution step.retryPolicy is invalid');
    }
    if (configured.idempotency !== null) {
      const idempotency = record(configured.idempotency, 'compiledPlan.execution step.idempotency');
      assertKeys(
        idempotency,
        ['derivation', 'businessKey'],
        'compiledPlan.execution step.idempotency',
      );
      if (
        idempotency.derivation !== 'step-id-and-business-key' ||
        !valueReferenceSchema.safeParse(idempotency.businessKey).success
      ) {
        throw new TypeError('compiledPlan.execution step.idempotency is invalid');
      }
    }
    if (configured.secretReference !== null && !isSafeSecretAlias(configured.secretReference)) {
      throw new TypeError('compiledPlan.execution step.secretReference must be an opaque alias');
    }
  }
  versionedCompiledWorkflowVersionSchema.parse(plan.workflow);
}

function isUnmistakableSecret(value: unknown): boolean {
  if (typeof value === 'string') {
    return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|^(?:Bearer\s+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:gh[opusr]_|sk_(?:live|test)_)[A-Za-z0-9_-]+|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^/\s]*:[^@\s]+@)/i.test(
      value,
    );
  }
  if (Array.isArray(value)) return value.some((entry) => isUnmistakableSecret(entry));
  return (
    !!value &&
    typeof value === 'object' &&
    Object.values(value).some((entry) => isUnmistakableSecret(entry))
  );
}

function isSafeSecretAlias(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 32 || codePoint === 127;
    }) &&
    !isUnmistakableSecret(value) &&
    !value.includes('://')
  );
}

function assertSafeLiteralContent(
  plan: TemporalWorkflowArtifactManifest,
  policy: AtlasBundleCompileInput['contentPolicy'],
) {
  const classifications = new Map<string, string>();
  for (const entry of policy?.literalClassifications ?? []) {
    const key = `${entry.stepId}\0${entry.argument}`;
    if (classifications.has(key))
      throw new TypeError('Literal classification evidence is duplicated');
    classifications.set(key, entry.classification);
  }
  for (const step of plan.workflow.executable.steps) {
    for (const [argument, reference] of Object.entries(workflowStepExpressions(step))) {
      const literals = transformationLiterals(reference);
      if (literals.length === 0) continue;
      const key = `${step.id}\0${argument}`;
      const classification = classifications.get(key);
      if (!classification)
        throw new TypeError(`Literal '${step.id}.${argument}' lacks classification evidence`);
      classifications.delete(key);
      if (classification === 'secret' || classification === 'restricted') {
        throw new TypeError(
          `Atlas bundle cannot contain ${classification} literal '${step.id}.${argument}'`,
        );
      }
      if (literals.some((literal) => isUnmistakableSecret(literal))) {
        throw new TypeError(
          `Atlas bundle cannot contain credential literal '${step.id}.${argument}'`,
        );
      }
    }
  }
  if (classifications.size > 0)
    throw new TypeError('Literal classification evidence names no literal');
}

function transformationLiterals(value: unknown): unknown[] {
  const literals: unknown[] = [];
  visitTransformationExpression(value, (node) => {
    if (node.source === 'literal') literals.push(node.value);
  });
  return literals;
}

function assertBundleShape(value: unknown): asserts value is AtlasBundleV1 {
  const bundle = record(value, 'Atlas bundle');
  assertKeys(
    bundle,
    [
      'formatVersion',
      'artifactId',
      'manifest',
      'compiledPlan',
      'schemas',
      'provenance',
      'approval',
      'signature',
    ],
    'Atlas bundle',
  );
  if (bundle.formatVersion !== 'atlas-bundle/v1') throw new TypeError('Unsupported bundle version');
  if (typeof bundle.artifactId !== 'string' || !sha256Pattern.test(bundle.artifactId)) {
    throw new TypeError('Atlas bundle artifactId is invalid');
  }
  assertCompiledPlanShape(bundle.compiledPlan);
  const manifest = record(bundle.manifest, 'Atlas bundle manifest');
  assertKeys(
    manifest,
    ['workflowVersionId', 'irHash', 'target', 'bindings'],
    'Atlas bundle manifest',
  );
  assertText(manifest.workflowVersionId, 'manifest.workflowVersionId');
  if (typeof manifest.irHash !== 'string' || !sha256Pattern.test(manifest.irHash)) {
    throw new TypeError('manifest.irHash is invalid');
  }
  const target = record(manifest.target, 'manifest.target');
  assertKeys(target, ['runtime', 'irVersion'], 'manifest.target');
  if (
    target.runtime !== 'temporal' ||
    !Number.isInteger(target.irVersion) ||
    Number(target.irVersion) < 1
  ) {
    throw new TypeError('manifest.target is invalid');
  }
  const bindings = record(manifest.bindings, 'manifest.bindings');
  assertKeys(
    bindings,
    ['organizationId', 'environmentId', 'capabilityVersionIds'],
    'manifest.bindings',
  );
  assertText(bindings.organizationId, 'manifest.bindings.organizationId');
  assertText(bindings.environmentId, 'manifest.bindings.environmentId');
  if (
    !Array.isArray(bindings.capabilityVersionIds) ||
    bindings.capabilityVersionIds.some((id) => typeof id !== 'string')
  ) {
    throw new TypeError('manifest.bindings.capabilityVersionIds is invalid');
  }
  const schemas = record(bundle.schemas, 'Atlas bundle schemas');
  assertKeys(
    schemas,
    schemas.input === undefined ? ['dialect', 'stepOutputs'] : ['dialect', 'input', 'stepOutputs'],
    'Atlas bundle schemas',
  );
  if (schemas.dialect !== 'atlas-workflow-schema/v1')
    throw new TypeError('Unsupported schema dialect');
  if (schemas.input !== undefined && !objectSchemaSchema.safeParse(schemas.input).success) {
    throw new TypeError('schemas.input is not a valid closed workflow schema');
  }
  const stepOutputs = record(schemas.stepOutputs, 'schemas.stepOutputs');
  for (const [stepId, schema] of Object.entries(stepOutputs)) {
    if (!stepId || !objectSchemaSchema.safeParse(schema).success) {
      throw new TypeError(`schemas.stepOutputs.${stepId} is not a valid closed workflow schema`);
    }
  }
  const provenance = record(bundle.provenance, 'Atlas bundle provenance');
  assertKeys(
    provenance,
    ['sourceFormatVersion', 'sourceSha256', 'compiler', 'compiledAt'],
    'Atlas bundle provenance',
  );
  if (
    provenance.sourceFormatVersion !== 'atlas-source/v1' ||
    typeof provenance.sourceSha256 !== 'string' ||
    !sha256Pattern.test(provenance.sourceSha256)
  ) {
    throw new TypeError('Atlas bundle provenance is invalid');
  }
  const compiler = record(provenance.compiler, 'provenance.compiler');
  assertKeys(compiler, ['name', 'version'], 'provenance.compiler');
  if (compiler.name !== 'atlas-workflow-compiler')
    throw new TypeError('Unsupported bundle compiler');
  assertText(compiler.version, 'provenance.compiler.version');
  timestamp(provenance.compiledAt, 'provenance.compiledAt');
  const approval = record(bundle.approval, 'Atlas bundle approval');
  assertKeys(
    approval,
    [
      'policyVersion',
      'projectionFingerprint',
      'sandboxSuiteFingerprint',
      'approvedBy',
      'approvedAt',
    ],
    'Atlas bundle approval',
  );
  assertText(approval.policyVersion, 'approval.policyVersion');
  assertText(approval.approvedBy, 'approval.approvedBy');
  if (
    typeof approval.projectionFingerprint !== 'string' ||
    !sha256Pattern.test(approval.projectionFingerprint) ||
    typeof approval.sandboxSuiteFingerprint !== 'string' ||
    !sha256Pattern.test(approval.sandboxSuiteFingerprint)
  ) {
    throw new TypeError('Atlas bundle approval fingerprint is invalid');
  }
  timestamp(approval.approvedAt, 'approval.approvedAt');
  const signature = record(bundle.signature, 'Atlas bundle signature');
  assertKeys(signature, ['keyId', 'algorithm', 'signedAt', 'value'], 'Atlas bundle signature');
  assertText(signature.keyId, 'signature.keyId');
  if (signature.algorithm !== 'Ed25519')
    throw new TypeError('Unsupported bundle signature algorithm');
  timestamp(signature.signedAt, 'signature.signedAt');
  if (typeof signature.value !== 'string') throw new TypeError('Atlas bundle signature is invalid');
  decodeAtlasBase64Url(signature.value);
}

function derivedSchemas(plan: TemporalWorkflowArtifactManifest): AtlasBundleV1['schemas'] {
  const stepOutputs = Object.fromEntries(
    plan.workflow.executable.steps.flatMap((step) =>
      'responseSchema' in step && step.responseSchema ? [[step.id, step.responseSchema]] : [],
    ),
  );
  const input = plan.workflow.executable.inputSchema;
  return input
    ? { dialect: 'atlas-workflow-schema/v1', input, stepOutputs }
    : { dialect: 'atlas-workflow-schema/v1', stepOutputs };
}

export function createNonProductionLocalEd25519Signer(
  keyId: string,
  privateKey: CryptoKey,
): AtlasBundleSigner {
  if (!keyId) throw new TypeError('A local demo signer requires a keyId');
  return {
    keyId,
    algorithm: 'Ed25519',
    async sign(content) {
      return new Uint8Array(
        await globalThis.crypto.subtle.sign('Ed25519', privateKey, new Uint8Array(content).buffer),
      );
    },
  };
}

export async function compileAtlasBundle(
  input: AtlasBundleCompileInput,
  signer: AtlasBundleSigner,
): Promise<{
  readonly bundle: AtlasBundleV1;
  readonly bytes: Uint8Array;
  readonly unsignedBytes: Uint8Array;
}> {
  if (!input.environmentId) throw new TypeError('Atlas bundle environmentId is required');
  if (!signer.keyId || signer.algorithm !== 'Ed25519')
    throw new TypeError('Atlas bundle signer is invalid');
  const plan = await verifyTemporalWorkflowArtifact(input.compiledPlan);
  assertSafeLiteralContent(plan, input.contentPolicy);
  const capabilityVersionIds = normalizedCapabilityPins(plan);
  if (
    canonicalize(capabilityVersionIds) !==
    canonicalize(plan.workflow.executionRequirements.requiredCapabilityVersionIds)
  ) {
    throw new TypeError('Compiled workflow capability pins must be sorted and unique');
  }
  if (input.approval.sandboxSuiteFingerprint !== plan.evidence.sandboxSuiteFingerprint) {
    throw new TypeError('Approval sandbox fingerprint does not match the compiled plan');
  }
  const partial = {
    formatVersion: 'atlas-bundle/v1' as const,
    manifest: {
      workflowVersionId: plan.workflowVersionId,
      irHash: plan.irHash,
      target: { runtime: 'temporal' as const, irVersion: plan.target.irVersion },
      bindings: {
        organizationId: plan.workflow.executionRequirements.organizationId,
        environmentId: input.environmentId,
        capabilityVersionIds,
      },
    },
    compiledPlan: plan,
    schemas: derivedSchemas(plan),
    provenance: input.provenance,
    approval: input.approval,
    signature: {
      keyId: signer.keyId,
      algorithm: signer.algorithm,
      signedAt: input.signedAt,
      value: '',
    },
  };
  const provisional = { artifactId: '0'.repeat(64), ...partial } satisfies AtlasBundleV1;
  const unsignedBytes = canonicalBytes(identityContent(provisional));
  const artifactId = await sha256Hex(unsignedBytes);
  const unsignedBundle = { ...provisional, artifactId };
  const signedBytes = concat(domain, canonicalBytes(withoutSignatureValue(unsignedBundle)));
  const signature = await signer.sign(signedBytes);
  if (signature.byteLength !== 64)
    throw new TypeError('Ed25519 signer returned an invalid signature');
  const bundle: AtlasBundleV1 = {
    ...unsignedBundle,
    signature: { ...unsignedBundle.signature, value: base64Url(signature) },
  };
  assertBundleShape(bundle);
  return { bundle, bytes: canonicalBytes(bundle), unsignedBytes };
}

export function inspectAtlasBundle(
  bytes: Uint8Array | string,
  limits: AtlasBundleParseLimits = {},
): AtlasBundleV1 {
  const supplied = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  const maximumBytes = limits.maximumBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    supplied.byteLength > maximumBytes
  ) {
    throw new TypeError('Atlas bundle exceeds the configured size limit');
  }
  if (
    (supplied[0] === 0x50 && supplied[1] === 0x4b) ||
    (supplied[0] === 0x1f && supplied[1] === 0x8b)
  ) {
    throw new TypeError('Atlas bundle compressed or archive containers are not supported');
  }
  let value: unknown;
  try {
    const json = decoder.decode(supplied);
    assertNoDuplicateJsonObjectNames(json);
    value = JSON.parse(json);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith('Atlas bundle JSON')) throw error;
    throw new TypeError('Atlas bundle is not valid UTF-8 JSON');
  }
  assertJsonComplexity(value, limits);
  assertBundleShape(value);
  const canonical = canonicalBytes(value);
  if (
    canonical.length !== supplied.length ||
    canonical.some((byte, index) => byte !== supplied[index])
  ) {
    throw new TypeError('Atlas bundle bytes are not canonical JCS');
  }
  return value;
}

function assertJsonComplexity(value: unknown, limits: AtlasBundleParseLimits) {
  const maximumNestingDepth = limits.maximumNestingDepth ?? 64;
  const maximumObjectMembers = limits.maximumObjectMembers ?? 20_000;
  if (
    !Number.isSafeInteger(maximumNestingDepth) ||
    maximumNestingDepth < 1 ||
    !Number.isSafeInteger(maximumObjectMembers) ||
    maximumObjectMembers < 1
  ) {
    throw new TypeError('Atlas bundle parse limits are invalid');
  }
  let members = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > maximumNestingDepth) throw new TypeError('Atlas bundle exceeds the nesting limit');
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      members += current.length;
      if (members > maximumObjectMembers)
        throw new TypeError('Atlas bundle exceeds the member-count limit');
      for (const entry of current) visit(entry, depth + 1);
      return;
    }
    const entries = Object.values(current);
    members += entries.length;
    if (members > maximumObjectMembers)
      throw new TypeError('Atlas bundle exceeds the member-count limit');
    for (const entry of entries) visit(entry, depth + 1);
  };
  visit(value, 1);
}

export async function verifyAtlasBundle(
  bytes: Uint8Array | string,
  options: AtlasBundleVerificationOptions,
  parseLimits?: AtlasBundleParseLimits,
): Promise<AtlasBundleV1> {
  const bundle = inspectAtlasBundle(bytes, parseLimits);
  const digest = await sha256Hex(canonicalBytes(identityContent(bundle)));
  if (digest !== bundle.artifactId) throw new TypeError('Atlas bundle content digest is invalid');
  if (options.revokedArtifactIds?.includes(bundle.artifactId))
    throw new TypeError('Atlas bundle is revoked');
  if (options.revokedKeyIds?.includes(bundle.signature.keyId))
    throw new TypeError('Atlas bundle signing key is revoked');
  const key = options.keys.find((candidate) => candidate.keyId === bundle.signature.keyId);
  if (!key || key.algorithm !== 'Ed25519')
    throw new TypeError('Atlas bundle signing key is not trusted');
  const now = timestamp(options.now ?? new Date().toISOString(), 'verification time');
  const notBefore = timestamp(key.notBefore, 'key.notBefore');
  const notAfter = timestamp(key.notAfter, 'key.notAfter');
  const signedAt = timestamp(bundle.signature.signedAt, 'signature.signedAt');
  if (now < notBefore || now > notAfter || signedAt < notBefore || signedAt > notAfter) {
    throw new TypeError('Atlas bundle signing key is outside its trust window');
  }
  if (
    !key.organizationIds.includes(bundle.manifest.bindings.organizationId) ||
    !key.environmentIds.includes(bundle.manifest.bindings.environmentId)
  ) {
    throw new TypeError(
      'Atlas bundle signing key is not authorized for this tenant and environment',
    );
  }
  const valid = await globalThis.crypto.subtle.verify(
    'Ed25519',
    key.publicKey,
    new Uint8Array(decodeAtlasBase64Url(bundle.signature.value)).buffer,
    new Uint8Array(concat(domain, canonicalBytes(withoutSignatureValue(bundle)))).buffer,
  );
  if (!valid) throw new TypeError('Atlas bundle signature is invalid');
  const plan = await verifyTemporalWorkflowArtifact(bundle.compiledPlan);
  const requiredPins = normalizedCapabilityPins(plan);
  const expectedSchemas = derivedSchemas(plan);
  const bindingsAgree =
    bundle.manifest.workflowVersionId === plan.workflowVersionId &&
    bundle.manifest.workflowVersionId === plan.workflow.workflowVersionId &&
    bundle.manifest.irHash === plan.irHash &&
    bundle.manifest.irHash === plan.workflow.irHash &&
    bundle.manifest.irHash === plan.workflow.executionRequirements.irHash &&
    bundle.manifest.target.irVersion === plan.target.irVersion &&
    bundle.manifest.target.irVersion === plan.workflow.executable.irVersion &&
    bundle.manifest.bindings.organizationId ===
      plan.workflow.executionRequirements.organizationId &&
    canonicalize(bundle.manifest.bindings.capabilityVersionIds) === canonicalize(requiredPins) &&
    bundle.approval.sandboxSuiteFingerprint === plan.evidence.sandboxSuiteFingerprint &&
    canonicalize(bundle.schemas) === canonicalize(expectedSchemas);
  if (!bindingsAgree) throw new TypeError('Atlas bundle duplicated bindings do not agree');
  return bundle;
}
