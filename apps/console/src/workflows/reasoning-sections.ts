import type { DraftRequestProgress } from './draft-request-progress.js';

interface Summary {
  text: string;
  complete: boolean;
  call: string;
  order: number;
}

export function reasoningSections(progress: DraftRequestProgress) {
  const summaries = new Map<string, Summary>();
  const endedCalls = new Set<string>();
  for (const [eventIndex, entry] of (progress.events ?? []).entries()) {
    const event = entry.data.event as Record<string, unknown> | undefined;
    const call = JSON.stringify([entry.data.callId, entry.data.attempt]);
    const keyFor = (itemId: unknown, index: unknown) => JSON.stringify([call, itemId, index ?? 0]);
    const key = keyFor(event?.item_id, event?.summary_index);
    if (
      event?.type === 'response.reasoning_summary_text.delta' &&
      typeof event.delta === 'string'
    ) {
      summaries.set(key, {
        text: (summaries.get(key)?.text ?? '') + event.delta,
        complete: false,
        call,
        order: summaries.get(key)?.order ?? eventIndex,
      });
    }
    if (event?.type === 'response.reasoning_summary_text.done' && typeof event.text === 'string') {
      summaries.set(key, {
        text: event.text,
        complete: true,
        call,
        order: summaries.get(key)?.order ?? eventIndex,
      });
    }
    if (event?.type === 'response.output_item.done') {
      const item = event.item as { id?: string } | undefined;
      for (const [summaryKey, summary] of summaries) {
        const [, itemId] = JSON.parse(summaryKey) as [string, unknown];
        if (summary.call === call && itemId === item?.id) summary.complete = true;
      }
    }
    if (
      entry.kind === 'model.attempt.failed' ||
      event?.type === 'response.completed' ||
      event?.type === 'response.failed' ||
      event?.type === 'response.incomplete' ||
      event?.type === 'error'
    )
      endedCalls.add(call);

    const response = (event?.response ?? entry.data.body) as
      | { output?: { type: string; id?: string; summary?: { text?: string }[] }[] }
      | undefined;
    for (const item of response?.output ?? []) {
      if (item.type !== 'reasoning') continue;
      item.summary?.forEach((summary, index) => {
        if (summary.text) {
          summaries.set(keyFor(item.id, index), {
            text: summary.text,
            complete: true,
            call,
            order: summaries.get(keyFor(item.id, index))?.order ?? eventIndex,
          });
        }
      });
    }
  }

  return [...summaries].flatMap(([key, summary]) => {
    // A new heading closes the previous section, even while the summary continues streaming.
    const headings = [...summary.text.matchAll(/^\s*\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n|$)/gm)];
    const parts: { title: string; body: string }[] = [];
    const preamble = summary.text.slice(0, headings[0]?.index ?? summary.text.length).trim();
    if (preamble) parts.push({ title: 'Thinking', body: preamble });
    headings.forEach((heading, index) => {
      parts.push({
        title: heading[1]!.trim(),
        body: summary.text
          .slice(heading.index! + heading[0].length, headings[index + 1]?.index)
          .trim(),
      });
    });
    return parts.map((part, index) => ({
      ...part,
      key: `${key}:${index}`,
      order: summary.order + index / 1000,
      active:
        progress.status === 'running' &&
        !summary.complete &&
        !endedCalls.has(summary.call) &&
        index === parts.length - 1,
    }));
  });
}
