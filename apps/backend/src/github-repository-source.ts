import { z } from 'zod';

const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const repositoryUnavailableMessage = 'This repository is either private or unreachable.';
export const repositoryServiceSchema = z
  .object({
    serviceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/),
    root: z
      .string()
      .refine(
        (path) =>
          path === '.' ||
          (!path.startsWith('/') &&
            !path.includes('\\') &&
            !path.split('/').some((part) => !part || part === '..' || part === '.')),
        'Use a repository-relative service directory',
      ),
  })
  .strict();
export const githubConnectionSchema = z
  .object({
    organizationId: z.string().min(1),
    repository: z.string().transform((value) => publicGithubRepository(value).url),
    branches: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .refine(
            (branch) =>
              !/[\s~^:?*[\\]/.test(branch) &&
              !branch.includes('..') &&
              !branch.startsWith('/') &&
              !branch.endsWith('/'),
            'Invalid branch name',
          ),
      )
      .min(1)
      .max(20),
    services: z.array(repositoryServiceSchema).max(20).default([]),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (
      new Set(input.branches).size !== input.branches.length ||
      new Set(input.services.map(({ serviceId }) => serviceId)).size !== input.services.length
    )
      ctx.addIssue({ code: 'custom', message: 'Branches and service names must be unique' });
  });

export type RepositoryService = z.infer<typeof repositoryServiceSchema>;
export interface RepositoryFile {
  path: string;
  sha: string;
  size: number;
}
export interface RepositorySnapshot {
  repository: string;
  commit: string;
  services: RepositoryService[];
  files: RepositoryFile[];
  // Track dependency versions without sending lockfile contents to the model.
  dependencyFiles?: RepositoryFile[];
  readFile(path: string): Promise<string>;
}
export interface RepositoryTarget {
  key: string;
  branch: string;
  commit: string;
  baseCommit: string;
  pullRequest?: number;
}
export interface GithubRepositorySource {
  targets(repository: string, branches: string[]): Promise<RepositoryTarget[]>;
  snapshot(
    repository: string,
    commit: string,
    services: RepositoryService[],
  ): Promise<RepositorySnapshot>;
}

export function publicGithubRepository(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Use a public https://github.com/owner/repository URL');
  const match = /^\/([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.pathname);
  if (!match || match[2] === '.' || match[2] === '..')
    throw new Error('Use a GitHub repository URL, without a file or branch path');
  return {
    owner: match[1]!.toLowerCase(),
    name: match[2]!.toLowerCase(),
    url: `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`,
  };
}

export function createGithubRepositorySource(
  options: { token?: string; fetch?: typeof fetch } = {},
): GithubRepositorySource {
  const fetcher = options.fetch ?? fetch;
  async function request(
    repository: string,
    suffix: string,
    notFoundMessage?: string,
  ): Promise<unknown> {
    const { owner, name } = publicGithubRepository(repository);
    const response = await fetcher(`https://api.github.com/repos/${owner}/${name}${suffix}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'Atlas-repository-contracts',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    }).catch((cause: unknown) => {
      throw new Error(repositoryUnavailableMessage, { cause });
    });
    if (!response.ok) {
      if (response.status === 404 && notFoundMessage) throw new Error(notFoundMessage);
      throw new Error(
        `GitHub returned HTTP ${response.status}${response.status === 403 || response.status === 429 ? '; check the GitHub rate limit and retry later' : ''}`,
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 16_000_000)
      throw new Error('GitHub response exceeds the analysis limit');
    return JSON.parse(text) as unknown;
  }
  async function requirePublic(repository: string) {
    const metadata = z
      .object({ private: z.literal(false), visibility: z.literal('public') })
      .safeParse(await request(repository, '', repositoryUnavailableMessage));
    if (!metadata.success) throw new Error(repositoryUnavailableMessage);
  }
  return {
    async targets(repository, branches) {
      await requirePublic(repository);
      const { owner, name } = publicGithubRepository(repository);
      const targets: RepositoryTarget[] = [];
      for (const branch of branches) {
        const ref = z
          .object({ object: z.object({ sha: shaSchema, type: z.literal('commit') }) })
          .parse(
            await request(
              repository,
              `/git/ref/heads/${encodeURIComponent(branch)}`,
              `GitHub returned HTTP 404: Branch "${branch}" was not found in ${owner}/${name}. Check the branch name.`,
            ),
          );
        targets.push({ key: `branch:${branch}`, branch, commit: ref.object.sha, baseCommit: '' });
      }
      for (let page = 1; ; page++) {
        if (page > 20) throw new Error('Too many open pull requests to finish the check');
        const pulls = z
          .array(
            z.object({
              number: z.number().int(),
              base: z.object({ ref: z.string(), sha: shaSchema }),
              head: z.object({ sha: shaSchema }),
            }),
          )
          .parse(await request(repository, `/pulls?state=open&per_page=100&page=${page}`));
        for (const pull of pulls)
          if (branches.includes(pull.base.ref))
            targets.push({
              key: `pr:${pull.number}`,
              branch: pull.base.ref,
              commit: pull.head.sha,
              baseCommit: pull.base.sha,
              pullRequest: pull.number,
            });
        if (pulls.length < 100) break;
      }
      return targets;
    },
    async snapshot(repository, commit, services) {
      shaSchema.parse(commit);
      await requirePublic(repository);
      const tree = z
        .object({
          truncated: z.literal(false),
          tree: z.array(
            z.object({
              path: z.string(),
              mode: z.string(),
              type: z.string(),
              sha: shaSchema,
              size: z.number().optional(),
            }),
          ),
        })
        .safeParse(await request(repository, `/git/trees/${commit}?recursive=1`));
      if (!tree.success) throw new Error('GitHub did not return a complete repository tree');
      const files = tree.data.tree
        .filter(
          (entry) =>
            entry.type === 'blob' &&
            ['100644', '100755'].includes(entry.mode) &&
            /\.(?:[cm]?[jt]sx?|json|ya?ml|md)$/i.test(entry.path) &&
            !/(^|\/)(?:node_modules|dist|build|vendor|\.git)\//.test(entry.path) &&
            !/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(entry.path),
        )
        .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 }));
      if (files.length > 2500)
        throw new Error('Repository exceeds the 2,500 source-file analysis limit');
      if (!files.some((file) => /\.[cm]?[jt]sx?$/.test(file.path)))
        throw new Error('No JavaScript or TypeScript source found in this repository');
      for (const service of services)
        if (
          !files.some(
            (file) =>
              (service.root === '.' || file.path.startsWith(`${service.root}/`)) &&
              /\.[cm]?[jt]sx?$/.test(file.path),
          )
        )
          throw new Error(`No JavaScript or TypeScript source found in ${service.root}`);
      const cache = new Map<string, Promise<string>>();
      let loadedBytes = 0;
      return {
        repository,
        commit,
        services,
        files,
        dependencyFiles: tree.data.tree
          .filter(
            (entry) =>
              entry.type === 'blob' &&
              ['100644', '100755'].includes(entry.mode) &&
              /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(
                entry.path,
              ) &&
              !/(^|\/)(?:node_modules|dist|build|vendor|\.git)\//.test(entry.path),
          )
          .map((entry) => ({ path: entry.path, sha: entry.sha, size: entry.size ?? 0 })),
        readFile(path) {
          const file = files.find((entry) => entry.path === path);
          if (!file)
            return Promise.reject(
              new Error('File is not a supported regular source file in this commit'),
            );
          if (!cache.has(path)) {
            if (file.size > 750_000 || loadedBytes + file.size > 12_000_000)
              return Promise.reject(new Error('Repository source exceeds the analysis size limit'));
            loadedBytes += file.size;
            cache.set(
              path,
              request(repository, `/git/blobs/${file.sha}`).then((raw) => {
                const blob = z
                  .object({ encoding: z.literal('base64'), content: z.string(), sha: shaSchema })
                  .parse(raw);
                if (blob.sha !== file.sha)
                  throw new Error('GitHub returned a different source file');
                const text = Buffer.from(blob.content, 'base64').toString('utf8');
                if (text.includes('\0')) throw new Error('Binary files cannot be analyzed');
                return text;
              }),
            );
          }
          return cache.get(path)!;
        },
      };
    },
  };
}

export const readRepositorySnapshot = (
  source: GithubRepositorySource,
  repository: string,
  commit: string,
  services: RepositoryService[],
) => source.snapshot(repository, commit, services);
