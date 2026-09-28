import { generateExecutionGrantKeyPair, issueExecutionGrant } from '@atlas/execution-grant';
import { createMockServicesApp } from '@atlas/mock-services';
import {
  compileAtlasBundle,
  compileTemporalWorkflowArtifact,
  createNonProductionLocalEd25519Signer,
  type AtlasBundleApprovalBinding,
  type AtlasBundleVerificationKey,
} from '@atlas/workflow-artifact';
import {
  createCompiledWorkflowVersion,
  createTransformationCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import { evaluateTransformationArguments } from '@atlas/temporal-adapter';
import type { JsonValue, VersionedCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  createAtlasBundleRunGate,
  type AtlasBundleVerificationAuditEvent,
} from './bundle-run-gate.js';

async function fixture() {
  const workflow = await createCompiledWorkflowVersion('payment@1', 'org_atlas', {
    irVersion: 1,
    steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
  });
  const compiledPlan = await compileTemporalWorkflowArtifact(workflow, {
    sandboxSuiteFingerprint: 'a'.repeat(64),
    secretReferencesByCapabilityVersion: {},
  });
  const signingKeys = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const result = await compileAtlasBundle(
    {
      environmentId: 'production',
      compiledPlan,
      provenance: {
        sourceFormatVersion: 'atlas-source/v1',
        sourceSha256: 'b'.repeat(64),
        compiler: { name: 'atlas-workflow-compiler', version: '1.0.0' },
        compiledAt: '2026-08-19T12:00:00Z',
      },
      approval: {
        policyVersion: 'policy/v1',
        projectionFingerprint: 'c'.repeat(64),
        sandboxSuiteFingerprint: 'a'.repeat(64),
        approvedBy: 'admin@example.com',
        approvedAt: '2026-08-19T12:01:00Z',
      },
      signedAt: '2026-08-19T12:02:00Z',
    },
    createNonProductionLocalEd25519Signer('bundle-key', signingKeys.privateKey),
  );
  const key: AtlasBundleVerificationKey = {
    keyId: 'bundle-key',
    algorithm: 'Ed25519',
    publicKey: signingKeys.publicKey,
    organizationIds: ['org_atlas'],
    environmentIds: ['production'],
    notBefore: '2026-08-19T00:00:00Z',
    notAfter: '2026-09-19T00:00:00Z',
    status: 'active',
  };
  const approval: AtlasBundleApprovalBinding = {
    artifactId: result.bundle.artifactId,
    organizationId: 'org_atlas',
    environmentId: 'production',
    workflowVersionId: 'payment@1',
    irHash: result.bundle.manifest.irHash,
    policyVersion: 'policy/v1',
    projectionFingerprint: 'c'.repeat(64),
    sandboxSuiteFingerprint: 'a'.repeat(64),
    status: 'active',
  };
  const grantKeys = await generateExecutionGrantKeyPair();
  const grant = await issueExecutionGrant(grantKeys.privateKey, {
    organizationId: 'org_atlas',
    environmentId: 'production',
    runId: 'run_1',
    workflowVersionId: 'payment@1',
    irHash: result.bundle.manifest.irHash,
    approvedCapabilityVersionIds: [],
    approvedHostnames: [],
  });
  return { result, key, approval, grantKeys, grant };
}

async function grantWith(
  context: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Parameters<typeof issueExecutionGrant>[1]>,
) {
  return issueExecutionGrant(context.grantKeys.privateKey, {
    organizationId: 'org_atlas',
    environmentId: 'production',
    runId: 'run_1',
    workflowVersionId: 'payment@1',
    irHash: context.result.bundle.manifest.irHash,
    approvedCapabilityVersionIds: [],
    approvedHostnames: [],
    ...overrides,
  });
}

describe('customer worker bundle run gate', () => {
  it('verifies a bundle and its live policy before permitting Temporal start', async () => {
    const { result, key, approval, grantKeys, grant } = await fixture();
    const audit = vi.fn<(event: AtlasBundleVerificationAuditEvent) => void>();
    const startTemporal = vi.fn<
      (workflow: VersionedCompiledWorkflowVersion) => Promise<VersionedCompiledWorkflowVersion>
    >(async (workflow) => workflow);
    const gate = createAtlasBundleRunGate({
      worker: {
        organizationId: 'org_atlas',
        environmentId: 'production',
        minimumIrVersion: 1,
        maximumIrVersion: 1,
      },
      grantPublicKey: grantKeys.publicKey,
      trust: { keys: [key], now: '2026-08-20T00:00:00Z' },
      loadBundle: async () => result.bytes,
      loadPolicy: async () => ({ activationArtifactId: result.bundle.artifactId, approval }),
      recordAuditEvent: audit,
    });

    await expect(
      gate.startVerifiedTemporalRun(
        {
          artifactId: result.bundle.artifactId,
          runId: 'run_1',
          grant,
        },
        startTemporal,
      ),
    ).resolves.toEqual(result.bundle.compiledPlan.workflow);
    expect(startTemporal).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith({
      eventType: 'atlas-bundle-verification',
      outcome: 'accepted',
      artifactId: result.bundle.artifactId,
      organizationId: 'org_atlas',
      environmentId: 'production',
    });
  });

  it('records a payload-free rejection and never permits the Temporal boundary', async () => {
    const { result, key, approval, grantKeys, grant } = await fixture();
    const audit = vi.fn<(event: AtlasBundleVerificationAuditEvent) => void>();
    const startTemporal = vi.fn<() => Promise<void>>(async () => undefined);
    const gate = createAtlasBundleRunGate({
      worker: {
        organizationId: 'org_atlas',
        environmentId: 'production',
        minimumIrVersion: 1,
        maximumIrVersion: 1,
      },
      grantPublicKey: grantKeys.publicKey,
      trust: {
        keys: [key],
        revokedArtifactIds: [result.bundle.artifactId],
        now: '2026-08-20T00:00:00Z',
      },
      loadBundle: async () => result.bytes,
      loadPolicy: async () => ({ activationArtifactId: result.bundle.artifactId, approval }),
      recordAuditEvent: audit,
    });

    await expect(
      gate.startVerifiedTemporalRun(
        {
          artifactId: result.bundle.artifactId,
          runId: 'run_1',
          grant,
        },
        startTemporal,
      ),
    ).rejects.toThrow('Bundle verification rejected');
    expect(startTemporal).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      eventType: 'atlas-bundle-verification',
      outcome: 'rejected',
      reason: 'policy-or-integrity-check-failed',
      artifactId: result.bundle.artifactId,
      organizationId: 'org_atlas',
      environmentId: 'production',
    });
    expect(JSON.stringify(audit.mock.calls)).not.toContain('payment');
  });

  it.each([
    [
      'a grant reused for another run',
      async (context: Awaited<ReturnType<typeof fixture>>) => ({
        runId: 'run_2',
        grant: context.grant,
      }),
    ],
    [
      'a grant for another tenant',
      async (context: Awaited<ReturnType<typeof fixture>>) => ({
        grant: await grantWith(context, { organizationId: 'other' }),
      }),
    ],
    [
      'a grant for Development',
      async (context: Awaited<ReturnType<typeof fixture>>) => ({
        grant: await grantWith(context, { environmentId: 'development' }),
      }),
    ],
    [
      'a grant for the retired environment',
      async (context: Awaited<ReturnType<typeof fixture>>) => ({
        grant: await grantWith(context, { environmentId: 'production-like' }),
      }),
    ],
    [
      'a grant for another workflow version',
      async (context: Awaited<ReturnType<typeof fixture>>) => ({
        grant: await grantWith(context, { workflowVersionId: 'payment@2' }),
      }),
    ],
    [
      'a grant for another IR hash',
      async (context: Awaited<ReturnType<typeof fixture>>) => ({
        grant: await grantWith(context, { irHash: 'f'.repeat(64) }),
      }),
    ],
    [
      'a grant with substituted capability pins',
      async (context: Awaited<ReturnType<typeof fixture>>) => ({
        grant: await grantWith(context, { approvedCapabilityVersionIds: ['billing.fake@1'] }),
      }),
    ],
    [
      'a revoked approval',
      async (context: Awaited<ReturnType<typeof fixture>>) => ({
        approval: { ...context.approval, status: 'revoked' as const },
      }),
    ],
    ['a rolled-back activation', async () => ({ activationArtifactId: 'f'.repeat(64) })],
  ])('rejects %s before Temporal start', async (_label, arrange) => {
    const context = await fixture();
    const changed = await arrange(context);
    const audit = vi.fn<(event: AtlasBundleVerificationAuditEvent) => void>();
    const startTemporal = vi.fn<() => Promise<void>>(async () => undefined);
    const gate = createAtlasBundleRunGate({
      worker: {
        organizationId: 'org_atlas',
        environmentId: 'production',
        minimumIrVersion: 1,
        maximumIrVersion: 1,
      },
      grantPublicKey: context.grantKeys.publicKey,
      trust: { keys: [context.key], now: '2026-08-20T00:00:00Z' },
      loadBundle: async () => context.result.bytes,
      loadPolicy: async () => ({
        activationArtifactId:
          'activationArtifactId' in changed
            ? changed.activationArtifactId
            : context.result.bundle.artifactId,
        approval: 'approval' in changed ? changed.approval : context.approval,
      }),
      recordAuditEvent: audit,
    });

    await expect(
      gate.startVerifiedTemporalRun(
        {
          artifactId: context.result.bundle.artifactId,
          runId: 'runId' in changed && typeof changed.runId === 'string' ? changed.runId : 'run_1',
          grant: 'grant' in changed ? changed.grant : context.grant,
        },
        startTemporal,
      ),
    ).rejects.toThrow('Bundle verification rejected');
    expect(startTemporal).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith({
      eventType: 'atlas-bundle-verification',
      outcome: 'rejected',
      reason: 'policy-or-integrity-check-failed',
      artifactId: context.result.bundle.artifactId,
      organizationId: 'org_atlas',
      environmentId: 'production',
    });
  });

  it('executes the incompatible Payment-to-Billing mapping only after verification and blocks a one-byte edit', async () => {
    const workflow = await createTransformationCompiledWorkflowVersion(
      'api-mapping-demo@1',
      'org_atlas',
      {
        irVersion: 2,
        inputSchema: { required: { paymentId: { type: 'string' } } },
        steps: [
          {
            id: 'get-payment',
            kind: 'capabilityCall',
            capabilityVersionId: 'payment.get@sha256:v1',
            inputSchema: { required: { paymentId: { type: 'string' } } },
            arguments: { paymentId: { source: 'input', path: ['paymentId'] } },
          },
          {
            id: 'settle-billing',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.settle@sha256:v3',
            inputSchema: {
              required: {
                invoiceId: { type: 'string' },
                payment: {
                  type: 'object',
                  required: {
                    amount: { type: 'number' },
                    currency: { type: 'string' },
                  },
                },
                notification: {
                  type: 'object',
                  required: { address: { type: 'string' } },
                },
              },
            },
            arguments: {
              invoiceId: {
                source: 'stepOutput',
                stepId: 'get-payment',
                path: ['invoice_id'],
              },
              payment: {
                kind: 'object',
                fields: {
                  amount: {
                    kind: 'call',
                    function: 'divide',
                    arguments: [
                      {
                        source: 'stepOutput',
                        stepId: 'get-payment',
                        path: ['amount_cents'],
                      },
                      { source: 'literal', value: 100 },
                    ],
                  },
                  currency: {
                    kind: 'call',
                    function: 'uppercase',
                    arguments: [
                      { source: 'stepOutput', stepId: 'get-payment', path: ['currency'] },
                    ],
                  },
                },
              },
              notification: {
                kind: 'object',
                fields: {
                  address: {
                    source: 'stepOutput',
                    stepId: 'get-payment',
                    path: ['customer', 'notification_email'],
                  },
                },
              },
            },
          },
        ],
      },
    );
    const plan = await compileTemporalWorkflowArtifact(workflow, {
      sandboxSuiteFingerprint: 'd'.repeat(64),
      secretReferencesByCapabilityVersion: {},
    });
    const signingKeys = (await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const signed = await compileAtlasBundle(
      {
        environmentId: 'production',
        compiledPlan: plan,
        provenance: {
          sourceFormatVersion: 'atlas-source/v1',
          sourceSha256: 'e'.repeat(64),
          compiler: { name: 'atlas-workflow-compiler', version: '1' },
          compiledAt: '2026-08-19T12:00:00Z',
        },
        approval: {
          policyVersion: 'policy/v1',
          projectionFingerprint: 'f'.repeat(64),
          sandboxSuiteFingerprint: 'd'.repeat(64),
          approvedBy: 'admin@example.com',
          approvedAt: '2026-08-19T12:01:00Z',
        },
        signedAt: '2026-08-19T12:02:00Z',
        contentPolicy: {
          literalClassifications: [
            { stepId: 'settle-billing', argument: 'payment', classification: 'public' },
          ],
        },
      },
      createNonProductionLocalEd25519Signer('mapping-key', signingKeys.privateKey),
    );
    const grantKeys = await generateExecutionGrantKeyPair();
    const grant = await issueExecutionGrant(grantKeys.privateKey, {
      organizationId: 'org_atlas',
      environmentId: 'production',
      runId: 'mapping-run',
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      approvedCapabilityVersionIds: workflow.executionRequirements.requiredCapabilityVersionIds,
      approvedHostnames: [],
    });
    const approval: AtlasBundleApprovalBinding = {
      artifactId: signed.bundle.artifactId,
      organizationId: 'org_atlas',
      environmentId: 'production',
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      policyVersion: 'policy/v1',
      projectionFingerprint: 'f'.repeat(64),
      sandboxSuiteFingerprint: 'd'.repeat(64),
      status: 'active',
    };
    let servedBytes = signed.bytes;
    const provider = createMockServicesApp();
    let acceptedAudits = 0;
    let rejectedAudits = 0;
    const gate = createAtlasBundleRunGate({
      worker: {
        organizationId: 'org_atlas',
        environmentId: 'production',
        minimumIrVersion: 1,
        maximumIrVersion: 2,
      },
      grantPublicKey: grantKeys.publicKey,
      trust: {
        keys: [
          {
            keyId: 'mapping-key',
            algorithm: 'Ed25519',
            publicKey: signingKeys.publicKey,
            organizationIds: ['org_atlas'],
            environmentIds: ['production'],
            notBefore: '2026-08-19T00:00:00Z',
            notAfter: '2026-09-19T00:00:00Z',
            status: 'active',
          },
        ],
        now: '2026-08-20T00:00:00Z',
      },
      loadBundle: async () => servedBytes,
      loadPolicy: async () => ({ activationArtifactId: signed.bundle.artifactId, approval }),
      recordAuditEvent: (event) => {
        if (event.outcome === 'accepted') acceptedAudits += 1;
        else rejectedAudits += 1;
      },
    });
    const startedAt = Date.now();
    await gate.startVerifiedTemporalRun(
      { artifactId: signed.bundle.artifactId, runId: 'mapping-run', grant },
      async (verifiedWorkflow) => {
        const destination = verifiedWorkflow.executable.steps[1];
        if (!destination || destination.kind === 'terminal' || !('inputSchema' in destination)) {
          throw new Error('Expected the verified transformation step');
        }
        const paymentResponse = await provider.request('/mapping-demo/payments/pay_123');
        expect(paymentResponse.ok).toBe(true);
        const payment = (await paymentResponse.json()) as Record<string, JsonValue>;
        const request = evaluateTransformationArguments(destination.arguments, {
          input: { paymentId: 'pay_123' },
          stepOutputs: { 'get-payment': payment },
        });
        const response = await provider.request('/mapping-demo/billing/settlements', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });
        expect(response.status).toBe(202);
      },
    );
    const observations = (await (await provider.request('/__control/observations')).json()) as {
      mappingDemoBillingRequests: Array<{ request: unknown; providerDurationMs: number }>;
    };
    expect(observations.mappingDemoBillingRequests[0]?.request).toEqual({
      invoiceId: 'inv_456',
      payment: { amount: 12.5, currency: 'USD' },
      notification: { address: 'ops@example.test' },
    });
    expect(observations.mappingDemoBillingRequests[0]?.providerDurationMs).toBeGreaterThanOrEqual(
      18,
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(18);
    expect(acceptedAudits).toBe(1);

    servedBytes = signed.bytes.slice();
    servedBytes[servedBytes.length - 2] = servedBytes[servedBytes.length - 2]! ^ 1;
    await expect(
      gate.startVerifiedTemporalRun(
        { artifactId: signed.bundle.artifactId, runId: 'mapping-run', grant },
        async () => {
          await provider.request('/mapping-demo/billing/settlements', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
        },
      ),
    ).rejects.toThrow('Bundle verification rejected');
    const afterTamper = (await (await provider.request('/__control/observations')).json()) as {
      mappingDemoBillingRequests: unknown[];
    };
    expect(afterTamper.mappingDemoBillingRequests).toHaveLength(1);
    expect(rejectedAudits).toBe(1);
  });
});
