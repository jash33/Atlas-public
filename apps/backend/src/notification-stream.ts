import type { Pool, PoolClient, Notification } from 'pg';
import { readNotifications } from './notifications.js';

type Subscriber = { changed: (organizationId: string) => void; failed: () => void };

// All browser streams sharing this pool use one database listener.
const listeners = new WeakMap<Pool, ReturnType<typeof createListener>>();

function createListener(pool: Pool) {
  const subscribers = new Set<Subscriber>();
  let client: PoolClient | undefined;
  let ready: Promise<void> | undefined;
  let schema: string;
  const close = () => {
    const previous = client;
    client = undefined;
    ready = undefined;
    previous?.removeListener('notification', changed);
    previous?.release(true);
  };
  const failed = () => {
    for (const subscriber of [...subscribers]) subscriber.failed();
    close();
  };
  const changed = (notification: Notification) => {
    if (notification.channel !== 'atlas_notifications' || !notification.payload) return;
    let change: { schema?: string; organizationId?: string };
    try {
      change = JSON.parse(notification.payload);
    } catch {
      return;
    }
    if (!change || change.schema !== schema || typeof change.organizationId !== 'string') return;
    for (const subscriber of subscribers) subscriber.changed(change.organizationId);
  };
  return async (subscriber: Subscriber) => {
    subscribers.add(subscriber);
    ready ??= (async () => {
      const connection = await pool.connect();
      client = connection;
      connection.on('error', () => {
        if (client === connection) failed();
      });
      connection.on('notification', changed);
      const result = await connection.query<{ schema: string }>(
        'SELECT current_schema() AS schema',
      );
      schema = result.rows[0]!.schema;
      await connection.query('LISTEN atlas_notifications');
    })();
    const unsubscribe = () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) close();
    };
    try {
      await ready;
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  };
}

export function notificationStream(
  pool: Pool,
  query: { organizationId: string; environmentId?: string | undefined },
  signal: AbortSignal,
) {
  let subscribe = listeners.get(pool);
  if (!subscribe) {
    subscribe = createListener(pool);
    listeners.set(pool, subscribe);
  }
  const encoder = new TextEncoder();
  let stop: (closeStream?: boolean) => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let dirty = false;
      let reading = false;
      let unsubscribe: (() => void) | undefined;
      const heartbeat = setInterval(() => send(': keepalive\n\n'), 20_000);
      // Reconnect periodically to recheck the current session and membership.
      const expiry = setTimeout(() => stop(), 5 * 60_000);
      stop = (closeStream = true) => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(expiry);
        signal.removeEventListener('abort', aborted);
        unsubscribe?.();
        if (closeStream) controller.close();
      };
      function send(text: string) {
        if (closed) return;
        // A slow client reconnects for a fresh snapshot instead of accumulating data.
        if ((controller.desiredSize ?? 0) <= 0) {
          stop();
          return;
        }
        controller.enqueue(encoder.encode(text));
      }
      async function refresh() {
        dirty = true;
        if (reading || closed) return;
        reading = true;
        try {
          while (dirty && !closed) {
            dirty = false;
            const feed = await readNotifications(pool, query);
            send(`event: notifications\ndata: ${JSON.stringify(feed)}\n\n`);
          }
        } catch {
          stop();
        } finally {
          reading = false;
        }
      }
      function aborted() {
        stop();
      }
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) {
        stop();
        return;
      }
      void subscribe!({
        changed: (organizationId) => {
          if (organizationId === query.organizationId) void refresh();
        },
        failed: () => stop(),
      })
        .then((cleanup) => {
          unsubscribe = cleanup;
          if (closed) cleanup();
          // LISTEN is established before the snapshot, so concurrent changes are not lost.
          else void refresh();
        })
        .catch(() => stop());
    },
    cancel() {
      stop(false);
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
