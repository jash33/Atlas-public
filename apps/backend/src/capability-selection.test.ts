import { describe, expect, it } from 'vite-plus/test';

import {
  decideCapabilityApprovability,
  decideNewCompilationSelection,
  decideWorkflowApprovalSelection,
  decidePinnedExecution,
  type CapabilitySelectionFacts,
} from './capability-selection.js';

const selectableCapability: CapabilitySelectionFacts = {
  capabilityVersionId: 'approved-version-hash',
  isCurrent: true,
  isAvailable: true,
  isFresh: true,
  hasCurrentAnnotation: true,
  annotationApprovalEffective: true,
  capabilityVersionApprovalEffective: true,
  hasOwnership: true,
  hasSafetyMetadata: true,
  hasSchemaLinks: true,
  hasHostPolicy: true,
};

describe('fail-closed capability selection', () => {
  it.each([
    ['hasCurrentAnnotation', 'missing-current-annotation'],
    ['annotationApprovalEffective', 'annotation-not-approved'],
    ['capabilityVersionApprovalEffective', 'capability-version-not-approved'],
    ['isCurrent', 'superseded-version'],
    ['isAvailable', 'capability-removed'],
  ] as const)('denies new compilation when %s is false', (fact, denial) => {
    const decision = decideNewCompilationSelection({
      ...selectableCapability,
      [fact]: false,
    });

    expect(decision).toEqual({ allowed: false, denials: [denial] });
  });

  it('allows drafting from stale definitions while preserving approval and pinned execution rules', () => {
    const stale = { ...selectableCapability, isFresh: false };
    expect(decideNewCompilationSelection(stale)).toEqual({ allowed: true, denials: [] });
    expect(decideWorkflowApprovalSelection(stale)).toEqual({
      allowed: false,
      denials: ['capability-observation-stale'],
    });
    expect(
      decidePinnedExecution(stale, { approvedCapabilityVersionIds: [stale.capabilityVersionId] }),
    ).toEqual({ allowed: true, denials: [] });
    expect(decideNewCompilationSelection({ ...stale, hasSourceConflict: true })).toEqual({
      allowed: false,
      denials: ['conflicting-sources'],
    });
    expect(
      decidePinnedExecution(
        { ...stale, capabilityVersionApprovalEffective: false },
        {
          approvedCapabilityVersionIds: [stale.capabilityVersionId],
        },
      ),
    ).toEqual({ allowed: false, denials: ['capability-version-not-approved'] });
  });

  it.each([
    ['hasOwnership', 'missing-ownership'],
    ['hasSafetyMetadata', 'missing-safety-metadata'],
    ['hasSchemaLinks', 'missing-schema-links'],
    ['hasHostPolicy', 'missing-host-policy'],
  ] as const)('blocks approvability when %s is false', (fact, denial) => {
    const decision = decideCapabilityApprovability({
      ...selectableCapability,
      [fact]: false,
    });

    expect(decision).toEqual({ allowed: false, denials: [denial] });
  });

  it('allows an older pinned version only with effective approvals and an exact grant binding', () => {
    const olderVersion = { ...selectableCapability, isCurrent: false };

    expect(
      decidePinnedExecution(olderVersion, {
        approvedCapabilityVersionIds: ['approved-version-hash'],
      }),
    ).toEqual({ allowed: true, denials: [] });
    expect(
      decidePinnedExecution(olderVersion, {
        approvedCapabilityVersionIds: ['different-version-hash'],
      }),
    ).toEqual({ allowed: false, denials: ['grant-version-mismatch'] });
    expect(
      decidePinnedExecution(
        { ...olderVersion, annotationApprovalEffective: false },
        { approvedCapabilityVersionIds: ['approved-version-hash'] },
      ),
    ).toEqual({ allowed: false, denials: ['annotation-not-approved'] });
    expect(
      decidePinnedExecution(
        { ...olderVersion, capabilityVersionApprovalEffective: false },
        { approvedCapabilityVersionIds: ['approved-version-hash'] },
      ),
    ).toEqual({ allowed: false, denials: ['capability-version-not-approved'] });
  });
});
