import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';
import type { Pool } from 'pg';

import { app, createApp } from './app.js';
import { PlanningTraceStore } from './planning-trace.js';
import type { PlannerModel } from './workflow-planning.js';

const draftPreflight = (origin: string) =>
  app.request('/v1/workflow-drafts', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });

describe('backend health API', () => {
  it('reports that the local shell is ready', async () => {
    const response = await app.request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      service: 'backend',
      status: 'ok',
    });
  });
});

describe('local console CORS', () => {
  it('allows the local Console to identify demo mode', async () => {
    const response = await app.request('/auth/session', {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(await response.json()).toEqual({ mode: 'demo' });
  });
  it('allows the Vite console when it lands on a fallback port', async () => {
    const response = await draftPreflight('http://127.0.0.1:5175');

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:5175');
  });

  it('still allows the documented localhost:5173 origin', async () => {
    const response = await draftPreflight('http://localhost:5173');

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('does not reflect a remote origin', async () => {
    const response = await draftPreflight('https://evil.example');

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('canonical environment API boundary', () => {
  it('rejects the retired environment identifier before any persistence work', async () => {
    let queryCount = 0;
    const pool = {
      query: () => {
        queryCount += 1;
        throw new Error('the retired environment request reached persistence');
      },
    } as unknown as Pool;
    const application = createApp(pool);

    const responses = await Promise.all([
      application.request(
        '/v1/capabilities?organizationId=org_atlas&environmentId=production-like',
      ),
      application.request(
        '/v1/organizations/org_atlas/environments/production-like/capabilities/capability_1/source-authority',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceRegistrationId: 'source_1' }),
        },
      ),
      application.request('/v1/capability-discoveries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production-like',
        }),
      }),
      application.request('/v1/capability-discoveries', {
        method: 'POST',
        body: JSON.stringify({
          organizationId: 'org_atlas',
          environmentId: 'production-like',
        }),
      }),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'environment-renamed',
        environmentId: 'production-like',
        replacementEnvironmentId: 'production',
      });
    }
    expect(queryCount).toBe(0);
  });

  it('does not treat retired-looking values inside opaque customer data as Atlas selectors', async () => {
    const application = createApp();

    const response = await application.request('/v1/opaque-document', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        environmentId: 'production',
        source: { example: { environmentId: 'production-like' } },
      }),
    });

    expect(response.status).toBe(404);
  });
});

describe('workflow planning traces', () => {
  it('returns a trace id and records the final API response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-app-planning-trace-'));
    const plannerModel: PlannerModel = {
      async extractIntent() {
        return {};
      },
      async draftWorkflow() {
        return {};
      },
      async repairWorkflow() {
        return {};
      },
    };
    const application = createApp(
      {} as Pool,
      { allowedHosts: [] },
      plannerModel,
      {
        async authorize() {
          return 'author';
        },
      },
      undefined,
      undefined,
      { planningTraceStore: new PlanningTraceStore(directory) },
    );

    try {
      const response = await application.request('/v1/workflow-drafts', {
        method: 'POST',
        headers: {
          authorization: 'Bearer route-test-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const traceId = response.headers.get('x-atlas-planning-trace-id');
      expect(traceId).toMatch(/^[0-9a-f-]{36}$/);
      const [file] = await readdir(directory);
      const contents = await readFile(join(directory, file!), 'utf8');
      expect(contents).not.toContain('route-test-secret');
      const records = contents
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map(({ kind }) => kind)).toEqual(['planning.started', 'planning.finished']);
      expect(records[1]).toMatchObject({
        traceId,
        httpStatus: 400,
        response: { error: 'invalid-planning-request' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
