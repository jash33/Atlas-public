import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { sha256 } from './capability-versioning.js';

export type RepositoryAnalysisPhase =
  | 'connecting'
  | 'discovering'
  | 'extracting'
  | 'checking'
  | 'complete';
export interface RepositoryProgressUpdate {
  phase: RepositoryAnalysisPhase;
  message: string;
  servicesFound?: number;
  sourceFiles?: number;
  filesRead?: number;
  operationsDrafted?: number;
  operationsDiscovered?: number | null;
  workflowsDrafted?: number;
}
export interface RepositoryAnalysisProgress extends RepositoryProgressUpdate {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'outdated';
  startedAt: string;
  updatedAt: string;
  checkId: string;
  targetKey?: string;
  runId?: string;
  activity: Array<{ at: string; message: string; phase: RepositoryAnalysisPhase }>;
}

export function queuedRepositoryProgress(): RepositoryAnalysisProgress {
  const now = new Date().toISOString();
  return {
    status: 'queued',
    phase: 'connecting',
    message: 'Waiting for analysis to start.',
    startedAt: now,
    updatedAt: now,
    checkId: '',
    activity: [],
  };
}

const draftCountsSchema = z.object({
  services: z.array(
    z.object({
      inventory: z.object({ operationIds: z.array(z.string()) }).optional(),
      openapi: z.object({ paths: z.record(z.string(), z.record(z.string(), z.unknown())) }),
      arazzo: z
        .object({ workflows: z.array(z.unknown()) })
        .nullable()
        .optional(),
    }),
  ),
});
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

// Counts are drafts, not verified contracts or a percentage of total analysis time.
export function repositoryProgressCounts(document: unknown) {
  const parsed = draftCountsSchema.safeParse(document);
  if (!parsed.success) return {};
  const services = parsed.data.services;
  return {
    operationsDrafted: services.reduce(
      (sum, service) =>
        sum +
        Object.values(service.openapi.paths).reduce(
          (count, path) => count + Object.keys(path).filter((method) => methods.has(method)).length,
          0,
        ),
      0,
    ),
    operationsDiscovered: services.some((service) => service.inventory)
      ? services.reduce(
          (sum, service) => sum + new Set(service.inventory?.operationIds ?? []).size,
          0,
        )
      : null,
    workflowsDrafted: services.reduce(
      (sum, service) => sum + (service.arazzo?.workflows.length ?? 0),
      0,
    ),
  };
}

export function createRepositoryProgressReporter(
  client: PoolClient,
  connectionId: string,
  generation: number,
) {
  let progress: RepositoryAnalysisProgress = {
    ...queuedRepositoryProgress(),
    checkId: randomUUID(),
    status: 'running',
  };
  async function report(
    update: Omit<RepositoryProgressUpdate, 'phase'> &
      Partial<Pick<RepositoryAnalysisProgress, 'phase' | 'status' | 'runId' | 'targetKey'>>,
    options: { connectionOnly?: boolean } = {},
  ) {
    const now = new Date().toISOString();
    const message = update.message.slice(0, 500);
    const phase = update.phase ?? progress.phase;
    const previous = progress.activity.at(-1);
    progress = {
      ...progress,
      ...update,
      phase,
      message,
      updatedAt: now,
      activity:
        previous?.message === message && previous.phase === phase
          ? progress.activity
          : [...progress.activity, { at: now, phase, message }].slice(-20),
    };
    await client.query(
      'UPDATE github_repository_connections SET progress=$3 WHERE id=$1 AND ingestion_generation=$2',
      [connectionId, generation, JSON.stringify(progress)],
    );
    if (progress.runId && !options.connectionOnly)
      await client.query(
        'UPDATE repository_analysis_runs SET progress=$2 WHERE id=$1 AND connection_id=$3',
        [progress.runId, JSON.stringify(progress), connectionId],
      );
  }
  return { report };
}

export async function notifyRepositoryAnalysis(
  client: PoolClient,
  connectionId: string,
  generation: number,
  result: { failed: boolean; message: string; candidates: string[] },
) {
  if (!result.failed && !result.candidates.length) return;
  const key = sha256(
    JSON.stringify([generation, result.failed, result.message, result.candidates]),
  );
  await client.query(
    `WITH subscribed AS (
      UPDATE github_repository_connections SET last_notification_key=$3
      WHERE id=$1 AND ingestion_generation=$2 AND notify_environment_id IS NOT NULL
        AND last_notification_key IS DISTINCT FROM $3
      RETURNING organization_id,notify_environment_id,repository
    )
    INSERT INTO notifications (id,organization_id,environment_id,severity,title,message,navigation_target)
    SELECT $4,organization_id,notify_environment_id,$5,$6,repository || ': ' || $7,$8 FROM subscribed`,
    [
      connectionId,
      generation,
      key,
      randomUUID(),
      result.failed ? 'warning' : 'info',
      result.failed
        ? 'Repository analysis needs attention'
        : 'Repository contracts are ready to review',
      result.message,
      `#/capabilities?repositoryConnection=${encodeURIComponent(connectionId)}`,
    ],
  );
}
