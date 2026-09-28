import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { generateExecutionGrantKeyPair, issueExecutionGrant } from '@atlas/execution-grant';
import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';

import {
  compileAtlasBundle,
  compileTemporalWorkflowArtifact,
  createNonProductionLocalEd25519Signer,
  inspectAtlasBundle,
  verifyAtlasBundle,
  verifyAtlasBundleForNewRun,
  verifyAtlasBundleForReplay,
  type AtlasBundleCompileInput,
  type AtlasBundleV1,
  type AtlasBundleVerificationKey,
} from './index.js';

async function fixture() {
  const workflow = await createCompiledWorkflowVersion('invoice@1', 'org_atlas', {
    irVersion: 1,
    inputSchema: { required: { invoiceId: { type: 'string' } } },
    steps: [
      {
        id: 'settle',
        kind: 'capabilityCall',
        capabilityVersionId: 'billing.settle@1',
        arguments: { invoiceId: { source: 'input', path: ['invoiceId'] } },
        responseSchema: { required: { receiptId: { type: 'string' } } },
      },
      { id: 'done', kind: 'terminal', state: 'completed' },
    ],
  });
  const compiledPlan = await compileTemporalWorkflowArtifact(workflow, {
    sandboxSuiteFingerprint: 'a'.repeat(64),
    secretReferencesByCapabilityVersion: { 'billing.settle@1': 'billing-demo' },
  });
  const { privateKey, publicKey } = (await globalThis.crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const signer = createNonProductionLocalEd25519Signer('demo-2026-08', privateKey);
  const input: AtlasBundleCompileInput = {
    environmentId: 'env_demo',
    compiledPlan,
    provenance: {
      sourceFormatVersion: 'atlas-source/v1',
      sourceSha256: 'b'.repeat(64),
      compiler: { name: 'atlas-workflow-compiler', version: '1.0.0' },
      compiledAt: '2026-08-19T12:00:00.000Z',
    },
    approval: {
      policyVersion: 'policy/v1',
      projectionFingerprint: 'c'.repeat(64),
      sandboxSuiteFingerprint: 'a'.repeat(64),
      approvedBy: 'operator@example.com',
      approvedAt: '2026-08-19T12:01:00.000Z',
    },
    signedAt: '2026-08-19T12:02:00.000Z',
  };
  const key: AtlasBundleVerificationKey = {
    keyId: 'demo-2026-08',
    algorithm: 'Ed25519',
    publicKey,
    organizationIds: ['org_atlas'],
    environmentIds: ['env_demo'],
    notBefore: '2026-08-19T00:00:00.000Z',
    notAfter: '2026-09-19T00:00:00.000Z',
    status: 'active',
  };
  return { input, signer, key };
}

describe('Atlas bundle v1', () => {
  it('signs and verifies a bundle scoped to canonical Production trust', async () => {
    const { input, signer, key } = await fixture();
    const result = await compileAtlasBundle({ ...input, environmentId: 'production' }, signer);
    const productionKey = { ...key, environmentIds: ['production'] };

    await expect(
      verifyAtlasBundle(result.bytes, {
        keys: [productionKey],
        now: '2026-08-20T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({
      manifest: { bindings: { environmentId: 'production' } },
    });
    await expect(
      verifyAtlasBundle(result.bytes, {
        keys: [{ ...key, environmentIds: ['production-like'] }],
        now: '2026-08-20T00:00:00.000Z',
      }),
    ).rejects.toThrow('not authorized');
  });

  it('assembles identical approved inputs into identical canonical bytes and digest', async () => {
    const { input, signer } = await fixture();
    const first = await compileAtlasBundle(input, signer);
    const second = await compileAtlasBundle(input, signer);

    expect(first.bytes).toEqual(second.bytes);
    expect(first.bundle.artifactId).toBe(second.bundle.artifactId);
    expect(first.bundle.manifest.bindings).toEqual({
      organizationId: 'org_atlas',
      environmentId: 'env_demo',
      capabilityVersionIds: ['billing.settle@1'],
    });
    expect(first.bundle.schemas.stepOutputs).toEqual({
      settle: { required: { receiptId: { type: 'string' } } },
    });
  });

  it('inspects and verifies canonical bundles while rejecting any changed byte', async () => {
    const { input, signer, key } = await fixture();
    const result = await compileAtlasBundle(input, signer);
    expect(inspectAtlasBundle(result.bytes)).toEqual(result.bundle);
    await expect(
      verifyAtlasBundle(result.bytes, { keys: [key], now: '2026-08-20T00:00:00.000Z' }),
    ).resolves.toEqual(result.bundle);

    const changed = result.bytes.slice();
    changed[changed.length - 4] = changed[changed.length - 4] === 65 ? 66 : 65;
    await expect(
      verifyAtlasBundle(changed, { keys: [key], now: '2026-08-20T00:00:00.000Z' }),
    ).rejects.toThrow('signature');
    expect(() =>
      inspectAtlasBundle(new TextEncoder().encode(` ${new TextDecoder().decode(result.bytes)}`)),
    ).toThrow('canonical');
  });

  it('supports overlap rotation and rejects keys outside their trust window', async () => {
    const { input, signer, key } = await fixture();
    const result = await compileAtlasBundle(input, signer);
    const replacementPair = (await globalThis.crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const replacement = {
      ...key,
      keyId: 'replacement',
      publicKey: replacementPair.publicKey,
      status: 'active' as const,
    };
    await expect(
      verifyAtlasBundle(result.bytes, {
        keys: [{ ...key, status: 'retiring' }, replacement],
        now: '2026-08-20T00:00:00.000Z',
      }),
    ).resolves.toEqual(result.bundle);
    await expect(
      verifyAtlasBundle(result.bytes, {
        keys: [{ ...key, notAfter: '2026-08-19T23:59:59.000Z' }],
        now: '2026-08-20T00:00:00.000Z',
      }),
    ).rejects.toThrow('trust window');
    const replacementBundle = await compileAtlasBundle(
      { ...input, signedAt: '2026-08-20T00:00:00.000Z' },
      createNonProductionLocalEd25519Signer('replacement', replacementPair.privateKey),
    );
    await expect(
      verifyAtlasBundle(replacementBundle.bytes, {
        keys: [{ ...key, status: 'retiring' }, replacement],
        now: '2026-08-20T00:00:00.000Z',
      }),
    ).resolves.toEqual(replacementBundle.bundle);

    const exactBoundaryKey = { ...key, notAfter: '2026-08-20T00:00:00.000000001Z' };
    await expect(
      verifyAtlasBundle(result.bytes, {
        keys: [exactBoundaryKey],
        now: '2026-08-20T00:00:00.000000001Z',
      }),
    ).resolves.toEqual(result.bundle);
    await expect(
      verifyAtlasBundle(result.bytes, {
        keys: [exactBoundaryKey],
        now: '2026-08-20T00:00:00.000000002Z',
      }),
    ).rejects.toThrow('trust window');
  });

  it('rejects non-UTC timestamps, duplicate JSON names, and malformed nested schemas', async () => {
    const { input, signer } = await fixture();
    await expect(
      compileAtlasBundle({ ...input, signedAt: '2026-08-19T07:02:00-05:00' }, signer),
    ).rejects.toThrow('UTC');
    await expect(
      compileAtlasBundle({ ...input, signedAt: '2026-02-30T12:02:00Z' }, signer),
    ).rejects.toThrow('UTC');
    await expect(
      compileAtlasBundle({ ...input, signedAt: '2026-06-30T23:59:60Z' }, signer),
    ).resolves.toBeDefined();

    const result = await compileAtlasBundle(input, signer);
    const json = new TextDecoder().decode(result.bytes);
    expect(() =>
      inspectAtlasBundle(json.replace('{', '{"formatVersion":"atlas-bundle/v1",')),
    ).toThrow('duplicate');
    const malformed = JSON.parse(json) as Record<string, unknown>;
    const schemas = malformed.schemas as Record<string, unknown>;
    schemas.input = { required: {}, unknown: true };
    expect(() => inspectAtlasBundle(JSON.stringify(malformed))).toThrow('schema');
    const unknownPlan = JSON.parse(json) as Record<string, unknown>;
    (unknownPlan.compiledPlan as Record<string, unknown>).formatVersion =
      'atlas-temporal-artifact/v2';
    expect(() => inspectAtlasBundle(JSON.stringify(unknownPlan))).toThrow('format version');
  });

  it('refuses credential and private-key literals even in otherwise valid compiled plans', async () => {
    const { input, signer } = await fixture();
    const workflow = await createCompiledWorkflowVersion('credential@1', 'org_atlas', {
      irVersion: 1,
      steps: [
        {
          id: 'send',
          kind: 'capabilityCall',
          capabilityVersionId: 'billing.settle@1',
          arguments: { apiToken: { source: 'literal', value: 'customer-secret' } },
        },
      ],
    });
    const compiledPlan = await compileTemporalWorkflowArtifact(workflow, {
      sandboxSuiteFingerprint: 'a'.repeat(64),
      secretReferencesByCapabilityVersion: {},
    });
    await expect(
      compileAtlasBundle(
        {
          ...input,
          compiledPlan,
          contentPolicy: {
            literalClassifications: [
              { stepId: 'send', argument: 'apiToken', classification: 'secret' },
            ],
          },
        },
        signer,
      ),
    ).rejects.toThrow('secret literal');
    const leakedReference = await compileTemporalWorkflowArtifact(input.compiledPlan.workflow, {
      sandboxSuiteFingerprint: 'a'.repeat(64),
      secretReferencesByCapabilityVersion: {
        'billing.settle@1': 'postgres://user:password@database/atlas',
      },
    });
    await expect(
      compileAtlasBundle({ ...input, compiledPlan: leakedReference }, signer),
    ).rejects.toThrow('opaque alias');
  });

  it('rejects independently modified plan, manifest, schema, provenance, and signature fixtures', async () => {
    const { input, signer, key } = await fixture();
    const result = await compileAtlasBundle(input, signer);
    const mutations: Array<(bundle: AtlasBundleV1) => AtlasBundleV1> = [
      (bundle) => ({
        ...bundle,
        compiledPlan: { ...bundle.compiledPlan, workflowVersionId: 'substituted@1' },
      }),
      (bundle) => ({
        ...bundle,
        manifest: {
          ...bundle.manifest,
          bindings: { ...bundle.manifest.bindings, environmentId: 'production' },
        },
      }),
      (bundle) => ({ ...bundle, schemas: { ...bundle.schemas, stepOutputs: {} } }),
      (bundle) => ({
        ...bundle,
        provenance: {
          ...bundle.provenance,
          compiler: { ...bundle.provenance.compiler, version: 'substituted' },
        },
      }),
      (bundle) => ({
        ...bundle,
        signature: {
          ...bundle.signature,
          value: `${bundle.signature.value[0] === 'A' ? 'B' : 'A'}${bundle.signature.value.slice(1)}`,
        },
      }),
    ];

    for (const mutate of mutations) {
      const changed = mutate(result.bundle);
      await expect(
        verifyAtlasBundle(canonicalize(changed)!, {
          keys: [key],
          now: '2026-08-20T00:00:00.000Z',
        }),
      ).rejects.toThrow('Atlas bundle');
    }
  });
});

describe('Atlas bundle execution policy', () => {
  it('authorizes a current bundle only when approval, activation, grant, and worker scope agree', async () => {
    const { input, signer, key } = await fixture();
    const result = await compileAtlasBundle(input, signer);
    const grantKeys = await generateExecutionGrantKeyPair();
    const grant = await issueExecutionGrant(grantKeys.privateKey, {
      organizationId: 'org_atlas',
      environmentId: 'env_demo',
      runId: 'run_1',
      workflowVersionId: 'invoice@1',
      irHash: result.bundle.manifest.irHash,
      approvedCapabilityVersionIds: ['billing.settle@1'],
      approvedHostnames: ['billing.internal'],
    });
    const approval = {
      artifactId: result.bundle.artifactId,
      organizationId: 'org_atlas',
      environmentId: 'env_demo',
      workflowVersionId: 'invoice@1',
      irHash: result.bundle.manifest.irHash,
      policyVersion: 'policy/v1',
      projectionFingerprint: 'c'.repeat(64),
      sandboxSuiteFingerprint: 'a'.repeat(64),
      status: 'active' as const,
    };

    await expect(
      verifyAtlasBundleForNewRun(result.bytes, {
        trust: { keys: [key], now: '2026-08-20T00:00:00.000Z' },
        worker: {
          organizationId: 'org_atlas',
          environmentId: 'env_demo',
          minimumIrVersion: 1,
          maximumIrVersion: 1,
        },
        requestedArtifactId: result.bundle.artifactId,
        activationArtifactId: result.bundle.artifactId,
        approval,
        grant,
        grantPublicKey: grantKeys.publicKey,
        runId: 'run_1',
      }),
    ).resolves.toEqual(result.bundle);

    for (const policy of [
      { requestedArtifactId: 'e'.repeat(64) },
      { activationArtifactId: 'f'.repeat(64) },
      { approval: { ...approval, status: 'revoked' as const } },
      { approval: { ...approval, artifactId: 'e'.repeat(64) } },
      { approval: { ...approval, organizationId: 'other' } },
      { approval: { ...approval, environmentId: 'production' } },
      { approval: { ...approval, workflowVersionId: 'invoice@2' } },
      { approval: { ...approval, irHash: 'e'.repeat(64) } },
      { approval: { ...approval, policyVersion: 'policy/v2' } },
      { approval: { ...approval, projectionFingerprint: 'e'.repeat(64) } },
      { approval: { ...approval, sandboxSuiteFingerprint: 'e'.repeat(64) } },
      {
        worker: {
          organizationId: 'other',
          environmentId: 'env_demo',
          minimumIrVersion: 1,
          maximumIrVersion: 1,
        },
      },
      {
        worker: {
          organizationId: 'org_atlas',
          environmentId: 'production',
          minimumIrVersion: 1,
          maximumIrVersion: 1,
        },
      },
      {
        worker: {
          organizationId: 'org_atlas',
          environmentId: 'env_demo',
          minimumIrVersion: 2,
          maximumIrVersion: 2,
        },
      },
    ]) {
      await expect(
        verifyAtlasBundleForNewRun(result.bytes, {
          trust: { keys: [key], now: '2026-08-20T00:00:00.000Z' },
          worker: {
            organizationId: 'org_atlas',
            environmentId: 'env_demo',
            minimumIrVersion: 1,
            maximumIrVersion: 1,
          },
          requestedArtifactId: result.bundle.artifactId,
          activationArtifactId: result.bundle.artifactId,
          approval,
          grant,
          grantPublicKey: grantKeys.publicKey,
          runId: 'run_1',
          ...policy,
        }),
      ).rejects.toThrow('Atlas bundle');
    }
  });

  it('blocks revoked bundles for new runs but preserves replay of the run-pinned immutable bundle', async () => {
    const { input, signer, key } = await fixture();
    const result = await compileAtlasBundle(input, signer);
    const grantKeys = await generateExecutionGrantKeyPair();
    const grant = await issueExecutionGrant(grantKeys.privateKey, {
      organizationId: 'org_atlas',
      environmentId: 'env_demo',
      runId: 'run_after_revocation',
      workflowVersionId: 'invoice@1',
      irHash: result.bundle.manifest.irHash,
      approvedCapabilityVersionIds: ['billing.settle@1'],
      approvedHostnames: ['billing.internal'],
    });
    const common = {
      trust: {
        keys: [{ ...key, notAfter: '2026-08-19T23:00:00.000Z' }],
        revokedArtifactIds: [result.bundle.artifactId],
        revokedKeyIds: [key.keyId],
        now: '2026-09-20T00:00:00.000Z',
      },
      worker: {
        organizationId: 'org_atlas',
        environmentId: 'env_demo',
        minimumIrVersion: 2,
        maximumIrVersion: 2,
      },
      pinnedArtifactId: result.bundle.artifactId,
    } as const;

    await expect(
      verifyAtlasBundleForNewRun(result.bytes, {
        trust: common.trust,
        worker: common.worker,
        requestedArtifactId: result.bundle.artifactId,
        activationArtifactId: result.bundle.artifactId,
        approval: {
          artifactId: result.bundle.artifactId,
          organizationId: 'org_atlas',
          environmentId: 'env_demo',
          workflowVersionId: 'invoice@1',
          irHash: result.bundle.manifest.irHash,
          policyVersion: 'policy/v1',
          projectionFingerprint: 'c'.repeat(64),
          sandboxSuiteFingerprint: 'a'.repeat(64),
          status: 'active',
        },
        grant,
        grantPublicKey: grantKeys.publicKey,
        runId: 'run_after_revocation',
      }),
    ).rejects.toThrow('revoked');

    const replayed = await verifyAtlasBundleForReplay(result.bytes, common);
    expect(replayed).toEqual(result.bundle);
    expect(replayed.manifest).toMatchObject({
      workflowVersionId: 'invoice@1',
      irHash: result.bundle.manifest.irHash,
      bindings: {
        organizationId: 'org_atlas',
        environmentId: 'env_demo',
        capabilityVersionIds: ['billing.settle@1'],
      },
    });
    expect(replayed.approval).toEqual(result.bundle.approval);
  });

  it('fails closed on oversized or compressed containers before parsing JSON', async () => {
    const { input, signer } = await fixture();
    const result = await compileAtlasBundle(input, signer);
    expect(() => inspectAtlasBundle(result.bytes, { maximumBytes: 32 })).toThrow('size limit');
    expect(() => inspectAtlasBundle(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toThrow(
      'compressed',
    );
  });
});
