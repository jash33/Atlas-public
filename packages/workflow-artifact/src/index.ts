import canonicalize from 'canonicalize';

import {
  versionedCompiledWorkflowVersionSchema,
  isCapabilityStep,
  verifyCompiledWorkflowVersionIntegrity,
  type VersionedCompiledWorkflowVersion,
  type RetryPolicy,
  type ValueReference,
} from '@atlas/workflow-ir';

export interface TemporalWorkflowArtifactManifest {
  readonly formatVersion: 'atlas-temporal-artifact/v1';
  readonly artifactId: string;
  readonly workflowVersionId: string;
  readonly irHash: string;
  readonly target: {
    readonly runtime: 'temporal';
    readonly workflowType: 'interpretCompiledWorkflow';
    readonly irVersion: number;
  };
  readonly evidence: { readonly sandboxSuiteFingerprint: string };
  readonly execution: {
    readonly ordering: { readonly mode: 'sequential'; readonly scope: 'workflow-run' };
    readonly observability: {
      readonly stepAttempts: true;
      readonly durations: true;
      readonly payloads: 'redacted';
    };
    readonly steps: ReadonlyArray<{
      readonly stepId: string;
      readonly capabilityVersionId: string;
      readonly retryPolicy: RetryPolicy | null;
      readonly idempotency: {
        readonly derivation: 'step-id-and-business-key';
        readonly businessKey: ValueReference;
      } | null;
      readonly secretReference: string | null;
    }>;
  };
  readonly workflow: VersionedCompiledWorkflowVersion;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function compileTemporalWorkflowArtifact(
  workflow: VersionedCompiledWorkflowVersion,
  input: {
    readonly sandboxSuiteFingerprint: string;
    readonly secretReferencesByCapabilityVersion: Readonly<Record<string, string>>;
  },
): Promise<TemporalWorkflowArtifactManifest> {
  const verifiedWorkflow = await verifyCompiledWorkflowVersionIntegrity(workflow);
  const content = {
    formatVersion: 'atlas-temporal-artifact/v1' as const,
    workflowVersionId: verifiedWorkflow.workflowVersionId,
    irHash: verifiedWorkflow.irHash,
    target: {
      runtime: 'temporal' as const,
      workflowType: 'interpretCompiledWorkflow' as const,
      irVersion: verifiedWorkflow.executable.irVersion,
    },
    evidence: { sandboxSuiteFingerprint: input.sandboxSuiteFingerprint },
    execution: {
      ordering: { mode: 'sequential' as const, scope: 'workflow-run' as const },
      observability: {
        stepAttempts: true as const,
        durations: true as const,
        payloads: 'redacted' as const,
      },
      steps: verifiedWorkflow.executable.steps.flatMap((step) =>
        !isCapabilityStep(step)
          ? []
          : [
              {
                stepId: step.id,
                capabilityVersionId: step.capabilityVersionId,
                retryPolicy: step.retryPolicy ?? null,
                idempotency: step.idempotency
                  ? {
                      derivation: 'step-id-and-business-key' as const,
                      businessKey: step.idempotency.businessKey,
                    }
                  : null,
                secretReference:
                  input.secretReferencesByCapabilityVersion[step.capabilityVersionId] ?? null,
              },
            ],
      ),
    },
    workflow: verifiedWorkflow,
  };
  const json = canonicalize(content);
  if (json === undefined) throw new TypeError('Temporal artifact cannot be canonicalized');
  return { artifactId: await sha256Hex(json), ...content };
}

export async function verifyTemporalWorkflowArtifact(
  value: unknown,
  expectedArtifactId?: string,
): Promise<TemporalWorkflowArtifactManifest> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Temporal artifact must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.artifactId !== 'string' ||
    typeof record.workflowVersionId !== 'string' ||
    typeof record.irHash !== 'string' ||
    !record.evidence ||
    typeof record.evidence !== 'object' ||
    !record.execution ||
    typeof record.execution !== 'object'
  ) {
    throw new TypeError('Temporal artifact manifest is incomplete');
  }
  if (expectedArtifactId && record.artifactId !== expectedArtifactId) {
    throw new TypeError('Temporal artifact identity does not match the requested artifact');
  }
  const evidence = record.evidence as Record<string, unknown>;
  const execution = record.execution as Record<string, unknown>;
  if (typeof evidence.sandboxSuiteFingerprint !== 'string' || !Array.isArray(execution.steps)) {
    throw new TypeError('Temporal artifact evidence or execution configuration is invalid');
  }
  const workflow = await verifyCompiledWorkflowVersionIntegrity(
    versionedCompiledWorkflowVersionSchema.parse(record.workflow),
  );
  const secretReferencesByCapabilityVersion = Object.fromEntries(
    execution.steps.flatMap((step) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
      const configured = step as Record<string, unknown>;
      return typeof configured.capabilityVersionId === 'string' &&
        typeof configured.secretReference === 'string'
        ? [[configured.capabilityVersionId, configured.secretReference]]
        : [];
    }),
  );
  const expected = await compileTemporalWorkflowArtifact(workflow, {
    sandboxSuiteFingerprint: evidence.sandboxSuiteFingerprint,
    secretReferencesByCapabilityVersion,
  });
  if (canonicalize(expected) !== canonicalize(value)) {
    throw new TypeError('Temporal artifact manifest does not match its reproducible identity');
  }
  return expected;
}

export * from './atlas-bundle.js';
export * from './atlas-bundle-execution.js';
export * from './atlas-trust-set.js';
