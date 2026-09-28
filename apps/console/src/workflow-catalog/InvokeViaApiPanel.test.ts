import type { ObjectSchema } from '@atlas/workflow-ir';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  buildIngestSampleBody,
  buildIngestSampleCurl,
  describeIngestPayloadFields,
  InvokeViaApiPanel,
  InvokeUnavailablePanel,
} from './InvokeViaApiPanel.js';

const inputSchema: ObjectSchema = {
  required: { location_id: { type: 'string' }, quantity: { type: 'integer' } },
};
const invocationExample = { location_id: 'loc_oak', quantity: 1 };

describe('Invoke via API', () => {
  it('copies source-backed values unchanged, not schema-generated placeholders', () => {
    expect(JSON.parse(buildIngestSampleBody('demo', invocationExample))).toEqual({
      workflowName: 'demo',
      payload: invocationExample,
    });
    const curl = buildIngestSampleCurl('demo', 'development', invocationExample);
    expect(curl).toContain('http://localhost:4300/ingest');
    expect(curl).toContain('"location_id": "loc_oak"');
    expect(curl).toContain('"quantity": 1');
    expect(curl).not.toContain('example-');
    expect(buildIngestSampleCurl("Payor's receipt", 'production', invocationExample)).toContain(
      "Payor'\\''s receipt",
    );
    expect(buildIngestSampleCurl('demo', 'production', invocationExample)).toContain(
      'http://localhost:4301/ingest',
    );
  });

  it('shows editable tested inputs and a runnable command', () => {
    const html = renderToStaticMarkup(
      createElement(InvokeViaApiPanel, {
        environmentId: 'development',
        inputSchema,
        invocationExample,
        workflowName: 'demo',
      }),
    );
    expect(html).toContain('loc_oak');
    expect(html).toContain('Copy sample request');
    expect(html).not.toContain('disabled');
    expect(html).toContain('connected source');
  });

  it.each(['development', 'production'] as const)(
    'requires real values when there is no usable fixture in %s',
    (environmentId) => {
      const html = renderToStaticMarkup(
        createElement(InvokeViaApiPanel, {
          environmentId,
          inputSchema,
          invocationExample: environmentId === 'production' ? invocationExample : null,
          workflowName: 'demo',
        }),
      );
      expect(html).toContain('No tested sample is available');
      expect(html).toContain('disabled');
      expect(html).not.toContain('curl -X');
      expect(html).not.toContain('loc_oak');
      expect(html).not.toContain('example-location');
    },
  );

  it('describes nested input fields without inventing their values', () => {
    expect(
      describeIngestPayloadFields({
        required: { context: { type: 'object', required: { retry: { type: 'boolean' } } } },
      }),
    ).toEqual([
      { path: 'context', type: 'object' },
      { path: 'context.retry', type: 'boolean' },
    ]);
  });

  it('blocks copying without an active schema', () => {
    const html = renderToStaticMarkup(
      createElement(InvokeViaApiPanel, {
        environmentId: 'development',
        inputSchema: null,
        workflowName: 'demo',
      }),
    );
    expect(html).toContain('disabled');
    expect(html).toContain('Payload fields were not found');
  });

  it('explains approval is required before invocation', () => {
    expect(
      renderToStaticMarkup(createElement(InvokeUnavailablePanel, { environmentId: 'production' })),
    ).toContain('cannot be invoked until a version is approved and active');
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
it('keeps customer request examples free of local endpoints and demo credentials', async () => {
  vi.stubEnv('VITE_ATLAS_AUTH_MODE', 'customer');
  const { InvokeViaApiPanel: CustomerPanel } = await import('./InvokeViaApiPanel.js');
  const html = renderToStaticMarkup(
    createElement(CustomerPanel, {
      environmentId: 'development',
      inputSchema,
      invocationExample,
      workflowName: 'Orders',
    }),
  );
  expect(html).toContain('Copy request body');
  expect(html).toContain('Ask your Atlas administrator');
  expect(html).not.toContain('localhost');
  expect(html).not.toContain('local-ingest-caller-token');
});
