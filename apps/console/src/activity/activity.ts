export type AuditEventType =
  | 'discovery'
  | 'classification'
  | 'reverse-lookup'
  | 'generation'
  | 'validation'
  | 'approval'
  | 'activation'
  | 'rollback'
  | 'abandonment'
  | 'organization-settings'
  | 'secret-reference'
  | 'membership'
  | 'capability-safety-approval'
  | 'capability-host-policy'
  | 'repair'
  | 'capability-source-authority';

export type AuditSubjectType =
  | 'capability-discovery'
  | 'capability-change'
  | 'migration-candidate'
  | 'workflow-version'
  | 'workflow-activation'
  | 'workflow-run'
  | 'organization-settings'
  | 'secret-reference'
  | 'membership'
  | 'capability-safety-approval'
  | 'capability-host-policy'
  | 'capability-version';

export interface AuditEntry {
  id: string;
  eventType: AuditEventType;
  subjectType: AuditSubjectType;
  subjectId: string;
  actorId: string | null;
  actorName: string | null;
  subjectName: string | null;
  environmentId: string | null;
  details: Record<string, unknown>;
  recordedAt: string;
}

export type ActivityActorKind =
  | 'person'
  | 'compiler'
  | 'planner'
  | 'validator'
  | 'discovery'
  | 'system';

export interface ActivityActor {
  id: string;
  kind: ActivityActorKind;
  label: string;
}

export type ActivityObjectKind =
  | 'workflow'
  | 'capability-source'
  | 'capability-version'
  | 'run'
  | 'migration'
  | 'membership'
  | 'person';

export interface ActivityObject {
  key: string;
  kind: ActivityObjectKind;
  id: string;
  label: string;
  eventIds: string[];
}

interface ObjectReference {
  kind: ActivityObjectKind;
  id: string;
  label?: string | undefined;
}

export function describeActor(entry: AuditEntry): ActivityActor {
  if (entry.actorId) {
    return { id: entry.actorId, kind: 'person', label: entry.actorName ?? entry.actorId };
  }
  if (entry.eventType === 'generation') {
    const planner = entry.details.author === 'planner';
    return planner
      ? { id: 'atlas-planner', kind: 'planner', label: 'Atlas planner' }
      : { id: 'atlas-compiler', kind: 'compiler', label: 'Atlas compiler' };
  }
  if (entry.eventType === 'validation') {
    return { id: 'atlas-validator', kind: 'validator', label: 'Atlas validator' };
  }
  if (['discovery', 'classification', 'reverse-lookup'].includes(entry.eventType)) {
    return { id: 'atlas-discovery', kind: 'discovery', label: 'Atlas discovery' };
  }
  return { id: 'atlas-system', kind: 'system', label: 'Atlas system' };
}

export interface ActivityDetailDefinition {
  detail: string;
  kind: ActivityObjectKind;
  label: string;
  lineage?: true;
  surface?: 'workflows' | 'capabilities';
  parameter?: string;
}

export const activityDetailDefinitions: readonly ActivityDetailDefinition[] = [
  {
    detail: 'workflowVersionId',
    kind: 'workflow',
    label: 'Workflow',
    lineage: true,
    surface: 'workflows',
    parameter: 'workflowVersionId',
  },
  {
    detail: 'sourceWorkflowVersionId',
    kind: 'workflow',
    label: 'Source workflow',
    lineage: true,
    surface: 'workflows',
    parameter: 'workflowVersionId',
  },
  {
    detail: 'currentWorkflowVersionId',
    kind: 'workflow',
    label: 'Current workflow',
    lineage: true,
    surface: 'workflows',
    parameter: 'workflowVersionId',
  },
  {
    detail: 'previousWorkflowVersionId',
    kind: 'workflow',
    label: 'Previous workflow',
    lineage: true,
    surface: 'workflows',
    parameter: 'workflowVersionId',
  },
  {
    detail: 'restoredWorkflowVersionId',
    kind: 'workflow',
    label: 'Restored workflow',
    lineage: true,
    surface: 'workflows',
    parameter: 'workflowVersionId',
  },
  {
    detail: 'replacedWorkflowVersionId',
    kind: 'workflow',
    label: 'Replaced workflow',
    lineage: true,
    surface: 'workflows',
    parameter: 'workflowVersionId',
  },
  {
    detail: 'capabilityVersionId',
    kind: 'capability-version',
    label: 'Capability version',
    surface: 'capabilities',
    parameter: 'capabilityVersionId',
  },
  {
    detail: 'fromCapabilityVersionId',
    kind: 'capability-version',
    label: 'Previous capability',
    surface: 'capabilities',
    parameter: 'capabilityVersionId',
  },
  {
    detail: 'toCapabilityVersionId',
    kind: 'capability-version',
    label: 'New capability',
    surface: 'capabilities',
    parameter: 'capabilityVersionId',
  },
  {
    detail: 'currentCapabilityVersionId',
    kind: 'capability-version',
    label: 'Current capability',
    surface: 'capabilities',
    parameter: 'capabilityVersionId',
  },
  {
    detail: 'previousCapabilityVersionId',
    kind: 'capability-version',
    label: 'Previous capability',
    surface: 'capabilities',
    parameter: 'capabilityVersionId',
  },
  {
    detail: 'restoredCapabilityVersionId',
    kind: 'capability-version',
    label: 'Restored capability',
    surface: 'capabilities',
    parameter: 'capabilityVersionId',
  },
  {
    detail: 'replacedCapabilityVersionId',
    kind: 'capability-version',
    label: 'Replaced capability',
    surface: 'capabilities',
    parameter: 'capabilityVersionId',
  },
  { detail: 'runId', kind: 'run', label: 'Run' },
  {
    detail: 'migrationCandidateId',
    kind: 'migration',
    label: 'Migration',
    surface: 'workflows',
    parameter: 'migrationCandidateId',
  },
];

function referencesFor(entry: AuditEntry): ObjectReference[] {
  const references: ObjectReference[] = [];
  const subjectKind: Partial<Record<AuditSubjectType, ActivityObjectKind>> = {
    'workflow-version': 'workflow',
    'workflow-run': 'run',
    'migration-candidate': 'migration',
    membership: 'membership',
    'capability-version': 'capability-version',
    'capability-safety-approval': 'capability-version',
  };
  const kind = subjectKind[entry.subjectType];
  if (kind) references.push({ kind, id: entry.subjectId, label: entry.subjectName ?? undefined });
  if (entry.subjectType === 'capability-discovery') {
    const serviceId = entry.details.serviceId;
    references.push({
      kind: 'capability-source',
      id: typeof serviceId === 'string' ? serviceId : entry.subjectId,
      label: typeof serviceId === 'string' ? serviceId : undefined,
    });
  }
  if (entry.subjectType === 'membership') {
    references.push({ kind: 'person', id: entry.subjectId, label: entry.subjectName ?? undefined });
  }
  if (entry.actorId) {
    references.push({ kind: 'person', id: entry.actorId, label: entry.actorName ?? undefined });
  }
  for (const definition of activityDetailDefinitions) {
    const value = entry.details[definition.detail];
    if (typeof value === 'string' && value.length > 0) {
      references.push({ kind: definition.kind, id: value });
    }
  }
  const affectedWorkflows = entry.details.affectedWorkflows;
  if (Array.isArray(affectedWorkflows)) {
    for (const affected of affectedWorkflows) {
      if (
        affected &&
        typeof affected === 'object' &&
        'workflowVersionId' in affected &&
        typeof affected.workflowVersionId === 'string'
      ) {
        references.push({ kind: 'workflow', id: affected.workflowVersionId });
      }
    }
  }
  return references;
}

export function buildActivityObjects(entries: AuditEntry[]): ActivityObject[] {
  const referencesByEntry = new Map(entries.map((entry) => [entry.id, referencesFor(entry)]));
  const referencesByDiscoveryId = new Map<string, ObjectReference[]>();
  const referencesByMigrationId = new Map<string, ObjectReference[]>();
  for (const entry of entries) {
    const discoveryId = entry.details.discoveryId;
    const references = referencesByEntry.get(entry.id) ?? [];
    if (typeof discoveryId === 'string') {
      const related = references.filter(
        (reference) => reference.kind === 'workflow' || reference.kind === 'capability-version',
      );
      referencesByDiscoveryId.set(discoveryId, [
        ...(referencesByDiscoveryId.get(discoveryId) ?? []),
        ...related,
      ]);
    }
    if (entry.subjectType === 'migration-candidate') {
      referencesByMigrationId.set(entry.subjectId, [
        ...(referencesByMigrationId.get(entry.subjectId) ?? []),
        ...references.filter(
          (reference) => reference.kind === 'workflow' || reference.kind === 'capability-version',
        ),
      ]);
    }
  }

  const contextualReferences = new Map<string, ObjectReference[]>();
  for (const entry of entries) {
    const references = [...(referencesByEntry.get(entry.id) ?? [])];
    if (entry.subjectType === 'capability-discovery') {
      references.push(...(referencesByDiscoveryId.get(entry.subjectId) ?? []));
    }
    if (entry.subjectType === 'migration-candidate') {
      references.push(...(referencesByMigrationId.get(entry.subjectId) ?? []));
    }
    contextualReferences.set(entry.id, references);
  }

  const workflowParent = new Map<string, string>();
  const findWorkflow = (id: string): string => {
    const parent = workflowParent.get(id);
    if (!parent) {
      workflowParent.set(id, id);
      return id;
    }
    if (parent === id) return id;
    const root = findWorkflow(parent);
    workflowParent.set(id, root);
    return root;
  };
  for (const entry of entries) {
    const workflowIds = activityDetailDefinitions.flatMap((definition) => {
      const value = entry.details[definition.detail];
      return definition.lineage && typeof value === 'string' ? [value] : [];
    });
    const canonical = workflowIds[0];
    if (!canonical) continue;
    findWorkflow(canonical);
    for (const id of workflowIds.slice(1)) {
      workflowParent.set(findWorkflow(id), findWorkflow(canonical));
    }
  }

  const objects = new Map<string, ActivityObject>();
  for (const entry of entries) {
    const seen = new Set<string>();
    for (const reference of contextualReferences.get(entry.id) ?? []) {
      const id = reference.kind === 'workflow' ? findWorkflow(reference.id) : reference.id;
      const key = `${reference.kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = objects.get(key);
      if (existing) {
        existing.eventIds.push(entry.id);
        if (existing.label === existing.id && reference.label) existing.label = reference.label;
      } else {
        objects.set(key, {
          key,
          kind: reference.kind,
          id,
          label: reference.label ?? id,
          eventIds: [entry.id],
        });
      }
    }
  }
  return [...objects.values()];
}
