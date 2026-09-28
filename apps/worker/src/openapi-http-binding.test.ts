import { expect, it } from 'vite-plus/test';

import { createOpenApiHttpRequest } from './openapi-http-binding.js';

it('maps and URL-encodes an OpenAPI path parameter', () => {
  const [url, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example/root/',
    fragment: {
      method: 'get',
      path: '/widgets/{widgetId}',
      pathParameters: [],
      operation: {
        parameters: [
          {
            name: 'widgetId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
      },
      references: {},
    },
    annotation: { idempotencyField: null },
    input: { widgetId: 'part / one' },
  });

  expect(url.href).toBe('https://provider.example/widgets/part%20%2F%20one');
  expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
});

it('maps query and header parameters and puts only unconsumed fields in a JSON body', () => {
  const [url, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'post',
      path: '/widgets',
      operation: {
        parameters: [
          { name: 'filter', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'x-request-label', in: 'header', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string' }, enabled: { type: 'boolean' } },
              },
            },
          },
        },
      },
      references: {},
    },
    annotation: { idempotencyField: null },
    input: {
      filter: 'active & new',
      'x-request-label': 'release 1',
      name: 'alpha',
      enabled: true,
    },
  });

  expect(url.href).toBe('https://provider.example/widgets?filter=active+%26+new');
  expect(new Headers(init.headers).get('x-request-label')).toBe('release 1');
  expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  expect(JSON.parse(bodyText(init.body))).toEqual({ name: 'alpha', enabled: true });
});

it('serializes OpenAPI array and object parameter styles deterministically', () => {
  const [url, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'get',
      path: '/widgets/{coordinates}',
      operation: {
        parameters: [
          {
            name: 'coordinates',
            in: 'path',
            required: true,
            style: 'simple',
            schema: { type: 'array' },
          },
          {
            name: 'tags',
            in: 'query',
            style: 'form',
            explode: true,
            schema: { type: 'array' },
          },
          {
            name: 'filter',
            in: 'query',
            style: 'deepObject',
            schema: { type: 'object' },
          },
          {
            name: 'x-context',
            in: 'header',
            style: 'simple',
            explode: true,
            schema: { type: 'object' },
          },
        ],
      },
    },
    annotation: { idempotencyField: null },
    input: {
      coordinates: [10, 20],
      tags: ['new', 'sale'],
      filter: { status: 'active', zone: 'east' },
      'x-context': { tenant: 'atlas', version: 2 },
    },
  });

  expect(url.pathname).toBe('/widgets/10,20');
  expect(url.searchParams.getAll('tags')).toEqual(['new', 'sale']);
  expect(url.searchParams.get('filter[status]')).toBe('active');
  expect(url.searchParams.get('filter[zone]')).toBe('east');
  expect(new Headers(init.headers).get('x-context')).toBe('tenant=atlas,version=2');
});

it('rejects a parameter value that violates its persisted schema type', () => {
  expect(() =>
    createOpenApiHttpRequest({
      baseUrl: 'https://provider.example',
      fragment: {
        method: 'get',
        path: '/widgets',
        operation: {
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer' },
            },
          ],
        },
      },
      annotation: { idempotencyField: null },
      input: { limit: '10' },
    }),
  ).toThrow(expect.objectContaining({ type: 'InvalidStepInput' }));
});

it('serializes unconsumed JSON body fields deterministically', () => {
  const requestFor = (input: Record<string, string>) =>
    createOpenApiHttpRequest({
      baseUrl: 'https://provider.example',
      fragment: {
        method: 'post',
        path: '/widgets',
        operation: {
          parameters: [{ name: 'filter', in: 'query' }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { alpha: { type: 'string' }, zeta: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      annotation: { idempotencyField: null },
      input,
    })[1];

  expect(bodyText(requestFor({ zeta: 'last', filter: 'active', alpha: 'first' }).body)).toBe(
    bodyText(requestFor({ alpha: 'first', filter: 'active', zeta: 'last' }).body),
  );
});

it.each([
  {
    location: 'header',
    idempotencyField: 'Idempotency-Key',
    fragment: {
      method: 'post',
      path: '/widgets',
      operation: {
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
      },
      references: {},
    },
    assertRequest(init: RequestInit) {
      expect(new Headers(init.headers).get('idempotency-key')).toBe('stable-key');
      expect(init.body).toBeUndefined();
    },
  },
  {
    location: 'body',
    idempotencyField: 'eventId',
    fragment: {
      method: 'post',
      path: '/events',
      operation: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['eventId', 'name'],
                properties: { eventId: { type: 'string' }, name: { type: 'string' } },
              },
            },
          },
        },
      },
      references: {},
    },
    assertRequest(init: RequestInit) {
      expect(JSON.parse(bodyText(init.body))).toEqual({ eventId: 'stable-key', name: 'created' });
    },
  },
])('places the derived idempotency value in the declared $location field', (testCase) => {
  expect.hasAssertions();
  const [, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: testCase.fragment,
    annotation: { idempotencyField: testCase.idempotencyField },
    input: { idempotencyKey: 'stable-key', name: 'created' },
  });

  testCase.assertRequest(init);
});

it('preserves an explicit annotated idempotency value and removes its generic alias', () => {
  const [, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'post',
      path: '/events',
      operation: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { eventId: { type: 'string' }, name: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    annotation: { idempotencyField: 'eventId' },
    input: { eventId: 'caller-value', idempotencyKey: 'runtime-value', name: 'created' },
  });

  expect(JSON.parse(bodyText(init.body))).toEqual({
    eventId: 'caller-value',
    name: 'created',
  });
});

it('serializes an OpenAPI form request using the declared content type', () => {
  const [, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'post',
      path: '/charges',
      operation: {
        requestBody: {
          required: true,
          content: {
            'application/x-www-form-urlencoded': {
              schema: {
                type: 'object',
                required: ['amount', 'currency'],
                properties: {
                  amount: { type: 'integer' },
                  currency: { type: 'string' },
                },
              },
            },
          },
        },
      },
      references: {},
    },
    annotation: { idempotencyField: null },
    input: { amount: 5000, currency: 'USD' },
  });

  expect(new Headers(init.headers).get('content-type')).toBe('application/x-www-form-urlencoded');
  expect(bodyText(init.body)).toBe('amount=5000&currency=USD');
});

it('fills a required JSON body field from its declared const', () => {
  const [, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'post',
      path: '/events',
      operation: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['eventType', 'eventId'],
                properties: {
                  eventType: { type: 'string', const: 'widget.created' },
                  eventId: { type: 'string' },
                },
              },
            },
          },
        },
      },
      references: {},
    },
    annotation: { idempotencyField: 'eventId' },
    input: { idempotencyKey: 'event-1' },
  });

  expect(JSON.parse(bodyText(init.body))).toEqual({
    eventId: 'event-1',
    eventType: 'widget.created',
  });
});

it.each([
  {
    location: 'path',
    fragment: {
      method: 'get',
      path: '/widgets/{widgetId}',
      operation: {
        parameters: [{ name: 'widgetId', in: 'path', required: true }],
      },
    },
  },
  {
    location: 'query',
    fragment: {
      method: 'get',
      path: '/widgets',
      operation: {
        parameters: [{ name: 'filter', in: 'query', required: true }],
      },
    },
  },
  {
    location: 'header',
    fragment: {
      method: 'get',
      path: '/widgets',
      operation: {
        parameters: [{ name: 'x-tenant', in: 'header', required: true }],
      },
    },
  },
  {
    location: 'JSON body',
    fragment: {
      method: 'post',
      path: '/widgets',
      operation: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: {} },
            },
          },
        },
      },
    },
  },
])('rejects a missing required $location value', ({ fragment }) => {
  expect(() =>
    createOpenApiHttpRequest({
      baseUrl: 'https://provider.example',
      fragment,
      annotation: { idempotencyField: null },
      input: {},
    }),
  ).toThrow(expect.objectContaining({ type: 'InvalidStepInput' }));
});

it('resolves referenced parameters and request bodies from the persisted fragment references', () => {
  const [url, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'post',
      path: '/widgets/{widgetId}',
      pathParameters: [{ $ref: '#/components/parameters/WidgetId' }],
      operation: {
        requestBody: { $ref: '#/components/requestBodies/WidgetBody' },
      },
      references: {
        '#/components/parameters/WidgetId': {
          name: 'widgetId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        '#/components/requestBodies/WidgetBody': {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['name'], properties: {} },
            },
          },
        },
      },
    },
    annotation: { idempotencyField: null },
    input: { widgetId: 'part / one', name: 'alpha' },
  });

  expect(url.href).toBe('https://provider.example/widgets/part%20%2F%20one');
  expect(JSON.parse(bodyText(init.body))).toEqual({ name: 'alpha' });
});

it('uses an operation parameter instead of its path-level definition', () => {
  const [url] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'get',
      path: '/widgets',
      pathParameters: [{ name: 'filter', in: 'query', required: false }],
      operation: {
        parameters: [{ name: 'filter', in: 'query', required: true }],
      },
    },
    annotation: { idempotencyField: null },
    input: { filter: 'active' },
  });

  expect(url.searchParams.getAll('filter')).toEqual(['active']);
});

it('sends an empty object when a required JSON body has no required properties', () => {
  const [, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'post',
      path: '/widgets/actions/refresh',
      operation: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', properties: {} },
            },
          },
        },
      },
    },
    annotation: { idempotencyField: null },
    input: {},
  });

  expect(JSON.parse(bodyText(init.body))).toEqual({});
});

it('does not materialize an omitted optional request body', () => {
  const [, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'post',
      path: '/widgets/actions/refresh',
      operation: {
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['scope'], properties: {} },
            },
          },
        },
      },
    },
    annotation: { idempotencyField: null },
    input: {},
  });

  expect(init.body).toBeUndefined();
  expect(new Headers(init.headers).has('content-type')).toBe(false);
});

it('does not send unconsumed fields forbidden by a closed body schema', () => {
  const [, init] = createOpenApiHttpRequest({
    baseUrl: 'https://provider.example',
    fragment: {
      method: 'post',
      path: '/widgets',
      operation: {
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: { name: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    annotation: { idempotencyField: null },
    input: { name: 'alpha', internalTrace: 'do-not-send' },
  });

  expect(JSON.parse(bodyText(init.body))).toEqual({ name: 'alpha' });
});

it('rejects required request bodies with an unsupported media type', () => {
  expect(() =>
    createOpenApiHttpRequest({
      baseUrl: 'https://provider.example',
      fragment: {
        method: 'post',
        path: '/widgets',
        operation: {
          requestBody: {
            required: true,
            content: { 'application/octet-stream': { schema: { type: 'string' } } },
          },
        },
      },
      annotation: { idempotencyField: null },
      input: { payload: 'bytes' },
    }),
  ).toThrow(expect.objectContaining({ type: 'UnsupportedCapabilityBinding' }));
});

it.each([
  '//metadata.google.internal/latest',
  '//provider.example:8443/admin',
  '/safe\\..\\admin',
  'https://evil.example/path',
])('rejects a fragment path that could replace the approved URL authority: %s', (path) => {
  expect(() =>
    createOpenApiHttpRequest({
      baseUrl: 'https://provider.example',
      fragment: { method: 'get', path, operation: {} },
      annotation: { idempotencyField: null },
      input: {},
    }),
  ).toThrow(expect.objectContaining({ type: 'InvalidCapabilityFragment' }));
});

function bodyText(body: RequestInit['body']): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError('Expected a text request body');
}
