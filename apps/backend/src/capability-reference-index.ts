export interface PlannerCapabilityIdentity {
  kind: 'openapi' | 'asyncapi';
  serviceId: string;
  operationId: string;
  channelAddress?: string;
  messageKey?: string;
}

export type FieldDirection = 'request' | 'response';

/** Canonical field path is an RFC 6901 JSON Pointer from the payload root. Array items use `/-`, e.g. `/lineItems/-/sku`. */
export interface CapabilityFieldReference {
  capabilityVersionId: string;
  direction: FieldDirection;
  path: string;
  type: string;
  required: boolean;
  label: string;
  searchTerms: string[];
}

export interface CapabilityReferenceProvenance {
  evidence:
    | {
        kind: 'atlas-generated';
        repository: string;
        commit: string;
        candidateId: string;
        label: string;
        confirmedBy: string;
        confirmedAt: string;
      }
    | {
        kind: 'repository' | 'github';
        repository: string;
        commit: string;
        path: string;
      }
    | {
        kind: 'human-confirmed';
        label: string;
        confirmedBy: string;
        confirmedAt: string;
      };
}

export interface CapabilityReferenceSafety {
  idempotencyField: string | null;
  compensatedBy: {
    kind: 'openapi' | 'asyncapi';
    serviceId: string;
    operationId: string;
    channelAddress: string | null;
    messageKey: string | null;
  } | null;
  irreversibleAfter: boolean | null;
}

export interface PlannerCapabilityReference {
  capabilityVersionId: string;
  identity: PlannerCapabilityIdentity;
  observation?: CapabilityObservation;
  owner: string;
  businessSemantics: Record<string, unknown> | null;
  userAnnotations: string[];
  summary: string | null;
  description: string | null;
  safety: CapabilityReferenceSafety;
  provenance: CapabilityReferenceProvenance | null;
  searchTerms: string[];
  fields: CapabilityFieldReference[];
}

export interface CapabilityObservation {
  availability: 'available' | 'removed';
  freshness: 'fresh' | 'stale';
  reason: string;
  lastObservedAt: string;
  statusChangedAt: string;
}

export type PlannerCapabilityReferenceIndex =
  | {
      status: 'ok';
      fingerprint: string;
      references: PlannerCapabilityReference[];
    }
  | { status: 'stale'; fingerprint: string }
  | { status: 'unavailable' };

export interface PlannerCapabilityReferenceCandidate {
  capabilityVersionId: string;
  identity: PlannerCapabilityIdentity;
  owner: string;
  direction?: FieldDirection;
  path?: string;
  label: string;
}

type PlannerProjectionInput = {
  fingerprint: string;
  capabilities: Array<{
    capabilityVersionId: string;
    identity: PlannerCapabilityIdentity;
    observation?: CapabilityObservation;
    fragment: unknown;
    annotation: {
      owner: string;
      businessSemantics: Record<string, unknown> | null;
      idempotencyField: string | null;
      compensatedBy: CapabilityReferenceSafety['compensatedBy'];
      irreversibleAfter: boolean | null;
    };
    userAnnotations?: string[];
  }>;
};

type JsonObject = Record<string, unknown>;

export function plannerCapabilityReferenceIndex(
  projection: PlannerProjectionInput | null,
  options: {
    expectedFingerprint?: string;
    provenanceByCapabilityVersionId?: ReadonlyMap<string, CapabilityReferenceProvenance>;
  } = {},
): PlannerCapabilityReferenceIndex {
  if (!projection) return { status: 'unavailable' };
  if (options.expectedFingerprint && options.expectedFingerprint !== projection.fingerprint) {
    return { status: 'stale', fingerprint: projection.fingerprint };
  }
  return {
    status: 'ok',
    fingerprint: projection.fingerprint,
    references: projection.capabilities.map((capability) =>
      capabilityReference(capability, options.provenanceByCapabilityVersionId),
    ),
  };
}

export function matchCapabilityReferences(
  index: {
    references: Array<{
      capabilityVersionId: string;
      identity: PlannerCapabilityIdentity;
      owner: string;
      searchTerms: string[];
      fields: Array<{
        capabilityVersionId: string;
        direction: FieldDirection;
        path: string;
        label: string;
        searchTerms: string[];
      }>;
    }>;
  },
  query: string,
): PlannerCapabilityReferenceCandidate[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  const matches: PlannerCapabilityReferenceCandidate[] = [];
  for (const reference of index.references) {
    if (matchesTerms(reference.searchTerms, tokens)) {
      matches.push({
        capabilityVersionId: reference.capabilityVersionId,
        identity: reference.identity,
        owner: reference.owner,
        label: reference.identity.operationId,
      });
    }
    for (const field of reference.fields) {
      if (!matchesTerms(field.searchTerms, tokens)) continue;
      matches.push({
        capabilityVersionId: field.capabilityVersionId,
        identity: reference.identity,
        owner: reference.owner,
        direction: field.direction,
        path: field.path,
        label: field.label,
      });
    }
  }
  return matches;
}

function truncatedCopy(value: unknown, limit = 240) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit).trimEnd()}…` : trimmed;
}

function operationCopy(fragment: unknown) {
  const root = objectValue(fragment) ?? {};
  const operation = objectValue(root.operation) ?? root;
  return {
    summary: truncatedCopy(operation.summary),
    description: truncatedCopy(operation.description),
  };
}

function capabilityReference(
  capability: PlannerProjectionInput['capabilities'][number],
  provenanceByCapabilityVersionId?: ReadonlyMap<string, CapabilityReferenceProvenance>,
): PlannerCapabilityReference {
  const fields = capabilityFieldReferences(capability.capabilityVersionId, capability.fragment);
  const copy = operationCopy(capability.fragment);
  return {
    capabilityVersionId: capability.capabilityVersionId,
    identity: capability.identity,
    ...(capability.observation ? { observation: capability.observation } : {}),
    owner: capability.annotation.owner,
    businessSemantics: capability.annotation.businessSemantics,
    userAnnotations: capability.userAnnotations ?? [],
    summary: copy.summary,
    description: copy.description,
    safety: {
      idempotencyField: capability.annotation.idempotencyField,
      compensatedBy: capability.annotation.compensatedBy,
      irreversibleAfter: capability.annotation.irreversibleAfter,
    },
    provenance: provenanceByCapabilityVersionId?.get(capability.capabilityVersionId) ?? null,
    searchTerms: collectSearchTerms([
      capability.identity.serviceId,
      capability.identity.operationId,
      capability.identity.channelAddress,
      capability.identity.messageKey,
      capability.annotation.owner,
      ...(capability.userAnnotations ?? []),
      copy.summary,
      copy.description,
    ]),
    fields,
  };
}

function capabilityFieldReferences(
  capabilityVersionId: string,
  fragmentValue: unknown,
): CapabilityFieldReference[] {
  const fragment = objectValue(fragmentValue) ?? {};
  const operation = objectValue(fragment.operation);
  const fields: CapabilityFieldReference[] = [];
  const parameters = [
    ...(Array.isArray(fragment.pathParameters) ? fragment.pathParameters : []),
    ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
  ];
  for (const value of parameters) {
    const parameter = objectValue(value);
    if (typeof parameter?.name !== 'string') continue;
    fields.push(
      fieldReference(
        capabilityVersionId,
        'request',
        jsonPointer('', parameter.name),
        resolveSchema(fragment, parameter.schema),
        parameter.required === true,
        parameter.name,
      ),
    );
  }
  const requestSchema =
    mediaSchema(fragment, objectValue(operation?.requestBody)) ?? messageSchema(fragment);
  if (requestSchema) {
    fields.push(
      ...schemaFieldReferences(capabilityVersionId, 'request', fragment, requestSchema, ''),
    );
  }
  const responses = objectValue(operation?.responses);
  const success = responses
    ? Object.entries(responses)
        .sort(([left], [right]) => left.localeCompare(right))
        .find(([status]) => /^2\d\d$/.test(status))?.[1]
    : undefined;
  const responseSchema = mediaSchema(fragment, objectValue(success));
  if (responseSchema) {
    fields.push(
      ...schemaFieldReferences(capabilityVersionId, 'response', fragment, responseSchema, ''),
    );
  }
  return fields;
}

function schemaFieldReferences(
  capabilityVersionId: string,
  direction: FieldDirection,
  fragment: JsonObject,
  schema: JsonObject,
  prefix: string,
): CapabilityFieldReference[] {
  const properties = objectValue(schema.properties);
  if (!properties) return [];
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  const fields: CapabilityFieldReference[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const child = resolveSchema(fragment, value) ?? objectValue(value);
    const path = jsonPointer(prefix, name);
    fields.push(
      fieldReference(capabilityVersionId, direction, path, child, required.has(name), name),
    );
    if (!child) continue;
    const type = schemaType(child);
    if (type === 'object') {
      fields.push(...schemaFieldReferences(capabilityVersionId, direction, fragment, child, path));
    }
    if (type === 'array') {
      const items = resolveSchema(fragment, child.items) ?? objectValue(child.items);
      if (items && schemaType(items) === 'object') {
        fields.push(
          ...schemaFieldReferences(
            capabilityVersionId,
            direction,
            fragment,
            items,
            jsonPointer(path, '-'),
          ),
        );
      }
    }
  }
  return fields;
}

function jsonPointer(path: string, key: string) {
  return `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function fieldReference(
  capabilityVersionId: string,
  direction: FieldDirection,
  path: string,
  schema: JsonObject | undefined,
  required: boolean,
  name: string,
): CapabilityFieldReference {
  return {
    capabilityVersionId,
    direction,
    path,
    type: schemaType(schema),
    required,
    label: humanLabel(name),
    searchTerms: collectSearchTerms([name, humanLabel(name)]),
  };
}

function mediaSchema(fragment: JsonObject, container: JsonObject | undefined) {
  const content = objectValue(container?.content);
  const mediaType = content ? objectValue(Object.values(content)[0]) : undefined;
  return resolveSchema(fragment, mediaType?.schema);
}

function messageSchema(fragment: JsonObject) {
  const channelMessages = objectValue(objectValue(fragment.channel)?.messages);
  const operation = objectValue(fragment.operation);
  const operationMessages = Array.isArray(operation?.messages) ? operation.messages : [];
  const referencedMessageKey = operationMessages
    .map(objectValue)
    .map((message) =>
      typeof message?.$ref === 'string' ? message.$ref.split('/').at(-1) : undefined,
    )
    .find((key) => key && channelMessages?.[key]);
  const projectedMessage = referencedMessageKey
    ? objectValue(channelMessages?.[referencedMessageKey])
    : objectValue(fragment.message);
  return resolveSchema(fragment, projectedMessage?.payload);
}

function resolveSchema(fragment: JsonObject, value: unknown): JsonObject | undefined {
  const schema = objectValue(value);
  if (!schema) return undefined;
  if (typeof schema.$ref !== 'string') return schema;
  return objectValue(objectValue(fragment.references)?.[schema.$ref]);
}

function schemaType(schema: JsonObject | undefined) {
  if (typeof schema?.type === 'string') return schema.type;
  if (schema && objectValue(schema.properties)) return 'object';
  if (schema && schema.items !== undefined) return 'array';
  return 'unknown';
}

function humanLabel(name: string) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function collectSearchTerms(values: Array<string | null | undefined>) {
  const terms = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const lower = value.toLowerCase();
    terms.add(lower);
    terms.add(lower.replace(/[-_]/g, ''));
    for (const token of tokenize(value)) terms.add(token);
  }
  return [...terms];
}

function queryTokens(query: string) {
  return tokenize(query);
}

function tokenize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesTerms(searchTerms: string[], tokens: string[]) {
  return tokens.every((token) => searchTerms.some((term) => term.startsWith(token)));
}

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
