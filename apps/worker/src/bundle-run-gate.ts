import type { ExecutionGrant } from '@atlas/execution-grant';
import {
  verifyAtlasBundleForNewRun,
  type AtlasBundleApprovalBinding,
  type AtlasBundleVerificationOptions,
  type AtlasBundleWorkerScope,
} from '@atlas/workflow-artifact';
import type { VersionedCompiledWorkflowVersion } from '@atlas/workflow-ir';

export interface AtlasBundleVerificationAuditEvent {
  readonly eventType: 'atlas-bundle-verification';
  readonly outcome: 'accepted' | 'rejected';
  readonly reason?: 'policy-or-integrity-check-failed';
  readonly artifactId?: string;
  readonly organizationId: string;
  readonly environmentId: string;
}

export class AtlasBundleRunRejected extends Error {
  constructor() {
    super('Bundle verification rejected before Temporal start');
    this.name = 'AtlasBundleRunRejected';
  }
}

export function createAtlasBundleRunGate(options: {
  readonly worker: AtlasBundleWorkerScope;
  readonly grantPublicKey: string;
  readonly trust: AtlasBundleVerificationOptions;
  readonly loadBundle: (artifactId: string) => Promise<Uint8Array | string>;
  readonly loadPolicy: (artifactId: string) => Promise<{
    readonly activationArtifactId: string;
    readonly approval: AtlasBundleApprovalBinding;
  }>;
  readonly recordAuditEvent: (event: AtlasBundleVerificationAuditEvent) => Promise<void> | void;
}) {
  return {
    async startVerifiedTemporalRun<Result>(
      input: {
        readonly artifactId: string;
        readonly runId: string;
        readonly grant: ExecutionGrant;
      },
      startTemporal: (workflow: VersionedCompiledWorkflowVersion) => Promise<Result>,
    ) {
      const safeArtifactId = /^[a-f0-9]{64}$/.test(input.artifactId) ? input.artifactId : undefined;
      let workflow: VersionedCompiledWorkflowVersion;
      try {
        if (!safeArtifactId) throw new TypeError('Artifact identity is invalid');
        const [bytes, policy] = await Promise.all([
          options.loadBundle(safeArtifactId),
          options.loadPolicy(safeArtifactId),
        ]);
        const bundle = await verifyAtlasBundleForNewRun(bytes, {
          trust: options.trust,
          worker: options.worker,
          requestedArtifactId: safeArtifactId,
          activationArtifactId: policy.activationArtifactId,
          approval: policy.approval,
          grant: input.grant,
          grantPublicKey: options.grantPublicKey,
          runId: input.runId,
        });
        await options.recordAuditEvent({
          eventType: 'atlas-bundle-verification',
          outcome: 'accepted',
          artifactId: bundle.artifactId,
          organizationId: options.worker.organizationId,
          environmentId: options.worker.environmentId,
        });
        workflow = bundle.compiledPlan.workflow;
      } catch {
        try {
          await options.recordAuditEvent({
            eventType: 'atlas-bundle-verification',
            outcome: 'rejected',
            reason: 'policy-or-integrity-check-failed',
            ...(safeArtifactId ? { artifactId: safeArtifactId } : {}),
            organizationId: options.worker.organizationId,
            environmentId: options.worker.environmentId,
          });
        } catch {
          // Audit transport errors must not turn a rejected bundle into an accepted run.
        }
        throw new AtlasBundleRunRejected();
      }
      return await startTemporal(workflow);
    },
  };
}
