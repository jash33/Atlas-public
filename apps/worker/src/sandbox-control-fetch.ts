/** Transport used only for sandbox setup and observation, never capability execution. */
export function createSandboxControlFetch(
  request: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      return await request(input, init);
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const method = (init?.method ?? 'GET').toUpperCase();
      // Retry only the observed pre-connection failure, and only replayable control
      // reads/assignments. Never retry executions, consumed streams, or socket errors
      // where the provider might already have processed the request.
      if (
        !(input instanceof Request) &&
        (method === 'GET' || method === 'PUT') &&
        (init?.body == null || typeof init.body === 'string') &&
        !init?.signal?.aborted &&
        cause !== null &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code === 'UND_ERR_CONNECT_TIMEOUT'
      ) {
        return request(input, init);
      }
      throw error;
    }
  };
}
