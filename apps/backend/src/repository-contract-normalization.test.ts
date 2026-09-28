import { describe, expect, it } from 'vite-plus/test';
import {
  applyRepositoryRequestResponseChanges,
  extractRequestResponseContract,
  normalizeRepositoryContract,
  requestResponseHash,
} from './repository-contract-normalization.js';
import type { JsonObject } from './capability-documents.js';

export function repositoryTestDocument(): JsonObject {
  return {
    openapi: '3.1.0',
    info: { title: 'Things', version: '1' },
    paths: {
      '/things': {
        post: {
          operationId: 'createThing',
          summary: 'Approved summary',
          description: 'Approved explanation',
          requestBody: {
            required: true,
            description: 'Approved body',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Input' } } },
          },
          responses: {
            '201': {
              description: 'Created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id'],
                    properties: { id: { type: 'string', description: 'Approved id' } },
                  },
                },
              },
            },
          },
          security: [],
        },
      },
    },
    components: {
      schemas: {
        Input: {
          type: 'object',
          required: ['name', 'description'],
          properties: {
            name: { type: 'string', minLength: 1, description: 'Approved name' },
            description: { type: 'string' },
            title: { type: 'integer' },
          },
        },
      },
    },
  };
}
async function fragment(document: JsonObject) {
  return (await normalizeRepositoryContract('things', document, null)).operations[0]!.fragment;
}
const clone = (document: JsonObject) => JSON.parse(JSON.stringify(document));

describe('repository request and response comparison', () => {
  it('retains object-valued enum and const constraints even when their fields use annotation names', async () => {
    const a = clone(repositoryTestDocument());
    a.components.schemas.Input.properties.choice = {
      enum: [{ description: 'yes', title: 'value' }],
    };
    const b = clone(a);
    b.components.schemas.Input.properties.choice.enum[0].description = 'no';
    expect(requestResponseHash(await fragment(a))).not.toBe(requestResponseHash(await fragment(b)));
    const c = clone(a);
    c.components.schemas.Input.properties.choice = { const: { description: 'yes' } };
    const d = clone(c);
    d.components.schemas.Input.properties.choice.const.description = 'no';
    expect(requestResponseHash(await fragment(c))).not.toBe(requestResponseHash(await fragment(d)));
  });
  it('normalizes equivalent optional flags and schema type representations', async () => {
    const a = repositoryTestDocument();
    const b = clone(a);
    b.components.schemas.Input.additionalProperties = true;
    b.components.schemas.Input.properties.name.type = ['string'];
    b.paths['/things'].post.parameters = [
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
    ];
    const c = clone(b);
    delete c.paths['/things'].post.parameters[0].required;
    expect(requestResponseHash(await fragment(b))).toBe(requestResponseHash(await fragment(c)));
    delete b.paths['/things'].post.parameters;
    expect(requestResponseHash(await fragment(a))).toBe(requestResponseHash(await fragment(b)));
  });

  it('preserves unrelated response links and schema annotations during contract edits', async () => {
    const a = clone(repositoryTestDocument());
    a.paths['/things'].post.responses['201'].links = { receipt: { operationId: 'createThing' } };
    a.components.schemas.Input['x-owner'] = 'approved team';
    const b = clone(a);
    b.components.schemas.Input.properties.name.minLength = 9;
    b.components.schemas.Input['x-owner'] = 'AI suggestion';
    b.paths['/things'].post.responses['201'].links = {};
    const result = clone(await applyRepositoryRequestResponseChanges('things', a, b));
    expect(result.paths['/things'].post.responses['201'].links).toEqual(
      a.paths['/things'].post.responses['201'].links,
    );
    expect(result.components.schemas.Input['x-owner']).toBe('approved team');
  });
  it('sorts unordered constraints but retains field names that resemble descriptive keywords', async () => {
    const a = repositoryTestDocument();
    const b = clone(a);
    b.components.schemas.Input.required.reverse();
    b.components.schemas.Input.description = 'AI wording';
    b.paths['/things'].post.summary = 'AI summary';
    expect(requestResponseHash(await fragment(a))).toBe(requestResponseHash(await fragment(b)));
    b.components.schemas.Input.properties.description.type = 'number';
    expect(requestResponseHash(await fragment(a))).not.toBe(requestResponseHash(await fragment(b)));
  });
  it('excludes route, authentication, examples and unrelated definitions', async () => {
    const a = repositoryTestDocument();
    const b = clone(a);
    b.paths['/renamed'] = { put: b.paths['/things'].post };
    delete b.paths['/things'];
    b.paths['/renamed'].put.security = [{ key: [] }];
    b.components.securitySchemes = { key: { type: 'apiKey', in: 'header', name: 'key' } };
    b.components.schemas.Unused = { type: 'number' };
    b.components.schemas.Input.example = { name: 'fake' };
    expect(requestResponseHash(await fragment(a))).toBe(requestResponseHash(await fragment(b)));
  });
  it('compares error responses, headers, required flags and referenced schema constraints', async () => {
    const a = repositoryTestDocument();
    const b = clone(a);
    b.paths['/things'].post.responses['400'] = {
      description: 'Error',
      headers: { 'Retry-After': { schema: { type: 'integer' } } },
      content: {
        'application/json': {
          schema: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    };
    const selected = extractRequestResponseContract(await fragment(b));
    expect(selected.responses).toHaveProperty('400');
    expect(selected.references).toHaveProperty('#/components/schemas/Input');
    expect(requestResponseHash(await fragment(a))).not.toBe(requestResponseHash(await fragment(b)));
  });
  it('applies only request/response changes and keeps approved prose', async () => {
    const a = repositoryTestDocument();
    const b = clone(a);
    b.paths['/things'].post.summary = 'Unapproved rewrite';
    b.paths['/things'].post.description = 'Different wording';
    b.paths['/things'].post.requestBody.description = 'New body prose';
    b.components.schemas.Input.properties.name.minLength = 5;
    b.components.schemas.Input.properties.name.description = 'Different name description';
    b.paths['/new-route'] = { put: b.paths['/things'].post };
    delete b.paths['/things'];
    const applied = clone(await applyRepositoryRequestResponseChanges('things', a, b));
    expect(applied.paths['/things'].post.summary).toBe('Approved summary');
    expect(applied.paths['/things'].post.description).toBe('Approved explanation');
    expect(applied.paths['/things'].post.requestBody.description).toBe('Approved body');
    expect(applied.components.schemas.Input.properties.name).toEqual({
      type: 'string',
      minLength: 5,
      description: 'Approved name',
    });
    expect(applied.paths['/new-route']).toBeUndefined();
  });
  it('rejects unmatched operations instead of inferring removal', async () => {
    const a = repositoryTestDocument();
    const b = clone(a);
    b.paths['/things'].post.operationId = 'different';
    await expect(applyRepositoryRequestResponseChanges('things', a, b)).rejects.toThrow(
      'Cannot match existing operation',
    );
  });
  it('rejects remote references before document parsing can fetch them', async () => {
    const a = clone(repositoryTestDocument());
    a.components.schemas.Input = { $ref: 'http://localhost/private' };
    await expect(fragment(a)).rejects.toThrow('local references');
  });
  it('validates Arazzo references against actual operations', async () => {
    await expect(
      normalizeRepositoryContract('things', repositoryTestDocument(), {
        arazzo: '1.0.1',
        info: { title: 'Things', version: '1' },
        workflows: [{ workflowId: 'missing', steps: [{ stepId: 'one', operationId: 'invented' }] }],
      }),
    ).rejects.toThrow('does not resolve');
  });
});
