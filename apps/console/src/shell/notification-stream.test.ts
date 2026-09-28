import type { NotificationFeed } from './notifications.js';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { subscribeToNotifications } from './notification-stream.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('receives split UTF-8 events on one authenticated connection without polling', async () => {
  vi.useFakeTimers();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
    },
  });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const onFeed = vi.fn<(feed: NotificationFeed) => void>();
  const onFailure = vi.fn<() => void>();
  const stop = subscribeToNotifications({
    organizationId: 'org',
    token: 'test',
    onFeed,
    onFailure,
  });
  const feed = { notifications: [{ title: 'Café' }], unreadCount: 1, urgentUnreadCount: 0 };
  for (const byte of new TextEncoder().encode(
    `: keepalive\r\n\r\nevent: notifications\r\ndata: ${JSON.stringify(feed)}\r\n\r\n`,
  ))
    output.enqueue(new Uint8Array([byte]));
  await vi.advanceTimersByTimeAsync(0);
  expect(onFeed).toHaveBeenCalledWith(feed);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toContain('/v1/notifications/stream?organizationId=org');
  expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer test' });
  expect(onFailure).not.toHaveBeenCalled();
  stop();
  output.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
});

it('reconnects after disconnection and accepts the fresh snapshot', async () => {
  vi.useFakeTimers();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const feed = { notifications: [], unreadCount: 0, urgentUnreadCount: 0 };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('', { headers: { 'content-type': 'text/event-stream' } }))
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            output = controller;
            controller.enqueue(
              new TextEncoder().encode(`event: notifications\ndata: ${JSON.stringify(feed)}\n\n`),
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  vi.stubGlobal('fetch', fetch);
  const onFeed = vi.fn<(feed: NotificationFeed) => void>();
  const stop = subscribeToNotifications({
    organizationId: 'org',
    token: 'test',
    onFeed,
    onFailure: vi.fn<() => void>(),
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(onFeed).toHaveBeenCalledWith(feed);
  stop();
  output.close();
});

it.each([401, 403])('does not retry denied access (%s)', async (status) => {
  vi.useFakeTimers();
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status }));
  vi.stubGlobal('fetch', fetch);
  const onFailure = vi.fn<() => void>();
  const stop = subscribeToNotifications({
    organizationId: 'org',
    token: 'test',
    onFeed: vi.fn<(feed: NotificationFeed) => void>(),
    onFailure,
  });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(onFailure).toHaveBeenCalledOnce();
  stop();
});
