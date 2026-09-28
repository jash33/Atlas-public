import { describe, expect, it } from 'vite-plus/test';
import {
  createRepositoryContractExtractor,
  RepositoryExtractionError,
  validateRepositoryExtraction,
} from './repository-contract-extraction.js';
import type { RepositorySnapshot } from './github-repository-source.js';

const code =
  'export function getHello() { return { hello: "world" }; }\napp.get("/hello", c => c.json(getHello()));';
const snapshot: RepositorySnapshot = {
  repository: 'https://github.com/example/api',
  commit: 'a'.repeat(40),
  services: [{ serviceId: 'api', root: '.' }],
  files: [{ path: 'app.ts', sha: 'b'.repeat(40), size: code.length }],
  readFile: async () => code,
};
function documents(quote = 'return { hello: "world" };') {
  const schema = { type: 'object', required: ['hello'], properties: { hello: { type: 'string' } } };
  const operation = {
    operationId: 'getHello',
    summary: 'Get a greeting',
    description: 'Returns a hello field containing world.',
    responses: { '200': { description: 'Greeting', content: { 'application/json': { schema } } } },
  };
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'Hello', version: '1' },
    paths: { '/hello': { get: operation } },
  };
  return {
    complete: true,
    services: [
      {
        serviceId: 'api',
        openapi,
        arazzo: null,
        evidence: [
          {
            operationId: 'getHello',
            path: 'app.ts',
            functionName: 'getHello',
            startLine: 1,
            endLine: 2,
            role: 'handler',
            covers: ['request', 'response', 'route'],
            quote,
          },
        ],
        workflowEvidence: [],
        unresolvedQuestions: [],
        dependenciesComplete: true,
        inventory: { operationIds: ['getHello'], workflowIds: [] as string[] },
      },
    ],
  };
}
function provider(
  replies: Array<{ name: string; arguments: unknown }>,
  observed: Record<string, unknown>[],
) {
  return async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
    observed.push(JSON.parse(init.body) as Record<string, unknown>);
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected additional model call');
    // Full-draft fixtures exercise the final validation path through the correction tool.
    let submission =
      reply.name === 'submit_contracts'
        ? {
            name: 'revise_contracts',
            arguments: {
              changes: Object.entries(reply.arguments as Record<string, unknown>).map(
                ([key, value]) => ({ op: 'set', path: `/${key}`, value }),
              ),
            },
          }
        : reply;
    if (['write_operations', 'write_components', 'write_workflows'].includes(submission.name)) {
      const input = structuredClone(submission.arguments) as Record<string, unknown>;
      const key = submission.name.slice('write_'.length);
      input[key] = (input[key] as Array<Record<string, unknown>>).map((entry) => ({
        ...entry,
        definition: JSON.stringify(entry.definition),
      }));
      submission = { name: submission.name, arguments: input };
    }
    return Response.json({
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: String(observed.length),
          name: submission.name,
          arguments: JSON.stringify(submission.arguments),
        },
      ],
    });
  };
}
function finish(operationIds = ['getHello'], workflowIds: string[] = []) {
  return [
    { name: 'write_service_inventory', arguments: { serviceId: 'api', operationIds, workflowIds } },
    { name: 'finish_contracts', arguments: { complete: true } },
  ];
}
describe('source-reading AI extraction', () => {
  it('does not let a correction tool bypass the required source inventory', async () => {
    const draft = documents();
    const { inventory: _, ...withoutInventory } = draft.services[0]!;
    const invalid = { ...draft, services: [withoutInventory] };
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          ...Array.from({ length: 6 }, () => ({ name: 'submit_contracts', arguments: invalid })),
        ],
        [],
      ),
    );
    await expect(extractor.extract(snapshot, {})).rejects.toThrow(
      'Record the complete source operation and workflow inventory',
    );
  });
  it('retains an explicit incomplete result instead of treating a finish call as completion', async () => {
    const observed: Record<string, unknown>[] = [];
    const service = documents().services[0]!;
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          finish()[0]!,
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          {
            name: 'write_operations',
            arguments: {
              serviceId: 'api',
              operations: [
                {
                  path: '/hello',
                  method: 'get',
                  definition: service.openapi.paths['/hello'].get,
                  evidence: service.evidence,
                },
              ],
            },
          },
          {
            name: 'write_service_inventory',
            arguments: { serviceId: 'api', operationIds: ['getHello'], workflowIds: [] },
          },
          {
            name: 'write_service_review',
            arguments: {
              serviceId: 'api',
              title: 'Hello',
              version: '1',
              unresolvedQuestions: ['More local handlers need to be read.'],
              dependenciesComplete: false,
            },
          },
          { name: 'finish_contracts', arguments: { complete: false } },
        ],
        observed,
      ),
    );
    const failure = (await extractor
      .extract(snapshot, {})
      .catch((error: unknown) => error)) as RepositoryExtractionError;
    expect(failure).toBeInstanceOf(RepositoryExtractionError);
    expect(failure.generatedDocuments).toMatchObject({ complete: false });
    expect(JSON.stringify(observed[6]!.input)).toContain('Repository analysis is incomplete');
  });

  it('rejects a complete claim when supported workflows are missing from the declared inventory', async () => {
    const draft = documents();
    Object.assign(draft.services[0]!, {
      inventory: { operationIds: ['getHello'], workflowIds: ['greet'] },
    });
    await expect(validateRepositoryExtraction(draft, snapshot)).rejects.toThrow(
      'Missing workflows: greet',
    );
  });
  it('validates shared schemas and complete workflows assembled in separate sections', async () => {
    const observed: Record<string, unknown>[] = [];
    const service = documents().services[0]!;
    const definition = structuredClone(service.openapi.paths['/hello'].get);
    const schema = definition.responses['200'].content['application/json'].schema;
    Object.assign(definition.responses['200'].content['application/json'], {
      schema: { $ref: '#/components/schemas/Greeting' },
    });
    const workflow = {
      workflowId: 'greet',
      description: 'Get a greeting',
      steps: [
        {
          stepId: 'hello',
          operationId: 'getHello',
          successCriteria: [{ condition: '$statusCode == 200' }],
          outputs: { greeting: '$response.body#/hello' },
        },
      ],
    };
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          finish(['getHello'], ['greet'])[0]!,
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          {
            name: 'write_operations',
            arguments: {
              serviceId: 'api',
              operations: [
                { path: '/hello', method: 'get', definition, evidence: service.evidence },
              ],
            },
          },
          {
            name: 'write_components',
            arguments: {
              serviceId: 'api',
              components: [{ kind: 'schemas', name: 'Greeting', definition: schema }],
            },
          },
          {
            name: 'write_workflows',
            arguments: {
              serviceId: 'api',
              workflows: [
                {
                  definition: workflow,
                  evidence: [
                    {
                      workflowId: 'greet',
                      path: 'app.ts',
                      startLine: 1,
                      endLine: 2,
                      quote: 'getHello',
                    },
                  ],
                },
              ],
            },
          },
          {
            name: 'write_service_review',
            arguments: {
              serviceId: 'api',
              title: 'Hello',
              version: '1',
              unresolvedQuestions: [],
              dependenciesComplete: true,
            },
          },
          ...finish(['getHello'], ['greet']),
        ],
        observed,
      ),
    );
    const result = await extractor.extract(snapshot, {});
    expect(result).toMatchObject({
      complete: true,
      services: [
        {
          openapi: {
            paths: { '/hello': { get: definition } },
            components: { schemas: { Greeting: schema } },
          },
          arazzo: { workflows: [workflow] },
        },
      ],
    });
  });

  it('rejects a misplaced path in a section and retains previously assembled operations', async () => {
    const observed: Record<string, unknown>[] = [];
    const service = documents().services[0]!;
    const good = {
      path: '/hello',
      method: 'get',
      definition: service.openapi.paths['/hello'].get,
      evidence: service.evidence,
    };
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          finish()[0]!,
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          { name: 'write_operations', arguments: { serviceId: 'api', operations: [good] } },
          {
            name: 'write_operations',
            arguments: {
              serviceId: 'api',
              operations: [
                { ...good, definition: { ...good.definition, '/misplaced': { get: {} } } },
              ],
            },
          },
          {
            name: 'write_service_review',
            arguments: {
              serviceId: 'api',
              title: 'Hello',
              version: '1',
              unresolvedQuestions: [],
              dependenciesComplete: true,
            },
          },
          ...finish(),
        ],
        observed,
      ),
    );
    const expected = documents();
    Object.assign(expected.services[0]!, {
      inventory: { operationIds: ['getHello'], workflowIds: [] },
    });
    expect(await extractor.extract(snapshot, {})).toEqual(expected);
    expect(JSON.stringify(observed[4]!.input)).toContain(
      'An operation cannot contain another HTTP path',
    );
  });

  it('assembles separately generated operations and review fields without nesting later paths', async () => {
    const observed: Record<string, unknown>[] = [];
    const service = documents().services[0]!;
    const second = { ...service.openapi.paths['/hello'].get, operationId: 'anotherGreeting' };
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          finish(['getHello', 'anotherGreeting'])[0]!,
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          {
            name: 'write_operations',
            arguments: {
              serviceId: 'api',
              operations: [
                {
                  path: '/hello',
                  method: 'get',
                  definition: service.openapi.paths['/hello'].get,
                  evidence: service.evidence,
                },
              ],
            },
          },
          {
            name: 'write_operations',
            arguments: {
              serviceId: 'api',
              operations: [
                {
                  path: '/another',
                  method: 'get',
                  definition: second,
                  evidence: service.evidence.map((entry) => ({
                    ...entry,
                    operationId: second.operationId,
                  })),
                },
              ],
            },
          },
          {
            name: 'write_service_review',
            arguments: {
              serviceId: 'api',
              title: 'Hello',
              version: '1',
              unresolvedQuestions: [],
              dependenciesComplete: true,
            },
          },
          ...finish(['getHello', 'anotherGreeting']),
        ],
        observed,
      ),
    );
    const expected = documents();
    Object.assign(expected.services[0]!, {
      inventory: { operationIds: ['getHello', 'anotherGreeting'], workflowIds: [] },
    });
    Object.assign(expected.services[0]!.openapi.paths, { '/another': { get: second } });
    expected.services[0]!.evidence.push(
      ...service.evidence.map((entry) => ({ ...entry, operationId: second.operationId })),
    );
    expect(await extractor.extract(snapshot, {})).toEqual(expected);
    const tools = observed[0]!.tools as Array<{ name: string }>;
    expect(tools.some((tool) => tool.name === 'write_operations')).toBe(true);
    expect(tools.some((tool) => tool.name === 'submit_contracts')).toBe(false);
  });

  it('retains assembled sections as an incomplete draft when generation stops', async () => {
    const observed: Record<string, unknown>[] = [];
    const service = documents().services[0]!;
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          finish()[0]!,
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          {
            name: 'write_operations',
            arguments: {
              serviceId: 'api',
              operations: [
                {
                  path: '/hello',
                  method: 'get',
                  definition: service.openapi.paths['/hello'].get,
                  evidence: service.evidence,
                },
              ],
            },
          },
        ],
        observed,
      ),
    );
    const error = (await extractor
      .extract(snapshot, {})
      .catch((failure: unknown) => failure)) as RepositoryExtractionError;
    expect(error).toBeInstanceOf(RepositoryExtractionError);
    expect(error.generatedDocuments).toMatchObject({
      complete: false,
      services: [{ serviceId: 'api', openapi: { paths: service.openapi.paths } }],
    });
  });

  it('retains the generated draft if the model connection fails during a correction', async () => {
    const observed: Record<string, unknown>[] = [];
    const draft = documents('invented code');
    const replies = provider(
      [
        { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
        { name: 'submit_contracts', arguments: draft },
      ],
      observed,
    );
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      async (url, init) => {
        if (observed.length === 2) throw new Error('Model connection closed');
        return replies(url, init);
      },
    );
    const failure = await extractor.extract(snapshot, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryExtractionError);
    expect((failure as RepositoryExtractionError).generatedDocuments).toEqual(draft);
  });

  it('can revalidate an unchanged draft after reading missing source evidence', async () => {
    const observed: Record<string, unknown>[] = [];
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'submit_contracts', arguments: documents() },
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          { name: 'revise_contracts', arguments: { changes: [] } },
        ],
        observed,
      ),
    );
    expect(await extractor.extract(snapshot, {})).toEqual(documents());
  });

  it('reports OpenAPI parser details so a malformed draft can be repaired', async () => {
    const observed: Record<string, unknown>[] = [];
    const malformed = documents();
    Object.assign(malformed.services[0]!.openapi.paths['/hello'], { '/misplaced': { get: {} } });
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          { name: 'submit_contracts', arguments: malformed },
          { name: 'inspect_draft', arguments: { path: '/services/0/openapi/paths/~1hello' } },
          {
            name: 'revise_contracts',
            arguments: {
              changes: [{ op: 'remove', path: '/services/0/openapi/paths/~1hello/~1misplaced' }],
            },
          },
        ],
        observed,
      ),
    );
    expect(await extractor.extract(snapshot, {})).toEqual(documents());
    expect(JSON.stringify(observed[2]!.input)).toContain('/paths/~1hello: Property /misplaced');
  });

  it('repairs misplaced review fields in a large draft without regenerating its contract', async () => {
    const observed: Record<string, unknown>[] = [];
    const { serviceId, openapi, ...reviewFields } = documents().services[0]!;
    const malformed = {
      complete: true,
      services: [{ serviceId, openapi: { ...openapi, ...reviewFields } }],
    };
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          { name: 'submit_contracts', arguments: malformed },
          {
            name: 'revise_contracts',
            arguments: {
              changes: Object.keys(reviewFields).map((key) => ({
                op: 'move',
                from: `/services/0/openapi/${key}`,
                path: `/services/0/${key}`,
              })),
            },
          },
        ],
        observed,
      ),
    );
    expect(await extractor.extract(snapshot, {})).toEqual(documents());
  });

  it('receives large tool responses as a stream and requires its completion event', async () => {
    const observed: Record<string, unknown>[] = [];
    const replies = provider(
      [
        { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
        { name: 'submit_contracts', arguments: documents() },
      ],
      observed,
    );
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      async (url, init) => {
        const response = await replies(url, init);
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: await response.json() })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    );
    expect(await extractor.extract(snapshot, {})).toEqual(documents());
    expect(observed.every((request) => request.stream === true)).toBe(true);
  });

  it('accepts citations whose complete range was read across adjacent file chunks', async () => {
    const observed: Record<string, unknown>[] = [];
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 2, endLine: 2 } },
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 1 } },
          { name: 'submit_contracts', arguments: documents() },
        ],
        observed,
      ),
    );
    expect(await extractor.extract(snapshot, {})).toEqual(documents());
  });

  it('still rejects a citation containing an unread gap between file chunks', async () => {
    const observed: Record<string, unknown>[] = [];
    const draft = documents();
    draft.services[0]!.evidence[0]!.endLine = 3;
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 1 } },
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 3, endLine: 3 } },
          ...Array.from({ length: 6 }, () => ({ name: 'submit_contracts', arguments: draft })),
        ],
        observed,
      ),
    );
    await expect(
      extractor.extract({ ...snapshot, readFile: async () => `${code}\n// end` }, {}),
    ).rejects.toThrow('did not read its supporting range');
  });

  it('returns read-tool input errors so the analyzer can correct them without losing the run', async () => {
    const observed: Record<string, unknown>[] = [];
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 421 } },
          { name: 'read_file', arguments: { path: 'missing.ts', startLine: 1, endLine: 2 } },
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 0, endLine: 2 } },
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          { name: 'submit_contracts', arguments: documents() },
        ],
        observed,
      ),
    );
    expect(await extractor.extract(snapshot, {})).toEqual(documents());
    expect(JSON.stringify(observed[1]!.input)).toContain('Read at most 400 lines');
    expect(JSON.stringify(observed[2]!.input)).toContain('Unknown snapshot file');
  });

  it('lets the analyzer finish unread handlers after a premature partial submission', async () => {
    const observed: Record<string, unknown>[] = [];
    const partial = {
      ...documents(),
      complete: false,
      services: [
        { ...documents().services[0]!, unresolvedQuestions: ['Handler has not been read yet.'] },
      ],
    };
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'submit_contracts', arguments: partial },
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          { name: 'submit_contracts', arguments: documents() },
        ],
        observed,
      ),
    );
    expect(await extractor.extract(snapshot, {})).toEqual(documents());
    expect(JSON.stringify(observed[1]!.input)).toContain('Continue reading');
  });

  it('retains the partial draft when missing source cannot be resolved within the retry limit', async () => {
    const observed: Record<string, unknown>[] = [];
    const partial = { ...documents(), complete: false };
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        Array.from({ length: 6 }, () => ({ name: 'submit_contracts', arguments: partial })),
        observed,
      ),
    );
    const failure = await extractor.extract(snapshot, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryExtractionError);
    expect((failure as RepositoryExtractionError).generatedDocuments).toEqual(partial);
    expect(observed).toHaveLength(6);
  });

  it('corrects invalid citations using a bounded tool loop and validates final documents', async () => {
    const observed: Record<string, unknown>[] = [];
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          { name: 'submit_contracts', arguments: documents('invented code') },
          { name: 'submit_contracts', arguments: documents() },
        ],
        observed,
      ),
    );
    expect(await extractor.extract(snapshot, {})).toEqual(documents());
    expect(observed[0]!.store).toBe(false);
    expect(JSON.stringify(observed[2]!.input)).toContain('Code evidence does not match');
  });
  it('retains invalid generated documents after the correction limit and never approves them', async () => {
    const observed: Record<string, unknown>[] = [];
    const invalid = documents('invented code');
    const extractor = createRepositoryContractExtractor(
      { apiKey: 'test-key', model: 'test-model' },
      provider(
        [
          { name: 'read_file', arguments: { path: 'app.ts', startLine: 1, endLine: 2 } },
          ...Array.from({ length: 6 }, () => ({ name: 'submit_contracts', arguments: invalid })),
        ],
        observed,
      ),
    );
    const failure = await extractor.extract(snapshot, {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryExtractionError);
    expect((failure as RepositoryExtractionError).generatedDocuments).toEqual(invalid);
  });
});
