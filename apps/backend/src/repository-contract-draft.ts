import { z } from 'zod';

export const repositoryDraftRevisionSchema = z
  .object({
    changes: z
      .array(
        z.discriminatedUnion('op', [
          z.object({ op: z.literal('set'), path: z.string(), value: z.unknown() }).strict(),
          z.object({ op: z.literal('move'), from: z.string(), path: z.string() }).strict(),
          z.object({ op: z.literal('remove'), path: z.string() }).strict(),
        ]),
      )
      .max(200),
  })
  .strict();

export const repositoryDraftInspectionSchema = z.object({ path: z.string() }).strict();

function location(document: unknown, path: string) {
  if (!path.startsWith('/') || /~(?![01])/u.test(path))
    throw new Error('Draft changes require a JSON Pointer starting with /');
  const parts = path
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  let parent = document;
  for (const key of parts.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key))
      throw new Error(`Draft path does not exist: ${path}`);
    parent = (parent as Record<string, unknown>)[key];
  }
  if (!parent || typeof parent !== 'object') throw new Error(`Draft path does not exist: ${path}`);
  const key = parts.at(-1)!;
  if (Array.isArray(parent) && !/^(0|[1-9][0-9]*|-)$/u.test(key))
    throw new Error('A draft array path needs a valid index');
  return { parent: parent as Record<string, unknown>, key };
}

function take(document: unknown, path: string) {
  const { parent, key } = location(document, path);
  if (!Object.hasOwn(parent, key)) throw new Error(`Draft path does not exist: ${path}`);
  const value = parent[key];
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[key];
  return value;
}

function put(document: unknown, path: string, value: unknown, insert: boolean) {
  const { parent, key } = location(document, path);
  if (Array.isArray(parent)) {
    const index = key === '-' ? parent.length : Number(key);
    if (index > parent.length) throw new Error('Draft array changes cannot leave gaps');
    if (insert) parent.splice(index, 0, value);
    else parent[index] = value;
  } else {
    Object.defineProperty(parent, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/** Apply edits only to a copied draft; publication still requires all validation and review. */
export function reviseRepositoryContractDraft(document: unknown, input: unknown): unknown {
  if (JSON.stringify(input).length > 50000)
    throw new Error('Correct smaller sections, at most 50,000 characters per call');
  if (!document || typeof document !== 'object')
    throw new Error('Submit a draft before revising it');
  const { changes } = repositoryDraftRevisionSchema.parse(input);
  const draft = structuredClone(document);
  for (const change of changes) {
    if (change.op === 'remove') take(draft, change.path);
    else if (change.op === 'move') {
      if (change.path.startsWith(`${change.from}/`))
        throw new Error('A draft value cannot move inside itself');
      put(draft, change.path, take(draft, change.from), true);
    } else {
      if (!Object.hasOwn(change, 'value')) throw new Error('A set change needs a value');
      put(draft, change.path, change.value, false);
    }
  }
  return draft;
}

export function inspectRepositoryContractDraft(document: unknown, input: unknown) {
  const { path } = repositoryDraftInspectionSchema.parse(input);
  let value = document;
  if (path) {
    const { parent, key } = location(document, path);
    if (!Object.hasOwn(parent, key)) throw new Error(`Draft path does not exist: ${path}`);
    value = parent[key];
  }
  const json = JSON.stringify(value);
  return {
    path,
    ...(value && typeof value === 'object' ? { keys: Object.keys(value) } : {}),
    ...(json && json.length <= 20000
      ? { value }
      : { note: 'Inspect a child path for its contents.' }),
  };
}
