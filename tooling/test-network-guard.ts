// Tests use injected provider responses. An accidental real request must fail before sending.
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(
      `External network calls are disabled in tests: ${url.hostname}. Inject a fake response.`,
    );
  }
  return localFetch(input, { ...init, redirect: 'error' });
};
