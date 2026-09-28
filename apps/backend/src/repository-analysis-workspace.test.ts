import { describe, expect, it } from 'vite-plus/test';
import {
  createRepositoryAnalysisWorkspace,
  type RepositoryAnalysisMemory,
} from './repository-analysis-workspace.js';
import { writeRepositoryContractSection } from './repository-contract-builder.js';
import type { RepositorySnapshot } from './github-repository-source.js';

const source = {
  'routes.ts': 'serve("/orders", createOrder); serve("/health", health);',
  'orders.ts': 'export function createOrder(input) { return internalCheck(input); }',
  'internal.ts':
    'export function internalCheck(input) { if (!input.name) throw missing(); return input; }',
  'health.ts': 'export function health() { return { ok: true }; }',
  'settings.json': '{}',
};
function snapshot(changes: Record<string, string> = {}): RepositorySnapshot {
  const code = { ...source, ...changes };
  return {
    repository: 'https://github.com/example/custom-api',
    commit: 'commit',
    services: [{ serviceId: 'api', root: '.' }],
    files: Object.entries(code).map(([path, text]) => ({ path, sha: text, size: text.length })),
    readFile: async (path) => code[path as keyof typeof code]!,
  };
}
const reference = (path: keyof typeof source) => ({
  path,
  startLine: 1,
  endLine: 1,
  quote: source[path],
});
const finding = {
  id: 'internal-check',
  serviceId: 'api',
  operationIds: ['createOrder'],
  summary:
    'The homegrown internalCheck requires a truthy name. The missing() response is unresolved.',
  evidence: [reference('internal.ts')],
  dependencyPaths: ['internal.ts'],
};
const inventory = { serviceId: 'api', operationIds: ['createOrder', 'health'], workflowIds: [] };

async function savedAnalysis() {
  const workspace = createRepositoryAnalysisWorkspace(snapshot());
  let draft: unknown = workspace.initialDocuments;
  function save(name: string, args: unknown) {
    draft = writeRepositoryContractSection(draft, name, args);
    workspace.sectionSaved(name, args, draft);
  }
  workspace.recordRead('routes.ts', 1, 1);
  save('write_service_inventory', inventory);
  for (const [id, path, file] of [
    ['createOrder', '/orders', 'orders.ts'],
    ['health', '/health', 'health.ts'],
  ] as const) {
    workspace.startTask({ kind: 'operations', serviceId: 'api', operationIds: [id] });
    workspace.recordRead(file, 1, 1);
    if (id === 'createOrder') {
      workspace.recordRead('internal.ts', 1, 1);
      await workspace.saveFinding(finding);
    }
    save('write_operations', {
      serviceId: 'api',
      operations: [
        {
          path,
          method: 'get',
          definition: JSON.stringify({
            operationId: id,
            summary: id,
            description: id,
            responses: { '200': { description: 'Success' } },
          }),
          evidence: [
            {
              ...reference(file),
              operationId: id,
              role: 'handler',
              functionName: id,
              covers: ['request', 'response', 'route'],
            },
          ],
        },
      ],
    });
  }
  save('write_service_review', {
    serviceId: 'api',
    title: 'API',
    version: '1',
    dependenciesComplete: true,
    unresolvedQuestions: [],
  });
  return workspace.memory({ ...(draft as object), complete: true }, true);
}
const savedIds = (memory: unknown) =>
  (
    memory as { services: Array<{ evidence: Array<{ operationId: string }> }> }
  ).services[0]!.evidence.map((e) => e.operationId);

describe('focused repository analysis workspace', () => {
  it('reuses unchanged operations while requiring fresh route discovery and service review', async () => {
    const workspace = createRepositoryAnalysisWorkspace(snapshot(), await savedAnalysis());
    await workspace.restoreEvidence();
    expect(savedIds(workspace.initialDocuments)).toEqual(['createOrder', 'health']);
    expect(workspace.nextTask(workspace.initialDocuments, false)).toEqual({
      kind: 'discovery',
      serviceId: 'api',
    });
    const draft = writeRepositoryContractSection(
      workspace.initialDocuments,
      'write_service_inventory',
      inventory,
    );
    workspace.sectionSaved('write_service_inventory', inventory, draft);
    expect(workspace.nextTask(draft, false)).toEqual({ kind: 'review', serviceId: 'api' });
  });

  it('invalidates an operation and shared finding when homegrown validation changes', async () => {
    const workspace = createRepositoryAnalysisWorkspace(
      snapshot({ 'internal.ts': 'export function internalCheck(input) { return input; }' }),
      await savedAnalysis(),
    );
    expect(savedIds(workspace.initialDocuments)).toEqual(['health']);
    await expect(workspace.readFinding('internal-check')).rejects.toThrow(
      'supporting code changed',
    );
    const draft = writeRepositoryContractSection(
      workspace.initialDocuments,
      'write_service_inventory',
      inventory,
    );
    workspace.sectionSaved('write_service_inventory', inventory, draft);
    expect(workspace.nextTask(draft, false)).toEqual({
      kind: 'operations',
      serviceId: 'api',
      operationIds: ['createOrder'],
    });
  });

  it.each([
    { 'routes.ts': 'serveDynamically(loadRoutes());' },
    { 'settings.json': '{"enabled":false}' },
    { 'new-routes.ts': 'registerAdditionalEndpoints();' },
  ])('broadens analysis when routing, configuration or new files change: %j', async (changes) => {
    const workspace = createRepositoryAnalysisWorkspace(snapshot(changes), await savedAnalysis());
    expect(savedIds(workspace.initialDocuments)).toEqual([]);
    await expect(workspace.readFinding('internal-check')).rejects.toThrow('unavailable');
  });

  it('does not reuse operation contracts when dependency coverage was uncertain', async () => {
    const memory = await savedAnalysis();
    (
      memory.documents as { services: Array<{ dependenciesComplete: boolean }> }
    ).services[0]!.dependenciesComplete = false;
    expect(
      savedIds(createRepositoryAnalysisWorkspace(snapshot(), memory).initialDocuments),
    ).toEqual([]);
  });

  it('invalidates saved analysis for dependency lockfile changes without loading their contents', async () => {
    const memory = await savedAnalysis();
    memory.files['pnpm-lock.yaml'] = 'old-version';
    const updated = {
      ...snapshot(),
      dependencyFiles: [{ path: 'pnpm-lock.yaml', sha: 'new-version', size: 900000 }],
    };
    const workspace = createRepositoryAnalysisWorkspace(updated, memory);
    expect(savedIds(workspace.initialDocuments)).toEqual([]);
    await expect(workspace.readFinding('internal-check')).rejects.toThrow('unavailable');
  });

  it('drops a cached operation omitted from the fresh route inventory', async () => {
    const workspace = createRepositoryAnalysisWorkspace(snapshot(), await savedAnalysis());
    const args = { ...inventory, operationIds: ['health'] };
    const draft = writeRepositoryContractSection(
      workspace.initialDocuments,
      'write_service_inventory',
      args,
    );
    workspace.sectionSaved('write_service_inventory', args, draft);
    expect(savedIds(draft)).toEqual(['health']);
  });

  it('checks note citations and dependencies before saving or reusing them', async () => {
    const workspace = createRepositoryAnalysisWorkspace(snapshot());
    await expect(workspace.saveFinding(finding)).rejects.toThrow('Read the exact supporting range');
    workspace.recordRead('internal.ts', 1, 1);
    await expect(
      workspace.saveFinding({
        ...finding,
        evidence: [{ ...reference('internal.ts'), quote: 'invented validation' }],
      }),
    ).rejects.toThrow('does not match');
    await expect(
      workspace.saveFinding({ ...finding, dependencyPaths: ['orders.ts'] }),
    ).rejects.toThrow('Read finding dependency');
    await workspace.saveFinding(finding);
    const memory = workspace.memory(workspace.initialDocuments);
    const resumed = createRepositoryAnalysisWorkspace(snapshot(), memory);
    expect(await resumed.readFinding('internal-check')).toMatchObject(finding);
    expect(resumed.readRanges.get('internal.ts')).toEqual([[1, 1]]);
  });

  it('invalidates shared findings when an indirect dependency changes', async () => {
    const memory = await savedAnalysis();
    const workspace = createRepositoryAnalysisWorkspace(
      snapshot({ 'orders.ts': 'useAnotherValidator();' }),
      memory,
    );
    await expect(workspace.readFinding('internal-check')).rejects.toThrow(
      'supporting code changed',
    );
  });

  it('does not import findings from another repository or service selection', async () => {
    const memory = await savedAnalysis();
    for (const previous of [
      { ...memory, repository: 'https://github.com/other/repo' },
      { ...memory, services: [{ serviceId: 'other', root: '.' }] },
    ]) {
      const workspace = createRepositoryAnalysisWorkspace(snapshot(), previous);
      expect(savedIds(workspace.initialDocuments)).toEqual([]);
      await expect(workspace.readFinding('internal-check')).rejects.toThrow('unavailable');
    }
  });

  it('reuses stored findings when database JSON changes object field ordering', async () => {
    const memory = await savedAnalysis();
    const restored = { ...snapshot(), services: [{ root: '.', serviceId: 'api' }] };
    const workspace = createRepositoryAnalysisWorkspace(restored, memory);
    expect(savedIds(workspace.initialDocuments)).toEqual(['createOrder', 'health']);
    expect(await workspace.readFinding('internal-check')).toMatchObject(finding);
  });

  it('does not reuse incomplete documents, but retains source-backed notes after interruption', async () => {
    const memory: RepositoryAnalysisMemory = await savedAnalysis();
    memory.documents = { ...(memory.documents as object), complete: false };
    const workspace = createRepositoryAnalysisWorkspace(snapshot(), memory);
    expect(savedIds(workspace.initialDocuments)).toEqual([]);
    expect(await workspace.readFinding('internal-check')).toMatchObject(finding);
  });

  it('does not treat a failed complete claim as a validated contract', async () => {
    const memory = await savedAnalysis();
    memory.validated = false;
    const workspace = createRepositoryAnalysisWorkspace(snapshot(), memory);
    expect(savedIds(workspace.initialDocuments)).toEqual([]);
    expect(await workspace.readFinding('internal-check')).toMatchObject(finding);
  });
});
