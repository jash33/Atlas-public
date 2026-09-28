// Pure mappers from backend payloads to Home dashboard widget summaries.

import type { ChangeClassification } from '../changes/changes.js';

export interface CatalogCapability {
  capabilityVersionId: string;
  identity: {
    kind: 'openapi' | 'asyncapi';
    serviceId: string;
    operationId: string;
    channelAddress?: string;
    messageKey?: string;
  };
  annotation: { owner: string } | null;
  provenance: { repository: string; commit: string; sourceDocument: string };
}

export type DiscoveryTrigger = 'repository-push' | 'daily-poll' | 'run-drift';

export interface CapabilityDiscovery {
  discoveryId: string;
  serviceId: string;
  trigger: DiscoveryTrigger;
  discoveredAt: string;
}

export type DriftClassification = ChangeClassification;

export interface DiscoveryFieldChange {
  kind: string;
  path: string;
  fromPath?: string;
  classification: DriftClassification;
}

export interface DiscoveryPotentialCoverage {
  operationId: string;
  fieldPath?: string;
}

export interface DiscoveryChange {
  fromCapabilityVersionId: string;
  toCapabilityVersionId: string | null;
  changeKind?: 'version-change' | 'removal';
  classification: DriftClassification;
  fieldChanges?: DiscoveryFieldChange[];
  affectedWorkflows: Array<{ workflowVersionId: string; stepId: string }>;
  potentialCoverage?: DiscoveryPotentialCoverage | null;
}

export interface CapabilityDiscoveryDetail extends CapabilityDiscovery {
  changes: DiscoveryChange[];
}

export interface CapabilityHealthSummary {
  totalCapabilities: number;
  annotatedCapabilities: number;
  missingAnnotation: number;
  services: Array<{ serviceId: string; capabilityCount: number; annotatedCount: number }>;
  latestDiscovery: { serviceId: string; trigger: DiscoveryTrigger; discoveredAt: string } | null;
}

export function summarizeCapabilityHealth(
  capabilities: CatalogCapability[],
  discoveries: CapabilityDiscovery[],
): CapabilityHealthSummary {
  const services = new Map<string, { capabilityCount: number; annotatedCount: number }>();
  let annotated = 0;
  for (const capability of capabilities) {
    const service = services.get(capability.identity.serviceId) ?? {
      capabilityCount: 0,
      annotatedCount: 0,
    };
    service.capabilityCount += 1;
    if (capability.annotation) {
      service.annotatedCount += 1;
      annotated += 1;
    }
    services.set(capability.identity.serviceId, service);
  }
  let latestDiscovery: CapabilityHealthSummary['latestDiscovery'] = null;
  for (const discovery of discoveries) {
    if (!latestDiscovery || discovery.discoveredAt > latestDiscovery.discoveredAt) {
      latestDiscovery = {
        serviceId: discovery.serviceId,
        trigger: discovery.trigger,
        discoveredAt: discovery.discoveredAt,
      };
    }
  }
  return {
    totalCapabilities: capabilities.length,
    annotatedCapabilities: annotated,
    missingAnnotation: capabilities.length - annotated,
    services: [...services.entries()]
      .map(([serviceId, counts]) => ({ serviceId, ...counts }))
      .sort((left, right) => left.serviceId.localeCompare(right.serviceId)),
    latestDiscovery,
  };
}

export type DriftSeverity = DriftClassification | 'unknown';

export interface DriftSummary {
  severity: DriftSeverity;
  counts: Record<DriftClassification, number>;
  affectedWorkflowVersionCount: number;
  latestChange: {
    serviceId: string;
    classification: DriftClassification;
    discoveredAt: string;
  } | null;
}

const severityOrder: DriftClassification[] = ['breaking', 'conditional', 'metadata', 'compatible'];

export function summarizeDrift(details: CapabilityDiscoveryDetail[]): DriftSummary {
  const counts: Record<DriftClassification, number> = {
    breaking: 0,
    conditional: 0,
    metadata: 0,
    compatible: 0,
  };
  const affectedVersions = new Set<string>();
  let latestChange: DriftSummary['latestChange'] = null;
  for (const detail of details) {
    for (const change of detail.changes) {
      counts[change.classification] += 1;
      for (const dependency of change.affectedWorkflows) {
        affectedVersions.add(dependency.workflowVersionId);
      }
      if (!latestChange || detail.discoveredAt > latestChange.discoveredAt) {
        latestChange = {
          serviceId: detail.serviceId,
          classification: change.classification,
          discoveredAt: detail.discoveredAt,
        };
      }
    }
  }
  const severity =
    details.length === 0
      ? 'unknown'
      : (severityOrder.find((classification) => counts[classification] > 0) ?? 'compatible');
  return {
    severity,
    counts,
    affectedWorkflowVersionCount: affectedVersions.size,
    latestChange,
  };
}

export type RunState =
  | 'running'
  | 'completed'
  | 'validation_failed'
  | 'manual_review'
  | 'repair_required';

export interface WorkflowRun {
  runId: string;
  workflowVersionId: string;
  paymentId: string;
  state: RunState;
  startedAt: string;
}

export interface RunAttentionSummary {
  total: number;
  counts: { repair_required: number; manual_review: number; validation_failed: number };
  mostRecent: WorkflowRun | null;
}

export function summarizeRunAttention(runs: WorkflowRun[]): RunAttentionSummary {
  const counts = { repair_required: 0, manual_review: 0, validation_failed: 0 };
  let mostRecent: WorkflowRun | null = null;
  for (const run of runs) {
    if (run.state in counts) counts[run.state as keyof typeof counts] += 1;
    if (!mostRecent || run.startedAt > mostRecent.startedAt) mostRecent = run;
  }
  return { total: runs.length, counts, mostRecent };
}

export interface WorkflowVersionSummary {
  workflowVersionId: string;
  irHash: string;
  status: 'approved' | 'superseded' | 'current';
  approvedBy: string;
  approvedAt: string;
  runs: Array<{ runId: string }>;
}

export interface ReviewAttentionSummary {
  currentVersion: {
    workflowVersionId: string;
    approvedBy: string;
    approvedAt: string;
    runCount: number;
  } | null;
  totalVersions: number;
  capabilitiesAwaitingAnnotation: number;
}

export function summarizeReviewAttention(
  versions: WorkflowVersionSummary[],
  capabilities: CatalogCapability[],
): ReviewAttentionSummary {
  const current = versions.find((version) => version.status === 'current') ?? null;
  return {
    currentVersion: current
      ? {
          workflowVersionId: current.workflowVersionId,
          approvedBy: current.approvedBy,
          approvedAt: current.approvedAt,
          runCount: current.runs.length,
        }
      : null,
    totalVersions: versions.length,
    capabilitiesAwaitingAnnotation: capabilities.filter(
      (capability) => capability.annotation === null,
    ).length,
  };
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const elapsedMs = now.getTime() - new Date(iso).getTime();
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
