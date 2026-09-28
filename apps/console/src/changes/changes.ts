export type ChangeClassification = 'compatible' | 'conditional' | 'breaking' | 'metadata';

export type ChangeClassificationTone = 'good' | 'warn' | 'bad' | 'quiet';

export const changeClassifications: ChangeClassification[] = [
  'breaking',
  'compatible',
  'metadata',
  'conditional',
];

export const changeClassificationTone: Record<ChangeClassification, ChangeClassificationTone> = {
  breaking: 'bad',
  conditional: 'warn',
  compatible: 'good',
  metadata: 'quiet',
};

export const changeClassificationCopy: Record<
  ChangeClassification,
  { label: string; summary: string }
> = {
  breaking: {
    label: 'Incompatible contract',
    summary: 'The declared contract is structurally incompatible; new intake is quarantined.',
  },
  conditional: {
    label: 'Needs review',
    summary:
      'The available contract or runtime evidence is not enough for a structural classification.',
  },
  compatible: {
    label: 'Compatible contract',
    summary: 'The declared contract has only structurally compatible additions.',
  },
  metadata: {
    label: 'Metadata changed',
    summary: 'Only descriptive annotations in the declared contract changed.',
  },
};

export const contractClassificationScope =
  'Classifications compare the registered OpenAPI or AsyncAPI operation fragment and its referenced schemas. They do not inspect service source code, prove runtime behavior, or prove that a deployment matches its declared contract. Runtime-only evidence needs review.';

export interface FieldChange {
  kind: string;
  path: string;
  fromPath?: string;
  classification: ChangeClassification;
}

export interface FieldChangePresentation {
  title: string;
  field: string;
  before: string;
  after: string;
}

export interface AffectedWorkflow {
  workflowVersionId: string;
  stepId: string;
}

export interface PotentialCoverageHint {
  operationId: string;
  fieldPath?: string;
}

export interface DiscoveredChange {
  fromCapabilityVersionId: string;
  toCapabilityVersionId: string;
  classification: ChangeClassification;
  fieldChanges: FieldChange[];
  affectedWorkflows: AffectedWorkflow[];
  organizationAffectedWorkflowCount?: number;
  potentialCoverage?: PotentialCoverageHint | null;
}

export interface RuntimeDriftSignal {
  environmentId: string;
  capabilityVersionId: string;
  stepId: string;
  affectedWorkflows: AffectedWorkflow[];
}

export interface ChangeDiscoveryDetail {
  discoveryId: string;
  serviceId: string;
  trigger: 'repository-push' | 'daily-poll' | 'run-drift';
  discoveredAt: string;
  environmentId?: string;
  changes: DiscoveredChange[];
  runtimeSignals?: RuntimeDriftSignal[];
}

export interface ChangeItem {
  id: string;
  discoveryId: string;
  serviceId: string;
  trigger: ChangeDiscoveryDetail['trigger'];
  discoveredAt: string;
  evidenceKind: 'discovered-version' | 'runtime-rejection';
  classification: ChangeClassification;
  intakeBehavior: 'quarantined' | 'old-pin-open' | 'awaiting-rediscovery' | 'unaffected';
  environmentAffected: boolean;
  runtimeStepId: string | null;
  fromCapabilityVersionId: string | null;
  toCapabilityVersionId: string | null;
  fieldChanges: FieldChange[];
  affectedWorkflows: AffectedWorkflow[];
}

export function buildChangeItems(details: ChangeDiscoveryDetail[]): ChangeItem[] {
  return details
    .flatMap((detail): ChangeItem[] => {
      const runtimeItems = (detail.runtimeSignals ?? []).map(
        (signal): ChangeItem => ({
          id: `${detail.discoveryId}:runtime-signal:${signal.environmentId}:${signal.capabilityVersionId}:${signal.stepId}`,
          discoveryId: detail.discoveryId,
          serviceId: detail.serviceId,
          trigger: detail.trigger,
          discoveredAt: detail.discoveredAt,
          evidenceKind: 'runtime-rejection',
          classification: 'conditional',
          intakeBehavior: 'awaiting-rediscovery',
          environmentAffected: true,
          runtimeStepId: signal.stepId,
          fromCapabilityVersionId: signal.capabilityVersionId,
          toCapabilityVersionId: null,
          fieldChanges: [],
          affectedWorkflows: signal.affectedWorkflows,
        }),
      );
      const discoveredItems = detail.changes.map((change): ChangeItem => {
        const environmentAffected =
          change.organizationAffectedWorkflowCount === undefined ||
          change.affectedWorkflows.length > 0;
        return {
          id: `${detail.discoveryId}:${change.fromCapabilityVersionId}:${change.toCapabilityVersionId}`,
          discoveryId: detail.discoveryId,
          serviceId: detail.serviceId,
          trigger: detail.trigger,
          discoveredAt: detail.discoveredAt,
          evidenceKind: 'discovered-version',
          classification: change.classification,
          intakeBehavior: !environmentAffected
            ? 'unaffected'
            : change.classification === 'breaking'
              ? 'quarantined'
              : 'old-pin-open',
          environmentAffected,
          runtimeStepId: null,
          fromCapabilityVersionId: change.fromCapabilityVersionId,
          toCapabilityVersionId: change.toCapabilityVersionId,
          fieldChanges: change.fieldChanges,
          affectedWorkflows: change.affectedWorkflows,
        };
      });
      return [...runtimeItems, ...discoveredItems];
    })
    .sort((left, right) => right.discoveredAt.localeCompare(left.discoveredAt));
}

export function countChangeItemsByClassification(
  items: readonly ChangeItem[],
): Record<ChangeClassification, number> {
  const counts: Record<ChangeClassification, number> = {
    breaking: 0,
    conditional: 0,
    compatible: 0,
    metadata: 0,
  };
  for (const item of items) counts[item.classification] += 1;
  return counts;
}

function decodePointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function readableSchemaPath(path: string): string {
  const segments = path.split('/').filter(Boolean).map(decodePointerSegment);
  const reference = segments.find((segment) => segment.startsWith('#/components/schemas/'));
  const schemaName = reference?.slice('#/components/schemas/'.length);
  const propertyNames = segments.flatMap((segment, index) =>
    segments[index - 1] === 'properties' ? [segment] : [],
  );

  if (schemaName && propertyNames.length > 0) return [schemaName, ...propertyNames].join('.');

  const readable = segments.filter(
    (segment) => segment !== 'references' && segment !== 'properties' && segment !== 'items',
  );
  return readable.join('.') || path;
}

export function presentFieldChange(change: FieldChange): FieldChangePresentation {
  const field = readableSchemaPath(change.path);
  switch (change.kind) {
    case 'added-optional':
      return { title: 'Added optional field', field, before: 'Absent', after: 'Optional' };
    case 'added-required':
      return { title: 'Added required field', field, before: 'Absent', after: 'Required' };
    case 'removed':
      return { title: 'Removed field', field, before: 'Present', after: 'Absent' };
    case 'retyped':
      return { title: 'Changed field type', field, before: 'Previous type', after: 'New type' };
    case 'renamed':
      return {
        title: 'Renamed field',
        field,
        before: change.fromPath ? readableSchemaPath(change.fromPath) : 'Previous name',
        after: field,
      };
    default:
      return {
        title: change.kind.replaceAll('-', ' '),
        field,
        before: 'Previous contract',
        after: 'Updated contract',
      };
  }
}

function surfaceDetailHash(surface: 'capabilities' | 'workflows', key: string, value: string) {
  return `#/${surface}?${new URLSearchParams({ [key]: value })}`;
}

export function capabilityDetailHash(capabilityVersionId: string): string {
  return surfaceDetailHash('capabilities', 'capabilityVersionId', capabilityVersionId);
}

export function workflowDetailHash(workflowVersionId: string): string {
  return surfaceDetailHash('workflows', 'workflowVersionId', workflowVersionId);
}

export function migrationReviewHash(migrationCandidateId: string): string {
  return surfaceDetailHash('workflows', 'migrationCandidateId', migrationCandidateId);
}
