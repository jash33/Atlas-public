import { z } from 'zod';

export interface PotentialCoverageFieldChange {
  readonly kind: string;
  readonly path?: string;
  readonly fromPath?: string;
}

export interface PotentialCoverageContract {
  readonly fromCapabilityVersionId: string;
  readonly fieldChanges?: readonly PotentialCoverageFieldChange[];
}

export interface DiscoveredSourceOperation {
  readonly operationId: string;
  readonly fieldPaths: readonly string[];
}

export interface PotentialCoveragePlanningInput {
  readonly unmappedContracts: readonly PotentialCoverageContract[];
  readonly discoveredSource: readonly DiscoveredSourceOperation[];
}

export interface PotentialCoveragePlanner {
  suggestPotentialCoverage?(input: PotentialCoveragePlanningInput): Promise<unknown>;
}

export interface VerifiedPotentialCoverage {
  readonly fromCapabilityVersionId: string;
  readonly operationId: string;
  readonly fieldPath?: string;
}

const suggestionSchema = z
  .object({
    fromCapabilityVersionId: z.string().min(1),
    operationId: z.string().min(1),
    fieldPath: z.string().min(1).nullable(),
  })
  .strict();

export const potentialCoverageResponseSchema = z
  .object({
    kind: z.enum(['suggestion', 'refusal']),
    suggestions: z.array(suggestionSchema),
  })
  .strict();

export const potentialCoverageResponseJsonSchema = z.toJSONSchema(potentialCoverageResponseSchema, {
  target: 'draft-07',
});

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function localReference(fragment: JsonObject, reference: string): unknown {
  if (!reference.startsWith('#/')) return undefined;
  return reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === 'object' ? (current as JsonObject)[part] : undefined,
      fragment,
    );
}

function resolveSchema(fragment: JsonObject, value: unknown): JsonObject | undefined {
  const schema = objectValue(value);
  if (!schema) return undefined;
  if (typeof schema.$ref === 'string') {
    const resolved = objectValue(localReference(fragment, schema.$ref));
    if (resolved) return resolved;
    const references = objectValue(fragment.references);
    return references ? objectValue(references[schema.$ref]) : undefined;
  }
  return schema;
}

function mediaSchema(fragment: JsonObject, container: JsonObject | undefined) {
  const content = objectValue(container?.content);
  const mediaType = content ? objectValue(Object.values(content)[0]) : undefined;
  return resolveSchema(fragment, mediaType?.schema);
}

function collectPropertyPaths(fragment: JsonObject, schema: JsonObject | undefined): string[] {
  const properties = objectValue(schema?.properties);
  if (!properties) return [];
  const paths: string[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const pointer = `/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    paths.push(pointer, `/request${pointer}`, `/response${pointer}`);
    const child = resolveSchema(fragment, value);
    if (child) paths.push(...collectPropertyPaths(fragment, child));
  }
  return paths;
}

function fieldPathsFromFragment(fragmentValue: unknown): string[] {
  const fragment = objectValue(fragmentValue) ?? {};
  const operation = objectValue(fragment.operation);
  const paths = new Set<string>();
  const parameters = [
    ...(Array.isArray(fragment.pathParameters) ? fragment.pathParameters : []),
    ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
  ];
  for (const value of parameters) {
    const parameter = objectValue(value);
    if (typeof parameter?.name !== 'string') continue;
    const pointer = `/${parameter.name.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    paths.add(pointer);
    paths.add(`/request${pointer}`);
  }
  const requestSchema = mediaSchema(fragment, objectValue(operation?.requestBody));
  for (const path of collectPropertyPaths(fragment, requestSchema)) {
    if (!path.startsWith('/response')) paths.add(path);
  }
  const responses = objectValue(operation?.responses);
  const success = responses
    ? Object.entries(responses)
        .sort(([left], [right]) => left.localeCompare(right))
        .find(([status]) => /^2\d\d$/.test(status))?.[1]
    : undefined;
  const responseSchema = mediaSchema(fragment, objectValue(success));
  for (const path of collectPropertyPaths(fragment, responseSchema)) {
    if (!path.startsWith('/request')) paths.add(path);
  }
  return [...paths];
}

export function projectDiscoveredSource(
  capabilities: readonly {
    identity: { operationId: string };
    fragment: unknown;
  }[],
): DiscoveredSourceOperation[] {
  return capabilities.map((capability) => ({
    operationId: capability.identity.operationId,
    fieldPaths: fieldPathsFromFragment(capability.fragment),
  }));
}

function verifiedHint(
  suggestion: z.infer<typeof suggestionSchema>,
  unmappedIds: ReadonlySet<string>,
  sourceByOperation: ReadonlyMap<string, ReadonlySet<string>>,
): VerifiedPotentialCoverage | undefined {
  if (!unmappedIds.has(suggestion.fromCapabilityVersionId)) return undefined;
  const fieldPaths = sourceByOperation.get(suggestion.operationId);
  if (!fieldPaths) return undefined;
  if (suggestion.fieldPath && !fieldPaths.has(suggestion.fieldPath)) return undefined;
  return {
    fromCapabilityVersionId: suggestion.fromCapabilityVersionId,
    operationId: suggestion.operationId,
    ...(suggestion.fieldPath ? { fieldPath: suggestion.fieldPath } : {}),
  };
}

const unmappedFieldKinds = new Set(['removed', 'added-required', 'retyped']);

export function isUnmappedDiscoveryChange(change: {
  toCapabilityVersionId?: string | null;
  classification: string;
  fieldChanges?: readonly unknown[];
}): boolean {
  if (change.toCapabilityVersionId === null || change.toCapabilityVersionId === '') return true;
  if (change.classification === 'breaking') return true;
  return Boolean(
    change.fieldChanges?.some((field) => {
      if (!field || typeof field !== 'object') return false;
      const record = field as { kind?: unknown; classification?: unknown };
      return (
        record.classification === 'breaking' ||
        (typeof record.kind === 'string' && unmappedFieldKinds.has(record.kind))
      );
    }),
  );
}

export async function suggestPotentialCoverage(input: {
  unmappedContracts: readonly PotentialCoverageContract[];
  discoveredSource: readonly DiscoveredSourceOperation[];
  plannerModel?: PotentialCoveragePlanner | undefined;
}): Promise<readonly VerifiedPotentialCoverage[]> {
  if (!input.plannerModel?.suggestPotentialCoverage || input.unmappedContracts.length === 0) {
    return [];
  }
  let raw: unknown;
  try {
    raw = await input.plannerModel.suggestPotentialCoverage({
      unmappedContracts: input.unmappedContracts,
      discoveredSource: input.discoveredSource,
    });
  } catch {
    return [];
  }
  const parsed = potentialCoverageResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.kind === 'refusal') return [];

  const unmappedIds = new Set(
    input.unmappedContracts.map((contract) => contract.fromCapabilityVersionId),
  );
  const sourceByOperation = new Map(
    input.discoveredSource.map((operation) => [
      operation.operationId,
      new Set(operation.fieldPaths),
    ]),
  );
  const verified: VerifiedPotentialCoverage[] = [];
  const seen = new Set<string>();
  for (const suggestion of parsed.data.suggestions) {
    const hint = verifiedHint(suggestion, unmappedIds, sourceByOperation);
    if (!hint || seen.has(hint.fromCapabilityVersionId)) continue;
    seen.add(hint.fromCapabilityVersionId);
    verified.push(hint);
  }
  return verified;
}
