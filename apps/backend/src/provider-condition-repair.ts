export interface ProviderConditionRepairer {
  repair(repairedCapabilityVersionId: string): Promise<boolean>;
}

export function createHttpProviderConditionRepairer(
  providerUrl: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): ProviderConditionRepairer {
  return {
    async repair(repairedCapabilityVersionId) {
      const response = await fetchImplementation(
        new URL('/__control/provider-conditions', providerUrl),
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repairedCapabilityVersionId }),
        },
      );
      return response.ok;
    },
  };
}
