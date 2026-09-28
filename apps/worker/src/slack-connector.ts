import { StepActivityError, type SecretProvider, type StepInvocation } from '@atlas/runtime-ports';
import type { AdditionalCapabilityActivity } from './capability-activity.js';
import { assertDownstreamResponseUrl, assertOutboundUrlApproved } from './outbound-http-policy.js';

export interface SlackCapabilityBinding {
  readonly capabilityVersionId: string;
  readonly secretAlias: string;
  readonly approvedHostnames: readonly string[];
}

export async function loadSlackCapabilityBinding(options: {
  readonly backendUrl: string;
  readonly organizationId: string;
  readonly environmentId: string;
  readonly fetch?: typeof globalThis.fetch;
}): Promise<SlackCapabilityBinding> {
  const url = new URL('/v1/capabilities', options.backendUrl);
  url.searchParams.set('organizationId', options.organizationId);
  url.searchParams.set('environmentId', options.environmentId);
  const response = await (options.fetch ?? globalThis.fetch)(url.href);
  if (!response.ok) {
    throw new Error(`Slack capability lookup failed with status ${response.status}`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.capabilities)) {
    throw new Error('Atlas returned an invalid capability catalog');
  }
  const capability = body.capabilities.find(
    (candidate) =>
      isRecord(candidate) &&
      isRecord(candidate.identity) &&
      candidate.identity.serviceId === 'slack' &&
      candidate.identity.operationId === 'chat_postMessage',
  );
  if (
    !isRecord(capability) ||
    typeof capability.capabilityVersionId !== 'string' ||
    !isRecord(capability.annotation) ||
    capability.annotation.secretAlias !== 'SLACK_BOT_TOKEN' ||
    !isRecord(capability.hostPolicy) ||
    !Array.isArray(capability.hostPolicy.approvedHostnames) ||
    !capability.hostPolicy.approvedHostnames.every((hostname) => typeof hostname === 'string')
  ) {
    throw new Error('The governed Slack chat_postMessage capability is unavailable');
  }
  return {
    capabilityVersionId: capability.capabilityVersionId,
    secretAlias: capability.annotation.secretAlias,
    approvedHostnames: capability.hostPolicy.approvedHostnames,
  };
}

export function createSlackCapabilityActivity(options: {
  readonly binding: SlackCapabilityBinding;
  readonly refreshBinding?: () => Promise<SlackCapabilityBinding>;
  readonly baseUrl: string;
  readonly secretProvider: SecretProvider;
  readonly fetch?: typeof globalThis.fetch;
}): AdditionalCapabilityActivity {
  const endpoint = new URL('/api/chat.postMessage', `${options.baseUrl.replace(/\/$/, '')}/`);
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
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: readString(invocation, 'channel'),
          text: readString(invocation, 'text'),
          client_msg_id: readString(invocation, 'idempotencyKey'),
        }),
      });
      assertDownstreamResponseUrl(response, endpoint);
      const body: unknown = await response.json();
      if (!response.ok || (isRecord(body) && body.ok === false)) {
        const providerError = isRecord(body) && typeof body.error === 'string' ? body.error : null;
        throw new StepActivityError(
          providerError ? `Slack_${providerError}` : 'DownstreamRequestFailed',
          providerError ?? `Slack request failed with status ${response.status}`,
        );
      }
      if (
        !isRecord(body) ||
        body.ok !== true ||
        typeof body.channel !== 'string' ||
        typeof body.ts !== 'string' ||
        !isRecord(body.message) ||
        typeof body.message.text !== 'string'
      ) {
        throw new StepActivityError('ResponseSchemaMismatch');
      }
      return {
        ok: true,
        channel: body.channel,
        ts: body.ts,
        message: { text: body.message.text },
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
