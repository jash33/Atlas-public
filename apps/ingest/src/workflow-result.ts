import { z } from 'zod';

const workflowResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running') }),
  z.object({ status: z.literal('completed'), output: z.record(z.string(), z.json()) }),
  z.object({ status: z.literal('failed'), error: z.string() }),
]);

export type WorkflowResult = z.infer<typeof workflowResultSchema>;

export function createWorkflowResultClient(options: {
  readonly workerUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}) {
  return async (runId: string, signal: AbortSignal): Promise<WorkflowResult> => {
    const response = await (options.fetch ?? fetch)(
      new URL(`/v1/workflow-results/${encodeURIComponent(runId)}`, options.workerUrl),
      { headers: { authorization: `Bearer ${options.token}` }, signal, redirect: 'error' },
    );
    if (!response.ok) throw new Error('workflow-result-unavailable');
    return workflowResultSchema.parse(await response.json());
  };
}
