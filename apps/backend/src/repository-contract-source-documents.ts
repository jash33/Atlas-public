import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import type { RepositorySnapshot } from './github-repository-source.js';
import {
  repositoryExtractionSchema,
  workflowEvidenceSchema,
} from './repository-contract-builder.js';
import {
  normalizeRepositoryContract,
  extractRequestResponseContract,
} from './repository-contract-normalization.js';
import { canonicalJson } from './capability-versioning.js';

const objectSchema = z.record(z.string(), z.unknown());
export const verifiedDocumentsSchema = z
  .object({
    serviceId: z.string(),
    openapiPath: z.string().nullable(),
    arazzoPath: z.string().nullable(),
    verifiedAgainstCode: z.boolean(),
    verificationNotes: z.string().min(1),
    workflowEvidence: z.array(workflowEvidenceSchema),
  })
  .strict();

/** Reuse repository definitions only after the analyzer has traced their operations in code. */
export async function useVerifiedRepositoryDocuments(
  document: unknown,
  input: unknown,
  snapshot: RepositorySnapshot,
) {
  const request = verifiedDocumentsSchema.parse(input);
  if (!request.verifiedAgainstCode)
    throw new Error(
      'Inspect implementation and resolve document conflicts before reusing definitions',
    );
  if (!request.openapiPath && !request.arazzoPath)
    throw new Error('Choose an existing repository contract document');
  const draft = repositoryExtractionSchema.parse(structuredClone(document));
  const service = draft.services.find((entry) => entry.serviceId === request.serviceId);
  if (!service) throw new Error('Unknown configured service');
  const before = await normalizeRepositoryContract(
    service.serviceId,
    service.openapi,
    service.arazzo,
  );
  async function read(path: string) {
    const file = snapshot.files.find((entry) => entry.path === path);
    if (!file || !/\.(json|ya?ml)$/i.test(path))
      throw new Error('Choose a JSON or YAML document from this snapshot');
    const parsed = objectSchema.parse(parseYaml(await snapshot.readFile(path)));
    service!.supportingDocuments ??= [];
    service!.supportingDocuments.push({
      path,
      sha: file.sha,
      verificationNotes: request.verificationNotes,
    });
    return parsed;
  }
  const openapi = request.openapiPath ? await read(request.openapiPath) : service.openapi;
  const arazzo = request.arazzoPath ? await read(request.arazzoPath) : service.arazzo;
  const documented = await normalizeRepositoryContract(service.serviceId, openapi, arazzo);
  const missing = documented.operations.filter(
    (operation) =>
      !before.operations.some(
        (entry) => entry.identity.operationId === operation.identity.operationId,
      ),
  );
  if (missing.length)
    throw new Error(
      `Trace and write these operations before reusing their documents: ${missing.map((op) => op.identity.operationId).join(', ')}`,
    );
  const documentedIds = new Set(documented.operations.map((op) => op.identity.operationId));
  if (request.openapiPath) {
    const paths = objectSchema.parse(openapi.paths);
    const previousPaths = objectSchema.parse(service.openapi.paths);
    for (const operation of before.operations.filter(
      (op) => !documentedIds.has(op.identity.operationId),
    )) {
      const path = z.string().parse(operation.fragment.path);
      const method = z.string().parse(operation.fragment.method);
      const prior = objectSchema.parse(previousPaths[path]);
      const target = Object.hasOwn(paths, path) ? objectSchema.parse(paths[path]) : {};
      Object.defineProperty(target, method.toLowerCase(), {
        value: prior[method.toLowerCase()],
        enumerable: true,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(paths, path, {
        value: target,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    openapi.paths = paths;
    const previousComponents = objectSchema.parse(service.openapi.components ?? {});
    const components = objectSchema.parse(openapi.components ?? {});
    for (const [kind, definitions] of Object.entries(previousComponents)) {
      Object.defineProperty(components, kind, {
        value: {
          ...objectSchema.parse(definitions),
          ...objectSchema.parse(Object.hasOwn(components, kind) ? components[kind] : {}),
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (Object.keys(components).length) openapi.components = components;
    service.openapi = openapi;
  }
  if (request.arazzoPath) {
    service.arazzo = arazzo;
    service.workflowEvidence = request.workflowEvidence;
  }
  draft.complete = false;
  return draft;
}

/** Surface differences from an existing service document instead of silently losing its details. */
export async function findUnreviewedRepositoryDocumentDifferences(
  document: unknown,
  snapshot: RepositorySnapshot,
) {
  const draft = repositoryExtractionSchema.parse(document);
  const reviews: Array<{ serviceId: string; path: string; operationIds: string[] }> = [];
  for (const service of draft.services) {
    const root = snapshot.services.find((entry) => entry.serviceId === service.serviceId)!.root;
    const prefixes = new Set([
      root === '.' ? '' : `${root}/`,
      ...(snapshot.services.length === 1 ? [''] : []),
    ]);
    const paths = [...prefixes].flatMap((prefix) =>
      ['openapi.json', 'openapi.yaml', 'openapi.yml'].map((name) => prefix + name),
    );
    const current = await normalizeRepositoryContract(service.serviceId, service.openapi, null);
    for (const path of paths) {
      if (!snapshot.files.some((file) => file.path === path)) continue;
      const text = await snapshot.readFile(path);
      let expected: Awaited<ReturnType<typeof normalizeRepositoryContract>>;
      try {
        expected = await normalizeRepositoryContract(
          service.serviceId,
          objectSchema.parse(parseYaml(text)),
          null,
        );
      } catch {
        continue;
      } // Supporting files in another format do not prevent source-based extraction.
      const operationIds = expected.operations
        .filter((operation) => {
          const found = current.operations.find(
            (entry) => entry.identity.operationId === operation.identity.operationId,
          );
          return (
            found &&
            canonicalJson(extractRequestResponseContract(found.fragment)) !==
              canonicalJson(extractRequestResponseContract(operation.fragment))
          );
        })
        .map((operation) => operation.identity.operationId);
      const unreviewed = operationIds.filter(
        (id) =>
          !service.unresolvedQuestions.some(
            (question) => question.includes(path) && question.includes(id),
          ),
      );
      if (unreviewed.length)
        reviews.push({ serviceId: service.serviceId, path, operationIds: unreviewed });
    }
  }
  return reviews;
}
