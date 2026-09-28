import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';

import { createApp } from './app.js';
import { createMembershipAuthorizer } from './admin-suite.js';
import {
  checkGithubRepositoryUpdates,
  type RepositoryAnalysisServices,
} from './github-repository-checks.js';
import { readCapabilityArchitecture } from './capability-architecture.js';
import {
  readAcceptedRepositoryContracts,
  type RepositoryCandidate,
} from './repository-contract-catalog.js';
import {
  RepositoryExtractionError,
  type ExtractedRepositoryService,
} from './repository-contract-extraction.js';
import type { RepositoryTarget } from './github-repository-source.js';
import {
  createRepositoryAnalysisWorkspace,
  type RepositoryAnalysisMemory,
} from './repository-analysis-workspace.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const databaseUrl = resolveTestDatabaseUrl();
const schemaName = `github_contracts_${process.pid}`;
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schemaName}` });
const authorizer = createMembershipAuthorizer(pool, [
  { token: 'reviewer-token', userId: 'reviewer' },
  { token: 'author-token', userId: 'author' },
]);
const app = createApp(pool, undefined, undefined, undefined, undefined, authorizer, {
  repositoryAnalysisConfigured: true,
});
const base = '/v1/organizations/repository-org/repositories';
const sourceCode =
  'export function handler(request) { return validate(request); }\nexport function validate(value) { return { id: value.name }; }';

function extractedService(serviceId = 'things'): ExtractedRepositoryService {
  return {
    serviceId,
    openapi: {
      openapi: '3.1.0',
      info: { title: 'Things', version: '1' },
      paths: {
        '/things': {
          post: {
            operationId: 'createThing',
            summary: 'Approved summary',
            description: 'Approved behavior',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['name'],
                    properties: {
                      name: { type: 'string', minLength: 1, description: 'Approved name' },
                    },
                  },
                },
              },
            },
            responses: {
              '201': {
                description: 'Created',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['id'],
                      properties: { id: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    arazzo: {
      arazzo: '1.0.1',
      info: { title: 'Create a thing', version: '1' },
      sourceDescriptions: [{ name: 'things', url: './openapi.json', type: 'openapi' }],
      workflows: [
        { workflowId: 'create', steps: [{ stepId: 'create', operationId: 'createThing' }] },
      ],
    },
    evidence: [
      {
        operationId: 'createThing',
        path: 'src/route.ts',
        functionName: 'handler',
        startLine: 1,
        endLine: 1,
        role: 'handler',
        covers: ['request', 'response', 'route'],
        quote: 'return validate(request);',
      },
      {
        operationId: 'createThing',
        path: 'src/shared.ts',
        functionName: 'validate',
        startLine: 2,
        endLine: 2,
        role: 'validator',
        covers: ['request', 'response'],
        quote: 'return { id: value.name };',
      },
    ],
    workflowEvidence: [
      {
        workflowId: 'create',
        path: 'src/route.ts',
        startLine: 1,
        endLine: 1,
        quote: 'return validate(request);',
      },
    ],
    unresolvedQuestions: [],
    dependenciesComplete: false,
  };
}
function fixture() {
  let sequence = 1;
  const state = {
    document: extractedService(),
    commit: sequence.toString(16).padStart(40, '0'),
    pulls: [] as RepositoryTarget[],
    fail: false,
    partial: false,
    analysisCalls: 0,
    beforeReturn: undefined as (() => Promise<void>) | undefined,
  };
  const services: RepositoryAnalysisServices = {
    source: {
      async targets() {
        if (state.fail) throw new Error('GitHub unavailable');
        return [
          { key: 'branch:main', branch: 'main', commit: state.commit, baseCommit: '' },
          ...state.pulls,
        ];
      },
      async snapshot(repository, commit, configured) {
        return {
          repository,
          commit,
          services: configured,
          files: ['src/route.ts', 'src/shared.ts'].map((path) => ({
            path,
            sha: commit,
            size: sourceCode.length,
          })),
          readFile: async () => sourceCode,
        };
      },
    },
    extractor: {
      version: 'test-1',
      model: 'test-model',
      promptVersion: 'test-prompt',
      async extract() {
        state.analysisCalls++;
        const result = { complete: !state.partial, services: [structuredClone(state.document)] };
        await state.beforeReturn?.();
        return result;
      },
    },
  };
  return {
    state,
    services,
    advance() {
      state.commit = (++sequence).toString(16).padStart(40, '0');
    },
    async connect(branches = ['main']) {
      const response = await request('', {
        repository: `https://github.com/example/${randomUUID()}`,
        branches,
        services: [{ serviceId: 'things', root: 'src' }],
      });
      expect(response.status).toBe(202);
      return (await response.json()).connectionId as string;
    },
  };
}
function request(path: string, body?: unknown, token = 'reviewer-token') {
  return app.request(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function pending(connectionId: string, kind = 'initial') {
  return (
    await pool.query<RepositoryCandidate>(
      `SELECT * FROM repository_contract_candidates WHERE connection_id=$1 AND kind=$2 ORDER BY created_at DESC LIMIT 1`,
      [connectionId, kind],
    )
  ).rows[0]!;
}
async function accept(
  candidate: RepositoryCandidate,
  token = 'reviewer-token',
  hash = candidate.candidate_hash,
) {
  return request(
    `/candidates/${candidate.id}/accept`,
    { candidateHash: hash, acknowledgeQuestions: true },
    token,
  );
}
async function liveState() {
  const tables = [
    'environment_capability_observations',
    'environment_capability_version_observations',
    'workflow_approvals',
    'workflow_quarantines',
    'capability_execution_bindings',
  ];
  return Promise.all(
    tables.map(
      async (table) =>
        (await pool.query(`SELECT row_to_json(entry) AS value FROM ${table} entry`)).rows,
    ),
  );
}
async function setupAccepted() {
  const f = fixture();
  const id = await f.connect();
  expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('checked');
  const candidate = await pending(id);
  expect((await accept(candidate)).status).toBe(200);
  return { ...f, id, candidate };
}

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema: schemaName, lockValue: 274000 + process.pid });
  await pool.query(`INSERT INTO organizations(id) VALUES ('repository-org'),('other-org');
    INSERT INTO environments(organization_id,id,name,kind) VALUES ('repository-org','development','Development','development');
    INSERT INTO users(id,email,name) VALUES ('reviewer','reviewer@example.test','Reviewer'),('author','author@example.test','Author');
    INSERT INTO organization_memberships(organization_id,user_id,role) VALUES ('repository-org','reviewer','admin'),('repository-org','author','author')`);
}, 60000);
afterAll(async () => {
  await pool.end();
  const cleanup = new Pool({ connectionString: databaseUrl });
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  } finally {
    await cleanup.end();
  }
});

describe('public repository source review through the HTTP API', () => {
  it('persists progress while extraction runs, then links the completed result and team notification', async () => {
    const f = fixture();
    const id = await f.connect();
    expect((await request(`/${id}/notifications`, { environmentId: 'development' })).status).toBe(
      200,
    );
    const original = f.services.extractor.extract.bind(f.services.extractor);
    f.state.document.inventory = { operationIds: ['createThing'], workflowIds: ['create'] };
    f.services.extractor.extract = async (...args) => {
      await args[2]?.progress?.({
        phase: 'extracting',
        message: 'Reading the createThing handler.',
        operationsDrafted: 1,
        operationsDiscovered: 1,
        filesRead: 2,
        servicesFound: 1,
      });
      const listing = await (await request('')).json();
      const connection = listing.connections.find((entry: { id: string }) => entry.id === id);
      expect(connection.progress).toMatchObject({
        status: 'running',
        phase: 'extracting',
        operationsDrafted: 1,
        filesRead: 2,
      });
      expect(connection.progress.activity.at(-1).message).toBe('Reading the createThing handler.');
      expect((await request(`/${id}/check`, {})).status).toBe(202);
      expect(
        (await (await request('')).json()).connections.find(
          (entry: { id: string }) => entry.id === id,
        ).progress.status,
      ).toBe('running');
      return original(...args);
    };
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('checked');
    const history = await (await request(`/${id}/history`)).json();
    expect(history.runs[0]).toMatchObject({
      status: 'succeeded',
      progress: { status: 'succeeded', phase: 'complete', operationsDrafted: 1 },
    });
    expect(history.runs[0].candidate_id).toBe((await pending(id)).id);
    const notifications = await pool.query(
      'SELECT title,navigation_target FROM notifications WHERE navigation_target=$1',
      [`#/capabilities?repositoryConnection=${id}`],
    );
    expect(notifications.rows).toEqual([
      {
        title: 'Repository contracts are ready to review',
        navigation_target: `#/capabilities?repositoryConnection=${id}`,
      },
    ]);
    await checkGithubRepositoryUpdates(pool, id, f.services);
    expect(f.state.analysisCalls).toBe(1);
    expect(
      (
        await pool.query('SELECT 1 FROM notifications WHERE navigation_target=$1', [
          notifications.rows[0].navigation_target,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it('records an initial access failure without extraction and avoids repeated failure notices', async () => {
    const f = fixture();
    const id = await f.connect();
    await request(`/${id}/notifications`, { environmentId: 'development' });
    f.services.source.targets = async () => {
      throw new Error('This repository is either private or unreachable.');
    };
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('failed');
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('failed');
    expect(f.state.analysisCalls).toBe(0);
    const history = await (await request(`/${id}/history`)).json();
    expect(history.runs[0]).toMatchObject({
      status: 'failed',
      progress: {
        status: 'failed',
        phase: 'connecting',
        message: 'This repository is either private or unreachable.',
      },
    });
    expect(
      (
        await pool.query('SELECT 1 FROM notifications WHERE navigation_target=$1', [
          `#/capabilities?repositoryConnection=${id}`,
        ])
      ).rowCount,
    ).toBe(1);
    await request(`/${id}/check`, {});
    const connection = (await (await request('')).json()).connections.find(
      (entry: { id: string }) => entry.id === id,
    );
    expect(connection.progress.status).toBe('queued');
    expect(
      (await request(`/${id}/notifications`, { environmentId: 'development' }, 'author-token'))
        .status,
    ).toBe(403);
    expect(
      (await request(`/${id}/notifications`, { environmentId: 'missing-environment' })).status,
    ).toBe(404);
  });
  it('keeps a newer ingestion queued when an earlier attempt finishes', async () => {
    const f = fixture();
    const id = await f.connect();
    f.state.beforeReturn = async () => {
      expect((await request(`/${id}/ingest`, {})).status).toBe(202);
    };
    await checkGithubRepositoryUpdates(pool, id, f.services);
    const connection = (await (await request('')).json()).connections.find(
      (entry: { id: string }) => entry.id === id,
    );
    expect(connection.progress.status).toBe('queued');
    expect(connection.ingestion_requested).toBe(true);
    expect(connection.ingestion_generation).toBe(1);
    expect((await accept(await pending(id))).status).toBe(400);
  });
  it('preserves each branch result when one branch fails and another succeeds', async () => {
    const f = fixture();
    const id = await f.connect(['main', 'release']);
    const brokenCommit = 'e'.repeat(40);
    f.services.source.targets = async () => [
      { key: 'branch:main', branch: 'main', commit: brokenCommit, baseCommit: '' },
      { key: 'branch:release', branch: 'release', commit: f.state.commit, baseCommit: '' },
    ];
    const original = f.services.source.snapshot.bind(f.services.source);
    f.services.source.snapshot = async (...args) => {
      if (args[1] === brokenCommit) throw new Error('Unable to read the main branch source.');
      return original(...args);
    };
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('failed');
    const history = await (await request(`/${id}/history`)).json();
    expect(
      history.runs.find((run: { target_key: string }) => run.target_key === 'branch:main'),
    ).toMatchObject({ status: 'failed', progress: { status: 'failed', phase: 'connecting' } });
    expect(
      history.runs.find((run: { target_key: string }) => run.target_key === 'branch:release'),
    ).toMatchObject({ status: 'succeeded', progress: { status: 'succeeded', phase: 'complete' } });
    const connection = (await (await request('')).json()).connections.find(
      (entry: { id: string }) => entry.id === id,
    );
    expect(connection.progress).toMatchObject({
      status: 'failed',
      phase: 'connecting',
      targetKey: 'branch:main',
    });
  });
  it('discovers and reviews a service when intake contains only the repository and branches', async () => {
    const f = fixture();
    const response = await request('', {
      repository: `https://github.com/example/${randomUUID()}`,
      branches: ['main'],
    });
    expect(response.status).toBe(202);
    const { connectionId } = await response.json();
    expect(
      (
        await pool.query('SELECT services FROM github_repository_connections WHERE id=$1', [
          connectionId,
        ])
      ).rows[0].services,
    ).toEqual([]);
    f.state.document.sourceRoot = 'src';
    f.state.document.serviceEvidence = [
      { path: 'src/route.ts', startLine: 1, endLine: 1, quote: 'export function handler(request)' },
    ];
    expect((await checkGithubRepositoryUpdates(pool, connectionId, f.services)).status).toBe(
      'checked',
    );
    const candidate = await pending(connectionId);
    expect(candidate.documents[0]).toMatchObject({ serviceId: 'things', sourceRoot: 'src' });
    expect((await accept(candidate)).status).toBe(200);
    expect(await readAcceptedRepositoryContracts(pool, connectionId, 'main')).toHaveLength(1);
  });

  it('persists interrupted findings for the same target and isolates extractor revisions', async () => {
    const f = fixture();
    const id = await f.connect();
    let saved: RepositoryAnalysisMemory | undefined;
    let observed: unknown;
    let interrupted = true;
    f.services.extractor.extract = async (snapshot, _accepted, context) => {
      observed = context?.previous;
      saved = createRepositoryAnalysisWorkspace(snapshot).memory({ complete: false, services: [] });
      await context?.checkpoint?.(saved);
      if (interrupted)
        throw new RepositoryExtractionError('Fake provider interrupted', { complete: false });
      return { complete: true, services: [f.state.document] };
    };
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('failed');
    expect(observed).toBeUndefined();
    const run = (
      await pool.query(
        'SELECT analysis_memory FROM repository_analysis_runs WHERE connection_id=$1',
        [id],
      )
    ).rows[0];
    expect(run.analysis_memory).toEqual(saved);
    interrupted = false;
    await pool.query('UPDATE repository_analysis_runs SET retry_at=now() WHERE connection_id=$1', [
      id,
    ]);
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('checked');
    expect(observed).toEqual(run.analysis_memory);
    f.services.extractor.version = 'different-extractor';
    f.advance();
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('checked');
    expect(observed).toBeUndefined();
  });

  it.each([
    { mode: 'returned', draft: [] },
    { mode: 'interrupted', draft: 'An unfinished generated document' },
  ])('retains $mode malformed draft data in a failed run', async ({ mode, draft }) => {
    const f = fixture();
    const id = await f.connect();
    const before = await liveState();
    f.services.extractor.extract = async () => {
      if (mode === 'interrupted') throw new RepositoryExtractionError('Model disconnected', draft);
      return draft;
    };
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe('failed');
    const run = (
      await pool.query('SELECT * FROM repository_analysis_runs WHERE connection_id=$1', [id])
    ).rows[0];
    expect(run.status).toBe('failed');
    expect(run.generated_documents).toEqual(draft);
    expect(run.document_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await pending(id)).toBeUndefined();
    expect(await liveState()).toEqual(before);
  });

  it('requires an explicit new ingestion to publish API additions and description edits', async () => {
    const f = await setupAccepted();
    f.advance();
    const document = JSON.parse(JSON.stringify(f.state.document.openapi));
    document.paths['/things'].post.summary = 'Reviewed replacement summary';
    document.paths['/extra'] = {
      get: {
        operationId: 'getExtra',
        summary: 'Get extra',
        description: 'Returns an extra response',
        responses: { '200': { description: 'Success' } },
      },
    };
    f.state.document.openapi = document;
    f.state.document.evidence.push({ ...f.state.document.evidence[0]!, operationId: 'getExtra' });
    await checkGithubRepositoryUpdates(pool, f.id, f.services);
    expect(await pending(f.id, 'periodic')).toBeUndefined();
    expect(
      Object.keys(
        (await readAcceptedRepositoryContracts(pool, f.id, 'main'))[0]!.capability_versions,
      ),
    ).toEqual(['createThing']);
    expect((await request(`/${f.id}/ingest`, {})).status).toBe(202);
    await checkGithubRepositoryUpdates(pool, f.id, f.services);
    const candidate = await pending(f.id);
    expect((await accept(candidate)).status).toBe(200);
    const accepted = (await readAcceptedRepositoryContracts(pool, f.id, 'main'))[0]!;
    expect(Object.keys(accepted.capability_versions).sort()).toEqual(['createThing', 'getExtra']);
    expect(JSON.stringify(accepted.openapi)).toContain('Reviewed replacement summary');
  });

  it('supersedes a proposed update when the branch returns to an already checked commit', async () => {
    const f = await setupAccepted();
    const original = f.state.commit;
    await checkGithubRepositoryUpdates(pool, f.id, f.services);
    f.advance();
    const document = JSON.parse(JSON.stringify(f.state.document.openapi));
    document.paths['/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name.minLength = 3;
    f.state.document.openapi = document;
    await checkGithubRepositoryUpdates(pool, f.id, f.services);
    const candidate = await pending(f.id, 'periodic');
    expect(candidate.status).toBe('review');
    f.state.commit = original;
    await checkGithubRepositoryUpdates(pool, f.id, f.services);
    expect((await accept(candidate)).status).toBe(400);
    expect((await pending(f.id, 'periodic')).status).toBe('superseded');
  });
  it('keeps multiple services and explicitly selected branches independent', async () => {
    const f = fixture();
    const second = extractedService('billing');
    f.services.extractor.extract = async () => ({
      complete: true,
      services: [extractedService(), second],
    });
    f.services.source.targets = async () => [
      { key: 'branch:main', branch: 'main', commit: 'a'.repeat(40), baseCommit: '' },
      { key: 'branch:release', branch: 'release', commit: 'b'.repeat(40), baseCommit: '' },
    ];
    const response = await request('', {
      repository: `https://github.com/example/${randomUUID()}`,
      branches: ['main', 'release'],
      services: [
        { serviceId: 'things', root: 'src' },
        { serviceId: 'billing', root: 'src' },
      ],
    });
    const id = (await response.json()).connectionId as string;
    await checkGithubRepositoryUpdates(pool, id, f.services);
    const candidates = (
      await pool.query<RepositoryCandidate>(
        'SELECT * FROM repository_contract_candidates WHERE connection_id=$1 ORDER BY branch',
        [id],
      )
    ).rows;
    expect(candidates).toHaveLength(2);
    for (const candidate of candidates) expect((await accept(candidate)).status).toBe(200);
    expect(await readAcceptedRepositoryContracts(pool, id, 'main')).toHaveLength(2);
    expect(await readAcceptedRepositoryContracts(pool, id, 'release')).toHaveLength(2);
    expect(
      (await readCapabilityArchitecture(pool, 'repository-org', `github:${id}:main`)).workflows.map(
        (workflow) => workflow.workflowId,
      ),
    ).toEqual(['billing:create', 'things:create']);
    expect(
      (
        await pool.query(
          'SELECT 1 FROM capability_architecture_versions WHERE source_key=ANY($1::text[])',
          [[`github:${id}:main`, `github:${id}:release`]],
        )
      ).rowCount,
    ).toBe(4);
    const foreign = await app.request(
      `/v1/organizations/other-org/repositories/candidates/${candidates[0]!.id}`,
      { headers: { authorization: 'Bearer reviewer-token' } },
    );
    expect(foreign.status).toBe(403);
  });

  it('rejects edits to a candidate even when an old approval hash is supplied', async () => {
    const f = fixture();
    const id = await f.connect();
    await checkGithubRepositoryUpdates(pool, id, f.services);
    const candidate = await pending(id);
    await pool.query(
      `UPDATE repository_contract_candidates SET documents=jsonb_set(documents,'{0,openapi,info,title}','"Changed after review"') WHERE id=$1`,
      [candidate.id],
    );
    const response = await accept(candidate);
    expect(response.status).toBe(400);
    expect(await readAcceptedRepositoryContracts(pool, id, 'main')).toEqual([]);
  });
  it('requires an authorized person and approval for the exact candidate before catalog publication', async () => {
    const f = fixture();
    const id = await f.connect();
    const before = await liveState();
    await checkGithubRepositoryUpdates(pool, id, f.services);
    const candidate = await pending(id);
    expect(await readAcceptedRepositoryContracts(pool, id, 'main')).toEqual([]);
    expect((await accept(candidate, 'author-token')).status).toBe(403);
    expect((await accept(candidate, 'reviewer-token', 'f'.repeat(64))).status).toBe(400);
    expect((await request('', undefined, 'unknown')).status).toBe(403);
    expect((await accept(candidate)).status).toBe(200);
    expect((await accept(candidate)).status).toBe(400);
    expect(await liveState()).toEqual(before);
    const stored = (
      await pool.query(
        `SELECT evidence_kind,path,generated_candidate_id FROM source_documents WHERE generated_candidate_id=$1`,
        [candidate.id],
      )
    ).rows[0];
    expect(stored).toEqual({
      evidence_kind: 'atlas-generated',
      path: null,
      generated_candidate_id: candidate.id,
    });
    expect(
      (await readCapabilityArchitecture(pool, 'repository-org', `github:${id}:main`)).workflows[0]
        ?.workflowId,
    ).toBe('create');
  });
  it('retains descriptions, Arazzo and version IDs for wording, routing, auth and new-operation changes', async () => {
    const f = await setupAccepted();
    const accepted = await readAcceptedRepositoryContracts(pool, f.id, 'main');
    f.advance();
    const document = JSON.parse(JSON.stringify(f.state.document.openapi));
    document.paths['/things'].post.summary = 'An AI rewrite';
    document.paths['/things'].post.description = 'More AI words';
    document.paths['/elsewhere'] = { put: document.paths['/things'].post };
    delete document.paths['/things'];
    document.paths['/elsewhere'].put.security = [{ token: [] }];
    document.components = { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } };
    f.state.document.openapi = document;
    f.state.document.arazzo = {
      ...f.state.document.arazzo,
      info: { title: 'Rewritten recipe', version: '2' },
    };
    expect((await checkGithubRepositoryUpdates(pool, f.id, f.services)).status).toBe('checked');
    expect(await readAcceptedRepositoryContracts(pool, f.id, 'main')).toEqual(accepted);
    expect(await pending(f.id, 'periodic')).toBeUndefined();
    const calls = f.state.analysisCalls;
    await checkGithubRepositoryUpdates(pool, f.id, f.services);
    expect(f.state.analysisCalls).toBe(calls);
  });
  it('previews shared-validator contract changes, reports workflow steps, and publishes only the reviewed branch changes', async () => {
    const f = await setupAccepted();
    const accepted = (await readAcceptedRepositoryContracts(pool, f.id, 'main'))[0]!;
    const oldVersion = accepted.capability_versions.createThing!;
    await pool.query(
      `INSERT INTO workflow_versions(organization_id,workflow_version_id) VALUES ('repository-org',$1)`,
      [f.id],
    );
    await pool.query(
      `INSERT INTO workflow_capability_dependencies(organization_id,workflow_version_id,step_id,capability_version_id) VALUES ('repository-org',$1,'create',$2)`,
      [f.id, oldVersion],
    );
    const before = await liveState();
    const document = JSON.parse(JSON.stringify(f.state.document.openapi));
    document.paths['/things'].post.requestBody.content[
      'application/json'
    ].schema.properties.name.minLength = 5;
    document.paths['/things'].post.summary = 'Do not accept this wording';
    f.state.document.openapi = document;
    const prCommit = 'b'.repeat(40);
    f.state.pulls = [
      { key: 'pr:7', branch: 'main', commit: prCommit, baseCommit: f.state.commit, pullRequest: 7 },
    ];
    await checkGithubRepositoryUpdates(pool, f.id, f.services);
    const preview = await pending(f.id, 'preview');
    expect(preview.changes[0]!.affectedWorkflows).toContainEqual({
      workflowVersionId: f.id,
      stepId: 'create',
    });
    expect((await accept(preview)).status).toBe(400);
    expect(
      (await readAcceptedRepositoryContracts(pool, f.id, 'main'))[0]!.capability_versions
        .createThing,
    ).toBe(oldVersion);
    f.advance();
    f.state.pulls = [];
    await checkGithubRepositoryUpdates(pool, f.id, f.services);
    const candidate = await pending(f.id, 'periodic');
    expect(candidate.changes[0]!.operationId).toBe('createThing');
    expect((await accept(candidate)).status).toBe(200);
    const updated = (await readAcceptedRepositoryContracts(pool, f.id, 'main'))[0]!;
    expect(updated.capability_versions.createThing).not.toBe(oldVersion);
    expect(JSON.stringify(updated.openapi)).toContain('Approved summary');
    expect(JSON.stringify(updated.openapi)).not.toContain('Do not accept');
    expect(updated.arazzo).toEqual(accepted.arazzo);
    expect(await liveState()).toEqual(before);
    expect(
      (
        await pool.query('SELECT 1 FROM capability_versions WHERE capability_version_id=$1', [
          oldVersion,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT 1 FROM capability_architecture_versions WHERE source_key=$1', [
          `github:${f.id}:main`,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it('retains last successful results on fetch failure, partial analysis and unmatched operations', async () => {
    const f = await setupAccepted();
    const baseline = await readAcceptedRepositoryContracts(pool, f.id, 'main');
    const live = await liveState();
    f.state.fail = true;
    expect((await checkGithubRepositoryUpdates(pool, f.id, f.services)).status).toBe('failed');
    f.state.fail = false;
    f.advance();
    f.state.partial = true;
    expect((await checkGithubRepositoryUpdates(pool, f.id, f.services)).status).toBe('failed');
    f.state.partial = false;
    f.advance();
    const document = JSON.parse(JSON.stringify(f.state.document.openapi));
    document.paths['/things'].post.operationId = 'unmatched';
    f.state.document.openapi = document;
    f.state.document.evidence = f.state.document.evidence.map((evidence) => ({
      ...evidence,
      operationId: 'unmatched',
    }));
    f.state.document.arazzo = null;
    expect((await checkGithubRepositoryUpdates(pool, f.id, f.services)).status).toBe('failed');
    expect(await readAcceptedRepositoryContracts(pool, f.id, 'main')).toEqual(baseline);
    expect(await liveState()).toEqual(live);
    const history = await request(`/${f.id}/history`);
    expect(
      (await history.json()).runs.filter((run: { status: string }) => run.status === 'failed')
        .length,
    ).toBe(3);
  });
  it('serializes duplicate runs and prevents a moved branch from replacing newer results', async () => {
    const f = fixture();
    const id = await f.connect();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.beforeReturn = async () => {
      entered();
      await waiting;
    };
    const slow = checkGithubRepositoryUpdates(pool, id, f.services);
    await started;
    expect((await checkGithubRepositoryUpdates(pool, id, f.services)).status).toBe(
      'already-running',
    );
    f.advance();
    release();
    expect((await slow).targets[0]?.status).toBe('outdated');
    expect(await pending(id)).toBeUndefined();
    f.state.beforeReturn = undefined;
    await checkGithubRepositoryUpdates(pool, id, f.services);
    const candidate = await pending(id);
    await checkGithubRepositoryUpdates(pool, id, f.services);
    expect(
      (
        await pool.query('SELECT 1 FROM repository_contract_candidates WHERE connection_id=$1', [
          id,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await accept(candidate)).status).toBe(200);
  });
});
