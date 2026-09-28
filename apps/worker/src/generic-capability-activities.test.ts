import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vite-plus/test';

import { createCapabilityStepActivities } from './capability-activities.js';
import { createGenericCapabilityActivityResolver } from './generic-capability-activities.js';

const backendUrl = 'http://atlas.internal';
const providerBaseUrl = 'http://providers.local';

it('uses a connected application address without losing its HTTP scheme or port', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(
        catalog({
          ...openApiCapability({ approvedHostnames: ['host.docker.internal'] }),
          executionBinding: { baseUrl: 'http://host.docker.internal:43123' },
        }),
      ),
    )
    .mockImplementationOnce(async (input, init) => {
      expect(requestUrl(input)).toBe('http://host.docker.internal:43123/widgets');
      expect(new Headers(init?.headers).has('x-atlas-sandbox-step-id')).toBe(false);
      expect(new Headers(init?.headers).get('x-atlas-step-id')).toBe('list-widgets');
      return Response.json({ widgets: [] });
    });
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });
  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['host.docker.internal'],
      input: {},
    }),
  ).resolves.toEqual({ widgets: [] });
});

it.each([
  { baseUrl: 'http://unapproved.example:43123', grant: ['host.docker.internal'] },
  { baseUrl: 'http://host.docker.internal:43123', grant: ['elsewhere.example'] },
  { baseUrl: 'http://host.docker.internal:43123', grant: undefined },
  { baseUrl: 'http://user:secret@host.docker.internal:43123', grant: ['host.docker.internal'] },
])(
  'denies a connected address without current policy and grant authority: $baseUrl',
  async ({ baseUrl, grant }) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      Response.json(
        catalog({
          ...openApiCapability({ approvedHostnames: ['host.docker.internal'] }),
          executionBinding: { baseUrl },
        }),
      ),
    );
    const resolve = createGenericCapabilityActivityResolver({
      backendUrl,
      organizationId: 'org_atlas',
      environmentId: 'development',
      providerBaseUrl,
      fetch,
    });
    await expect(
      (await resolve('widgets-current'))?.invokeStep({
        stepId: 'list-widgets',
        capabilityVersionId: 'widgets-current',
        ...(grant ? { approvedHostnames: grant } : {}),
        input: {},
      }),
    ).rejects.toMatchObject({ type: 'ExecutionHostNotApproved' });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it('executes a previously unnamed approved OpenAPI operation through the public activity interface', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith(`${backendUrl}/v1/capabilities`)) {
      expect(new URL(url).searchParams.get('capabilityVersionId')).toBe('inventory-current');
      return Response.json(
        catalog({
          capabilityVersionId: 'inventory-current',
          identity: { kind: 'openapi', serviceId: 'inventory', operationId: 'searchWidgets' },
          fragment: {
            identity: { kind: 'openapi', serviceId: 'inventory', operationId: 'searchWidgets' },
            method: 'get',
            path: '/inventory/{warehouseId}/widgets',
            pathParameters: [],
            operation: {
              parameters: [
                { name: 'warehouseId', in: 'path', required: true },
                { name: 'status', in: 'query', required: true },
                { name: 'x-tenant', in: 'header', required: true },
              ],
            },
            references: {},
          },
          annotation: { idempotencyField: null, secretAlias: null },
          hostPolicy: { approvedHostnames: ['providers.local'] },
        }),
      );
    }
    expect(url).toBe('http://providers.local/inventory/east%20coast/widgets?status=in+stock');
    expect(new Headers(init?.headers).get('x-tenant')).toBe('tenant-1');
    expect(init?.redirect).toBe('manual');
    return Response.json({ widgets: [] });
  });
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  const activity = await resolve('inventory-current');
  await expect(
    activity?.invokeStep({
      runId: 'run_1',
      stepId: 'search-inventory',
      capabilityVersionId: 'inventory-current',
      approvedHostnames: ['providers.local'],
      input: {
        warehouseId: 'east coast',
        status: 'in stock',
        'x-tenant': 'tenant-1',
      },
    }),
  ).resolves.toEqual({ widgets: [] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('selects an approved HTTPS host when the capability is not served by the local provider', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(
        catalog(
          openApiCapability({
            approvedHostnames: ['api.inventory.example'],
          }),
        ),
      ),
    )
    .mockImplementationOnce(async (input) => {
      expect(requestUrl(input)).toBe('https://api.inventory.example/widgets');
      return Response.json({ widgets: [] });
    });
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['api.inventory.example'],
      input: {},
    }),
  ).resolves.toEqual({ widgets: [] });
});

it('selects a hostname shared by the environment policy and execution grant', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(
        catalog(
          openApiCapability({
            approvedHostnames: ['policy-only.example', 'shared.example'],
          }),
        ),
      ),
    )
    .mockImplementationOnce(async (input) => {
      expect(requestUrl(input)).toBe('https://shared.example/widgets');
      return Response.json({ widgets: [] });
    });
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['grant-only.example', 'shared.example'],
      input: {},
    }),
  ).resolves.toEqual({ widgets: [] });
});

it('fails closed when multiple approved remote hosts have no configured routing preference', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    Response.json(
      catalog(
        openApiCapability({
          approvedHostnames: ['secondary.example', 'primary.example'],
        }),
      ),
    ),
  );
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['primary.example', 'secondary.example'],
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'ExecutionHostNotApproved' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects a non-canonical IP literal instead of letting URL normalization bypass policy', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(catalog(openApiCapability({ approvedHostnames: ['2130706433'] }))),
    );
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['2130706433'],
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'ExecutionHostNotApproved' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

function catalog(capability: Record<string, unknown>) {
  return { capabilities: [capability] };
}

it('rejects missing required input before the provider fetch', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    Response.json(
      catalog(
        openApiCapability({
          operation: {
            parameters: [{ name: 'widgetId', in: 'path', required: true }],
          },
          path: '/widgets/{widgetId}',
        }),
      ),
    ),
  );
  const activities = createCapabilityStepActivities({
    resolveCapability: createGenericCapabilityActivityResolver({
      backendUrl,
      organizationId: 'org_atlas',
      environmentId: 'development',
      providerBaseUrl,
      fetch,
    }),
  });

  await expect(
    activities.invokeStep({
      stepId: 'get-widget',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['providers.local'],
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'InvalidStepInput' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([
  {
    label: 'capability policy',
    policyHostnames: ['providers.local'],
    grantHostnames: ['unapproved.example'],
    path: 'https://unapproved.example/widgets',
  },
  {
    label: 'execution grant',
    policyHostnames: ['providers.local'],
    grantHostnames: ['other.example'],
    path: '/widgets',
  },
])('fails closed when the selected host is absent from the $label', async (testCase) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
    Response.json(
      catalog(
        openApiCapability({
          approvedHostnames: testCase.policyHostnames,
          path: testCase.path,
        }),
      ),
    ),
  );
  const activities = createCapabilityStepActivities({
    resolveCapability: createGenericCapabilityActivityResolver({
      backendUrl,
      organizationId: 'org_atlas',
      environmentId: 'development',
      providerBaseUrl,
      fetch,
    }),
  });

  await expect(
    activities.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: testCase.grantHostnames,
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'ExecutionHostNotApproved' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('maps a non-2xx JSON error.type through the worker activity interface', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalog(openApiCapability())))
    .mockResolvedValueOnce(
      Response.json({ error: { type: 'WidgetTemporarilyUnavailable' } }, { status: 503 }),
    );
  const activities = createCapabilityStepActivities({
    resolveCapability: createGenericCapabilityActivityResolver({
      backendUrl,
      organizationId: 'org_atlas',
      environmentId: 'development',
      providerBaseUrl,
      fetch,
    }),
  });

  await expect(
    activities.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['providers.local'],
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'WidgetTemporarilyUnavailable' });
});

it('keeps a malformed non-JSON provider failure retryable', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalog(openApiCapability())))
    .mockResolvedValueOnce(new Response('<html>unavailable</html>', { status: 503 }));
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['providers.local'],
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'DownstreamRequestFailed' });
});

it('uses the worker-held secret for declared generic capability authentication', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(
        catalog(
          openApiCapability({
            operation: { security: [{ BasicAuth: [] }] },
            secretAlias: 'STRIPE_SECRET_KEY',
          }),
        ),
      ),
    )
    .mockImplementationOnce(async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        `Basic ${Buffer.from(`${testStripeCredential}:`).toString('base64')}`,
      );
      return Response.json({ widgets: [] });
    });
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    secretProvider: {
      async getSecret() {
        return testStripeCredential;
      },
    },
    fetch,
  });

  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['providers.local'],
      input: {},
    }),
  ).resolves.toEqual({ widgets: [] });
});

it('reloads environment host policy before resolving a later activity', async () => {
  let approvedHostnames = ['providers.local'];
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    if (requestUrl(input).startsWith(`${backendUrl}/v1/capabilities`)) {
      return Response.json(catalog(openApiCapability({ approvedHostnames })));
    }
    return Response.json({ widgets: [] });
  });
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });
  const invocation = {
    stepId: 'list-widgets',
    capabilityVersionId: 'widgets-current',
    approvedHostnames: ['providers.local'],
    input: {},
  } as const;

  await expect((await resolve('widgets-current'))?.invokeStep(invocation)).resolves.toEqual({
    widgets: [],
  });
  approvedHostnames = ['replacement.example'];
  await expect((await resolve('widgets-current'))?.invokeStep(invocation)).rejects.toMatchObject({
    type: 'ExecutionHostNotApproved',
  });
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('continues a pre-host-grant invocation under the current capability policy', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalog(openApiCapability())))
    .mockResolvedValueOnce(Response.json({ widgets: [] }));
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      input: {},
    }),
  ).resolves.toEqual({ widgets: [] });
});

it('does not let a pre-host grant acquire a newly approved remote hostname', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json(catalog(openApiCapability({ approvedHostnames: ['newly-approved.example'] }))),
    );
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  await expect(
    (await resolve('widgets-current'))?.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'ExecutionHostNotApproved' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('denies provider redirects instead of following them to another host', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalog(openApiCapability())))
    .mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://metadata.google.internal/latest' },
      }),
    );
  const activities = createCapabilityStepActivities({
    resolveCapability: createGenericCapabilityActivityResolver({
      backendUrl,
      organizationId: 'org_atlas',
      environmentId: 'development',
      providerBaseUrl,
      fetch,
    }),
  });

  await expect(
    activities.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['providers.local'],
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'DownstreamRedirectDenied' });
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ redirect: 'manual' });
});

it('denies a fetch implementation that returns an unapproved final URL', async () => {
  const finalResponse = Response.json({ widgets: [] });
  Object.defineProperty(finalResponse, 'url', {
    value: 'http://metadata.google.internal/latest',
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json(catalog(openApiCapability())))
    .mockResolvedValueOnce(finalResponse);
  const activities = createCapabilityStepActivities({
    resolveCapability: createGenericCapabilityActivityResolver({
      backendUrl,
      organizationId: 'org_atlas',
      environmentId: 'development',
      providerBaseUrl,
      fetch,
    }),
  });

  await expect(
    activities.invokeStep({
      stepId: 'list-widgets',
      capabilityVersionId: 'widgets-current',
      approvedHostnames: ['providers.local'],
      input: {},
    }),
  ).rejects.toMatchObject({ type: 'DownstreamRedirectDenied' });
});

it('binds an approved AsyncAPI send operation to the mock estate HTTP event route', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith(`${backendUrl}/v1/capabilities`)) {
      return Response.json(
        catalog({
          capabilityVersionId: 'event-current',
          identity: { kind: 'asyncapi', serviceId: 'events', operationId: 'publishWidget' },
          fragment: {
            identity: {
              kind: 'asyncapi',
              serviceId: 'events',
              operationId: 'publishWidget',
            },
            operation: { action: 'send' },
            channel: { address: 'widget.created' },
            message: {
              payload: {
                type: 'object',
                required: ['eventId', 'widgetId'],
                properties: {
                  eventId: { type: 'string' },
                  widgetId: { type: 'string' },
                },
              },
            },
            references: {},
          },
          annotation: { idempotencyField: 'eventId', secretAlias: null },
          hostPolicy: { approvedHostnames: ['providers.local'] },
        }),
      );
    }
    expect(url).toBe('http://providers.local/events/widget.created');
    expect(JSON.parse(bodyText(init?.body))).toEqual({
      eventId: 'stable-event',
      widgetId: 'widget-1',
    });
    return Response.json({ published: true });
  });
  const resolve = createGenericCapabilityActivityResolver({
    backendUrl,
    organizationId: 'org_atlas',
    environmentId: 'development',
    providerBaseUrl,
    fetch,
  });

  await expect(
    (await resolve('event-current'))?.invokeStep({
      stepId: 'publish-widget',
      capabilityVersionId: 'event-current',
      approvedHostnames: ['providers.local'],
      input: { idempotencyKey: 'stable-event', widgetId: 'widget-1' },
    }),
  ).resolves.toEqual({ published: true });
});

function openApiCapability(
  overrides: {
    operation?: Record<string, unknown>;
    path?: string;
    approvedHostnames?: string[];
    secretAlias?: string;
  } = {},
) {
  return {
    capabilityVersionId: 'widgets-current',
    identity: { kind: 'openapi', serviceId: 'inventory', operationId: 'listWidgets' },
    fragment: {
      identity: { kind: 'openapi', serviceId: 'inventory', operationId: 'listWidgets' },
      method: 'get',
      path: overrides.path ?? '/widgets',
      pathParameters: [],
      operation: overrides.operation ?? {},
      references: {},
    },
    annotation: { idempotencyField: null, secretAlias: overrides.secretAlias ?? null },
    hostPolicy: {
      approvedHostnames: overrides.approvedHostnames ?? ['providers.local'],
    },
  };
}

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input;
}

function bodyText(body: RequestInit['body']): string {
  if (typeof body === 'string') return body;
  throw new TypeError('Expected a text request body');
}

const testStripeCredential = ['sk', 'test', randomBytes(16).toString('hex')].join('_');
