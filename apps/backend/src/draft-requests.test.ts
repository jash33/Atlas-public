import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { DraftRequests } from './draft-requests.js';
import { recordPlanningTrace } from './planning-trace.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schema = 'draft_requests_test';
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
const owner = { actorId: 'author', organizationId: 'org_atlas', environmentId: 'development' };
const result = { httpStatus: 200, body: { status: 'validated' } };
beforeAll(() => migrateTestDatabase(databaseUrl, { schema, lockValue: 245 }));
afterAll(() => pool.end());

describe('stored draft requests', () => {
  it('keeps streamed output and traces after failure and reconnect', async () => {
    const id = randomUUID();
    const requests = new DraftRequests(pool);
    await requests.start(id, owner, 'stream', async () => {
      await recordPlanningTrace('model.stream.started', {});
      await recordPlanningTrace('model.stream.event', {
        event: { type: 'response.output_text.delta', delta: 'partial output' },
      });
      throw new Error('failed');
    });
    await vi.waitFor(async () =>
      expect(await requests.read(id, owner)).toMatchObject({ status: 'failed' }),
    );
    const saved = await new DraftRequests(pool).read(id, owner);
    expect(saved?.liveText).toBe(true);
    expect(saved?.events?.map((event) => event.kind)).toEqual([
      'model.stream.started',
      'model.stream.event',
    ]);
    expect(JSON.stringify(saved?.events)).toContain('partial output');
    expect(await requests.read(id, { ...owner, actorId: 'other' })).toBeUndefined();
  });
  it('recovers slow and completed requests without calling the model twice', async () => {
    const requests = new DraftRequests(pool);
    const id = randomUUID();
    const release = Promise.withResolvers<void>();
    const work = vi.fn<Parameters<DraftRequests['start']>[3]>(async (_signal, progress) => {
      await progress('understanding');
      await release.promise;
      await progress('building');
      await progress('validating');
      return result;
    });
    await requests.start(id, owner, 'same-request', work);
    await vi.waitFor(async () =>
      expect(await requests.read(id, owner)).toMatchObject({ stage: 'understanding' }),
    );
    const reconnected = new DraftRequests(pool);
    expect(await reconnected.start(id, owner, 'same-request', work)).toMatchObject({
      status: 'running',
      stage: 'understanding',
    });
    expect(work).toHaveBeenCalledTimes(1);
    release.resolve();
    await vi.waitFor(async () =>
      expect(await reconnected.read(id, owner)).toMatchObject({
        status: 'completed',
        result,
        finishedAt: expect.any(String),
      }),
    );
    expect(await reconnected.start(id, owner, 'same-request', work)).toMatchObject({
      status: 'completed',
    });
    expect(work).toHaveBeenCalledTimes(1);
    expect(await reconnected.read(id, { ...owner, actorId: 'someone-else' })).toBeUndefined();
    expect(await reconnected.read(id, { ...owner, environmentId: 'production' })).toBeUndefined();
    expect(await reconnected.start(id, owner, 'different-request', work)).toBeUndefined();
  });

  it('cancels the provider signal and rejects a late result even from another server', async () => {
    const requests = new DraftRequests(pool);
    const id = randomUUID();
    const release = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    await requests.start(id, owner, 'cancel', async (currentSignal, progress) => {
      signal = currentSignal;
      await progress('building');
      await release.promise;
      return result;
    });
    await requests.cancel(id, owner);
    expect(signal?.aborted).toBe(true);
    release.resolve();
    await vi.waitFor(async () =>
      expect(await new DraftRequests(pool).read(id, owner)).toMatchObject({ status: 'cancelled' }),
    );
    expect((await requests.read(id, owner))?.result).toBeUndefined();
  });

  it('stores safe failure details and recovers interrupted server work', async () => {
    const requests = new DraftRequests(pool);
    const id = randomUUID();
    await requests.start(id, owner, 'failure', async () => {
      throw new Error('secret-provider-body');
    });
    await vi.waitFor(async () =>
      expect(await requests.read(id, owner)).toMatchObject({ status: 'failed' }),
    );
    expect(JSON.stringify(await requests.read(id, owner))).not.toContain('secret-provider-body');
    const stalledId = randomUUID();
    const release = Promise.withResolvers<void>();
    await requests.start(stalledId, owner, 'interrupted', async () => {
      await release.promise;
      return result;
    });
    await pool.query(
      "UPDATE draft_requests SET heartbeat_at = now() - interval '3 minutes' WHERE id = $1",
      [stalledId],
    );
    expect(await new DraftRequests(pool).read(stalledId, owner)).toMatchObject({
      status: 'failed',
    });
    release.resolve();
    await requests.cancel(stalledId, owner);
    expect((await requests.read(stalledId, owner))?.result).toBeUndefined();
  });
});
