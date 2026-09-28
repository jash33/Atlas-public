import { StepActivityError } from '@atlas/runtime-ports';
import type { JsonValue } from '@atlas/workflow-ir';

export interface OpenApiHttpBindingInput {
  readonly baseUrl: string;
  readonly fragment: Readonly<Record<string, unknown>>;
  readonly annotation: { readonly idempotencyField: string | null };
  readonly input: Readonly<Record<string, JsonValue>>;
}

type SupportedParameter = Record<string, unknown> & {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
};

export function createOpenApiHttpRequest({
  baseUrl,
  fragment,
  annotation,
  input,
}: OpenApiHttpBindingInput): [URL, RequestInit] {
  if (typeof fragment.method !== 'string' || typeof fragment.path !== 'string') {
    throw new StepActivityError('InvalidCapabilityFragment');
  }
  const operation = isRecord(fragment.operation) ? fragment.operation : {};
  const parameters = mergedParameters(fragment, operation);
  const requestInput: Record<string, JsonValue> = { ...input };
  if (annotation.idempotencyField && requestInput.idempotencyKey !== undefined) {
    requestInput[annotation.idempotencyField] ??= requestInput.idempotencyKey;
    if (annotation.idempotencyField !== 'idempotencyKey') delete requestInput.idempotencyKey;
  }
  let path = fragment.path;
  const consumed = new Set<string>();
  const query = new URLSearchParams();
  const headers = new Headers();
  for (const parameter of parameters) {
    const value = requestInput[parameter.name];
    if (value === undefined && parameter.required === true) {
      throw new StepActivityError('InvalidStepInput');
    }
    if (value === undefined) continue;
    assertParameterSchema(fragment, parameter, value);
    consumed.add(parameter.name);
    if (parameter.in === 'path') {
      path = path.replaceAll(`{${parameter.name}}`, serializePathParameter(parameter, value));
    } else if (parameter.in === 'query') {
      for (const [name, serialized] of serializeQueryParameter(parameter, value)) {
        query.append(name, serialized);
      }
    } else if (parameter.in === 'header') {
      headers.set(parameter.name, serializeHeaderParameter(parameter, value));
    }
  }
  if (/\{[^}]+\}/.test(path)) throw new StepActivityError('InvalidStepInput');
  const url = capabilityUrl(baseUrl, path);
  for (const [name, value] of query) url.searchParams.append(name, value);

  const requestBody = resolveObject(fragment, operation.requestBody);
  const content = requestBody && isRecord(requestBody.content) ? requestBody.content : undefined;
  const jsonMedia =
    content && isRecord(content['application/json']) ? content['application/json'] : undefined;
  const formMedia =
    content && isRecord(content['application/x-www-form-urlencoded'])
      ? content['application/x-www-form-urlencoded']
      : undefined;
  const selectedMedia = jsonMedia ?? formMedia;
  const schema = selectedMedia ? resolveSchema(fragment, selectedMedia.schema) : undefined;
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const body = Object.fromEntries(
    Object.entries(requestInput)
      .filter(
        ([name]) =>
          !consumed.has(name) &&
          (schema?.additionalProperties !== false || Object.hasOwn(properties, name)),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as Record<string, JsonValue>;
  const shouldSendBody = requestBody?.required === true || Object.keys(body).length > 0;
  if (requestBody && !jsonMedia && !formMedia && shouldSendBody) {
    throw new StepActivityError('UnsupportedCapabilityBinding');
  }
  if (selectedMedia && shouldSendBody) {
    for (const [name, propertyValue] of Object.entries(properties)) {
      const property = isRecord(propertyValue) ? propertyValue : undefined;
      if (!(name in body) && property && isJsonValue(property.const)) {
        body[name] = property.const;
      }
    }
    const required = Array.isArray(schema?.required) ? schema.required : [];
    if (required.some((name) => typeof name === 'string' && !(name in body))) {
      throw new StepActivityError('InvalidStepInput');
    }
  }
  if (jsonMedia && shouldSendBody) {
    headers.set('content-type', 'application/json');
  } else if (formMedia && shouldSendBody) {
    headers.set('content-type', 'application/x-www-form-urlencoded');
  }

  return [
    url,
    {
      method: fragment.method.toUpperCase(),
      redirect: 'manual',
      ...(Array.from(headers).length > 0 ? { headers } : {}),
      ...(jsonMedia && shouldSendBody
        ? { body: JSON.stringify(body) }
        : formMedia && shouldSendBody
          ? { body: formBody(body) }
          : {}),
    },
  ];
}

function isScalar(value: JsonValue): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function scalarText(value: JsonValue): string {
  if (!isScalar(value)) throw new StepActivityError('InvalidStepInput');
  return String(value);
}

function objectEntries(value: JsonValue) {
  if (!isJsonObject(value)) throw new StepActivityError('InvalidStepInput');
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, child]) => [name, scalarText(child)] as const);
}

function serializePathParameter(parameter: SupportedParameter, value: JsonValue): string {
  const style = typeof parameter.style === 'string' ? parameter.style : 'simple';
  const explode = parameter.explode === true;
  const atom = (part: string) => encodeURIComponent(part);
  if (isScalar(value)) {
    const serialized = atom(String(value));
    if (style === 'simple') return serialized;
    if (style === 'label') return `.${serialized}`;
    if (style === 'matrix') return `;${atom(parameter.name)}=${serialized}`;
  } else if (Array.isArray(value)) {
    const parts = value.map((child) => atom(scalarText(child)));
    if (style === 'simple') return parts.join(',');
    if (style === 'label') return `.${parts.join(explode ? '.' : ',')}`;
    if (style === 'matrix') {
      return explode
        ? parts.map((part) => `;${atom(parameter.name)}=${part}`).join('')
        : `;${atom(parameter.name)}=${parts.join(',')}`;
    }
  } else if (isJsonObject(value)) {
    const entries = objectEntries(value).map(([name, child]) => [atom(name), atom(child)] as const);
    if (style === 'simple') {
      return entries
        .flatMap(([name, child]) => (explode ? [`${name}=${child}`] : [name, child]))
        .join(',');
    }
    if (style === 'label') {
      return `.${entries
        .flatMap(([name, child]) => (explode ? [`${name}=${child}`] : [name, child]))
        .join(explode ? '.' : ',')}`;
    }
    if (style === 'matrix') {
      return explode
        ? entries.map(([name, child]) => `;${name}=${child}`).join('')
        : `;${atom(parameter.name)}=${entries.flat().join(',')}`;
    }
  }
  throw new StepActivityError('UnsupportedCapabilityBinding');
}

function serializeQueryParameter(
  parameter: SupportedParameter,
  value: JsonValue,
): ReadonlyArray<readonly [string, string]> {
  if (parameter.allowReserved === true) {
    throw new StepActivityError('UnsupportedCapabilityBinding');
  }
  const style = typeof parameter.style === 'string' ? parameter.style : 'form';
  const explode = parameter.explode === undefined ? style === 'form' : parameter.explode === true;
  if (isScalar(value)) return [[parameter.name, String(value)]];
  if (Array.isArray(value)) {
    const parts = value.map(scalarText);
    if (style === 'form') {
      return explode
        ? parts.map((part) => [parameter.name, part] as const)
        : [[parameter.name, parts.join(',')]];
    }
    if (style === 'spaceDelimited') return [[parameter.name, parts.join(' ')]];
    if (style === 'pipeDelimited') return [[parameter.name, parts.join('|')]];
  }
  if (isJsonObject(value)) {
    const entries = objectEntries(value);
    if (style === 'form') {
      return explode
        ? entries
        : [[parameter.name, entries.flatMap(([name, child]) => [name, child]).join(',')]];
    }
    if (style === 'deepObject') {
      return entries.map(([name, child]) => [`${parameter.name}[${name}]`, child] as const);
    }
  }
  throw new StepActivityError('UnsupportedCapabilityBinding');
}

function serializeHeaderParameter(parameter: SupportedParameter, value: JsonValue): string {
  const style = typeof parameter.style === 'string' ? parameter.style : 'simple';
  if (style !== 'simple') throw new StepActivityError('UnsupportedCapabilityBinding');
  if (isScalar(value)) return String(value);
  if (Array.isArray(value)) return value.map(scalarText).join(',');
  const entries = objectEntries(value);
  return entries
    .flatMap(([name, child]) => (parameter.explode === true ? [`${name}=${child}`] : [name, child]))
    .join(',');
}

function assertParameterSchema(
  fragment: Readonly<Record<string, unknown>>,
  parameter: SupportedParameter,
  value: JsonValue,
) {
  const schema = resolveSchema(fragment, parameter.schema);
  const type = schema?.type;
  const valid =
    type === undefined ||
    (type === 'string' && typeof value === 'string') ||
    (type === 'number' && typeof value === 'number') ||
    (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
    (type === 'boolean' && typeof value === 'boolean') ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'object' && isJsonObject(value));
  if (!valid) throw new StepActivityError('InvalidStepInput');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveSchema(
  fragment: Readonly<Record<string, unknown>>,
  value: unknown,
): Record<string, unknown> | undefined {
  return resolveObject(fragment, value);
}

function mergedParameters(
  fragment: Readonly<Record<string, unknown>>,
  operation: Readonly<Record<string, unknown>>,
) {
  const merged = new Map<string, SupportedParameter>();
  const groups = [
    Array.isArray(fragment.pathParameters) ? fragment.pathParameters : [],
    Array.isArray(operation.parameters) ? operation.parameters : [],
  ];
  for (const group of groups) {
    for (const unresolvedParameter of group) {
      const parameter = resolveObject(fragment, unresolvedParameter);
      if (
        !parameter ||
        typeof parameter.name !== 'string' ||
        !['path', 'query', 'header'].includes(String(parameter.in))
      ) {
        throw new StepActivityError('InvalidCapabilityFragment');
      }
      const supportedParameter = parameter as SupportedParameter;
      merged.set(`${supportedParameter.in}:${supportedParameter.name}`, supportedParameter);
    }
  }
  return [...merged.values()];
}

function resolveObject(
  fragment: Readonly<Record<string, unknown>>,
  value: unknown,
  seen = new Set<string>(),
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref !== 'string') return value;
  if (seen.has(value.$ref)) throw new StepActivityError('InvalidCapabilityFragment');
  const references = isRecord(fragment.references) ? fragment.references : undefined;
  const referenced = references?.[value.$ref];
  if (referenced === undefined) throw new StepActivityError('InvalidCapabilityFragment');
  seen.add(value.$ref);
  return resolveObject(fragment, referenced, seen);
}

function capabilityUrl(baseUrl: string, path: string): URL {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new StepActivityError('InvalidCapabilityFragment');
  }
  const url = new URL(baseUrl);
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url;
}

function formBody(body: Readonly<Record<string, JsonValue>>): URLSearchParams {
  const result = new URLSearchParams();
  for (const [name, value] of Object.entries(body)) {
    if (!isScalar(value)) throw new StepActivityError('InvalidStepInput');
    result.append(name, String(value));
  }
  return result;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
