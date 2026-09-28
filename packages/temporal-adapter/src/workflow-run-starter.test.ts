import { WorkflowExecutionAlreadyStartedError, type WorkflowClient } from '@temporalio/client';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';
import { describe, expect, it, vi } from 'vite-plus/test';

import { createTemporalWorkflowRunStarter } from './workflow-run-starter.js';

describe('scheduled workflow run identity', () => {
  it('uses the immutable schedule occurrence instead of the reusable payment ID', async () => {
    const workflowRunIds: string[] = [];
    const verifiedWorkflow = await createCompiledWorkflowVersion('verified@1', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
    });
    const starter = createTemporalWorkflowRunStarter({
      workflowClient: {
        start: vi
          .fn<() => Promise<{ result: () => Promise<{ state: string }> }>>()
          .mockResolvedValue({
            async result() {
              return { state: 'completed' };
            },
          }),
      } as unknown as WorkflowClient,
      taskQueue: 'scheduled-payments',
      async startAuthorized(_input, startTemporal) {
        return await startTemporal(verifiedWorkflow);
      },
      async createInterpreterInput(_payload, workflowRunId) {
        workflowRunIds.push(workflowRunId);
        return { workflowVersionId: 'verified@1', input: {} };
      },
    });
    const scheduleId = '00000000-0000-4000-8000-000000000068';

    await starter.startWorkflowRun(
      { paymentId: 'pay_reused' },
      {
        runCommandId: 'command-first-delivery',
        trigger: { type: 'schedule', scheduleId, scheduledFor: '2026-08-17T13:00:00.000Z' },
      },
    );
    await starter.startWorkflowRun(
      { paymentId: 'pay_reused' },
      {
        runCommandId: 'command-duplicate-delivery',
        trigger: { type: 'schedule', scheduleId, scheduledFor: '2026-08-17T13:00:00.000Z' },
      },
    );
    await starter.startWorkflowRun(
      { paymentId: 'pay_reused' },
      {
        runCommandId: 'command-next-occurrence',
        trigger: { type: 'schedule', scheduleId, scheduledFor: '2026-08-17T14:00:00.000Z' },
      },
    );

    expect(workflowRunIds[0]).toBe(workflowRunIds[1]);
    expect(workflowRunIds[2]).not.toBe(workflowRunIds[0]);
  });

  it('cannot reach the Temporal client when start authorization rejects the bundle', async () => {
    const start = vi.fn<() => Promise<{ state: string }>>();
    const starter = createTemporalWorkflowRunStarter({
      workflowClient: { start } as unknown as WorkflowClient,
      taskQueue: 'verified-payments',
      async createInterpreterInput() {
        return { workflowVersionId: 'verified@1', input: {} };
      },
      async startAuthorized() {
        throw new Error('bundle rejected');
      },
    });

    await expect(starter.startWorkflowRun({ paymentId: 'pay_1' })).rejects.toThrow(
      'bundle rejected',
    );
    expect(start).not.toHaveBeenCalled();
  });

  it('puts the exact worker-verified plan into the Temporal start input', async () => {
    const verifiedWorkflow = await createCompiledWorkflowVersion('verified@1', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
    });
    const start = vi.fn<(...args: unknown[]) => Promise<{ result: () => Promise<unknown> }>>(
      async () => ({
        async result() {
          return { state: 'completed' };
        },
      }),
    );
    const starter = createTemporalWorkflowRunStarter({
      workflowClient: { start } as unknown as WorkflowClient,
      taskQueue: 'verified-plan',
      reportLifecycle: true,
      async createInterpreterInput() {
        return {
          workflowVersionId: 'verified@1',
          input: { paymentId: 'pay_verified' },
          grant: {
            organizationId: 'org_atlas',
            environmentId: 'production',
            runId: 'run_verified',
            workflowVersionId: 'verified@1',
            irHash: verifiedWorkflow.irHash,
            approvedCapabilityVersionIds: [],
            approvedHostnames: ['providers.internal'],
            signatureAlgorithm: 'Ed25519' as const,
            signature: 'verified-by-test-gate',
          },
        };
      },
      async startAuthorized(_input, startTemporal) {
        return await startTemporal(verifiedWorkflow);
      },
    });

    await starter.startWorkflowRun(
      { paymentId: 'pay_verified' },
      {
        trigger: { type: 'manual' },
        workflowName: 'Verified workflow',
      },
    );

    expect(start.mock.calls[0]?.[0]).toBe('interpretCompiledWorkflow');
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      args: [
        {
          workflow: verifiedWorkflow,
          input: { paymentId: 'pay_verified' },
          approvedHostnames: ['providers.internal'],
          lifecycle: { workflowName: 'Verified workflow' },
        },
      ],
    });
  });

  it('rejects a second execution for the same business key even after the first closes', async () => {
    const verifiedWorkflow = await createCompiledWorkflowVersion('verified@1', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
    });
    const start = vi
      .fn<(...args: unknown[]) => Promise<{ result: () => Promise<unknown> }>>()
      .mockResolvedValueOnce({
        async result() {
          return { state: 'completed' };
        },
      })
      .mockRejectedValueOnce(
        new WorkflowExecutionAlreadyStartedError('already started', 'run', 'interpret'),
      );
    const starter = createTemporalWorkflowRunStarter({
      workflowClient: { start } as unknown as WorkflowClient,
      taskQueue: 'deduped-payments',
      async createInterpreterInput() {
        return { workflowVersionId: 'verified@1', input: { paymentId: 'pay_once' } };
      },
      async startAuthorized(_input, startTemporal) {
        return await startTemporal(verifiedWorkflow);
      },
    });

    const first = await starter.startWorkflowRun({ paymentId: 'pay_once' });
    const redelivery = await starter.startWorkflowRun({ paymentId: 'pay_once' });

    expect(first.status).toBe('accepted');
    expect(redelivery).toEqual({ workflowRunId: first.workflowRunId, status: 'duplicate' });
    expect(start.mock.calls[0]?.[1]).toMatchObject({ workflowIdReusePolicy: 'REJECT_DUPLICATE' });
  });

  it('keeps the same business key independent across workflow identities', async () => {
    const verifiedWorkflow = await createCompiledWorkflowVersion('verified@1', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
    });
    const starter = createTemporalWorkflowRunStarter({
      workflowClient: {
        start: vi.fn<() => Promise<{ result: () => Promise<{ state: string }> }>>(async () => ({
          async result() {
            return { state: 'completed' };
          },
        })),
      } as unknown as WorkflowClient,
      taskQueue: 'independent-workflows',
      async createInterpreterInput() {
        return { workflowVersionId: 'verified@1', input: { paymentId: 'pay_shared' } };
      },
      async startAuthorized(_input, startTemporal) {
        return await startTemporal(verifiedWorkflow);
      },
    });

    const first = await starter.startWorkflowRun(
      { paymentId: 'pay_shared' },
      { workflowId: 'workflow-a', trigger: { type: 'manual' } },
    );
    const second = await starter.startWorkflowRun(
      { paymentId: 'pay_shared' },
      { workflowId: 'workflow-b', trigger: { type: 'manual' } },
    );

    expect(second.workflowRunId).not.toBe(first.workflowRunId);
  });
});

describe('API workflow run identity', () => {
  it('uses the API idempotency key as the Temporal business key', async () => {
    const verifiedWorkflow = await createCompiledWorkflowVersion('verified@1', 'org_atlas', {
      irVersion: 1,
      steps: [{ id: 'done', kind: 'terminal', state: 'completed' }],
    });
    const start = vi
      .fn<(...args: unknown[]) => Promise<{ result: () => Promise<unknown> }>>()
      .mockResolvedValueOnce({
        async result() {
          return { state: 'completed' };
        },
      })
      .mockRejectedValueOnce(
        new WorkflowExecutionAlreadyStartedError('already started', 'run', 'interpret'),
      );
    const starter = createTemporalWorkflowRunStarter({
      workflowClient: { start } as unknown as WorkflowClient,
      taskQueue: 'api-payments',
      async startAuthorized(_input, startTemporal) {
        return await startTemporal(verifiedWorkflow);
      },
      async createInterpreterInput() {
        return { workflowVersionId: 'verified@1', input: { orderId: 'ignored' } };
      },
    });

    const first = await starter.startWorkflowRun(
      { orderId: 'ord_1' },
      {
        runCommandId: 'command-api-1',
        workflowId: 'workflow_api',
        trigger: { type: 'api', deliveryId: 'idempotency-shared' },
      },
    );
    const redelivery = await starter.startWorkflowRun(
      { orderId: 'ord_different' },
      {
        runCommandId: 'command-api-2',
        workflowId: 'workflow_api',
        trigger: { type: 'api', deliveryId: 'idempotency-shared' },
      },
    );

    expect(first.status).toBe('accepted');
    expect(redelivery).toEqual({ workflowRunId: first.workflowRunId, status: 'duplicate' });
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      workflowId: first.workflowRunId,
      workflowIdReusePolicy: 'REJECT_DUPLICATE',
      args: [expect.objectContaining({ returnFinalOutput: true })],
    });
  });
});
