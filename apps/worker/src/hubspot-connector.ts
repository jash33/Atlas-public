import { StepActivityError, type SecretProvider, type StepInvocation } from '@atlas/runtime-ports';
import type { AdditionalCapabilityActivity } from './capability-activity.js';
import { assertDownstreamResponseUrl, assertOutboundUrlApproved } from './outbound-http-policy.js';

export interface HubSpotCapabilityBinding {
  readonly capabilityVersionId: string;
  readonly secretAlias: string;
  readonly approvedHostnames: readonly string[];
}

export async function loadHubSpotCapabilityBinding(options: {
  readonly backendUrl: string;
  readonly organizationId: string;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<HubSpotCapabilityBinding> {
  const url = new URL('/v1/capabilities', options.backendUrl);
  url.searchParams.set('organizationId', options.organizationId);
  url.searchParams.set('environmentId', options.environmentId);
  const response = await (options.fetch ?? globalThis.fetch)(url.href);
  if (!response.ok) {
    throw new Error(`HubSpot capability lookup failed with status ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.capabilities)) {
    throw new Error('Atlas returned an invalid capability catalog');
  }
  const capability = body.capabilities.find(
    (candidate) =>
      isRecord(candidate) &&
      isRecord(candidate.identity) &&
      candidate.identity.serviceId === 'hubspot' &&
      candidate.identity.operationId === 'createContact',
  );
  if (
    !isRecord(capability) ||
    typeof capability.capabilityVersionId !== 'string' ||
    !isRecord(capability.annotation) ||
    capability.annotation.secretAlias !== 'HUBSPOT_ACCESS_TOKEN' ||
    !isRecord(capability.hostPolicy) ||
    !Array.isArray(capability.hostPolicy.approvedHostnames) ||
    !capability.hostPolicy.approvedHostnames.every((hostname) => typeof hostname === 'string')
  ) {
    throw new Error('The governed HubSpot createContact capability is unavailable');
  }
  return {
    capabilityVersionId: capability.capabilityVersionId,
    secretAlias: capability.annotation.secretAlias,
    approvedHostnames: capability.hostPolicy.approvedHostnames,
  };
}

export function createHubSpotCapabilityActivity(options: {
  readonly binding: HubSpotCapabilityBinding;
  readonly refreshBinding?: () => Promise<HubSpotCapabilityBinding>;
  readonly baseUrl: string;
  readonly secretProvider: SecretProvider;
  readonly fetch?: typeof globalThis.fetch;
}): AdditionalCapabilityActivity {
  const endpoint = new URL('/crm/v3/objects/contacts', `${options.baseUrl.replace(/\/$/, '')}/`);
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    capabilityVersionId: options.binding.capabilityVersionId,
    async invokeStep(invocation) {
      if (!invocation.approvedHostnames) {
        throw new StepActivityError('ExecutionHostNotApproved');
      }
      const binding = options.refreshBinding ? await options.refreshBinding() : options.binding;
      assertOutboundUrlApproved(endpoint, binding.approvedHostnames, invocation.approvedHostnames);
      const token = await options.secretProvider.getSecret(binding.secretAlias);
      const response = await fetchImplementation(endpoint.href, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          properties: {
            email: readString(invocation, 'email'),
            firstname: readString(invocation, 'firstName'),
            lastname: readString(invocation, 'lastName'),
          },
        }),
      });
      assertDownstreamResponseUrl(response, endpoint);
      const body: unknown = await response.json();
      if (!response.ok) {
        const category = isRecord(body) && typeof body.category === 'string' ? body.category : null;
        const message = isRecord(body) && typeof body.message === 'string' ? body.message : null;
        throw new StepActivityError(
          category ? `HubSpot_${category}` : 'DownstreamRequestFailed',
          message ?? `HubSpot request failed with status ${response.status}`,
        );
      }
      if (
        !isRecord(body) ||
        typeof body.id !== 'string' ||
        !isRecord(body.properties) ||
        typeof body.properties.email !== 'string' ||
        typeof body.createdAt !== 'string' ||
        typeof body.updatedAt !== 'string' ||
        body.archived !== false
      ) {
        throw new StepActivityError('ResponseSchemaMismatch');
      }
      return {
        id: body.id,
        properties: {
          email: body.properties.email,
          firstname: typeof body.properties.firstname === 'string' ? body.properties.firstname : '',
          lastname: typeof body.properties.lastname === 'string' ? body.properties.lastname : '',
        },
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
        archived: false,
      };
    },
  };
}

function readString(invocation: StepInvocation, field: string) {
  const value = invocation.input[field];
  if (typeof value !== 'string') {
    throw new StepActivityError('InvalidStepInput', `${field} must be a string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
