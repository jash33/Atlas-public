import { recordPlanningTrace, type PlanningTraceData } from './planning-trace.js';

export async function readPlannerResponseStream(response: Response, context: PlanningTraceData) {
  if (!response.body) throw new Error('The planning response stream has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: unknown;
  async function consume(frame: string) {
    const text = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!text || text === '[DONE]') return;
    const event = JSON.parse(text) as Record<string, unknown>;
    if (typeof event.type !== 'string') throw new Error('Invalid planning stream event');
    // Only provider summaries are intended for display, not private reasoning payloads.
    if (!event.type.startsWith('response.reasoning_text.')) {
      await recordPlanningTrace('model.stream.event', { ...context, event });
    }
    if (event.type === 'response.completed') completed = event.response;
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) {
      const failedResponse = event.response as Record<string, unknown> | undefined;
      const error = (event.error ?? failedResponse?.error ?? event) as Record<string, unknown>;
      const explanation =
        error.code === 'credit_balance_exhausted'
          ? ': Model API credits are exhausted'
          : error.code === 'server_is_overloaded'
            ? ': The model service is temporarily overloaded'
            : '';
      throw new Error(`Planning stream ended with ${event.type}${explanation}`);
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        await consume(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (buffer.length > 16 * 1024 * 1024) throw new Error('Planning stream event is too large');
      if (done) break;
    }
    if (buffer.trim()) await consume(buffer);
    if (!completed) throw new Error('Planning stream disconnected before completion');
    return JSON.stringify(completed);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
