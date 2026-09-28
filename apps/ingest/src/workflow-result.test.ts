import { describe, expect, it, vi } from 'vite-plus/test';
import { createWorkflowResultClient } from './workflow-result.js';

describe('worker result client', () => {
  it('uses the environment worker credential and preserves the final output', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ status: 'completed', output: { fifth: { id: 'receipt' } } }),
      );
    const read = createWorkflowResultClient({
      workerUrl: 'http://worker:4200',
      token: 'result-token',
      fetch,
    });
    const signal = new AbortController().signal;
    expect(await read('atlas:run:one', signal)).toEqual({
      status: 'completed',
      output: { fifth: { id: 'receipt' } },
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://worker:4200/v1/workflow-results/atlas%3Arun%3Aone'),
      {
        headers: { authorization: 'Bearer result-token' },
        signal,
        redirect: 'error',
      },
    );
  });

  it('rejects a malformed response instead of treating it as workflow completion', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ status: 'completed' }));
    const read = createWorkflowResultClient({
      workerUrl: 'http://worker:4200',
      token: 'result-token',
      fetch,
    });
    await expect(read('atlas:run:one', new AbortController().signal)).rejects.toThrow('output');
  });
});
