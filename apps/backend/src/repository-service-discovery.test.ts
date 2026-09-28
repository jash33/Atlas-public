import { describe, expect, it } from 'vite-plus/test';
import {
  createRepositoryContractExtractor,
  validateRepositoryExtraction,
} from './repository-contract-extraction.js';
import { validateDiscoveredServices } from './repository-service-discovery.js';
import type { RepositorySnapshot } from './github-repository-source.js';
import type { RepositoryAnalysisMemory } from './repository-analysis-workspace.js';
import type { RepositoryProgressUpdate } from './repository-analysis-progress.js';

const applications = [
  { serviceId: 'orders', root: 'custom/orders', operationId: 'getOrders', path: '/orders' },
  { serviceId: 'billing', root: 'another/place', operationId: 'getBilling', path: '/billing' },
];
const files = Object.fromEntries(
  applications.map((app) => [
    `${app.root}/entry.ts`,
    `serve("${app.path}", function ${app.operationId}() { return { value: 1 }; });`,
  ]),
);
const snapshot: RepositorySnapshot = {
  repository: 'https://github.com/example/monorepo',
  commit: 'a'.repeat(40),
  services: [],
  files: Object.entries(files).map(([path, text]) => ({
    path,
    sha: 'b'.repeat(40),
    size: text.length,
  })),
  readFile: async (path) => files[path]!,
};
function reference(app = applications[0]!) {
  const path = `${app.root}/entry.ts`;
  return { path, startLine: 1, endLine: 1, quote: files[path]! };
}
const identified = {
  services: applications.map((app) => ({
    serviceId: app.serviceId,
    root: app.root,
    evidence: [reference(app)],
  })),
};
type Call = { name: string; arguments: unknown };
function calls(): Call[] {
  return [
    ...applications.map((app) => ({
      name: 'read_file',
      arguments: { path: `${app.root}/entry.ts`, startLine: 1, endLine: 1 },
    })),
    { name: 'identify_services', arguments: identified },
    ...applications.map((app) => ({
      name: 'write_service_inventory',
      arguments: { serviceId: app.serviceId, operationIds: [app.operationId], workflowIds: [] },
    })),
    ...applications.flatMap((app) => [
      {
        name: 'write_operations',
        arguments: {
          serviceId: app.serviceId,
          operations: [
            {
              path: app.path,
              method: 'get',
              definition: JSON.stringify({
                operationId: app.operationId,
                summary: 'Return a value',
                description: 'Returns value 1.',
                responses: {
                  '200': {
                    description: 'Value',
                    content: {
                      'application/json': {
                        schema: { type: 'object', properties: { value: { type: 'number' } } },
                      },
                    },
                  },
                },
              }),
              evidence: [
                {
                  ...reference(app),
                  operationId: app.operationId,
                  functionName: app.operationId,
                  role: 'handler',
                  covers: ['route', 'request', 'response'],
                },
              ],
            },
          ],
        },
      },
      {
        name: 'write_service_review',
        arguments: {
          serviceId: app.serviceId,
          title: app.serviceId,
          version: '1',
          unresolvedQuestions: [],
          dependenciesComplete: true,
        },
      },
    ]),
    { name: 'finish_contracts', arguments: { complete: true } },
  ];
}
function extractor(replies: Call[], observed: Array<Record<string, unknown>>) {
  return createRepositoryContractExtractor(
    { apiKey: 'fake-key', model: 'fake-model' },
    async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected JSON');
      observed.push(JSON.parse(init.body));
      const reply = replies.shift();
      if (!reply) throw new Error('Unexpected fake model request');
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: String(observed.length),
            name: reply.name,
            arguments: JSON.stringify(reply.arguments),
          },
        ],
      });
    },
  );
}

describe('automatic repository service discovery with fake model responses', () => {
  it('discovers multiple applications in unconventional directories and extracts their contracts', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const progress: RepositoryProgressUpdate[] = [];
    const raw = await extractor(calls(), requests).extract(
      snapshot,
      {},
      {
        progress: async (value) => {
          progress.push(value);
        },
      },
    );
    const result = await validateRepositoryExtraction(raw, snapshot);
    expect(result.services.map(({ serviceId, sourceRoot }) => ({ serviceId, sourceRoot }))).toEqual(
      applications.map(({ serviceId, root }) => ({ serviceId, sourceRoot: root })),
    );
    expect(result.services.every((service) => service.serviceEvidence?.length === 1)).toBe(true);
    const initial = JSON.parse((requests[0]!.input as Array<{ content: string }>)[0]!.content);
    expect(initial.task.kind).toBe('identify_services');
    const tools = (requests[0]!.tools as Array<{ name: string }>).map(({ name }) => name);
    expect(tools).toContain('identify_services');
    expect(tools).not.toContain('write_operations');
    expect(progress[0]).toMatchObject({
      phase: 'discovering',
      servicesFound: 0,
      operationsDrafted: 0,
    });
    expect(progress.some((update) => update.message.startsWith('Found 2 API services'))).toBe(true);
    expect(
      progress.some(
        (update) =>
          update.phase === 'extracting' &&
          update.operationsDrafted === 1 &&
          update.operationsDiscovered === 2,
      ),
    ).toBe(true);
    expect(progress.at(-1)).toMatchObject({
      phase: 'checking',
      operationsDrafted: 2,
      operationsDiscovered: 2,
      filesRead: 2,
    });
  });

  it('requires discovery before accepting a full-document shortcut', async () => {
    const requests: Array<Record<string, unknown>> = [];
    await extractor(
      [{ name: 'finish_contracts', arguments: { complete: true } }, ...calls()],
      requests,
    ).extract(snapshot, {});
    expect(JSON.stringify(requests[1]!.input)).toContain('Identify the API services from source');
  });

  it('requires application evidence to have been read before accepting the service map', async () => {
    const requests: Array<Record<string, unknown>> = [];
    await extractor(
      [{ name: 'identify_services', arguments: identified }, ...calls()],
      requests,
    ).extract(snapshot, {});
    expect(JSON.stringify(requests[1]!.input)).toContain('Read the supporting code');
  });

  it('preserves accepted service IDs during rediscovery', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const replies = calls();
    replies.splice(2, 0, {
      name: 'identify_services',
      arguments: { services: [identified.services[0]] },
    });
    await extractor(replies, requests).extract(snapshot, { billing: ['getBilling'] });
    expect(JSON.stringify(requests[3]!.input)).toContain(
      'Previously accepted services were not found: billing',
    );
  });

  it('reuses unchanged contracts after automatically confirming the service map again', async () => {
    let memory: RepositoryAnalysisMemory | undefined;
    const original = await extractor(calls(), []).extract(
      snapshot,
      {},
      {
        checkpoint: async (value) => {
          memory = value;
        },
      },
    );
    const requests: Array<Record<string, unknown>> = [];
    const nextCalls = calls().filter((call) => call.name !== 'write_operations');
    nextCalls.find((call) => call.name === 'identify_services')!.arguments = {
      services: [...identified.services].reverse(),
    };
    const resumed = await extractor(nextCalls, requests).extract(
      { ...snapshot, commit: 'c'.repeat(40) },
      { orders: ['getOrders'], billing: ['getBilling'] },
      { previous: memory },
    );
    expect(resumed).toEqual(original);
    const initial = JSON.parse((requests[0]!.input as Array<{ content: string }>)[0]!.content);
    expect(initial.previousServices).toEqual(
      applications.map(({ serviceId, root }) => ({ serviceId, root })),
    );
    expect(requests.length).toBeLessThan(calls().length);
  });

  it.each([
    {
      input: { services: [{ ...identified.services[0], root: '../outside' }] },
      message: 'repository-relative service directory',
    },
    {
      input: { services: [{ ...identified.services[0], root: 'missing' }] },
      message: 'No application source found',
    },
    {
      input: {
        services: [
          { ...identified.services[0], evidence: [{ ...reference(), quote: 'invented code' }] },
        ],
      },
      message: 'Service evidence does not match',
    },
    {
      input: { services: [identified.services[0], identified.services[0]] },
      message: 'Discovered service names must be unique',
    },
    {
      input: { services: [{ ...identified.services[0], evidence: [reference(applications[1])] }] },
      message: 'application code evidence within its directory',
    },
  ])('rejects invalid or unsupported service locations: $message', async ({ input, message }) => {
    await expect(validateDiscoveredServices(input, snapshot)).rejects.toThrow(message);
  });

  it('requires discovered roots in automatically scoped results', async () => {
    const raw = await extractor(calls(), []).extract(snapshot, {});
    const result = await validateRepositoryExtraction(raw, snapshot);
    delete result.services[0]!.sourceRoot;
    await expect(validateRepositoryExtraction(result, snapshot)).rejects.toThrow('expected string');
  });
});
