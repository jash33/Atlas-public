import { createHash } from 'node:crypto';
import { lookup as resolveAddresses } from 'node:dns/promises';
import { request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export interface CapabilitySourcePolicy {
  allowedHosts: readonly string[];
  allowedPrivateHosts?: readonly string[];
  fetch?: (
    url: URL,
    init: { redirect: 'manual' },
    resolvedAddresses: readonly ResolvedAddress[],
  ) => Promise<Response>;
  lookup?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
}

export class CapabilitySourcePolicyError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'CapabilitySourcePolicyError';
  }
}

function expectedGithubRawUrl(source: Record<string, unknown>): URL | null {
  if (source.repositoryProvider !== 'github') return null;
  if (
    typeof source.repository !== 'string' ||
    typeof source.commit !== 'string' ||
    typeof source.path !== 'string'
  ) {
    throw new CapabilitySourcePolicyError('source-repository-evidence-invalid');
  }
  if (!/^[0-9a-f]{40}$/i.test(source.commit)) {
    throw new CapabilitySourcePolicyError('source-github-commit-not-immutable');
  }
  let repository: URL;
  try {
    repository = new URL(source.repository);
  } catch {
    throw new CapabilitySourcePolicyError('source-repository-evidence-invalid');
  }
  const segments = repository.pathname
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (repository.hostname !== 'github.com' || segments.length !== 2) {
    throw new CapabilitySourcePolicyError('source-repository-evidence-invalid');
  }
  const encodedPath = source.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return new URL(
    `https://raw.githubusercontent.com/${segments.map(encodeURIComponent).join('/')}/${encodeURIComponent(source.commit)}/${encodedPath}`,
  );
}

function ipv4Octets(address: string): [number, number, number, number] | null {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return null;
  return octets as [number, number, number, number];
}

function privateIpv4([first, second]: [number, number, number, number]) {
  return (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function deniedIpv4(address: string) {
  const octets = ipv4Octets(address);
  if (!octets) return true;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    privateIpv4(octets) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224 ||
    address === '100.100.100.200'
  );
}

function normalizeIpv6(address: string) {
  return address.toLowerCase().split('%')[0]!;
}

function privateIpv6(address: string) {
  const first = Number.parseInt(normalizeIpv6(address).split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00;
}

function deniedIpv6(address: string) {
  const normalized = normalizeIpv6(address);
  if (normalized === '::' || normalized === '::1' || normalized === 'fd00:ec2::254') return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIP(mapped) !== 4 || deniedIpv4(mapped);
  }
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return privateIpv6(normalized) || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

function addressDenied(address: string) {
  const family = isIP(address);
  if (family === 4) return deniedIpv4(address);
  if (family === 6) return deniedIpv6(address);
  return true;
}

function privateNetworkAddress(address: string) {
  const family = isIP(address);
  if (family === 4) {
    const octets = ipv4Octets(address)!;
    // RFC 2544 198.18.0.0/15 is still denied by default. OrbStack maps
    // host.docker.internal into this range, so an explicit private-host
    // allowlist may reach it the same way it reaches RFC 1918 addresses.
    return privateIpv4(octets) || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19));
  }
  if (family === 6) {
    return privateIpv6(address);
  }
  return false;
}

function normalizeHostname(hostname: string) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

async function defaultLookup(hostname: string): Promise<readonly ResolvedAddress[]> {
  return resolveAddresses(hostname, { all: true, verbatim: true });
}

const maximumSourceBytes = 10 * 1024 * 1024;

function fetchFromResolvedAddress(
  url: URL,
  resolvedAddresses: readonly ResolvedAddress[],
): Promise<Response> {
  const selectedAddress = resolvedAddresses[0]!;
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(
        null,
        resolvedAddresses.map(({ address, family }) => ({ address, family })),
      );
      return;
    }
    callback(null, selectedAddress.address, selectedAddress.family);
  };
  const request = url.protocol === 'https:' ? requestHttps : requestHttp;
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      {
        headers: { accept: 'application/json' },
        lookup,
        method: 'GET',
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        incoming.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.length;
          if (receivedBytes > maximumSourceBytes) {
            incoming.destroy(new Error('capability source exceeds size limit'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on('error', reject);
        incoming.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            for (const item of Array.isArray(value) ? value : [value]) {
              if (item !== undefined) headers.append(name, item);
            }
          }
          const status = incoming.statusCode ?? 500;
          const body = [101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(
            new Response(body, {
              headers,
              status,
              ...(incoming.statusMessage === undefined
                ? {}
                : { statusText: incoming.statusMessage }),
            }),
          );
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

export async function fetchCapabilitySource(
  sourceUrl: string | URL,
  policy: CapabilitySourcePolicy,
) {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new CapabilitySourcePolicyError('source-url-invalid');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CapabilitySourcePolicyError('source-protocol-denied');
  }
  const hostname = normalizeHostname(url.hostname);
  const allowedHosts = new Set(policy.allowedHosts.map(normalizeHostname));
  if (!allowedHosts.has(hostname)) {
    throw new CapabilitySourcePolicyError('source-host-not-allowlisted');
  }
  if (url.username || url.password) {
    throw new CapabilitySourcePolicyError('source-credentials-denied');
  }

  let addresses: readonly ResolvedAddress[];
  const literalFamily = isIP(hostname);
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await (policy.lookup ?? defaultLookup)(hostname);
  } catch {
    throw new CapabilitySourcePolicyError('source-address-unresolved');
  }
  const privateHostAllowed = new Set((policy.allowedPrivateHosts ?? []).map(normalizeHostname)).has(
    hostname,
  );
  if (
    addresses.length === 0 ||
    addresses.some(
      ({ address }) =>
        addressDenied(address) && !(privateHostAllowed && privateNetworkAddress(address)),
    )
  ) {
    throw new CapabilitySourcePolicyError('source-address-denied');
  }

  let response: Response;
  try {
    response = policy.fetch
      ? await policy.fetch(url, { redirect: 'manual' }, addresses)
      : await fetchFromResolvedAddress(url, addresses);
  } catch {
    throw new CapabilitySourcePolicyError('source-fetch-failed');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CapabilitySourcePolicyError('source-redirect-denied');
  }
  if (response.redirected || (response.url && new URL(response.url).href !== url.href)) {
    throw new CapabilitySourcePolicyError('source-redirect-denied');
  }
  return response;
}

export async function materializeRemoteCapabilitySource(
  input: unknown,
  policy: CapabilitySourcePolicy,
): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const request = input as Record<string, unknown>;
  const source = request.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return input;
  }
  const remoteSource = source as Record<string, unknown>;
  const githubRawUrl = expectedGithubRawUrl(remoteSource);
  if (githubRawUrl && 'document' in remoteSource) {
    throw new CapabilitySourcePolicyError('source-github-document-denied');
  }
  if (githubRawUrl && !('url' in remoteSource)) {
    throw new CapabilitySourcePolicyError('source-github-url-required');
  }
  if (!('url' in remoteSource)) return input;
  if (typeof remoteSource.url !== 'string') {
    throw new CapabilitySourcePolicyError('source-url-invalid');
  }
  if ('document' in remoteSource) {
    throw new CapabilitySourcePolicyError('source-document-ambiguous');
  }

  if (githubRawUrl) {
    let providedUrl: URL;
    try {
      providedUrl = new URL(remoteSource.url);
    } catch {
      throw new CapabilitySourcePolicyError('source-url-invalid');
    }
    if (githubRawUrl.href !== providedUrl.href) {
      throw new CapabilitySourcePolicyError('source-repository-evidence-mismatch');
    }
  }

  const response = await fetchCapabilitySource(remoteSource.url, policy);
  if (!response.ok) {
    throw new CapabilitySourcePolicyError('source-fetch-failed');
  }
  let document: unknown;
  try {
    document = await response.json();
  } catch {
    throw new CapabilitySourcePolicyError('source-document-invalid');
  }
  const triggeredRefresh = request.trigger === 'daily-poll' || request.trigger === 'run-drift';
  const refreshRevision =
    response.headers.get('x-atlas-source-commit') ??
    response.headers.get('etag') ??
    `content-${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`;
  const materializedSource = {
    ...remoteSource,
    ...(triggeredRefresh && 'commit' in remoteSource && remoteSource.repositoryProvider !== 'github'
      ? { commit: refreshRevision }
      : {}),
    document,
  };
  return { ...request, source: materializedSource };
}
