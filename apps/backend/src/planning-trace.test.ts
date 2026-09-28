import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vite-plus/test';

import {
  credentialFingerprint,
  PlanningTraceStore,
  recordPlanningTrace,
  runWithPlanningTrace,
  serializeTraceError,
} from './planning-trace.js';

async function withTraceDirectory<T>(test: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-planning-trace-'));
  try {
    return await test(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readOnlyTrace(directory: string) {
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const contents = await readFile(join(directory, files[0]!), 'utf8');
  return {
    contents,
    records: contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

it('writes ordered JSONL and flushes an error before close', async () => {
  await withTraceDirectory(async (directory) => {
    const store = new PlanningTraceStore(directory);
    const trace = await store.start({
      request: { request: 'Make a workflow' },
      actorId: 'actor-1',
    });

    await expect(
      runWithPlanningTrace(trace, async () => {
        try {
          await recordPlanningTrace('planning.test', { exact: { value: 42 } });
          throw new Error('planned failure');
        } catch (error) {
          await recordPlanningTrace('planning.failed', {
            error: serializeTraceError(error),
          });
          throw error;
        } finally {
          await trace.close();
        }
      }),
    ).rejects.toThrow('planned failure');

    const { records } = await readOnlyTrace(directory);
    expect(records.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
    expect(records.map(({ kind }) => kind)).toEqual([
      'planning.started',
      'planning.test',
      'planning.failed',
    ]);
    expect(records[1]).toMatchObject({ exact: { value: 42 } });
  });
});

it('uses separate files for concurrent planning requests', async () => {
  await withTraceDirectory(async (directory) => {
    const store = new PlanningTraceStore(directory);
    const traceIds = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const trace = await store.start({
          request: { request: `Workflow ${index}` },
          actorId: `actor-${index}`,
        });
        await runWithPlanningTrace(trace, async () => {
          await recordPlanningTrace('planning.finished', {
            httpStatus: 200,
            response: { index },
          });
        });
        await trace.close();
        return trace.traceId;
      }),
    );

    const files = await readdir(directory);
    expect(files).toHaveLength(12);
    expect(new Set(files).size).toBe(12);
    expect(new Set(traceIds).size).toBe(12);
    await Promise.all(
      files.map(async (file) => {
        const records = (await readFile(join(directory, file), 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { traceId: string; sequence: number });
        expect(records.map(({ sequence }) => sequence)).toEqual([0, 1]);
        expect(new Set(records.map(({ traceId }) => traceId)).size).toBe(1);
      }),
    );
  });
});

it('records a stable credential fingerprint without the credential', async () => {
  await withTraceDirectory(async (directory) => {
    const credential = 'Bearer secret-planning-token';
    const store = new PlanningTraceStore(directory);
    const trace = await store.start({
      request: { request: 'Make a workflow' },
      actorId: 'actor-1',
      authorizationFingerprint: credentialFingerprint(credential),
    });
    await trace.close();

    const { contents, records } = await readOnlyTrace(directory);
    expect(contents).not.toContain(credential);
    expect(records[0]).toMatchObject({
      authorizationFingerprint: credentialFingerprint(credential),
    });
  });
});
