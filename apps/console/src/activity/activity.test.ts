import { describe, expect, it } from 'vite-plus/test';

import { buildActivityObjects, describeActor, type AuditEntry } from './activity.js';

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: 'evt_1',
    eventType: 'approval',
    subjectType: 'workflow-version',
    subjectId: 'workflow_1',
    actorId: null,
    actorName: null,
    subjectName: null,
    environmentId: 'production',
    details: {},
    recordedAt: '2026-08-16T12:00:00.000Z',
    ...overrides,
  };
}

describe('activity history', () => {
  it('distinguishes people from compiler, planner, validator, and discovery actors', () => {
    expect(describeActor(entry({ actorId: 'user_maya', actorName: 'Maya Chen' }))).toEqual({
      id: 'user_maya',
      kind: 'person',
      label: 'Maya Chen',
    });
    expect(
      describeActor(entry({ eventType: 'generation', details: { author: 'compiler' } })),
    ).toEqual({ id: 'atlas-compiler', kind: 'compiler', label: 'Atlas compiler' });
    expect(
      describeActor(entry({ eventType: 'generation', details: { author: 'planner' } })),
    ).toEqual({ id: 'atlas-planner', kind: 'planner', label: 'Atlas planner' });
    expect(describeActor(entry({ eventType: 'validation' }))).toEqual({
      id: 'atlas-validator',
      kind: 'validator',
      label: 'Atlas validator',
    });
    expect(describeActor(entry({ eventType: 'classification' }))).toEqual({
      id: 'atlas-discovery',
      kind: 'discovery',
      label: 'Atlas discovery',
    });
  });

  it('builds contextual object histories from subjects, actors, and structured evidence', () => {
    const objects = buildActivityObjects([
      entry({
        id: 'evt_activation',
        eventType: 'activation',
        subjectType: 'workflow-activation',
        subjectId: 'activation_1',
        actorId: 'user_maya',
        actorName: 'Maya Chen',
        recordedAt: '2026-08-16T12:02:00.000Z',
        details: {
          currentWorkflowVersionId: 'workflow_v2',
          previousWorkflowVersionId: 'workflow_v1',
          currentCapabilityVersionId: 'capability_v2',
        },
      }),
      entry({
        id: 'evt_approval',
        subjectId: 'workflow_v1',
        actorId: 'user_maya',
        actorName: 'Maya Chen',
        recordedAt: '2026-08-16T12:01:00.000Z',
      }),
      entry({
        id: 'evt_generation',
        eventType: 'generation',
        subjectType: 'migration-candidate',
        subjectId: 'migration_1',
        recordedAt: '2026-08-16T12:00:00.000Z',
        details: { workflowVersionId: 'workflow_v2', author: 'planner' },
      }),
      entry({
        id: 'evt_membership',
        eventType: 'membership',
        subjectType: 'membership',
        subjectId: 'user_owen',
        subjectName: 'Owen Brooks',
        actorId: 'user_maya',
        actorName: 'Maya Chen',
        recordedAt: '2026-08-16T11:59:00.000Z',
      }),
      entry({
        id: 'evt_validation',
        eventType: 'validation',
        subjectType: 'migration-candidate',
        subjectId: 'migration_1',
        recordedAt: '2026-08-16T11:59:30.000Z',
        details: { result: { diagnostics: [] } },
      }),
      entry({
        id: 'evt_discovery',
        eventType: 'discovery',
        subjectType: 'capability-discovery',
        subjectId: 'discovery_1',
        recordedAt: '2026-08-16T11:58:00.000Z',
        details: { serviceId: 'billing' },
      }),
      entry({
        id: 'evt_classification',
        eventType: 'classification',
        subjectType: 'capability-change',
        subjectId: 'discovery_1:capability_v2',
        recordedAt: '2026-08-16T11:57:00.000Z',
        details: { discoveryId: 'discovery_1', toCapabilityVersionId: 'capability_v2' },
      }),
    ]);

    expect(objects.find((object) => object.key === 'workflow:workflow_v2')).toMatchObject({
      kind: 'workflow',
      eventIds: ['evt_activation', 'evt_approval', 'evt_generation', 'evt_validation'],
    });
    expect(
      objects.find((object) => object.key === 'capability-version:capability_v2'),
    ).toMatchObject({
      kind: 'capability-version',
      eventIds: ['evt_activation', 'evt_discovery', 'evt_classification'],
    });
    expect(objects.find((object) => object.key === 'migration:migration_1')).toMatchObject({
      kind: 'migration',
      eventIds: ['evt_generation', 'evt_validation'],
    });
    expect(objects.find((object) => object.key === 'membership:user_owen')).toMatchObject({
      kind: 'membership',
      label: 'Owen Brooks',
      eventIds: ['evt_membership'],
    });
    expect(objects.find((object) => object.key === 'person:user_maya')).toMatchObject({
      kind: 'person',
      label: 'Maya Chen',
      eventIds: ['evt_activation', 'evt_approval', 'evt_membership'],
    });
    expect(objects.find((object) => object.key === 'capability-source:billing')).toMatchObject({
      label: 'billing',
      eventIds: ['evt_discovery'],
    });
    expect(objects.filter((object) => object.kind === 'workflow')).toHaveLength(1);
  });

  it('preserves the API recorded order when event timestamps are equal', () => {
    const objects = buildActivityObjects([
      entry({ id: '10', actorId: 'user_maya' }),
      entry({ id: '9', actorId: 'user_maya' }),
    ]);

    expect(objects.find((object) => object.key === 'person:user_maya')?.eventIds).toEqual([
      '10',
      '9',
    ]);
  });

  it('surfaces capability source authority changes in capability and actor history', () => {
    const objects = buildActivityObjects([
      entry({
        id: 'evt_authority',
        eventType: 'capability-source-authority',
        subjectType: 'capability-version',
        subjectId: 'capability_v3',
        actorId: 'user_admin',
        details: { action: 'designated', sourceKey: 'source_a' },
      }),
    ]);

    expect(objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'capability-version:capability_v3',
          eventIds: ['evt_authority'],
        }),
        expect.objectContaining({ key: 'person:user_admin', eventIds: ['evt_authority'] }),
      ]),
    );
  });

  it('keeps independently affected workflows separate', () => {
    const objects = buildActivityObjects([
      entry({
        id: 'evt_reverse_lookup',
        eventType: 'reverse-lookup',
        subjectType: 'capability-change',
        subjectId: 'discovery_2:capability_v3',
        details: {
          discoveryId: 'discovery_2',
          affectedWorkflows: [
            { workflowVersionId: 'workflow_payments', stepId: 'charge' },
            { workflowVersionId: 'workflow_refunds', stepId: 'refund' },
          ],
        },
      }),
    ]);

    expect(objects.filter((object) => object.kind === 'workflow')).toEqual([
      expect.objectContaining({
        key: 'workflow:workflow_payments',
        eventIds: ['evt_reverse_lookup'],
      }),
      expect.objectContaining({
        key: 'workflow:workflow_refunds',
        eventIds: ['evt_reverse_lookup'],
      }),
    ]);
  });
});
