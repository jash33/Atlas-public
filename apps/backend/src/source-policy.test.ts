import { describe, expect, it, vi } from 'vite-plus/test';

import { fetchCapabilitySource, materializeRemoteCapabilitySource } from './source-policy.js';

describe('capability source network policy', () => {
  it('binds connected GitHub evidence to the fetched commit and path', async () => {
    const document = { openapi: '3.1.0', info: { title: 'API', version: '1' }, paths: {} };
    const policy = {
      allowedHosts: ['raw.githubusercontent.com'],
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(document)),
      lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    };
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const source = {
      format: 'openapi',
      url: `https://raw.githubusercontent.com/acme/payments/${commit}/specs/openapi.json`,
      repository: 'https://github.com/acme/payments',
      repositoryProvider: 'github',
      commit,
      path: 'specs/openapi.json',
    };

    await expect(materializeRemoteCapabilitySource({ source }, policy)).resolves.toMatchObject({
      source: { ...source, document },
    });
    await expect(
      materializeRemoteCapabilitySource(
        { source: { ...source, url: `https://raw.githubusercontent.com/acme/other/${commit}/x` } },
        policy,
      ),
    ).rejects.toThrow('source-repository-evidence-mismatch');
    await expect(
      materializeRemoteCapabilitySource({ source: { ...source, commit: 'main' } }, policy),
    ).rejects.toThrow('source-github-commit-not-immutable');
    await expect(
      materializeRemoteCapabilitySource(
        { source: { ...source, url: undefined, document } },
        policy,
      ),
    ).rejects.toThrow('source-github-document-denied');
  });

  it('does not manufacture a repository revision when refreshing human-confirmed evidence', async () => {
    const document = { openapi: '3.1.0', info: { title: 'API', version: '1' }, paths: {} };
    const result = await materializeRemoteCapabilitySource(
      {
        trigger: 'daily-poll',
        source: {
          format: 'openapi',
          url: 'https://private-api.example/openapi.json',
          evidence: {
            kind: 'human-confirmed',
            label: 'Private API',
            confirmedBy: 'atlas-author',
            confirmedAt: '2026-08-16T18:00:00.000Z',
          },
        },
      },
      {
        allowedHosts: ['private-api.example'],
        fetch: async () => Response.json(document),
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      },
    );

    expect(result).toMatchObject({ source: { document } });
    expect((result as { source: Record<string, unknown> }).source).not.toHaveProperty('commit');
  });

  it('fetches an explicitly allowlisted private one-box source host', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'));

    await expect(
      fetchCapabilitySource('http://mock-specs:4100/specs/billing.openapi.json', {
        allowedHosts: ['mock-specs'],
        allowedPrivateHosts: ['mock-specs'],
        fetch,
        lookup: async () => [{ address: '172.30.100.3', family: 4 }],
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('fetches an allowlisted private host that resolves into the 198.18.0.0/15 range', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{}'));

    await expect(
      fetchCapabilitySource('http://host.docker.internal:43123/', {
        allowedHosts: ['host.docker.internal'],
        allowedPrivateHosts: ['host.docker.internal'],
        fetch,
        lookup: async () => [{ address: '198.19.248.254', family: 4 }],
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('denies a host that is not allowlisted before fetching', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      fetchCapabilitySource('https://untrusted.example/openapi.json', {
        allowedHosts: ['specs.example'],
        fetch,
        lookup: async () => [{ address: '203.0.113.10', family: 4 }],
      }),
    ).rejects.toThrow('source-host-not-allowlisted');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    '10.0.0.4',
    '127.0.0.1',
    '169.254.169.254',
    '192.168.1.2',
    '198.19.248.254',
    '100.100.100.200',
    'fc00::1',
    'fd00:ec2::254',
  ])('denies private or cloud-metadata destination %s before fetching', async (address) => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      fetchCapabilitySource('https://specs.example/openapi.json', {
        allowedHosts: ['specs.example'],
        fetch,
        lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      }),
    ).rejects.toThrow('source-address-denied');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('denies non-HTTP protocols and any hostname with a denied address', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const policy = {
      allowedHosts: ['specs.example'],
      fetch,
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.4', family: 4 },
      ],
    };

    await expect(
      fetchCapabilitySource('file://specs.example/openapi.json', policy),
    ).rejects.toThrow('source-protocol-denied');
    await expect(
      fetchCapabilitySource('https://specs.example/openapi.json', policy),
    ).rejects.toThrow('source-address-denied');
    await expect(
      fetchCapabilitySource('http://[::1]/openapi.json', {
        ...policy,
        allowedHosts: ['::1'],
      }),
    ).rejects.toThrow('source-address-denied');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disables and rejects redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://internal.example/openapi.json' },
      }),
    );

    await expect(
      fetchCapabilitySource('https://specs.example/openapi.json', {
        allowedHosts: ['specs.example'],
        fetch,
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
      }),
    ).rejects.toThrow('source-redirect-denied');
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://specs.example/openapi.json'),
      expect.objectContaining({ redirect: 'manual' }),
      [{ address: '8.8.8.8', family: 4 }],
    );
  });
});
