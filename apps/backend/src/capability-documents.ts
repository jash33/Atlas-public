import { DiagnosticSeverity, Parser as AsyncApiParser } from '@asyncapi/parser';
import { validate as validateOpenApi } from '@scalar/openapi-parser';
import { z } from 'zod';

const jsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = Record<string, unknown>;

export interface DiscoveredCapability {
  identity: {
    kind: 'openapi' | 'asyncapi';
    serviceId: string;
    operationId: string;
    channelAddress?: string;
    messageKey?: string;
  };
  fragment: JsonObject;
}

function validationError(format: 'OpenAPI' | 'AsyncAPI', message: string) {
  return new z.ZodError([
    {
      code: 'custom',
      path: ['source', 'document'],
      message: `Invalid ${format} document: ${message}`,
    },
  ]);
}

function validationLocation(path: unknown) {
  if (Array.isArray(path))
    return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
  return typeof path === 'string' && path ? path : '/';
}

function localReference(document: JsonObject, reference: string): unknown {
  if (!reference.startsWith('#/')) return undefined;
  return reference
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>(
      (current, part) =>
        current && typeof current === 'object' ? (current as JsonObject)[part] : undefined,
      document,
    );
}

function referencedValues(
  document: JsonObject,
  value: unknown,
  found = new Map<string, unknown>(),
) {
  if (Array.isArray(value)) {
    for (const child of value) referencedValues(document, child, found);
  } else if (value && typeof value === 'object') {
    const object = value as JsonObject;
    if (typeof object.$ref === 'string' && !found.has(object.$ref)) {
      const resolved = localReference(document, object.$ref);
      if (resolved !== undefined) {
        found.set(object.$ref, resolved);
        referencedValues(document, resolved, found);
      }
    }
    for (const child of Object.values(object)) referencedValues(document, child, found);
  }
  return Object.fromEntries(
    [...found.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function discoverOpenApi(document: JsonObject, serviceId: string): DiscoveredCapability[] {
  const paths = jsonObjectSchema.parse(document.paths);
  const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  const discovered: DiscoveredCapability[] = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = jsonObjectSchema.parse(pathValue);
    for (const [method, operationValue] of Object.entries(pathItem)) {
      if (!methods.has(method)) continue;
      const operation = jsonObjectSchema.parse(operationValue);
      const operationId = z.string().min(1).parse(operation.operationId);
      const operationWithPathParameters = {
        method,
        path,
        operation,
        pathParameters: pathItem.parameters ?? [],
      };
      discovered.push({
        identity: { kind: 'openapi', serviceId, operationId },
        fragment: {
          ...operationWithPathParameters,
          references: referencedValues(document, operationWithPathParameters),
        },
      });
    }
  }
  return discovered;
}

function referenceTail(reference: string) {
  return reference.split('/').at(-1);
}

function discoverAsyncApi(document: JsonObject, serviceId: string): DiscoveredCapability[] {
  const channels = jsonObjectSchema.parse(document.channels);
  const operations = jsonObjectSchema.parse(document.operations);
  return Object.entries(operations).flatMap(([operationKey, operationValue]) => {
    const operation = jsonObjectSchema.parse(operationValue);
    const operationId =
      typeof operation.operationId === 'string' ? operation.operationId : operationKey;
    const channelReference = jsonObjectSchema.parse(operation.channel).$ref;
    const channelKey = z
      .string()
      .min(1)
      .parse(referenceTail(z.string().parse(channelReference)));
    const channel = jsonObjectSchema.parse(channels[channelKey]);
    const channelAddress = z.string().min(1).parse(channel.address);
    return z
      .array(jsonObjectSchema)
      .min(1)
      .parse(operation.messages)
      .map((messageReferenceObject) => {
        const messageReference = z.string().parse(messageReferenceObject.$ref);
        const messageKey = z.string().min(1).parse(referenceTail(messageReference));
        const message = jsonObjectSchema.parse(localReference(document, messageReference));
        const operationWithoutMessageOrChannel = { ...operation };
        delete operationWithoutMessageOrChannel.messages;
        delete operationWithoutMessageOrChannel.channel;
        const channelWithoutMessages = { ...channel };
        delete channelWithoutMessages.messages;
        const scopedOperation = {
          ...operationWithoutMessageOrChannel,
          channel: operation.channel,
          messages: [messageReferenceObject],
        };
        const scopedChannel = { ...channelWithoutMessages, messages: { [messageKey]: message } };
        return {
          identity: {
            kind: 'asyncapi' as const,
            serviceId,
            channelAddress,
            messageKey,
            operationId,
          },
          fragment: {
            operation: scopedOperation,
            channel: scopedChannel,
            message,
            references: referencedValues(document, {
              operation: operationWithoutMessageOrChannel,
              channel: channelWithoutMessages,
              message,
            }),
          },
        };
      });
  });
}

export async function validateAndDiscoverCapabilities(
  format: 'openapi' | 'asyncapi',
  document: JsonObject,
  serviceId: string,
) {
  if (format === 'openapi') {
    if (typeof document.openapi !== 'string' || !document.openapi.startsWith('3.1.')) {
      throw validationError('OpenAPI', 'OpenAPI 3.1 document required');
    }
    const validation = await validateOpenApi(document);
    if (!validation.valid) {
      throw validationError(
        'OpenAPI',
        validation.errors
          ?.slice(0, 25)
          .map((error) => `${validationLocation(error.path)}: ${error.message}`)
          .join('; ') || 'validation failed',
      );
    }
    return discoverOpenApi(document, serviceId);
  }

  if (typeof document.asyncapi !== 'string' || !document.asyncapi.startsWith('3.0.')) {
    throw validationError('AsyncAPI', 'AsyncAPI 3.0 document required');
  }
  const parsed = await new AsyncApiParser().parse(JSON.stringify(document));
  const error = parsed.diagnostics.find(
    (diagnostic) => diagnostic.severity === DiagnosticSeverity.Error,
  );
  if (!parsed.document || error) {
    throw validationError('AsyncAPI', error?.message ?? 'validation failed');
  }
  return discoverAsyncApi(document, serviceId);
}
