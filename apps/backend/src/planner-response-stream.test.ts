import { expect, it } from 'vite-plus/test';
import { readPlannerResponseStream } from './planner-response-stream.js';
import { runWithPlanningTraceListener } from './planning-trace.js';

it('reports exhausted model credits without copying arbitrary provider error text', async () => {
  await expect(
    readPlannerResponseStream(
      new Response(
        'data: {"type":"error","error":{"code":"credit_balance_exhausted","message":"private diagnostic text"}}\n\n',
      ),
      {},
    ),
  ).rejects.toThrow('Model API credits are exhausted');
});

it('streams split UTF-8 frames before completion and keeps summaries and usage', async () => {
  const events: unknown[] = [];
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const pending = runWithPlanningTraceListener(
    async (kind, data) => {
      events.push({ kind, ...data });
    },
    () => readPlannerResponseStream(new Response(stream.readable), { callId: 'call' }),
  );
  const bytes = new TextEncoder().encode(
    'data: {"type":"response.reasoning_summary_text.delta","delta":"Café"}\r\n\r\n',
  );
  for (const byte of bytes) await writer.write(new Uint8Array([byte]));
  await writer.write(
    new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"{}"}\n\n'),
  );
  expect(JSON.stringify(events)).toContain('Café');
  await writer.write(
    new TextEncoder().encode(
      'data: {"type":"response.completed","response":{"output":[],"usage":{"total_tokens":10}}}\n\n',
    ),
  );
  await writer.close();
  expect(JSON.parse(await pending)).toEqual({ output: [], usage: { total_tokens: 10 } });
});

it('rejects a disconnected stream instead of treating partial output as success', async () => {
  await expect(
    readPlannerResponseStream(
      new Response('data: {"type":"response.output_text.delta","delta":"{}"}\n\n'),
      {},
    ),
  ).rejects.toThrow('disconnected before completion');
});

it('records provider failure details before rejecting an incomplete response', async () => {
  const events: unknown[] = [];
  await expect(
    runWithPlanningTraceListener(
      async (_kind, data) => {
        events.push(data);
      },
      () =>
        readPlannerResponseStream(
          new Response(
            'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n',
          ),
          {},
        ),
    ),
  ).rejects.toThrow('response.incomplete');
  expect(JSON.stringify(events)).toContain('max_output_tokens');
});
