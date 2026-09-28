import { describe, expect, it } from 'vite-plus/test';
import {
  useVerifiedRepositoryDocuments,
  findUnreviewedRepositoryDocumentDifferences,
} from './repository-contract-source-documents.js';
import type { RepositorySnapshot } from './github-repository-source.js';

function fixture() {
  const operation = {
    operationId: 'hello',
    summary: 'Hello',
    description: 'Returns a greeting.',
    responses: {
      '200': { description: 'OK', content: { 'application/json': { schema: { type: 'string' } } } },
    },
  };
  const openapi = {
    openapi: '3.1.0',
    info: { title: 'Greeting', version: '1' },
    paths: { '/hello': { get: operation } },
  };
  const published = structuredClone(openapi);
  Object.assign(published.paths['/hello'].get.responses['200'].content['application/json'].schema, {
    const: 'world',
  });
  const draft = {
    complete: false,
    services: [
      {
        serviceId: 'hello',
        openapi,
        arazzo: null,
        evidence: [
          {
            operationId: 'hello',
            path: 'app.ts',
            functionName: 'hello',
            startLine: 1,
            endLine: 1,
            role: 'handler',
            covers: ['request', 'response', 'route'],
            quote: 'world',
          },
        ],
        workflowEvidence: [],
        unresolvedQuestions: [] as string[],
        dependenciesComplete: true,
      },
    ],
  };
  const source: RepositorySnapshot = {
    repository: 'https://github.com/example/hello',
    commit: 'a'.repeat(40),
    services: [{ serviceId: 'hello', root: '.' }],
    files: [{ path: 'openapi.json', sha: 'b'.repeat(40), size: 1000 }],
    readFile: async () => JSON.stringify(published),
  };
  const request = {
    serviceId: 'hello',
    openapiPath: 'openapi.json',
    arazzoPath: null,
    verifiedAgainstCode: true,
    verificationNotes: 'The handler returns the documented constant.',
    workflowEvidence: [],
  };
  return { draft, published, source, request };
}

describe('source-verified repository documents', () => {
  it('requires dropped documented details to be restored or named for human review', async () => {
    const { draft, source, request } = fixture();
    expect(await findUnreviewedRepositoryDocumentDifferences(draft, source)).toEqual([
      { serviceId: 'hello', path: 'openapi.json', operationIds: ['hello'] },
    ]);
    const reused = await useVerifiedRepositoryDocuments(draft, request, source);
    expect(await findUnreviewedRepositoryDocumentDifferences(reused, source)).toEqual([]);
    draft.services[0]!.unresolvedQuestions.push(
      'openapi.json: hello does not always return the documented constant.',
    );
    expect(await findUnreviewedRepositoryDocumentDifferences(draft, source)).toEqual([]);
  });
  it('preserves documented constraints and generated extra operations without approving the draft', async () => {
    const { draft, published, source, request } = fixture();
    const extra = { ...draft.services[0]!.openapi.paths['/hello'].get, operationId: 'metadata' };
    Object.assign(draft.services[0]!.openapi.paths, { '/metadata': { get: extra } });
    const result = await useVerifiedRepositoryDocuments(draft, request, source);
    expect(result.complete).toBe(false);
    expect(result.services[0]!.openapi.paths).toEqual({
      ...published.paths,
      '/metadata': { get: extra },
    });
    expect(result.services[0]!.evidence).toEqual(draft.services[0]!.evidence);
    expect(result.services[0]!.supportingDocuments?.[0]).toMatchObject({
      path: 'openapi.json',
      sha: 'b'.repeat(40),
    });
    expect(
      draft.services[0]!.openapi.paths['/hello'].get.responses['200'].content['application/json']
        .schema,
    ).not.toHaveProperty('const');
  });

  it('cannot introduce operations that have not first been traced and generated', async () => {
    const { draft, published, source, request } = fixture();
    published.paths['/hello'].get.operationId = 'unexamined';
    await expect(useVerifiedRepositoryDocuments(draft, request, source)).rejects.toThrow(
      'Trace and write these operations',
    );
  });

  it('requires an explicit code-verification assertion and a snapshot file', async () => {
    const { draft, source, request } = fixture();
    await expect(
      useVerifiedRepositoryDocuments(draft, { ...request, verifiedAgainstCode: false }, source),
    ).rejects.toThrow('Inspect implementation');
    await expect(
      useVerifiedRepositoryDocuments(
        draft,
        { ...request, openapiPath: 'https://example.com/openapi.json' },
        source,
      ),
    ).rejects.toThrow('from this snapshot');
  });
});
