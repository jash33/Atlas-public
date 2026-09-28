// Optional live acceptance check. Builds must have run before invoking this script.
import { readFile, writeFile } from 'node:fs/promises';
import { createGithubRepositorySource } from '../apps/backend/dist/github-repository-source.js';
import {
  createRepositoryContractExtractor,
  validateRepositoryExtraction,
} from '../apps/backend/dist/repository-contract-extraction.js';

const [repository, branch, serviceId, root, outputPath] = process.argv.slice(2);
if (!repository || !branch || !serviceId || !root || !outputPath) {
  throw new Error(
    'Usage: node tooling/analyze-repository.mjs REPOSITORY BRANCH SERVICE ROOT OUTPUT.json',
  );
}
async function secret(value, path) {
  return value || (path ? (await readFile(path, 'utf8')).trim() : undefined);
}
const apiKey = await secret(process.env.OPENAI_API_KEY, process.env.OPENAI_API_KEY_FILE);
const token = await secret(process.env.GITHUB_TOKEN, process.env.GITHUB_TOKEN_FILE);
const model = process.env.OPENAI_MODEL;
if (!apiKey || !model)
  throw new Error('Configure OPENAI_MODEL and OPENAI_API_KEY or OPENAI_API_KEY_FILE');
const source = createGithubRepositorySource(token ? { token } : {});
const target = (await source.targets(repository, [branch])).find(
  (entry) => entry.key === `branch:${branch}`,
);
if (!target) throw new Error('Tracked branch not found');
const snapshot = await source.snapshot(repository, target.commit, [{ serviceId, root }]);
console.log(`Analyzing ${repository} at ${target.commit}`);
const extractor = createRepositoryContractExtractor({ apiKey, model });
const documents = await extractor.extract(snapshot, {});
await writeFile(
  outputPath,
  JSON.stringify(
    {
      repository,
      commit: target.commit,
      extractorVersion: extractor.version,
      model,
      promptVersion: extractor.promptVersion,
      documents,
    },
    null,
    2,
  ) + '\n',
);
await validateRepositoryExtraction(documents, snapshot);
console.log(
  `Validated documents saved to ${outputPath}. Catalog publication still requires human review in Atlas.`,
);
