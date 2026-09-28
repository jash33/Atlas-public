import { describe, expect, it } from 'vite-plus/test';
import {
  createGithubRepositorySource,
  githubConnectionSchema,
  publicGithubRepository,
} from './github-repository-source.js';

const commit = 'a'.repeat(40);
const blob = 'b'.repeat(40);
describe('public GitHub source reader', () => {
  it('accepts a connection without customer-supplied services or directories', () => {
    const connection = githubConnectionSchema.parse({
      organizationId: 'org',
      repository: 'https://github.com/example/api',
      branches: ['main'],
    });
    expect(connection.services).toEqual([]);
  });
  it('requires explicit branches and repository-relative service roots', () => {
    expect(() =>
      githubConnectionSchema.parse({
        organizationId: 'org',
        repository: 'https://github.com/example/api',
        branches: [],
        services: [{ serviceId: 'api', root: '.' }],
      }),
    ).toThrow('Too small');
    expect(() => publicGithubRepository('https://github.com@example.test/repo/api')).toThrow(
      'Use a public',
    );
    expect(() => publicGithubRepository('https://github.com/example/api/tree/main')).toThrow(
      'without a file or branch',
    );
    expect(publicGithubRepository('https://github.com/example/api.git').url).toBe(
      'https://github.com/example/api',
    );
  });
  it('pins reads to a commit and follows only explicitly selected branches and their PRs', async () => {
    const requests: string[] = [];
    const source = createGithubRepositorySource({
      fetch: async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        requests.push(url);
        expect(init?.redirect).toBe('error');
        if (url.endsWith('/repos/example/api'))
          return Response.json({ private: false, visibility: 'public' });
        if (url.includes('/git/ref/heads/'))
          return Response.json({ object: { sha: commit, type: 'commit' } });
        if (url.includes('/pulls?'))
          return Response.json([
            { number: 1, base: { ref: 'main', sha: commit }, head: { sha: blob } },
            { number: 2, base: { ref: 'untracked', sha: commit }, head: { sha: blob } },
          ]);
        if (url.includes('/git/trees/'))
          return Response.json({
            truncated: false,
            tree: [
              { path: 'src/app.ts', mode: '100644', type: 'blob', sha: blob, size: 12 },
              { path: 'src/link.ts', mode: '120000', type: 'blob', sha: blob, size: 10 },
              { path: 'pnpm-lock.yaml', mode: '100644', type: 'blob', sha: blob, size: 900000 },
            ],
          });
        if (url.endsWith(`/git/blobs/${blob}`))
          return Response.json({
            sha: blob,
            encoding: 'base64',
            content: Buffer.from('export const app = 1;').toString('base64'),
          });
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    const targets = await source.targets('https://github.com/example/api', ['main']);
    expect(targets.map((target) => target.key)).toEqual(['branch:main', 'pr:1']);
    const snapshot = await source.snapshot('https://github.com/example/api', commit, [
      { serviceId: 'api', root: 'src' },
    ]);
    expect(await snapshot.readFile('src/app.ts')).toContain('export const');
    await expect(snapshot.readFile('src/link.ts')).rejects.toThrow('regular source file');
    await expect(snapshot.readFile('pnpm-lock.yaml')).rejects.toThrow('regular source file');
    expect(snapshot.dependencyFiles).toEqual([{ path: 'pnpm-lock.yaml', sha: blob, size: 900000 }]);
    expect(requests.some((url) => url.includes(`/git/trees/${commit}`))).toBe(true);
  });
  it('rejects private repositories and truncated trees without analyzing partial files', async () => {
    const privateSource = createGithubRepositorySource({
      fetch: async () => Response.json({ private: true, visibility: 'private' }),
    });
    await expect(
      privateSource.targets('https://github.com/example/private', ['main']),
    ).rejects.toThrow(new Error('This repository is either private or unreachable.'));
    const partial = createGithubRepositorySource({
      fetch: async (input) =>
        Response.json(
          (input instanceof Request ? input.url : input.toString()).includes('/git/trees/')
            ? { truncated: true, tree: [] }
            : { private: false, visibility: 'public' },
        ),
    });
    await expect(
      partial.snapshot('https://github.com/example/api', commit, [{ serviceId: 'api', root: '.' }]),
    ).rejects.toThrow('complete repository tree');
  });
  it('explains that a repository 404 can mean the repository is not public', async () => {
    const requests: string[] = [];
    const source = createGithubRepositorySource({
      fetch: async (input) => {
        requests.push(input instanceof Request ? input.url : input.toString());
        return Response.json({ message: 'Not Found' }, { status: 404 });
      },
    });
    await expect(source.targets('https://github.com/example/api', ['main'])).rejects.toThrow(
      new Error('This repository is either private or unreachable.'),
    );
    expect(requests).toEqual(['https://api.github.com/repos/example/api']);
  });
  it('uses the repository access message when GitHub cannot be reached', async () => {
    const source = createGithubRepositorySource({
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(source.targets('https://github.com/example/api', ['main'])).rejects.toThrow(
      new Error('This repository is either private or unreachable.'),
    );
  });
  it('identifies a missing selected branch after confirming public access', async () => {
    const requests: string[] = [];
    const source = createGithubRepositorySource({
      fetch: async (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        requests.push(url);
        return url.endsWith('/repos/example/api')
          ? Response.json({ private: false, visibility: 'public' })
          : Response.json({ message: 'Not Found' }, { status: 404 });
      },
    });
    await expect(
      source.targets('https://github.com/example/api', ['release/next']),
    ).rejects.toThrow(
      'GitHub returned HTTP 404: Branch "release/next" was not found in example/api. Check the branch name.',
    );
    expect(requests).toEqual([
      'https://api.github.com/repos/example/api',
      'https://api.github.com/repos/example/api/git/ref/heads/release%2Fnext',
    ]);
  });
});
