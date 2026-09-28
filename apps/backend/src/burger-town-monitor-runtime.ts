import type { PollingClock, PollingHttp } from './burger-town-monitor.js';

export const systemPollingClock: PollingClock = {
  now: () => new Date(),
  repeat(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    return () => clearInterval(timer);
  },
  after(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    return () => clearTimeout(timer);
  },
};

export const fetchPollingHttp: PollingHttp = {
  async send(target, signal) {
    const response = await fetch(target.url, {
      method: target.method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `${target.definitionKey}:revision-${target.revision}`,
      },
      ...(['GET', 'HEAD'].includes(target.method)
        ? {}
        : { body: JSON.stringify(target.requestBody) }),
      signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    return {
      status: response.status,
      body: contentType.includes('application/json') ? await response.json() : null,
    };
  },
};
