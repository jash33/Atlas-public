import { generateExecutionGrantKeyPair, issueExecutionGrant } from '@atlas/execution-grant';
import { compileTemporalWorkflowArtifact } from '@atlas/workflow-artifact';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { describe, expect, it, vi } from 'vitest';

import { createBackendWorkflowLoader } from './workflow-loader.js';

describe('backend workflow loader', () => {
  it('fetches the activated artifact and verifies its reviewed IR against the grant', async () => {
    const keys = await generateExecutionGrantKeyPair();
    const workflow = await createCompiledWorkflowVersion('payment@1', 'org_demo', {
      irVersion: 1,
      steps: [{ id: 'complete', kind: 'terminal', state: 'completed' }],
    });
    const artifact = await compileTemporalWorkflowArtifact(workflow, {
      sandboxSuiteFingerprint: 'a'.repeat(64),
      secretReferencesByCapabilityVersion: {},
    });
    const artifactId = artifact.artifactId;
    const grant = await issueExecutionGrant(keys.privateKey, {
      organizationId: 'org_demo',
      environmentId: 'demo',
      runId: 'run_1',
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      approvedCapabilityVersionIds: [],
      approvedHostnames: [],
    });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const requestedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(requestedUrl).toBe(
        `http://atlas.internal/v1/workflow-artifacts/${artifactId}?organizationId=org_demo&environmentId=demo`,
      );
      return Response.json(artifact);
    });
    const loader = createBackendWorkflowLoader({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_demo',
      environmentId: 'demo',
      executionGrantPublicKey: keys.publicKey,
      fetch,
    });

    await expect(
      loader.loadAuthorizedWorkflow({
        artifactId,
        workflowVersionId: workflow.workflowVersionId,
        runId: 'run_1',
        grant,
      }),
    ).resolves.toEqual(workflow);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not reuse an IR cache entry for a different tested artifact', async () => {
    const keys = await generateExecutionGrantKeyPair();
    const workflow = await createCompiledWorkflowVersion('payment@1', 'org_demo', {
      irVersion: 1,
      steps: [{ id: 'complete', kind: 'terminal', state: 'completed' }],
    });
    const artifacts = await Promise.all(
      ['a', 'b'].map((value) =>
        compileTemporalWorkflowArtifact(workflow, {
          sandboxSuiteFingerprint: value.repeat(64),
          secretReferencesByCapabilityVersion: {},
        }),
      ),
    );
    const grant = await issueExecutionGrant(keys.privateKey, {
      organizationId: 'org_demo',
      environmentId: 'demo',
      runId: 'run_1',
      workflowVersionId: workflow.workflowVersionId,
      irHash: workflow.irHash,
      approvedCapabilityVersionIds: [],
      approvedHostnames: [],
    });
    const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const path = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      ).pathname;
      const artifact = artifactById.get(path.split('/').at(-1) ?? '');
      return artifact ? Response.json(artifact) : new Response(null, { status: 404 });
    });
    const loader = createBackendWorkflowLoader({
      backendUrl: 'http://atlas.internal',
      workerToken: 'worker-token',
      organizationId: 'org_demo',
      environmentId: 'demo',
      executionGrantPublicKey: keys.publicKey,
      fetch,
    });

    for (const artifact of artifacts) {
      await loader.loadAuthorizedWorkflow({
        artifactId: artifact.artifactId,
        workflowVersionId: workflow.workflowVersionId,
        runId: 'run_1',
        grant,
      });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
