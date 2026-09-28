# Notification delivery

The Console opens one authenticated `GET /v1/notifications/stream` connection per mounted notification center. The response uses server-sent events (SSE). It sends a `notifications` event containing the current feed on connection and whenever saved notifications change. There is no notification polling timer in either the browser or the backend.

Migration `078_notification_events.cjs` adds a PostgreSQL trigger for notification inserts, updates, and deletes. The trigger sends the schema and organization ID through `LISTEN/NOTIFY` after the transaction commits. Each backend pool shares one database listener across its browser streams, and releases that listener when the last stream closes. Changes from other backend processes are delivered through PostgreSQL as well.

The listener starts before the initial snapshot is read. Updates arriving during a read cause another read, avoiding a gap between subscribing and loading. The stored notification rows are authoritative; signals are not a durable event history. Reconnecting always reads a fresh snapshot, including changes missed while disconnected. Organization authorization applies before opening the stream, and database signals are filtered by schema and organization.

The browser uses streaming fetch through the existing Console authentication helper, supporting both demo bearer headers and customer session cookies. It reconnects after failures with a delay increasing from one to thirty seconds, resetting after a valid snapshot. Access denials stop retries. Unmounting or changing organization aborts the connection. Existing feed data stays visible during temporary connection failures.

The backend sends a keepalive comment every twenty seconds without querying the database. Streams close after five minutes so reconnecting rechecks session and membership access. Database listener failures also close affected streams. Slow clients reconnect for a fresh snapshot rather than accumulating queued updates. Responses disable caching and request that proxies avoid buffering.

Notification delivery is independent of monitoring. Read, resolve, and clear actions retain their existing HTTP endpoints; their saved changes reach all connected notification centers through the stream.

Protocol references: [SSE format](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events), [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), and [LISTEN startup ordering](https://www.postgresql.org/docs/current/sql-listen.html).
