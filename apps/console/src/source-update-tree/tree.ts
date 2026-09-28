import type { ChangeClassification } from '../changes/changes.js';

export type SourceUpdateClassification = ChangeClassification;

export type SourceUpdateCoverage = 'mapped' | 'potential' | 'unmapped';

export interface SourceUpdatePotentialCoverage {
  operationId: string;
  fieldPath?: string;
}

export interface SourceUpdatePin {
  workflowVersionId: string;
  stepId: string;
}

export interface SourceUpdateFieldChange {
  kind: string;
  path?: string;
  fromPath?: string;
  classification: SourceUpdateClassification;
}

export interface SourceUpdateChangeInput {
  fromCapabilityVersionId: string;
  toCapabilityVersionId?: string | null;
  classification: SourceUpdateClassification;
  fieldChanges?: readonly SourceUpdateFieldChange[];
  affectedWorkflows: readonly SourceUpdatePin[];
  potentialCoverage?: SourceUpdatePotentialCoverage | null;
}

export interface SourceUpdateWorkflowNode {
  workflowVersionId: string;
  coverage: SourceUpdateCoverage;
  steps: string[];
}

export interface SourceUpdateCapabilityNode {
  capabilityVersionId: string;
  coverage: SourceUpdateCoverage;
  workflowVersions: SourceUpdateWorkflowNode[];
}

export interface SourceUpdateTree {
  serviceId: string;
  coverage: SourceUpdateCoverage;
  capabilityVersions: SourceUpdateCapabilityNode[];
}

function isNotFullyCompatible(changes: readonly SourceUpdateChangeInput[]): boolean {
  return changes.some(
    (change) => change.classification === 'breaking' || change.classification === 'conditional',
  );
}

const unmappedFieldKinds = new Set(['removed', 'added-required', 'retyped']);

const coverageRank: Record<SourceUpdateCoverage, number> = {
  mapped: 0,
  potential: 1,
  unmapped: 2,
};

function worseCoverage(
  left: SourceUpdateCoverage,
  right: SourceUpdateCoverage,
): SourceUpdateCoverage {
  return coverageRank[left] >= coverageRank[right] ? left : right;
}

function rollupCoverage(
  nodes: readonly { coverage: SourceUpdateCoverage }[],
): SourceUpdateCoverage {
  return nodes.reduce<SourceUpdateCoverage>(
    (coverage, node) => worseCoverage(coverage, node.coverage),
    'mapped',
  );
}

function hasVerifiedHint(change: SourceUpdateChangeInput): boolean {
  return Boolean(change.potentialCoverage?.operationId);
}

function fieldChangeUnmapped(change: SourceUpdateFieldChange): boolean {
  return change.classification === 'breaking' || unmappedFieldKinds.has(change.kind);
}

function changeCoverage(change: SourceUpdateChangeInput): SourceUpdateCoverage {
  if (change.toCapabilityVersionId === null || change.toCapabilityVersionId === '') {
    return hasVerifiedHint(change) ? 'potential' : 'unmapped';
  }
  if (change.classification === 'breaking' || change.fieldChanges?.some(fieldChangeUnmapped)) {
    return hasVerifiedHint(change) ? 'potential' : 'unmapped';
  }
  return 'mapped';
}

function groupPins(
  pins: readonly SourceUpdatePin[],
): Array<{ workflowVersionId: string; steps: string[] }> {
  const workflows: Array<{ workflowVersionId: string; steps: string[] }> = [];
  const byVersion = new Map<string, { workflowVersionId: string; steps: string[] }>();
  for (const pin of pins) {
    const existing = byVersion.get(pin.workflowVersionId);
    if (existing) {
      if (!existing.steps.includes(pin.stepId)) existing.steps.push(pin.stepId);
      continue;
    }
    const node = { workflowVersionId: pin.workflowVersionId, steps: [pin.stepId] };
    byVersion.set(pin.workflowVersionId, node);
    workflows.push(node);
  }
  return workflows;
}

export function buildSourceUpdateTree(input: {
  serviceId: string;
  changes: readonly SourceUpdateChangeInput[];
}): SourceUpdateTree | null {
  if (!isNotFullyCompatible(input.changes)) return null;

  const capabilityVersions: SourceUpdateCapabilityNode[] = [];
  const byCapability = new Map<
    string,
    { pins: SourceUpdatePin[]; coverage: SourceUpdateCoverage }
  >();
  for (const change of input.changes) {
    const coverage = changeCoverage(change);
    const existing = byCapability.get(change.fromCapabilityVersionId);
    if (!existing) {
      byCapability.set(change.fromCapabilityVersionId, {
        pins: [...change.affectedWorkflows],
        coverage,
      });
      continue;
    }
    existing.pins.push(...change.affectedWorkflows);
    existing.coverage = worseCoverage(existing.coverage, coverage);
  }

  for (const [capabilityVersionId, { pins, coverage }] of byCapability) {
    const workflowVersions = groupPins(pins);
    if (workflowVersions.length === 0) continue;
    capabilityVersions.push({
      capabilityVersionId,
      coverage,
      workflowVersions: workflowVersions.map((workflow) => ({ ...workflow, coverage })),
    });
  }

  return {
    serviceId: input.serviceId,
    coverage: rollupCoverage(capabilityVersions),
    capabilityVersions,
  };
}
