import {
  decodeAtlasBase64Url,
  type AtlasBundleApprovalBinding,
  type AtlasBundleVerificationKey,
} from '@atlas/workflow-artifact';

import { createAtlasBundleRunGate } from './bundle-run-gate.js';
import type { BackendExecutionScope } from './backend-execution.js';

interface SerializedTrustKey extends Omit<AtlasBundleVerificationKey, 'publicKey'> {
  readonly publicKey: string;
}

interface SerializedTrustConfig {
  readonly keys: readonly SerializedTrustKey[];
  readonly revokedKeyIds?: readonly string[];
  readonly revokedArtifactIds?: readonly string[];
}

export async function createBackendAtlasBundleRunGate(
  options: BackendExecutionScope & {
    readonly grantPublicKey: string;
    readonly trustConfigJson: string;
    readonly fetch?: typeof globalThis.fetch;
  },
) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const trust = await parseTrustConfig(options.trustConfigJson);
  const request = async (path: string) => {
    const url = new URL(path, options.backendUrl);
    url.searchParams.set('organizationId', options.organizationId);
    url.searchParams.set('environmentId', options.environmentId);
    const response = await fetchImplementation(url, {
      headers: { authorization: `Bearer ${options.workerToken}` },
    });
    if (!response.ok) throw new Error(`Bundle verification source rejected (${response.status})`);
    return response;
  };
  return createAtlasBundleRunGate({
    worker: {
      organizationId: options.organizationId,
      environmentId: options.environmentId,
      minimumIrVersion: 2,
      maximumIrVersion: 3,
    },
    grantPublicKey: options.grantPublicKey,
    trust,
    async loadBundle(artifactId) {
      const response = await request(`/v1/workflow-bundles/${encodeURIComponent(artifactId)}`);
      return new Uint8Array(await response.arrayBuffer());
    },
    async loadPolicy(artifactId) {
      const response = await request(
        `/v1/workflow-bundles/${encodeURIComponent(artifactId)}/execution-policy`,
      );
      return parseExecutionPolicy(await response.json());
    },
    async recordAuditEvent(event) {
      const response = await fetchImplementation(
        new URL('/v1/bundle-verification-events', options.backendUrl),
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.workerToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(event),
        },
      );
      if (!response.ok) throw new Error(`Bundle audit rejected (${response.status})`);
    },
  });
}

async function parseTrustConfig(json: string) {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || !Array.isArray(value.keys)) {
    throw new TypeError('ATLAS_BUNDLE_TRUST_CONFIG is invalid');
  }
  const serialized = value as unknown as SerializedTrustConfig;
  const keys = await Promise.all(
    serialized.keys.map(async (key) => {
      if (
        !key ||
        typeof key !== 'object' ||
        typeof key.publicKey !== 'string' ||
        key.algorithm !== 'Ed25519'
      ) {
        throw new TypeError('ATLAS_BUNDLE_TRUST_CONFIG key is invalid');
      }
      return {
        ...key,
        publicKey: await crypto.subtle.importKey(
          'spki',
          decodeAtlasBase64Url(key.publicKey),
          'Ed25519',
          false,
          ['verify'],
        ),
      } satisfies AtlasBundleVerificationKey;
    }),
  );
  return {
    keys,
    ...(serialized.revokedKeyIds ? { revokedKeyIds: serialized.revokedKeyIds } : {}),
    ...(serialized.revokedArtifactIds ? { revokedArtifactIds: serialized.revokedArtifactIds } : {}),
  };
}

function parseExecutionPolicy(value: unknown): {
  activationArtifactId: string;
  approval: AtlasBundleApprovalBinding;
} {
  if (
    !isRecord(value) ||
    typeof value.activationArtifactId !== 'string' ||
    !isRecord(value.approval)
  ) {
    throw new TypeError('Bundle execution policy is invalid');
  }
  const approval = value.approval;
  const fields = [
    'artifactId',
    'organizationId',
    'environmentId',
    'workflowVersionId',
    'irHash',
    'policyVersion',
    'projectionFingerprint',
    'sandboxSuiteFingerprint',
  ] as const;
  if (
    fields.some((field) => typeof approval[field] !== 'string') ||
    (approval.status !== 'active' && approval.status !== 'revoked')
  ) {
    throw new TypeError('Bundle approval policy is invalid');
  }
  return {
    activationArtifactId: value.activationArtifactId,
    approval: approval as unknown as AtlasBundleApprovalBinding,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
