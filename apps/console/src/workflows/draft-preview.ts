import type { DraftRequestProgress } from './draft-request-progress.js';

// Read complete values from an unfinished JSON document. Never guess a partial string.
export function readPartialJson(text: string, onReading?: (path: string[]) => void): unknown {
  let cursor = 0;
  const space = () => {
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++;
  };
  function value(depth = 0, path: string[] = [], readingKey = false): unknown {
    if (!readingKey) onReading?.(path);
    if (depth > 80) return undefined;
    space();
    const start = cursor;
    if (text[cursor] === '"') {
      cursor++;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text[cursor++] === '"') {
          try {
            const parsed: unknown = JSON.parse(text.slice(start, cursor));
            if (!readingKey) onReading?.(path.slice(0, -1));
            return parsed;
          } catch {
            return undefined;
          }
        }
      }
      return undefined;
    }
    if (text[cursor] === '{') {
      cursor++;
      const result: Record<string, unknown> = Object.create(null);
      while (cursor < text.length) {
        space();
        if (text[cursor] === '}') {
          onReading?.(path.slice(0, -1));
          cursor++;
          break;
        }
        const key = value(depth + 1, path, true);
        space();
        if (typeof key !== 'string' || text[cursor++] !== ':') break;
        const child = value(depth + 1, [...path, key]);
        if (child === undefined) break;
        result[key] = child;
        space();
        if (text[cursor] !== ',') {
          if (text[cursor] === '}') {
            cursor++;
            onReading?.(path.slice(0, -1));
          }
          break;
        }
        cursor++;
      }
      return result;
    }
    if (text[cursor] === '[') {
      cursor++;
      const result: unknown[] = [];
      while (cursor < text.length) {
        space();
        if (text[cursor] === ']') {
          onReading?.(path.slice(0, -1));
          cursor++;
          break;
        }
        const child = value(depth + 1, path);
        if (child === undefined) break;
        result.push(child);
        onReading?.(path);
        space();
        if (text[cursor] !== ',') {
          if (text[cursor] === ']') {
            cursor++;
            onReading?.(path.slice(0, -1));
          }
          break;
        }
        cursor++;
      }
      return result;
    }
    while (cursor < text.length && !/[\s,}\]]/.test(text[cursor]!)) cursor++;
    try {
      return JSON.parse(text.slice(start, cursor));
    } catch {
      return undefined;
    }
  }
  return value();
}

export function previewObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function draftPreview(progress: DraftRequestProgress) {
  const calls = new Map<string, { name: string; text: string; ended: boolean; order: number }>();
  for (const [eventIndex, entry] of (progress.events ?? []).entries()) {
    const name = entry.data.name;
    if (
      !['atlas_intent_frame', 'atlas_planner_output', 'atlas_planner_repair'].includes(String(name))
    )
      continue;
    const key = JSON.stringify([entry.data.callId, entry.data.attempt ?? 1]);
    if (entry.kind === 'model.call.started' || entry.kind === 'model.attempt.started') {
      calls.set(key, { name: String(name), text: '', ended: false, order: eventIndex });
    }
    const call = calls.get(key) ?? {
      name: String(name),
      text: '',
      ended: false,
      order: eventIndex,
    };
    const event = previewObject(entry.data.event);
    if (!call.text) call.order = eventIndex;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string')
      call.text += event.delta;
    if (event.type === 'response.output_text.done' && typeof event.text === 'string')
      call.text = event.text;
    if (
      [
        'response.output_text.done',
        'response.completed',
        'response.failed',
        'response.incomplete',
        'error',
      ].includes(String(event.type)) ||
      entry.kind === 'model.attempt.failed'
    )
      call.ended = true;
    const response = previewObject(event.response ?? entry.data.body);
    if (Array.isArray(response.output)) {
      const output = response.output.flatMap((item) => {
        const content = previewObject(item).content;
        return Array.isArray(content)
          ? content
              .filter((part) => previewObject(part).type === 'output_text')
              .map((part) => previewObject(part).text)
              .filter((text): text is string => typeof text === 'string')
          : [];
      });
      if (output.length) call.text = output.join('');
    }
    calls.set(key, call);
  }
  let intent: Record<string, unknown> = {};
  let summaryOrder = 0;
  let stepsOrder = 0;
  let draft: Record<string, unknown> = {};
  let active: 'summary' | 'inputs' | 'steps' | undefined;
  for (const call of calls.values()) {
    active = undefined;
    const parsed = previewObject(
      readPartialJson(call.text, (path) => {
        active =
          call.name === 'atlas_intent_frame'
            ? path[0] === 'summary'
              ? 'summary'
              : path[0] === 'requiredInputs'
                ? 'inputs'
                : undefined
            : path.slice(0, 4).join('.') === 'result.draft.executable.steps'
              ? 'steps'
              : undefined;
      }),
    );
    if (call.ended) active = undefined;
    if (call.name === 'atlas_intent_frame') {
      if (!Object.keys(draft).length) {
        intent = parsed;
        summaryOrder = call.order;
      } else active = undefined;
    } else {
      const nextDraft = previewObject(previewObject(parsed.result).draft);
      if (call.name === 'atlas_planner_repair' && Object.keys(draft).length) {
        // Keep the current proposal visible until a complete replacement arrives.
        try {
          JSON.parse(call.text);
          if (Object.keys(nextDraft).length) {
            draft = nextDraft;
            stepsOrder = call.order;
          }
        } catch {
          /* The repair is still streaming. */
        }
      } else {
        draft = nextDraft;
        stepsOrder = call.order;
      }
    }
  }
  const executable = previewObject(draft.executable);
  return {
    active: progress.status === 'running' ? active : undefined,
    summaryOrder,
    stepsOrder,
    summary: typeof intent.summary === 'string' ? intent.summary : '',
    inputs: Array.isArray(intent.requiredInputs)
      ? intent.requiredInputs.filter((input): input is string => typeof input === 'string')
      : [],
    steps: Array.isArray(executable.steps)
      ? executable.steps.map(previewObject).filter((step) => typeof step.id === 'string')
      : [],
  };
}
