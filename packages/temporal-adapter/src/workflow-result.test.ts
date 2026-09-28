import type { WorkflowClient } from '@temporalio/client';
import { describe, expect, it, vi } from 'vite-plus/test';
import { createWorkflowResultReader } from './workflow-result.js';

describe('workflow result reader', () => {
  it.each(['RUNNING', 'FAILED', 'CANCELED', 'TIMED_OUT'])(
    'does not read a result for %s',
    async (status) => {
      const result = vi.fn<() => Promise<unknown>>();
      const client = {
        getHandle: () => ({ describe: async () => ({ status: { name: status } }), result }),
      };
      const read = createWorkflowResultReader(client as unknown as WorkflowClient);
      expect(await read('atlas:run:one')).toEqual(
        status === 'RUNNING'
          ? { status: 'running' }
          : { status: 'failed', error: 'workflow-execution-failed' },
      );
      expect(result).not.toHaveBeenCalled();
    },
  );

  it.each([
    { state: 'completed', output: { receipt: 'five' } },
    { state: 'completed', output: {} },
  ])('returns the final output, including an empty response object', async (result) => {
    const client = {
      getHandle: () => ({
        describe: async () => ({ status: { name: 'COMPLETED' } }),
        result: async () => result,
      }),
    };
    const read = createWorkflowResultReader(client as unknown as WorkflowClient);
    expect(await read('atlas:run:one')).toEqual({ status: 'completed', output: result.output });
  });

  it.each([{ state: 'completed' }, { state: 'repair_required', output: { earlier: 'not final' } }])(
    'does not return a missing or failed output',
    async (result) => {
      const client = {
        getHandle: () => ({
          describe: async () => ({ status: { name: 'COMPLETED' } }),
          result: async () => result,
        }),
      };
      const read = createWorkflowResultReader(client as unknown as WorkflowClient);
      expect(await read('atlas:run:one')).toMatchObject({ status: 'failed' });
    },
  );
});
