import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import { buildSubmission, ConnectSourcePanel, type FormState } from './ConnectSourcePanel.js';
import { readBurgerTownConnectionDefaults } from './data.js';

const document = {
  openapi: '3.1.0',
  info: { title: 'Private API', version: '1.0.0' },
  paths: {},
};

function form(overrides: Partial<FormState> = {}): FormState {
  return {
    serviceId: 'private-api',
    documentJson: JSON.stringify(document),
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAPI import submission', () => {
  it('imports a pasted OpenAPI document as a human-confirmed source', () => {
    expect(buildSubmission('org-acme', form())).toEqual({
      organizationId: 'org-acme',
      serviceId: 'private-api',
      source: {
        format: 'openapi',
        document,
        evidence: { kind: 'human-confirmed', label: 'Private API' },
      },
      manifest: {
        source: { kind: 'human-confirmed', label: 'Private API import' },
        annotations: [],
      },
    });
  });

  it('derives the service id from the OpenAPI title when the field is empty', () => {
    expect(buildSubmission('org-acme', form({ serviceId: '' })).serviceId).toBe('private-api');
  });

  it('rejects documents that are not OpenAPI JSON objects', () => {
    expect(() => buildSubmission('org-acme', form({ documentJson: 'not-json' }))).toThrow(
      'valid JSON',
    );
    expect(() => buildSubmission('org-acme', form({ documentJson: '[]' }))).toThrow(
      'OpenAPI document must be a JSON object',
    );
    expect(() => buildSubmission('org-acme', form({ documentJson: '{"info":{}}' }))).toThrow(
      'OpenAPI 3',
    );
    expect(() =>
      buildSubmission('org-acme', form({ serviceId: '', documentJson: '{"openapi":"3.1.0"}' })),
    ).toThrow('Service id is required');
  });
});

describe('source connection panel', () => {
  it('loads the prepared Burger Town addresses from the Backend', async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(async () =>
      Response.json({
        applicationUrl: 'https://burger-town.test/',
        openApiUrl: 'https://burger-town.test/openapi.json',
        arazzoUrl: 'https://burger-town.test/arazzo.yaml',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      readBurgerTownConnectionDefaults('org-atlas', 'development', 'token'),
    ).resolves.toEqual({
      applicationUrl: 'https://burger-town.test/',
      openApiUrl: 'https://burger-town.test/openapi.json',
      arazzoUrl: 'https://burger-town.test/arazzo.yaml',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/v1/burger-town-source-connections?organizationId=org-atlas&environmentId=development',
      expect.objectContaining({ headers: { authorization: 'Bearer token' } }),
    );
  });

  it('asks for the repository and branches and discovers services automatically', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectSourcePanel, {
        organizationId: 'org-acme',
        environmentId: 'development',
        bearerToken: 'token',
        demoProfile: 'sample',
        initialServiceId: null,
        onDiscovered: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(html).toContain('Public GitHub repository');
    expect(html).toContain('Branches to track');
    expect(html).not.toContain('Services and source directories');
    expect(html).not.toContain('name:directory');
    expect(html).toContain('Atlas finds the API services and their source code automatically');
    expect(html).toContain('Import an OpenAPI document');
  });

  it('offers the running Burger Town connection alongside the repository path', () => {
    const html = renderToStaticMarkup(
      createElement(ConnectSourcePanel, {
        organizationId: 'org-atlas',
        environmentId: 'development',
        bearerToken: 'token',
        demoProfile: 'burger-town',
        initialServiceId: null,
        onDiscovered: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(html).toContain('Public GitHub repository');
    expect(html).toContain('Connect the running Burger Town demo');
    expect(html).toContain('Accept');
  });
});
