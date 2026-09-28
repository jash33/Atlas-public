import type { WorkflowClient } from '@temporalio/client';
import type { WorkflowResult } from '@atlas/runtime-ports';
import type { InterpreterResult } from './workflow.js';

export function createWorkflowResultReader(client: Pick<WorkflowClient, 'getHandle'>) {
  return async (runId: string): Promise<WorkflowResult> => {
    const handle = client.getHandle(runId);
    const description = await handle.describe();
    if (description.status.name === 'RUNNING') return { status: 'running' };
    if (description.status.name !== 'COMPLETED') {
      return { status: 'failed', error: 'workflow-execution-failed' };
    }
    // Uses the worker's encrypted data converter; business outputs never enter the backend DB.
    const result = (await handle.result()) as InterpreterResult;
    if (result.state !== 'completed')
      return { status: 'failed', error: 'workflow-execution-failed' };
    if (result.output === undefined)
      return { status: 'failed', error: 'workflow-response-unavailable' };
    return { status: 'completed', output: result.output };
  };
}
