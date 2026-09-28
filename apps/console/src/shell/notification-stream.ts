import { consoleConfig } from '../config.js';
import { consoleFetch } from './api.js';
import { notificationQuery, type NotificationFeed } from './notifications.js';

export function subscribeToNotifications({
  organizationId,
  token,
  onFeed,
  onFailure,
}: {
  organizationId: string;
  token: string;
  onFeed: (feed: NotificationFeed) => void;
  onFailure: () => void;
}) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 1_000;
  const connect = async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let retry = true;
    try {
      const response = await consoleFetch(
        `${consoleConfig.backendUrl}/v1/notifications/stream?${notificationQuery(organizationId)}`,
        {
          signal: controller.signal,
          headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
        },
      );
      if (response.status === 401 || response.status === 403) retry = false;
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get('content-type')?.includes('text/event-stream')
      )
        throw new Error('Notification stream unavailable');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator: RegExpExecArray | null;
        while ((separator = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const lines = frame.split(/\r?\n/);
          if (!lines.some((line) => /^event: ?notifications$/.test(line))) continue;
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (controller.signal.aborted) return;
          onFeed(JSON.parse(data) as NotificationFeed);
          retryMs = 1_000;
        }
      }
      if (!controller.signal.aborted) onFailure();
    } catch {
      if (!controller.signal.aborted) onFailure();
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      if (!controller.signal.aborted && retry) {
        timer = setTimeout(() => void connect(), retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
  };
  void connect();
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  };
}
