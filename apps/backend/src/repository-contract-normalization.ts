import { z } from 'zod';

import { parseArazzoDocument } from './arazzo-document.js';
import { validateAndDiscoverCapabilities, type JsonObject } from './capability-documents.js';
import { canonicalJson, sha256 } from './capability-versioning.js';

const proseKeys = new Set([
  'description',
  'summary',
  'title',
  'example',
  'examples',
  'externalDocs',
  '$comment',
  'deprecated',
]);
const namedMaps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'schemas',
  'responses',
  'headers',
  'content',
  'references',
  'dependentSchemas',
  'securitySchemes',
  'security',
  'paths',
]);
const unordered = new Set(['required', 'enum', 'allOf', 'anyOf', 'oneOf']);
const objectSchema = z.record(z.string(), z.unknown());
export const asObject = (value: unknown): JsonObject => {
  objectSchema.parse(value);
  return value as JsonObject;
};
const pointerPart = (part: string) => part.replaceAll('~', '~0').replaceAll('/', '~1');

/** Keep property names (including names like "description") separate from schema annotations. */
function structured(
  value: unknown,
  descriptions: JsonObject,
  path = '',
  named = false,
  key = '',
): unknown {
  // JSON values inside const/default/enum are user data, not schema annotations.
  if (key === 'const' || key === 'default') return structuredClone(value);
  if (key === 'enum' && Array.isArray(value))
    return [...new Map(value.map((entry) => [canonicalJson(entry), entry])).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, entry]) => entry);
  if (Array.isArray(value)) {
    const entries = value.map((entry, index) =>
      structured(entry, descriptions, `${path}/${index}`, named),
    );
    const sorted =
      unordered.has(key) || (key === 'type' && entries.every((entry) => typeof entry === 'string'))
        ? [...new Map(entries.map((entry) => [canonicalJson(entry), entry])).entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, entry]) => entry)
        : entries;
    return key === 'type' && sorted.length === 1 ? sorted[0] : sorted;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, entry]) => {
      const nextPath = `${path}/${pointerPart(name)}`;
      if (!named && (proseKeys.has(name) || name.startsWith('x-'))) {
        descriptions[nextPath] = entry;
        return [];
      }
      if (
        !named &&
        ((name === 'required' && (entry === false || (Array.isArray(entry) && !entry.length))) ||
          (name === 'additionalProperties' && entry === true))
      )
        return [];
      return [
        [
          name,
          structured(
            entry,
            descriptions,
            nextPath,
            !named && namedMaps.has(name),
            named ? '' : name,
          ),
        ],
      ];
    }),
  );
}

function reference(document: JsonObject, ref: string): unknown {
  if (!ref.startsWith('#/')) throw new Error('Repository documents may only use local references');
  const value = ref
    .slice(2)
    .split('/')
    .reduce<unknown>((parent, key) => {
      const decoded = key.replaceAll('~1', '/').replaceAll('~0', '~');
      return parent && typeof parent === 'object' && Object.hasOwn(parent, decoded)
        ? (parent as JsonObject)[decoded]
        : undefined;
    }, document);
  if (value === undefined) throw new Error(`Unresolved contract reference: ${ref}`);
  return value;
}

function checkReferences(document: JsonObject, value: unknown = document): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value) && typeof (value as JsonObject).$ref === 'string')
    reference(document, (value as JsonObject).$ref as string);
  for (const child of Object.values(value)) checkReferences(document, child);
}

function resolve(value: unknown, references: JsonObject): JsonObject {
  const object = asObject(value);
  if (typeof object.$ref !== 'string') return object;
  const target = references[object.$ref];
  if (!target) throw new Error(`Missing reference ${object.$ref}`);
  const { $ref: _, ...siblings } = object;
  return { ...asObject(target), ...siblings };
}

function select(value: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
}

export interface RequestResponseContract extends JsonObject {
  parameters: JsonObject[];
  responses: JsonObject;
  references: JsonObject;
}

/** The only input to periodic comparison. Routing, authentication and prose never enter it. */
export function extractRequestResponseContract(fragment: JsonObject): RequestResponseContract {
  const operation = asObject(fragment.operation);
  const references = asObject(fragment.references ?? {});
  const parameterMap = new Map<string, JsonObject>();
  for (const raw of [
    ...z.array(objectSchema).parse(fragment.pathParameters ?? []),
    ...z.array(objectSchema).parse(operation.parameters ?? []),
  ]) {
    const parameter = resolve(raw, references);
    parameterMap.set(
      `${String(parameter.in)}:${String(parameter.name)}`,
      select(parameter, [
        'name',
        'in',
        'required',
        'allowEmptyValue',
        'style',
        'explode',
        'allowReserved',
        'schema',
        'content',
      ]),
    );
  }
  const responses = Object.fromEntries(
    Object.entries(asObject(operation.responses)).map(([status, raw]) => {
      const response = resolve(raw, references);
      const headers = Object.fromEntries(
        Object.entries(asObject(response.headers ?? {})).map(([name, header]) => [
          name.toLowerCase(),
          select(resolve(header, references), [
            'required',
            'style',
            'explode',
            'schema',
            'content',
          ]),
        ]),
      );
      return [
        status,
        { ...select(response, ['content']), ...(Object.keys(headers).length ? { headers } : {}) },
      ];
    }),
  );
  const selected: JsonObject = {
    parameters: [...parameterMap.values()].sort((a, b) =>
      `${String(a.in)}:${String(a.name)}`.localeCompare(`${String(b.in)}:${String(b.name)}`),
    ),
    responses,
  };
  if (operation.requestBody !== undefined)
    selected.requestBody = select(resolve(operation.requestBody, references), [
      'required',
      'content',
    ]);
  // Resolve only definitions reachable from inputs/outputs. Other component edits are irrelevant.
  const reached: JsonObject = {};
  function collect(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const ref = (value as JsonObject).$ref;
    if (typeof ref === 'string' && !(ref in reached)) {
      if (!(ref in references)) throw new Error(`Missing request/response reference ${ref}`);
      reached[ref] = references[ref];
      collect(references[ref]);
    }
    for (const child of Object.values(value)) collect(child);
  }
  collect(selected);
  return structured({ ...selected, references: reached }, {}) as RequestResponseContract;
}

export function requestResponseHash(fragment: JsonObject): string {
  return sha256(canonicalJson(extractRequestResponseContract(fragment)));
}

export async function normalizeRepositoryContract(
  serviceId: string,
  openapi: JsonObject,
  arazzo: JsonObject | null,
) {
  checkReferences(openapi);
  const operations = await validateAndDiscoverCapabilities('openapi', openapi, serviceId);
  const ids = operations.map(({ identity }) => identity.operationId);
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('Operations must have unique, stable identifiers');
  if (arazzo) {
    parseArazzoDocument(JSON.stringify(arazzo));
    for (const workflow of z.array(objectSchema).parse(arazzo.workflows)) {
      for (const step of z.array(objectSchema).min(1).parse(workflow.steps)) {
        if (typeof step.operationId !== 'string' || !ids.includes(step.operationId))
          throw new Error(`Arazzo operation does not resolve: ${String(step.operationId)}`);
      }
    }
  }
  const descriptions: JsonObject = {};
  const contract = asObject(structured({ openapi, arazzo }, descriptions));
  return {
    contract,
    descriptions,
    operations,
    requestResponseHash: sha256(
      canonicalJson(
        Object.fromEntries(
          operations.map((operation) => [
            operation.identity.operationId,
            extractRequestResponseContract(operation.fragment),
          ]),
        ),
      ),
    ),
  };
}

/** Restore previously approved prose at matching fields, discarding all fresh AI prose. */
function withApprovedProse(
  next: unknown,
  previous: unknown,
  selectedPrevious: unknown,
  contextKey = '',
): unknown {
  if (
    previous !== undefined &&
    canonicalJson(next ?? null) === canonicalJson(selectedPrevious ?? null)
  )
    return structuredClone(previous);
  if (Array.isArray(next)) {
    const before = Array.isArray(previous) ? previous : [];
    const selectedBefore = Array.isArray(selectedPrevious) ? selectedPrevious : [];
    return next.map((value, index) => {
      const record = value && typeof value === 'object' ? (value as JsonObject) : null;
      const prior =
        record && typeof record.name === 'string'
          ? before.find((item) => item?.name === record.name && item?.in === record.in)
          : before[index];
      const selectedPrior =
        record && typeof record.name === 'string'
          ? selectedBefore.find((item) => item?.name === record.name && item?.in === record.in)
          : selectedBefore[index];
      return withApprovedProse(value, prior, selectedPrior);
    });
  }
  if (!next || typeof next !== 'object') return next;
  let before =
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? (previous as JsonObject)
      : {};
  if (contextKey === 'headers')
    before = Object.fromEntries(
      Object.entries(before).map(([name, value]) => [name.toLowerCase(), value]),
    );
  const selectedBefore =
    selectedPrevious && typeof selectedPrevious === 'object' && !Array.isArray(selectedPrevious)
      ? (selectedPrevious as JsonObject)
      : {};
  const result = { ...before };
  for (const key of Object.keys(selectedBefore)) if (!(key in next)) delete result[key];
  for (const [key, value] of Object.entries(next))
    Object.defineProperty(result, key, {
      value: withApprovedProse(
        value,
        Object.hasOwn(before, key) ? before[key] : undefined,
        Object.hasOwn(selectedBefore, key) ? selectedBefore[key] : undefined,
        key,
      ),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result;
}

function setReference(document: JsonObject, ref: string, value: unknown) {
  const parts = ref
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent = document;
  for (const key of parts.slice(0, -1)) {
    if (!Object.hasOwn(parent, key))
      Object.defineProperty(parent, key, {
        value: {},
        enumerable: true,
        writable: true,
        configurable: true,
      });
    parent = asObject(parent[key]);
  }
  Object.defineProperty(parent, parts.at(-1)!, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export async function applyRepositoryRequestResponseChanges(
  serviceId: string,
  accepted: JsonObject,
  generated: JsonObject,
): Promise<JsonObject> {
  const previous = await normalizeRepositoryContract(serviceId, accepted, null);
  const next = await normalizeRepositoryContract(serviceId, generated, null);
  const byId = new Map(
    next.operations.map((operation) => [operation.identity.operationId, operation]),
  );
  const result = structuredClone(accepted);
  const flattenedPaths = new Set<string>();
  for (const operation of previous.operations) {
    const replacement = byId.get(operation.identity.operationId);
    if (!replacement)
      throw new Error(
        `Cannot match existing operation ${operation.identity.operationId}; its accepted definition is retained`,
      );
    if (requestResponseHash(operation.fragment) === requestResponseHash(replacement.fragment))
      continue;
    const selected = extractRequestResponseContract(replacement.fragment);
    const priorSelected = extractRequestResponseContract(operation.fragment);
    const oldReferences = asObject(operation.fragment.references);
    const pathItem = asObject(asObject(result.paths)[String(operation.fragment.path)]);
    const target = asObject(pathItem[String(operation.fragment.method)]);
    const beforeParameters = [
      ...z.array(objectSchema).parse(operation.fragment.pathParameters ?? []),
      ...z.array(objectSchema).parse(target.parameters ?? []),
    ].map((parameter) => resolve(parameter, oldReferences));
    // Make inherited parameters operation-local so another operation on the path is untouched.
    if (canonicalJson(selected.parameters) !== canonicalJson(priorSelected.parameters)) {
      target.parameters = withApprovedProse(
        selected.parameters,
        beforeParameters,
        priorSelected.parameters,
      );
      if (pathItem.parameters !== undefined) flattenedPaths.add(String(operation.fragment.path));
    }
    for (const key of ['requestBody', 'responses']) {
      if (canonicalJson(selected[key] ?? null) === canonicalJson(priorSelected[key] ?? null))
        continue;
      if (selected[key] === undefined) delete target[key];
      else {
        const before =
          key === 'responses'
            ? Object.fromEntries(
                Object.entries(asObject(target.responses)).map(([status, response]) => [
                  status,
                  resolve(response, oldReferences),
                ]),
              )
            : target[key] === undefined
              ? undefined
              : resolve(target[key], oldReferences);
        target[key] = withApprovedProse(selected[key], before, priorSelected[key]);
      }
    }
    for (const response of Object.values(asObject(target.responses)))
      asObject(response).description ??= '';
    for (const [ref, value] of Object.entries(selected.references))
      setReference(
        result,
        ref,
        withApprovedProse(value, oldReferences[ref], priorSelected.references[ref]),
      );
  }
  // Flatten all inherited parameters together to make deletions unambiguous and preserve siblings.
  for (const operation of previous.operations) {
    const item = asObject(asObject(result.paths)[String(operation.fragment.path)]);
    if (flattenedPaths.has(String(operation.fragment.path))) {
      const target = asObject(item[String(operation.fragment.method)]);
      if (
        canonicalJson(extractRequestResponseContract(operation.fragment).parameters) ===
        canonicalJson(
          extractRequestResponseContract(byId.get(operation.identity.operationId)!.fragment)
            .parameters,
        )
      ) {
        const inherited = [
          ...z.array(objectSchema).parse(operation.fragment.pathParameters ?? []),
          ...z.array(objectSchema).parse(target.parameters ?? []),
        ];
        target.parameters = [
          ...new Map(
            inherited.map((parameter) => {
              const resolved = resolve(parameter, asObject(operation.fragment.references));
              return [`${String(resolved.in)}:${String(resolved.name)}`, parameter];
            }),
          ).values(),
        ];
      }
    }
  }
  for (const path of flattenedPaths) delete asObject(asObject(result.paths)[path]).parameters;
  const applied = await normalizeRepositoryContract(serviceId, result, null);
  for (const operation of applied.operations) {
    if (
      requestResponseHash(operation.fragment) !==
      requestResponseHash(byId.get(operation.identity.operationId)!.fragment)
    )
      throw new Error(
        `Shared definitions prevent isolating the request/response update for ${operation.identity.operationId}; review the analysis`,
      );
  }
  return result;
}
