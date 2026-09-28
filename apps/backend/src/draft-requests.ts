import type { Pool } from 'pg';
import { DraftTraceLog, type DraftTraceEvent } from './draft-trace.js';
import { runWithPlanningTraceListener } from './planning-trace.js';

export type DraftStage = 'understanding' | 'building' | 'validating' | 'repairing';
export interface DraftRequestState {
  requestId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  stage?: DraftStage;
  startedAt: string;
  finishedAt?: string;
  liveText: boolean;
  events?: DraftTraceEvent[];
  error?: string;
  result?: { httpStatus: number; body: unknown };
}

interface RequestOwner {
  actorId: string;
  organizationId: string;
  environmentId: string;
}

// The database owns terminal state. A cancelled or expired request cannot complete later.
export class DraftRequests {
  readonly #controllers = new Map<string, AbortController>();
  constructor(private readonly pool: Pool) {}

  async read(id: string, owner: RequestOwner): Promise<DraftRequestState | undefined> {
    await this.pool.query(
      `UPDATE draft_requests SET state = state || $5::jsonb
       WHERE id = $1 AND actor_id = $2 AND organization_id = $3 AND environment_id = $4
       AND state->>'status' = 'running' AND heartbeat_at < now() - interval '2 minutes'`,
      [
        id,
        owner.actorId,
        owner.organizationId,
        owner.environmentId,
        JSON.stringify({
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: 'Drafting was interrupted on the server. Start a new draft.',
        }),
      ],
    );
    const result = await this.pool.query<{ state: DraftRequestState }>(
      `SELECT state FROM draft_requests WHERE id = $1 AND actor_id = $2 AND organization_id = $3 AND environment_id = $4`,
      [id, owner.actorId, owner.organizationId, owner.environmentId],
    );
    return result.rows[0]?.state;
  }

  async cancel(id: string, owner: RequestOwner) {
    const state = await this.read(id, owner);
    if (!state) return;
    await this.#update(id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    this.#controllers.get(id)?.abort();
    return this.read(id, owner);
  }

  async start(
    id: string,
    owner: RequestOwner,
    requestHash: string,
    work: (
      signal: AbortSignal,
      progress: (stage: DraftStage) => Promise<void>,
    ) => Promise<{ httpStatus: number; body: unknown }>,
  ) {
    const state: DraftRequestState = {
      requestId: id,
      status: 'running',
      startedAt: new Date().toISOString(),
      liveText: false,
    };
    const inserted = await this.pool.query(
      `INSERT INTO draft_requests (id, actor_id, organization_id, environment_id, request_hash, state)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING id`,
      [
        id,
        owner.actorId,
        owner.organizationId,
        owner.environmentId,
        requestHash,
        JSON.stringify(state),
      ],
    );
    if (!inserted.rowCount) {
      const existing = await this.pool.query(
        `SELECT id FROM draft_requests WHERE id = $1 AND actor_id = $2 AND organization_id = $3 AND environment_id = $4 AND request_hash = $5`,
        [id, owner.actorId, owner.organizationId, owner.environmentId, requestHash],
      );
      return existing.rowCount ? this.read(id, owner) : undefined;
    }
    const controller = new AbortController();
    const log = new DraftTraceLog(async (events) => {
      await this.pool.query(
        `UPDATE draft_requests SET state = jsonb_set(state, '{events}',
         COALESCE(state->'events', '[]'::jsonb) || $2::jsonb)
         || jsonb_build_object('liveText', COALESCE((state->>'liveText')::boolean, false) OR $3)
         WHERE id = $1 AND state->>'status' = 'running'`,
        [id, JSON.stringify(events), events.some((event) => event.kind === 'model.stream.started')],
      );
    });
    this.#controllers.set(id, controller);
    const traceFlush = setInterval(() => {
      void log.flush().catch(() => controller.abort());
    }, 250);
    traceFlush.unref();
    const heartbeat = setInterval(() => {
      void this.#update(id, {})
        .then((active) => {
          if (!active) controller.abort();
        })
        .catch(() => controller.abort());
    }, 5_000);
    heartbeat.unref();
    void (async () => {
      try {
        const result = await runWithPlanningTraceListener(
          (kind, data) => log.record(kind, data),
          () =>
            work(controller.signal, async (stage) => {
              controller.signal.throwIfAborted();
              if (!(await this.#update(id, { stage }))) controller.abort();
              controller.signal.throwIfAborted();
              await log.record('planning.stage', { stage });
            }),
        );
        await log.flush();
        controller.signal.throwIfAborted();
        await this.#update(id, {
          status: 'completed',
          result,
          finishedAt: new Date().toISOString(),
        });
      } catch {
        await log.flush().catch(() => undefined);
        // Keep the headline error concise; provider details are in the saved trace.
        await this.#update(id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: 'Atlas could not finish drafting. Check the AI connection and try again.',
        }).catch(() => undefined);
      } finally {
        clearInterval(traceFlush);
        clearInterval(heartbeat);
        this.#controllers.delete(id);
      }
    })();
    return state;
  }

  async #update(id: string, patch: Partial<DraftRequestState>) {
    const result = await this.pool.query(
      `UPDATE draft_requests SET state = state || $2::jsonb, heartbeat_at = now()
       WHERE id = $1 AND state->>'status' = 'running'
       AND heartbeat_at >= now() - interval '2 minutes' RETURNING id`,
      [id, JSON.stringify(patch)],
    );
    return Boolean(result.rowCount);
  }
}
