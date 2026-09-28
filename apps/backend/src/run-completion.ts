import type { Pool } from 'pg';
import { z } from 'zod';

import { recordRunLifecycleEnded } from './run-lifecycle.js';
import { recordWorkflowRunOutcome, runOutcomeSchema } from './workflow-runs.js';

export const runCompletionSchema = runOutcomeSchema.extend({
  workflowName: z.string(),
  occurredAt: z.iso.datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
});

export async function recordRunCompletion(
  pool: Pool,
  runId: string,
  input: z.infer<typeof runCompletionSchema>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `SELECT run_id FROM workflow_runs
       WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3 FOR UPDATE`,
      [input.organizationId, input.environmentId, runId],
    );
    if (run.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    const ended = await client.query(
      `SELECT 1 FROM workflow_run_lifecycles
       WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3 AND ended_at IS NOT NULL`,
      [input.organizationId, input.environmentId, runId],
    );
    if (ended.rowCount === 0) {
      const retries = await client.query<{ count: string }>(
        `SELECT count(*) FROM workflow_run_step_attempts
         WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3 AND attempt > 1`,
        [input.organizationId, input.environmentId, runId],
      );
      await recordWorkflowRunOutcome(client, runId, input);
      await recordRunLifecycleEnded(client, runId, {
        ...input,
        event: 'ended',
        retryCount: Number(retries.rows[0]!.count),
        outcome: input.state === 'completed' ? 'succeeded' : 'failed',
      });
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
