import type { PlanningTraceData } from './planning-trace.js';

export interface DraftTraceEvent {
  sequence: number;
  timestamp: string;
  kind: string;
  data: PlanningTraceData;
}

// Omit transport copies and credentials; keep prompts, outputs and validation details.
export function draftTraceData(data: PlanningTraceData): PlanningTraceData {
  return JSON.parse(
    JSON.stringify(data, (key, value: unknown) => {
      if (
        /^(rawBody|encrypted_content|authorization|authorizationFingerprint|apiKey|password|secret|access_token|refresh_token|stack)$/i.test(
          key,
        )
      )
        return undefined;
      if (value && typeof value === 'object' && 'type' in value && value.type === 'reasoning') {
        const item = value as Record<string, unknown>;
        return { type: item.type, id: item.id, summary: item.summary };
      }
      return value;
    }),
  );
}

export class DraftTraceLog {
  #sequence = 0;
  #bytes = 0;
  #pending: DraftTraceEvent[] = [];
  #lastFlush = 0;
  #writes = Promise.resolve();
  #truncated = false;

  constructor(private readonly save: (events: DraftTraceEvent[]) => Promise<void>) {}

  async record(kind: string, data: PlanningTraceData) {
    if (this.#truncated) return;
    let event: DraftTraceEvent = {
      sequence: this.#sequence++,
      timestamp: new Date().toISOString(),
      kind,
      data: draftTraceData(data),
    };
    this.#bytes += Buffer.byteLength(JSON.stringify(event));
    if (this.#bytes > 4 * 1024 * 1024) {
      this.#truncated = true;
      event = {
        ...event,
        kind: 'trace.truncated',
        data: { message: 'The saved log reached its 4 MB limit.' },
      };
    }
    this.#pending.push(event);
    if (Date.now() - this.#lastFlush >= 250) await this.flush();
  }

  flush() {
    const events = this.#pending.splice(0);
    this.#lastFlush = Date.now();
    if (events.length) this.#writes = this.#writes.then(() => this.save(events));
    return this.#writes;
  }
}
