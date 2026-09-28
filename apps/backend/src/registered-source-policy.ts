import type { CapabilitySourcePolicy } from './source-policy.js';

export type RediscoverySourcePolicy =
  | CapabilitySourcePolicy
  | ((serviceId: string, sourceUrl: unknown) => CapabilitySourcePolicy);

// A prepared connection keeps its address permissions when it is refreshed.
export function registeredSourcePolicy(
  fallback: CapabilitySourcePolicy,
  prepared: {
    serviceId?: string | undefined;
    urls?: readonly string[] | undefined;
    policy?: CapabilitySourcePolicy | undefined;
  },
): RediscoverySourcePolicy {
  return (serviceId, sourceUrl) => {
    if (serviceId !== prepared.serviceId || typeof sourceUrl !== 'string' || !prepared.policy)
      return fallback;
    try {
      const url = new URL(sourceUrl).href;
      return prepared.urls?.some((allowed) => new URL(allowed).href === url)
        ? prepared.policy
        : fallback;
    } catch {
      return fallback;
    }
  };
}
