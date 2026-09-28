import { expect, it } from 'vite-plus/test';
import { DraftTraceLog, draftTraceData, type DraftTraceEvent } from './draft-trace.js';

it('keeps useful trace data while omitting transport copies and private payloads', () => {
  expect(
    draftTraceData({
      request: {
        headers: { authorization: 'Bearer secret' },
        rawBody: 'duplicate',
        body: { prompt: 'Draft a workflow' },
      },
      output: [
        {
          type: 'reasoning',
          id: 'r1',
          encrypted_content: 'private',
          content: ['private'],
          summary: [{ text: 'Checking fields' }],
        },
      ],
    }),
  ).toEqual({
    request: { headers: {}, body: { prompt: 'Draft a workflow' } },
    output: [{ type: 'reasoning', id: 'r1', summary: [{ text: 'Checking fields' }] }],
  });
});

it('flushes ordered events and explicitly marks the storage limit', async () => {
  const events: DraftTraceEvent[] = [];
  const log = new DraftTraceLog(async (batch) => {
    events.push(...batch);
  });
  await log.record('first', {});
  await log.record('second', {});
  await log.record('large', { text: 'x'.repeat(4 * 1024 * 1024) });
  await log.record('omitted', {});
  await log.flush();
  expect(events.map((event) => [event.sequence, event.kind])).toEqual([
    [0, 'first'],
    [1, 'second'],
    [2, 'trace.truncated'],
  ]);
});
