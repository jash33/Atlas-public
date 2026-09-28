import { verifyExecutionGrant, type ExecutionGrant } from '@atlas/execution-grant';

import {
  inspectAtlasBundle,
  verifyAtlasBundle,
  type AtlasBundleParseLimits,
  type AtlasBundleV1,
  type AtlasBundleVerificationOptions,
} from './atlas-bundle.js';

export interface AtlasBundleApprovalBinding {
  readonly artifactId: string;
  readonly organizationId: string;
  readonly environmentId: string;
  readonly workflowVersionId: string;
  readonly irHash: string;
  readonly policyVersion: string;
  readonly projectionFingerprint: string;
  readonly sandboxSuiteFingerprint: string;
  readonly status: 'active' | 'revoked';
}

export interface AtlasBundleWorkerScope {
  readonly organizationId: string;
  readonly environmentId: string;
  readonly minimumIrVersion: number;
  readonly maximumIrVersion: number;
}

export interface AtlasBundleNewRunVerification {
  readonly trust: AtlasBundleVerificationOptions;
  readonly worker: AtlasBundleWorkerScope;
  readonly requestedArtifactId: string;
  readonly activationArtifactId: string;
  readonly approval: AtlasBundleApprovalBinding;
  readonly grant: ExecutionGrant;
  readonly grantPublicKey: string;
  readonly runId: string;
  readonly parseLimits?: AtlasBundleParseLimits;
}

export interface AtlasBundleReplayVerification {
  readonly trust: AtlasBundleVerificationOptions;
  readonly worker: AtlasBundleWorkerScope;
  readonly pinnedArtifactId: string;
  readonly parseLimits?: AtlasBundleParseLimits;
}

export async function verifyAtlasBundleForNewRun(
  bytes: Uint8Array | string,
  verification: AtlasBundleNewRunVerification,
): Promise<AtlasBundleV1> {
  const bundle = await verifyAtlasBundle(bytes, verification.trust, verification.parseLimits);
  assertWorkerIdentity(bundle, verification.worker);
  assertSupportedIrVersion(bundle, verification.worker);
  if (bundle.artifactId !== verification.requestedArtifactId) {
    throw new TypeError('Atlas bundle does not match the requested artifact');
  }
  if (bundle.artifactId !== verification.activationArtifactId) {
    throw new TypeError('Atlas bundle is not the currently activated artifact');
  }
  const approval = verification.approval;
  const approvalMatches =
    approval.status === 'active' &&
    approval.artifactId === bundle.artifactId &&
    approval.organizationId === bundle.manifest.bindings.organizationId &&
    approval.environmentId === bundle.manifest.bindings.environmentId &&
    approval.workflowVersionId === bundle.manifest.workflowVersionId &&
    approval.irHash === bundle.manifest.irHash &&
    approval.policyVersion === bundle.approval.policyVersion &&
    approval.projectionFingerprint === bundle.approval.projectionFingerprint &&
    approval.sandboxSuiteFingerprint === bundle.approval.sandboxSuiteFingerprint;
  if (!approvalMatches)
    throw new TypeError('Atlas bundle approval binding is not active and exact');
  await verifyExecutionGrant(verification.grantPublicKey, verification.grant, {
    organizationId: verification.worker.organizationId,
    environmentId: verification.worker.environmentId,
    runId: verification.runId,
    workflowVersionId: bundle.manifest.workflowVersionId,
    irHash: bundle.manifest.irHash,
    requiredCapabilityVersionIds: bundle.manifest.bindings.capabilityVersionIds,
  });
  return bundle;
}

export async function verifyAtlasBundleForReplay(
  bytes: Uint8Array | string,
  verification: AtlasBundleReplayVerification,
): Promise<AtlasBundleV1> {
  const inspected = inspectAtlasBundle(bytes, verification.parseLimits);
  const bundle = await verifyAtlasBundle(
    bytes,
    {
      ...verification.trust,
      revokedArtifactIds: [],
      revokedKeyIds: [],
      now: inspected.signature.signedAt,
    },
    verification.parseLimits,
  );
  assertWorkerIdentity(bundle, verification.worker);
  if (bundle.artifactId !== verification.pinnedArtifactId) {
    throw new TypeError('Atlas bundle does not match the run-pinned artifact');
  }
  return bundle;
}

function assertWorkerIdentity(bundle: AtlasBundleV1, worker: AtlasBundleWorkerScope) {
  if (
    bundle.manifest.bindings.organizationId !== worker.organizationId ||
    bundle.manifest.bindings.environmentId !== worker.environmentId
  ) {
    throw new TypeError('Atlas bundle tenant or environment does not match this worker');
  }
}

function assertSupportedIrVersion(bundle: AtlasBundleV1, worker: AtlasBundleWorkerScope) {
  if (
    bundle.manifest.target.irVersion < worker.minimumIrVersion ||
    bundle.manifest.target.irVersion > worker.maximumIrVersion
  ) {
    throw new TypeError('Atlas bundle IR version is outside this worker supported range');
  }
}
