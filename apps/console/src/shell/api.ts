import { consoleConfig, customerAuth } from '../config.js';

function serverMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : undefined;
}

export function describeApiFailure(status: number, body: unknown): string {
  const message = serverMessage(body);
  if (status === 401) return 'Your sign-in has expired. Sign in again.';
  if (status === 403) {
    return (
      message ??
      'Your Atlas role does not allow this action. Contact an administrator if you need access.'
    );
  }
  return message ?? `Request failed (${status})`;
}

export async function requestJson<T>(
  path: string,
  init?: RequestInit,
  describeFailure: (status: number, body: unknown) => string = describeApiFailure,
): Promise<T> {
  const response = await consoleFetch(`${consoleConfig.backendUrl}${path}`, init);
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(describeFailure(response.status, body));
  return body as T;
}

export function requestJsonWithFailure(describeFailure: (status: number, body: unknown) => string) {
  return <T>(path: string, init?: RequestInit) => requestJson<T>(path, init, describeFailure);
}

export const sessionExpiredEvent = 'atlas-session-expired';

export async function consoleFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!customerAuth) return fetch(url, init);
  const headers = new Headers(init?.headers);
  headers.delete('authorization');
  const response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  if (response.status === 401) window.dispatchEvent(new Event(sessionExpiredEvent));
  return response;
}
