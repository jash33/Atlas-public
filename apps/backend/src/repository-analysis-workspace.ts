import { z } from 'zod';
import type { RepositorySnapshot } from './github-repository-source.js';
import type { RepositoryProgressUpdate } from './repository-analysis-progress.js';
import {
  createRepositoryContractDraft,
  repositoryExtractionSchema,
  repositoryDraftProgress,
} from './repository-contract-builder.js';

const referenceSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: z.string().min(1).max(400),
  })
  .strict();
export const sourceFindingSchema = z
  .object({
    id: z.string().min(1).max(120),
    serviceId: z.string().min(1),
    operationIds: z.array(z.string().min(1)).max(250),
    summary: z.string().min(1).max(3000),
    evidence: z.array(referenceSchema).min(1).max(12),
    dependencyPaths: z.array(z.string().min(1)).min(1).max(250),
  })
  .strict();
const storedFindingSchema = sourceFindingSchema.extend({
  dependencies: z.record(z.string(), z.string()),
});
const memorySchema = z.object({
  version: z.literal(1),
  repository: z.string(),
  services: z.array(z.object({ serviceId: z.string(), root: z.string() })),
  files: z.record(z.string(), z.string()),
  findings: z.array(storedFindingSchema),
  operationSources: z.record(z.string(), z.array(z.string())),
  discoverySources: z.array(z.string()),
  componentSources: z.record(z.string(), z.array(z.string())),
  validated: z.boolean().default(false),
  documents: z.unknown(),
});
export type RepositoryAnalysisMemory = z.infer<typeof memorySchema>;
export interface RepositoryAnalysisContext {
  previous?: unknown;
  checkpoint?(memory: RepositoryAnalysisMemory): Promise<void>;
  progress?(update: RepositoryProgressUpdate): Promise<void>;
}
type Task = {
  kind: 'discovery' | 'operations' | 'workflows' | 'review' | 'validation';
  serviceId?: string;
  operationIds?: string[];
  workflowIds?: string[];
};
type Reference = z.infer<typeof referenceSchema>;
const operationKey = (serviceId: string, id: string) => JSON.stringify([serviceId, id]);
const object = (value: unknown) => z.record(z.string(), z.unknown()).parse(value);
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

export function sourceRangeWasRead(ranges: Array<[number, number]>, start: number, end: number) {
  let next = start;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from > next) break;
    next = Math.max(next, to + 1);
    if (next > end) return true;
  }
  return false;
}

/** Keeps source-backed notes and completed work outside the model conversation. */
export function createRepositoryAnalysisWorkspace(
  snapshot: RepositorySnapshot,
  previous?: unknown,
) {
  const files = Object.fromEntries(
    [...snapshot.files, ...(snapshot.dependencyFiles ?? [])].map((file) => [file.path, file.sha]),
  );
  const parsed = memorySchema.safeParse(previous);
  const prior =
    parsed.success &&
    parsed.data.repository === snapshot.repository &&
    parsed.data.services.length === snapshot.services.length &&
    new Set(parsed.data.services.map((service) => service.serviceId)).size ===
      snapshot.services.length &&
    parsed.data.services.every((service) =>
      snapshot.services.some(
        (selected) => selected.serviceId === service.serviceId && selected.root === service.root,
      ),
    )
      ? parsed.data
      : undefined;
  const changed = prior
    ? [...new Set([...Object.keys(prior.files), ...Object.keys(files)])].filter(
        (path) => prior.files[path] !== files[path],
      )
    : [];
  const tracked = new Set(
    prior
      ? [
          ...prior.discoverySources,
          ...Object.values(prior.operationSources).flat(),
          ...Object.values(prior.componentSources).flat(),
        ]
      : [],
  );
  // New files, removed files, configuration and untraced code may change routing or resolution.
  const broaden = changed.some(
    (path) =>
      !tracked.has(path) ||
      !files[path] ||
      !prior?.files[path] ||
      !/\.[cm]?[jt]sx?$/i.test(path) ||
      prior?.discoverySources.includes(path),
  );
  const readRanges = new Map<string, Array<[number, number]>>();
  const readFiles = new Set<string>();
  const taskReads = new Set<string>();
  const discoverySources = new Set<string>();
  const componentSources: Record<string, string[]> = {};
  const operationSources: Record<string, string[]> = {};
  const findings = new Map<string, z.infer<typeof storedFindingSchema>>();
  const inventories = new Set<string>();
  const reviews = new Set<string>();
  const reused = new Set<string>();
  let currentTask: Task = {
    kind: 'discovery',
    ...(snapshot.services[0] ? { serviceId: snapshot.services[0].serviceId } : {}),
  };
  let documents: unknown = createRepositoryContractDraft(snapshot.services.map((s) => s.serviceId));

  if (prior && !broaden) {
    for (const finding of prior.findings) {
      if (Object.entries(finding.dependencies).every(([path, sha]) => files[path] === sha)) {
        findings.set(finding.id, finding);
      }
    }
    const saved = repositoryExtractionSchema.safeParse(prior.documents);
    if (prior.validated && saved.success && saved.data.complete) {
      const draft = structuredClone(saved.data);
      draft.complete = false;
      for (const service of draft.services) {
        const sources = prior.componentSources[service.serviceId] ?? [];
        const changedComponents = sources.some((path) => changed.includes(path));
        componentSources[service.serviceId] = sources;
        if (changedComponents) delete service.openapi.components;
        const keep = new Set<string>();
        for (const item of Object.values(object(service.openapi.paths))) {
          const path = object(item);
          for (const [method, value] of Object.entries(path)) {
            if (!methods.has(method)) continue;
            const id = String(object(value).operationId);
            const key = operationKey(service.serviceId, id);
            const dependencies = prior.operationSources[key];
            if (
              service.dependenciesComplete &&
              !changedComponents &&
              dependencies?.length &&
              dependencies.every((file) => files[file] && !changed.includes(file))
            ) {
              keep.add(id);
              reused.add(key);
              operationSources[key] = dependencies;
            } else delete path[method];
          }
          // Mutate the original path object, not the validated copy returned by Zod.
          for (const method of Object.keys(object(item))) {
            if (methods.has(method) && !Object.hasOwn(path, method))
              delete (item as Record<string, unknown>)[method];
          }
        }
        service.evidence = service.evidence.filter((entry) => keep.has(entry.operationId));
        // Reconfirm route discovery and workflow relationships on every new analysis.
        service.arazzo = null;
        service.workflowEvidence = [];
        delete service.inventory;
        delete service.supportingDocuments;
      }
      documents = draft;
    }
  }

  function recordRead(path: string, startLine: number, endLine: number) {
    readRanges.set(path, [...(readRanges.get(path) ?? []), [startLine, endLine]]);
    readFiles.add(path);
    taskReads.add(path);
    if (currentTask.kind === 'discovery') discoverySources.add(path);
  }
  async function verify(reference: Reference, requireRead: boolean) {
    if (
      !files[reference.path] ||
      reference.endLine < reference.startLine ||
      (requireRead &&
        !sourceRangeWasRead(
          readRanges.get(reference.path) ?? [],
          reference.startLine,
          reference.endLine,
        ))
    ) {
      throw new Error('Read the exact supporting range before saving a finding');
    }
    const lines = (await snapshot.readFile(reference.path)).split('\n');
    if (
      reference.endLine > lines.length ||
      !lines
        .slice(reference.startLine - 1, reference.endLine)
        .join('\n')
        .includes(reference.quote)
    ) {
      throw new Error(`Source finding does not match ${reference.path}:${reference.startLine}`);
    }
  }
  function task(document: unknown, finishing: boolean): Task {
    if (finishing) return { kind: 'validation' };
    const progress = repositoryDraftProgress(document);
    for (const service of snapshot.services) {
      if (!inventories.has(service.serviceId))
        return { kind: 'discovery', serviceId: service.serviceId };
    }
    const draft = object(document);
    for (const service of z.array(objectSchema).parse(draft.services)) {
      const serviceId = String(service.serviceId);
      const inventory = z
        .object({ operationIds: z.array(z.string()), workflowIds: z.array(z.string()) })
        .parse(service.inventory);
      const saved = progress.find((entry) => entry.serviceId === serviceId)!;
      const operationIds = inventory.operationIds.filter((id) => !saved.operationIds.includes(id));
      if (operationIds.length) {
        if (
          currentTask.kind === 'operations' &&
          currentTask.serviceId === serviceId &&
          currentTask.operationIds?.some((id) => operationIds.includes(id))
        )
          return currentTask;
        return { kind: 'operations', serviceId, operationIds: operationIds.slice(0, 3) };
      }
      const workflowIds = inventory.workflowIds.filter((id) => !saved.workflowIds.includes(id));
      if (workflowIds.length) {
        if (
          currentTask.kind === 'workflows' &&
          currentTask.serviceId === serviceId &&
          currentTask.workflowIds?.some((id) => workflowIds.includes(id))
        )
          return currentTask;
        return { kind: 'workflows', serviceId, workflowIds: workflowIds.slice(0, 2) };
      }
      if (!reviews.has(serviceId)) return { kind: 'review', serviceId };
    }
    return { kind: 'validation' };
  }
  const objectSchema = z.record(z.string(), z.unknown());

  return {
    initialDocuments: documents,
    readRanges,
    reviews,
    recordRead,
    changedFiles: changed,
    async restoreEvidence() {
      const services = z.array(objectSchema).parse(object(documents).services);
      for (const service of services) {
        for (const reference of z.array(referenceSchema.passthrough()).parse(service.evidence)) {
          await verify(reference, false);
          recordRead(reference.path, reference.startLine, reference.endLine);
        }
      }
      taskReads.clear();
      discoverySources.clear();
    },
    async saveFinding(input: unknown) {
      const finding = sourceFindingSchema.parse(input);
      if (!snapshot.services.some((s) => s.serviceId === finding.serviceId))
        throw new Error('Unknown service');
      if (findings.has(finding.id) && findings.get(finding.id)!.serviceId !== finding.serviceId)
        throw new Error('Choose a distinct finding ID for each service');
      if (!findings.has(finding.id) && findings.size >= 250)
        throw new Error('At most 250 saved findings are allowed');
      for (const reference of finding.evidence) await verify(reference, true);
      const paths = [
        ...new Set([
          ...finding.dependencyPaths,
          ...taskReads,
          ...finding.evidence.map((r) => r.path),
        ]),
      ];
      for (const path of paths) {
        if (!files[path] || !readFiles.has(path))
          throw new Error(`Read finding dependency before saving: ${path}`);
      }
      findings.set(finding.id, {
        ...finding,
        dependencies: Object.fromEntries(paths.map((path) => [path, files[path]!])),
      });
      return { saved: finding.id };
    },
    async readFinding(id: string) {
      const finding = findings.get(id);
      if (!finding) throw new Error('Finding is unavailable or its supporting code changed');
      for (const reference of finding.evidence) {
        await verify(reference, false);
        recordRead(reference.path, reference.startLine, reference.endLine);
      }
      for (const path of Object.keys(finding.dependencies)) {
        readFiles.add(path);
        taskReads.add(path);
        if (currentTask.kind === 'discovery') discoverySources.add(path);
      }
      return finding;
    },
    listFindings(text: string, offset: number) {
      const matches = [...findings.values()].filter((finding) =>
        JSON.stringify(finding).includes(text),
      );
      return {
        total: matches.length,
        findings: matches
          .slice(offset, offset + 40)
          .map(({ id, serviceId, operationIds, summary }) => ({
            id,
            serviceId,
            operationIds,
            summary: summary.slice(0, 120),
          })),
      };
    },
    checkSection(name: string, input: unknown) {
      if (name !== 'write_operations') return;
      const args = object(input);
      if (!inventories.has(String(args.serviceId)))
        throw new Error(
          'Map the service with write_service_inventory before writing operation definitions',
        );
      if (currentTask.kind !== 'operations') return;
      for (const operation of z.array(objectSchema).parse(args.operations)) {
        const id = String(object(JSON.parse(String(operation.definition))).operationId);
        if (args.serviceId !== currentTask.serviceId || !currentTask.operationIds?.includes(id))
          throw new Error(
            `Complete the assigned operation group first: ${currentTask.operationIds?.join(', ')}`,
          );
      }
    },
    invalidateRevisedSources() {
      // Arbitrary corrections may change dependencies. Keep notes, but do not cache these operations.
      for (const key of Object.keys(operationSources)) delete operationSources[key];
    },
    sectionSaved(name: string, input: unknown, document: unknown) {
      const args = object(input);
      const serviceId = String(args.serviceId);
      if (name === 'write_service_inventory') {
        inventories.add(serviceId);
        const service = (document as { services: Array<Record<string, unknown>> }).services.find(
          (s) => s.serviceId === serviceId,
        )!;
        const ids = z
          .object({ operationIds: z.array(z.string()) })
          .parse(service.inventory).operationIds;
        const dropped = new Set<string>();
        for (const path of Object.values(
          (service.openapi as Record<string, Record<string, unknown>>).paths!,
        )) {
          for (const [method, value] of Object.entries(object(path))) {
            if (!methods.has(method)) continue;
            const id = String(object(value).operationId);
            const key = operationKey(serviceId, id);
            if (reused.has(key) && !ids.includes(id)) {
              delete (path as Record<string, unknown>)[method];
              delete operationSources[key];
              reused.delete(key);
              dropped.add(id);
            }
          }
        }
        service.evidence = z
          .array(objectSchema)
          .parse(service.evidence)
          .filter((e) => !dropped.has(String(e.operationId)));
      }
      if (name === 'write_service_review') reviews.add(serviceId);
      if (name === 'write_components')
        componentSources[serviceId] = [
          ...new Set([...(componentSources[serviceId] ?? []), ...taskReads]),
        ];
      if (name === 'write_operations') {
        const service = z
          .array(objectSchema)
          .parse(object(document).services)
          .find((entry) => entry.serviceId === serviceId)!;
        const evidence = z
          .array(z.object({ operationId: z.string(), path: z.string() }))
          .parse(service.evidence);
        for (const operation of z.array(objectSchema).parse(args.operations)) {
          const id = String(object(JSON.parse(String(operation.definition))).operationId);
          const key = operationKey(serviceId, id);
          operationSources[key] = [
            ...new Set([
              ...taskReads,
              ...evidence.filter((e) => e.operationId === id).map((e) => e.path),
            ]),
          ];
          reused.delete(key);
        }
      }
    },
    nextTask: task,
    startTask(next: Task) {
      currentTask = next;
      taskReads.clear();
    },
    context(document: unknown, next: Task, acceptedOperations: Record<string, string[]>) {
      let progress: ReturnType<typeof repositoryDraftProgress> = [];
      try {
        progress = repositoryDraftProgress(document);
      } catch {
        /* Retain malformed drafts for focused repair. */
      }
      const active = progress.find((service) => service.serviceId === next.serviceId);
      return {
        repository: snapshot.repository,
        commit: snapshot.commit,
        services: snapshot.services,
        task: next,
        acceptedOperationIds: next.serviceId ? (acceptedOperations[next.serviceId] ?? []) : [],
        progress: progress.map((service) => ({
          serviceId: service.serviceId,
          operationsSaved: service.operationIds.length,
          workflowsSaved: service.workflowIds.length,
        })),
        componentNames: active?.componentNames ?? [],
        fileCount: snapshot.files.length,
        files: snapshot.files.slice(0, 40).map(({ path }) => path),
        moreFiles: snapshot.files.length > 40,
        changedFiles: changed.slice(0, 80),
        moreChangedFiles: changed.length > 80,
        broadReviewRequired: broaden,
        previousInventory:
          prior && next.kind === 'discovery'
            ? repositoryExtractionSchema
                .safeParse(prior.documents)
                .data?.services.find((s) => s.serviceId === next.serviceId)?.inventory
            : undefined,
        findings: [...findings.values()]
          .filter(
            (f) =>
              (!next.serviceId || f.serviceId === next.serviceId) &&
              (!next.operationIds ||
                !f.operationIds.length ||
                f.operationIds.some((id) => next.operationIds!.includes(id))),
          )
          .map(({ id, operationIds, summary }) => ({
            id,
            operationIds,
            summary: summary.slice(0, 120),
          }))
          .slice(0, 80),
        instruction:
          'Complete the assigned task. Saved documents and findings remain available through inspection tools. Use list_files for more paths, list_source_findings to search notes, and read_source_finding for full notes. Save source-backed findings before a long investigation; conversation history is bounded. Follow unfamiliar and homegrown code; do not assume a validation library is required.',
      };
    },
    memory(document: unknown, validated = false): RepositoryAnalysisMemory {
      return {
        version: 1,
        repository: snapshot.repository,
        services: snapshot.services,
        files,
        findings: [...findings.values()],
        operationSources,
        discoverySources: [...new Set([...(prior?.discoverySources ?? []), ...discoverySources])],
        componentSources,
        validated,
        documents: document,
      };
    },
  };
}
