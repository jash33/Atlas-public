import { describe, expect, it } from 'vite-plus/test';
import {
  createRepositoryContractExtractor,
  RepositoryExtractionError,
} from './repository-contract-extraction.js';
import type { RepositoryAnalysisMemory } from './repository-analysis-workspace.js';
import type { RepositorySnapshot } from './github-repository-source.js';

type Call = { name: string; arguments: unknown };
const ids = ['first', 'second', 'third', 'fourth'];
const source: Record<string, string> = {
  'routes.ts': ids.map((id) => `app.get('/${id}', ${id});`).join('\n'),
  'custom-check.ts': 'export function customCheck(input) { return { result: input.value }; }',
  ...Object.fromEntries(
    ids.map((id) => [
      `${id}.ts`,
      `export function ${id}(request) { return customCheck(request); }`,
    ]),
  ),
};
const evidence = (path: string, startLine = 1, endLine = 1) => ({
  path,
  startLine,
  endLine,
  quote: source[path]!,
});
function snapshot(changes: Record<string, string> = {}): RepositorySnapshot {
  const files = { ...source, ...changes };
  return {
    repository: 'https://github.com/example/custom',
    commit: 'a'.repeat(40),
    services: [{ serviceId: 'api', root: '.' }],
    files: Object.entries(files).map(([path, text]) => ({ path, sha: text, size: text.length })),
    readFile: async (path) => files[path]!,
  };
}
function fakeProvider(replies: Call[], requests: Array<{ input: unknown[] }>): typeof fetch {
  return async (_input, init) => {
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request');
    requests.push(JSON.parse(init.body));
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected fake provider request');
    return Response.json({
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: String(requests.length),
          name: reply.name,
          arguments: JSON.stringify(reply.arguments),
        },
      ],
    });
  };
}
const read = (path: string): Call => ({
  name: 'read_file',
  arguments: { path, startLine: 1, endLine: source[path]!.split('\n').length },
});
const discover: Call[] = [
  read('routes.ts'),
  {
    name: 'write_service_inventory',
    arguments: { serviceId: 'api', operationIds: ids, workflowIds: [] },
  },
];
const finding: Call = {
  name: 'save_source_finding',
  arguments: {
    id: 'custom-check',
    serviceId: 'api',
    operationIds: [],
    summary: 'customCheck constructs result from input.value. It performs no runtime validation.',
    evidence: [evidence('custom-check.ts')],
    dependencyPaths: ['custom-check.ts'],
  },
};
const readFinding: Call = { name: 'read_source_finding', arguments: { id: 'custom-check' } };
function write(ids: string[]): Call {
  return {
    name: 'write_operations',
    arguments: {
      serviceId: 'api',
      operations: ids.map((id) => ({
        path: `/${id}`,
        method: 'get',
        definition: JSON.stringify({
          operationId: id,
          summary: `Read ${id}`,
          description: `Returns the custom result. ${id === 'first' ? 'earlier-operation-detail '.repeat(200) : ''}`,
          responses: {
            '200': {
              description: 'Result',
              content: {
                'application/json': { schema: { type: 'object', properties: { result: {} } } },
              },
            },
          },
        }),
        evidence: [
          {
            ...evidence(`${id}.ts`),
            operationId: id,
            functionName: id,
            role: 'handler',
            covers: ['request', 'response'],
          },
          {
            ...evidence('routes.ts', 1, 4),
            operationId: id,
            functionName: 'routes',
            role: 'route',
            covers: ['route'],
          },
          {
            ...evidence('custom-check.ts'),
            operationId: id,
            functionName: 'customCheck',
            role: 'helper',
            covers: ['response'],
          },
        ],
      })),
    },
  };
}
const finish: Call[] = [
  {
    name: 'write_service_review',
    arguments: {
      serviceId: 'api',
      title: 'Custom API',
      version: '1',
      dependenciesComplete: true,
      unresolvedQuestions: ['The external HTTP framework handles uncaught errors.'],
    },
  },
  { name: 'finish_contracts', arguments: { complete: true } },
];
function initialCalls(): Call[] {
  return [
    ...discover,
    read('custom-check.ts'),
    finding,
    ...ids.slice(0, 3).map((id) => read(`${id}.ts`)),
    write(ids.slice(0, 3)),
    readFinding,
    read('fourth.ts'),
    write(['fourth']),
    ...finish,
  ];
}
const configured = { apiKey: 'fake-test-key', model: 'fake-test-model' };

describe('focused extraction with no live provider', () => {
  it('starts a fresh conversation for each small group and reuses homegrown helper findings', async () => {
    const requests: Array<{ input: unknown[] }> = [];
    let saved: RepositoryAnalysisMemory | undefined;
    const extractor = createRepositoryContractExtractor(
      configured,
      fakeProvider(initialCalls(), requests),
    );
    const result = await extractor.extract(
      snapshot(),
      {},
      {
        checkpoint: async (memory) => {
          saved = memory;
        },
      },
    );
    expect(result).toMatchObject({ complete: true });
    // Context is JSON inside a user message, so inspect it directly.
    const tasks = requests.map(({ input }) =>
      JSON.parse((input[0] as { content: string }).content),
    );
    const fourthIndex = tasks.findIndex(
      (task) =>
        task.task.kind === 'operations' &&
        task.task.operationIds.length === 1 &&
        task.task.operationIds[0] === 'fourth',
    );
    expect(fourthIndex).toBeGreaterThan(0);
    expect(requests[fourthIndex]!.input).toHaveLength(1);
    expect(JSON.stringify(requests[fourthIndex]!.input)).not.toContain('earlier-operation-detail');
    expect(JSON.stringify(requests[fourthIndex + 1]!.input)).toContain(
      'performs no runtime validation',
    );
    expect(saved?.findings).toHaveLength(1);
    expect(saved?.documents).toEqual(result);
  });

  it('reuses unchanged contracts across commits and rechecks only the changed operation group', async () => {
    let memory: RepositoryAnalysisMemory | undefined;
    await createRepositoryContractExtractor(configured, fakeProvider(initialCalls(), [])).extract(
      snapshot(),
      {},
      {
        checkpoint: async (value) => {
          memory = value;
        },
      },
    );
    const updated = snapshot({ 'fourth.ts': `${source['fourth.ts']} // changed implementation` });
    const requests: Array<{ input: unknown[] }> = [];
    const replies = [...discover, readFinding, read('fourth.ts'), write(['fourth']), ...finish];
    const result = await createRepositoryContractExtractor(
      configured,
      fakeProvider(replies, requests),
    ).extract(updated, { api: ids }, { previous: memory });
    expect(result).toMatchObject({ complete: true });
    const tasks = requests.map(
      ({ input }) => JSON.parse((input[0] as { content: string }).content).task,
    );
    expect(
      tasks
        .filter((task) => task.kind === 'operations')
        .every((task) => JSON.stringify(task.operationIds) === JSON.stringify(['fourth'])),
    ).toBe(true);
    expect(JSON.stringify(result)).toContain('earlier-operation-detail');
    expect(requests.length).toBeLessThan(initialCalls().length);
  });

  it('caps repeated input and retains the draft instead of spending indefinitely', async () => {
    let calls = 0;
    const repeatedRead: typeof fetch = async () => {
      calls++;
      return Response.json({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: String(calls),
            name: 'read_file',
            arguments: JSON.stringify({ path: 'long.ts', startLine: 1, endLine: 100 }),
          },
        ],
      });
    };
    const long = Array.from({ length: 100 }, () => '// code '.repeat(25)).join('\n');
    let retained: RepositoryAnalysisMemory | undefined;
    const failure = await createRepositoryContractExtractor(configured, repeatedRead)
      .extract(
        snapshot({ 'long.ts': long }),
        {},
        {
          checkpoint: async (memory) => {
            retained = memory;
          },
        },
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RepositoryExtractionError);
    expect((failure as Error).message).toContain('input budget');
    expect(calls).toBeLessThan(180);
    expect(retained?.documents).toMatchObject({ complete: false });
  });

  it('blocks accidental external fetches before any network request', async () => {
    await expect(fetch('https://provider.example.invalid/completions')).rejects.toThrow(
      'External network calls are disabled in tests',
    );
  });
});
