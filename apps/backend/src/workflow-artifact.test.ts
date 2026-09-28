import { verifyTemporalWorkflowArtifact } from '@atlas/workflow-artifact';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { describe, expect, it } from 'vite-plus/test';

import { compileTemporalWorkflowArtifact } from './workflow-artifact.js';

describe('Temporal workflow artifact compiler', () => {
  it('reproducibly packages the reviewed workflow and its runtime configuration', async () => {
    const workflow = await createCompiledWorkflowVersion('invoice-notification@1', 'org_demo', {
      irVersion: 1,
      steps: [
        {
          id: 'notify-operations',
          kind: 'notify',
          capabilityVersionId: 'slack.post-message@1',
          arguments: { text: { source: 'literal', value: 'Invoice paid' } },
          retryPolicy: {
            initialInterval: '1 second',
            backoffCoefficient: 2,
            maximumInterval: '30 seconds',
            maximumAttempts: 4,
            nonRetryableErrorTypes: ['InvalidStepInput'],
          },
          idempotency: { businessKey: { source: 'input', path: ['paymentId'] } },
        },
        { id: 'complete', kind: 'terminal', state: 'completed' },
      ],
    });

    const input = {
      sandboxSuiteFingerprint: 'a'.repeat(64),
      secretReferencesByCapabilityVersion: {
        'slack.post-message@1': 'SLACK_BOT_TOKEN',
      },
    };
    const first = await compileTemporalWorkflowArtifact(workflow, input);
    const second = await compileTemporalWorkflowArtifact(workflow, {
      secretReferencesByCapabilityVersion: {
        'slack.post-message@1': 'SLACK_BOT_TOKEN',
      },
      sandboxSuiteFingerprint: 'a'.repeat(64),
    });

    expect(first).toEqual(second);
    expect(first.artifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toMatchObject({
      formatVersion: 'atlas-temporal-artifact/v1',
      workflowVersionId: 'invoice-notification@1',
      irHash: workflow.irHash,
      target: {
        runtime: 'temporal',
        workflowType: 'interpretCompiledWorkflow',
        irVersion: 1,
      },
      evidence: { sandboxSuiteFingerprint: 'a'.repeat(64) },
      execution: {
        ordering: { mode: 'sequential', scope: 'workflow-run' },
        observability: {
          stepAttempts: true,
          durations: true,
          payloads: 'redacted',
        },
        steps: [
          expect.objectContaining({
            stepId: 'notify-operations',
            capabilityVersionId: 'slack.post-message@1',
            secretReference: 'SLACK_BOT_TOKEN',
            retryPolicy: expect.objectContaining({ maximumAttempts: 4 }),
            idempotency: expect.objectContaining({
              derivation: 'step-id-and-business-key',
            }),
          }),
        ],
      },
      workflow,
    });
  });

  it('changes identity when executable configuration or test evidence changes', async () => {
    const workflow = await createCompiledWorkflowVersion('simple@1', 'org_demo', {
      irVersion: 1,
      steps: [{ id: 'complete', kind: 'terminal', state: 'completed' }],
    });
    const first = await compileTemporalWorkflowArtifact(workflow, {
      sandboxSuiteFingerprint: 'a'.repeat(64),
      secretReferencesByCapabilityVersion: {},
    });
    const retested = await compileTemporalWorkflowArtifact(workflow, {
      sandboxSuiteFingerprint: 'b'.repeat(64),
      secretReferencesByCapabilityVersion: {},
    });

    expect(retested.artifactId).not.toBe(first.artifactId);
  });

  it('rejects stored content changed without recomputing its artifact identity', async () => {
    const workflow = await createCompiledWorkflowVersion('simple@1', 'org_demo', {
      irVersion: 1,
      steps: [{ id: 'complete', kind: 'terminal', state: 'completed' }],
    });
    const artifact = await compileTemporalWorkflowArtifact(workflow, {
      sandboxSuiteFingerprint: 'a'.repeat(64),
      secretReferencesByCapabilityVersion: {},
    });

    await expect(
      verifyTemporalWorkflowArtifact({
        ...artifact,
        evidence: { sandboxSuiteFingerprint: 'b'.repeat(64) },
      }),
    ).rejects.toThrow('does not match its reproducible identity');
  });
});
