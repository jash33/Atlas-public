import { expect, it } from 'vite-plus/test';
import { registeredSourcePolicy } from './registered-source-policy.js';
import { materializeRemoteCapabilitySource } from './source-policy.js';

it('refreshes the configured demo source with its connection policy while denying other addresses', async () => {
  const fallback = { allowedHosts: ['specs.example'] };
  const policy = registeredSourcePolicy(fallback, {
    serviceId: 'burger-town',
    urls: ['http://demo.internal:43123/openapi.json'],
    policy: {
      allowedHosts: ['demo.internal'],
      allowedPrivateHosts: ['demo.internal'],
      lookup: async () => [{ address: '192.168.1.2', family: 4 }],
      fetch: async () => Response.json({ openapi: '3.1.0' }),
    },
  });
  if (typeof policy !== 'function') throw new Error('Expected a source policy selector');
  const url = 'http://demo.internal:43123/openapi.json';
  await expect(
    materializeRemoteCapabilitySource({ source: { url }, trigger: 'daily-poll' }, fallback),
  ).rejects.toThrow('source-host-not-allowlisted');
  await expect(
    materializeRemoteCapabilitySource(
      { source: { url }, trigger: 'daily-poll' },
      policy('burger-town', url),
    ),
  ).resolves.toMatchObject({ source: { document: { openapi: '3.1.0' } } });
  expect(policy('other-service', url)).toBe(fallback);
  expect(policy('burger-town', 'http://demo.internal:43123/private')).toBe(fallback);
  expect(policy('burger-town', 'http://demo.internal:9999/openapi.json')).toBe(fallback);
});
