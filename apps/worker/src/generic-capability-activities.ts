import { stepFetch } from './step-fetch.js';
import {
  StepActivityError,
  type SecretProvider,
  type StepInvocation,
  type StepExecutionContext,
} from '@atlas/runtime-ports';
import type { JsonValue } from '@atlas/workflow-ir';

import type { AdditionalCapabilityActivity } from './capability-activity.js';
import { createOpenApiHttpRequest } from './openapi-http-binding.js';
import { assertDownstreamResponseUrl, assertOutboundUrlApproved } from './outbound-http-policy.js';

interface GenericCapabilityActivityOptions {
  readonly backendUrl: string;
  readonly organizationId: string;
  readonly environmentId: string;
  readonly providerBaseUrl: string;
  readonly secretProvider?: SecretProvider;
  readonly fetch?: typeof globalThis.fetch;
}

interface CatalogCapability {
  readonly capabilityVersionId: string;
  readonly identity: Readonly<Record<string, unknown>>;
  readonly fragment: Readonly<Record<string, unknown>>;
  readonly annotation: {
    readonly idempotencyField: string | null;
    readonly secretAlias?: string | null;
  };
  readonly hostPolicy: { readonly approvedHostnames: readonly string[] };
  readonly executionBinding?: { readonly baseUrl: string } | null;
}

export function createGenericCapabilityActivityResolver(options: GenericCapabilityActivityOptions) {
  return async (capabilityVersionId: string, context?: StepExecutionContext) => {
    const activities = await loadGenericCapabilityActivities(options, capabilityVersionId, context);
    return activities.find((activity) => activity.capabilityVersionId === capabilityVersionId);
  };
}

export async function loadGenericCapabilityActivities(
  options: GenericCapabilityActivityOptions,
  capabilityVersionId?: string,
  context?: StepExecutionContext,
): Promise<readonly AdditionalCapabilityActivity[]> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const catalogUrl = new URL('/v1/capabilities', options.backendUrl);
  catalogUrl.searchParams.set('organizationId', options.organizationId);
  catalogUrl.searchParams.set('environmentId', options.environmentId);
  if (capabilityVersionId) catalogUrl.searchParams.set('capabilityVersionId', capabilityVersionId);
  const response = await stepFetch(fetchImplementation, context)(catalogUrl.href);
  if (!response.ok) {
    throw new Error(`Capability lookup failed with status ${response.status}`);
  }
  const body: unknown = await response.json();
  const capabilities = isRecord(body) ? body.capabilities : undefined;
  if (!Array.isArray(capabilities)) throw new Error('Atlas returned an invalid capability catalog');
  return capabilities.flatMap((value) => {
    const capability = parseCatalogCapability(value);
    return capability
      ? [
          activityFor(
            capability,
            options.providerBaseUrl,
            options.secretProvider,
            fetchImplementation,
          ),
        ]
      : [];
  });
}

function activityFor(
  capability: CatalogCapability,
  providerBaseUrl: string,
  secretProvider: SecretProvider | undefined,
  fetchImplementation: typeof globalThis.fetch,
): AdditionalCapabilityActivity {
  return {
    capabilityVersionId: capability.capabilityVersionId,
    async invokeStep(invocation, context) {
      const fetch = stepFetch(fetchImplementation, context);
      const selectedBaseUrl = selectProviderBaseUrl(
        providerBaseUrl,
        capability.hostPolicy.approvedHostnames,
        invocation.approvedHostnames,
        capability.executionBinding?.baseUrl,
      );
      const [url, initialRequest] = createCapabilityHttpRequest(
        selectedBaseUrl,
        capability,
        invocation,
      );
      assertOutboundUrlApproved(
        url,
        capability.hostPolicy.approvedHostnames,
        invocation.approvedHostnames,
      );
      const headers = new Headers(initialRequest.headers);
      headers.set('x-atlas-step-id', invocation.stepId);
      const authorization = await authorizationForDeclaredSecurity(capability, secretProvider);
      if (authorization) {
        headers.set('authorization', authorization);
      }
      const response = await fetch(url, { ...initialRequest, headers });
      assertDownstreamResponseUrl(response, url);
      let output: unknown;
      try {
        output = await response.json();
      } catch {
        context?.signal.throwIfAborted();
        throw new StepActivityError(
          response.ok ? 'ResponseSchemaMismatch' : 'DownstreamRequestFailed',
          response.ok
            ? 'Downstream response was not valid JSON'
            : `Downstream request failed with status ${response.status}`,
        );
      }
      context?.signal.throwIfAborted();
      if (!response.ok) {
        const error = isRecord(output) && isRecord(output.error) ? output.error.type : undefined;
        throw new StepActivityError(
          typeof error === 'string' ? error : 'DownstreamRequestFailed',
          `Downstream request failed with status ${response.status}`,
        );
      }
      if (!isRecord(output)) throw new StepActivityError('ResponseSchemaMismatch');
      return output as Readonly<Record<string, JsonValue>>;
    },
  };
}

function selectProviderBaseUrl(
  configuredBaseUrl: string,
  policyHostnames: readonly string[],
  grantHostnames: readonly string[] | undefined,
  boundBaseUrl?: string,
): string {
  if (boundBaseUrl) {
    // A connected address is execution configuration, not authority: both the live policy and
    // the immutable run grant must permit it. Legacy grants keep their fixed local route.
    if (!grantHostnames) throw new StepActivityError('ExecutionHostNotApproved');
    const bound = new URL(boundBaseUrl);
    assertOutboundUrlApproved(bound, policyHostnames, grantHostnames);
    return bound.href;
  }
  const configured = new URL(configuredBaseUrl);
  const grant = grantHostnames
    ? new Set(grantHostnames.map((hostname) => hostname.toLowerCase()))
    : undefined;
  const approvedHostnames = policyHostnames.filter(
    (hostname) => grant === undefined || grant.has(hostname.toLowerCase()),
  );
  if (approvedHostnames.some((hostname) => hostname.toLowerCase() === configured.hostname)) {
    return configured.href;
  }
  // Grants issued before host claims existed may finish only against the worker's fixed local
  // provider. They cannot gain access to a remote hostname added to policy after they were signed.
  if (grant === undefined) {
    throw new StepActivityError('ExecutionHostNotApproved');
  }
  if (approvedHostnames.length !== 1) {
    throw new StepActivityError('ExecutionHostNotApproved');
  }
  return new URL(`https://${approvedHostnames[0]}`).href;
}

function createCapabilityHttpRequest(
  providerBaseUrl: string,
  capability: CatalogCapability,
  invocation: StepInvocation,
): [URL, RequestInit] {
  if (capability.identity.kind === 'openapi') {
    return createOpenApiHttpRequest({
      baseUrl: providerBaseUrl,
      fragment: capability.fragment,
      annotation: capability.annotation,
      input: invocation.input,
    });
  }
  const operation = isRecord(capability.fragment.operation)
    ? capability.fragment.operation
    : undefined;
  const channel = isRecord(capability.fragment.channel) ? capability.fragment.channel : undefined;
  const message = isRecord(capability.fragment.message) ? capability.fragment.message : undefined;
  if (
    capability.identity.kind !== 'asyncapi' ||
    operation?.action !== 'send' ||
    typeof channel?.address !== 'string' ||
    !message
  ) {
    throw new StepActivityError('UnsupportedCapabilityBinding');
  }
  const channelPath = channel.address
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return createOpenApiHttpRequest({
    baseUrl: providerBaseUrl,
    fragment: {
      method: 'post',
      path: `/events/${channelPath}`,
      operation: {
        requestBody: {
          required: true,
          content: { 'application/json': { schema: message.payload } },
        },
      },
      references: capability.fragment.references,
    },
    annotation: capability.annotation,
    input: invocation.input,
  });
}

function parseCatalogCapability(value: unknown): CatalogCapability | undefined {
  if (
    !isRecord(value) ||
    typeof value.capabilityVersionId !== 'string' ||
    !isRecord(value.identity) ||
    !isRecord(value.fragment) ||
    !isRecord(value.annotation) ||
    !isRecord(value.hostPolicy) ||
    !Array.isArray(value.hostPolicy.approvedHostnames) ||
    !value.hostPolicy.approvedHostnames.every((hostname) => typeof hostname === 'string') ||
    (value.executionBinding != null &&
      (!isRecord(value.executionBinding) || typeof value.executionBinding.baseUrl !== 'string')) ||
    (value.annotation.idempotencyField !== null &&
      typeof value.annotation.idempotencyField !== 'string')
  ) {
    return undefined;
  }
  return value as unknown as CatalogCapability;
}

async function authorizationForDeclaredSecurity(
  capability: CatalogCapability,
  secretProvider: SecretProvider | undefined,
): Promise<string | undefined> {
  const operation = isRecord(capability.fragment.operation)
    ? capability.fragment.operation
    : undefined;
  const security = Array.isArray(operation?.security) ? operation.security : [];
  const schemeNames = security.flatMap((requirement) =>
    isRecord(requirement) ? Object.keys(requirement) : [],
  );
  if (schemeNames.some((name) => name.toLowerCase().includes('basic'))) {
    const secret = capability.annotation.secretAlias
      ? await readExecutionSecret(secretProvider, capability.annotation.secretAlias)
      : 'atlas-local-rehearsal-token';
    return `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
  }
  if (schemeNames.some((name) => name.toLowerCase().includes('bearer'))) {
    const secret = capability.annotation.secretAlias
      ? await readExecutionSecret(secretProvider, capability.annotation.secretAlias)
      : 'atlas-local-rehearsal-token';
    return `Bearer ${secret}`;
  }
  if (schemeNames.length > 0 && capability.annotation.secretAlias) {
    throw new StepActivityError('UnsupportedCapabilityBinding');
  }
  return undefined;
}

async function readExecutionSecret(secretProvider: SecretProvider | undefined, alias: string) {
  if (!secretProvider) throw new StepActivityError('ExecutionCredentialUnavailable');
  try {
    return await secretProvider.getSecret(alias);
  } catch {
    throw new StepActivityError('ExecutionCredentialUnavailable');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
