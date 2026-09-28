import { expect, it } from 'vitest';

import { createGraphCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { compileTemporalWorkflowArtifact, verifyTemporalWorkflowArtifact } from './index.js';

it('verifies a graph artifact with builtins and no invented capability pins', async () => {
  const workflow = await createGraphCompiledWorkflowVersion('graph@1', 'org', {
    irVersion: 3,
    startStepId: 'prepare',
    steps: [
      {
        id: 'prepare',
        kind: 'transform',
        arguments: { ready: { source: 'literal', value: true } },
        responseSchema: { required: { ready: { type: 'boolean' } } },
        next: 'wait',
      },
      { id: 'wait', kind: 'sleep', durationMs: 10, next: 'done' },
      {
        id: 'done',
        kind: 'terminal',
        state: 'completed',
        output: { source: 'stepOutput', stepId: 'prepare', path: [] },
      },
    ],
  });
  const artifact = await compileTemporalWorkflowArtifact(workflow, {
    sandboxSuiteFingerprint: 'graph-suite',
    secretReferencesByCapabilityVersion: {},
  });
  expect(artifact.execution.steps).toEqual([]);
  expect(artifact.target.irVersion).toBe(3);
  expect(await verifyTemporalWorkflowArtifact(artifact)).toEqual(artifact);
  await expect(
    verifyTemporalWorkflowArtifact({ ...artifact, target: { ...artifact.target, irVersion: 2 } }),
  ).rejects.toThrow('reproducible identity');
});
