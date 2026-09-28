import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { arazzoUrlBesideOpenApi, parseArazzoDocument } from './arazzo-document.js';
import { saveCapabilityArchitecture } from './capability-architecture.js';
import { validateAndDiscoverCapabilities } from './capability-documents.js';
import type { DiscoveredCapability, JsonObject } from './capability-documents.js';
import { addDiscoveryCoverage, discoverCapabilitiesInTransaction } from './capability-ingestion.js';
import { installConnectedSandboxTargets } from './capability-sandbox-targets.js';
import { canonicalJson } from './capability-versioning.js';
import {
  CapabilitySourcePolicyError,
  fetchCapabilitySource,
  type CapabilitySourcePolicy,
} from './source-policy.js';

const jsonObjectSchema = z.record(z.string(), z.unknown());
export const burgerTownRecognizedErrorSchema = z
  .object({
    status: z.literal(400),
    code: z.string().min(1),
    codePath: z.array(z.string()).min(1),
    fieldPathPath: z.array(z.string()).min(1),
    fieldPath: z.string().min(1).optional(),
  })
  .strict();

const burgerTownOperationSchema = z
  .object({
    operationId: z.string().min(1),
    owner: z.string().min(1),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().startsWith('/'),
    requestBody: jsonObjectSchema,
    expectedSuccess: z
      .object({
        status: z.number().int().min(100).max(599),
        acceptAnyStatus: z.boolean().optional(),
      })
      .strict(),
    recognizedError: burgerTownRecognizedErrorSchema,
  })
  .strict();

const burgerTownPlanSchema = z
  .object({
    serviceId: z.string().min(1),
    operations: z.array(burgerTownOperationSchema),
  })
  .strict();

const pollingFixtureSchema = burgerTownOperationSchema.omit({ operationId: true, owner: true });
const providerSafetySchema = z
  .object({
    idempotencyField: z.string().min(1).nullable(),
    compensatedBy: z
      .object({ operationId: z.string().min(1) })
      .strict()
      .nullable(),
    irreversibleAfter: z.boolean(),
  })
  .strict();

export type BurgerTownConnectionPlan = z.input<typeof burgerTownPlanSchema>;

const burgerTownConnectionSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    applicationUrl: z.string().url(),
    openApiUrl: z.string().url(),
    arazzoUrl: z.string().url().optional(),
  })
  .strict();

export type BurgerTownConnectionInput = z.input<typeof burgerTownConnectionSchema>;

function requireAgreedAddress(value: string, allowed: readonly string[], label: string) {
  const normalized = new URL(value).href;
  if (!allowed.some((candidate) => new URL(candidate).href === normalized)) {
    throw new Error(`${label} is not one of the configured Burger Town addresses`);
  }
}

async function resolveConfirmationTimestamp(
  client: PoolClient,
  input: BurgerTownConnectionInput,
  serviceId: string,
  document: JsonObject,
  annotations: ReturnType<typeof annotationsFor>,
  now: () => Date,
) {
  const existing = await client.query<{
    confirmed_at: string | null;
    document: JsonObject;
    annotations: unknown;
  }>(
    `SELECT discovery_input #>> '{source,evidence,confirmedAt}' AS confirmed_at,
            discovery_input #> '{source,document}' AS document,
            discovery_input #> '{manifest,annotations}' AS annotations
     FROM capability_source_registrations
     WHERE organization_id = $1 AND environment_id = $2 AND service_id = $3
       AND discovery_input #>> '{source,url}' = $4
     ORDER BY updated_at DESC
     LIMIT 1`,
    [input.organizationId, input.environmentId, serviceId, input.openApiUrl],
  );
  const previous = existing.rows[0];
  if (
    previous?.confirmed_at &&
    canonicalJson(previous.document) === canonicalJson(document) &&
    canonicalJson(previous.annotations) === canonicalJson(annotations)
  )
    return previous.confirmed_at;
  // Source and generated manifest share confirmation evidence. Either changing requires
  // a fresh timestamp, including successive confirmations within one clock millisecond.
  return new Date(
    Math.max(now().getTime(), previous?.confirmed_at ? Date.parse(previous.confirmed_at) + 1 : 0),
  ).toISOString();
}

function checkPlan(rawPlan: BurgerTownConnectionPlan) {
  const plan = burgerTownPlanSchema.parse(rawPlan);
  const configured = new Set(plan.operations.map(({ operationId }) => operationId));
  if (configured.size !== plan.operations.length) {
    throw new Error('Burger Town setup lists the same operation more than once');
  }
  return plan;
}

async function fetchOpenApiDocument(url: string, policy: CapabilitySourcePolicy) {
  let response: Response;
  try {
    response = await fetchCapabilitySource(url, policy);
  } catch (error) {
    if (error instanceof CapabilitySourcePolicyError) {
      throw new Error(`Burger Town OpenAPI address was rejected: ${error.code}`, { cause: error });
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Burger Town OpenAPI address returned HTTP ${response.status}`);
  }
  try {
    return jsonObjectSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error('Burger Town OpenAPI address did not return a JSON object', { cause: error });
    }
    throw new Error('Burger Town OpenAPI address did not return valid JSON', { cause: error });
  }
}

async function fetchArazzoDocument(
  url: string,
  policy: CapabilitySourcePolicy,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchCapabilitySource(url, policy);
  } catch (error) {
    if (error instanceof CapabilitySourcePolicyError) {
      throw new Error(`Burger Town Arazzo address was rejected: ${error.code}`, { cause: error });
    }
    throw error;
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Burger Town Arazzo address returned HTTP ${response.status}`);
  }
  const text = await response.text();
  try {
    parseArazzoDocument(text);
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Burger Town Arazzo document is invalid: ${error.message}`
        : 'Burger Town Arazzo document is invalid',
      { cause: error },
    );
  }
  return text;
}

async function checkApplication(url: string, policy: CapabilitySourcePolicy) {
  let response: Response;
  try {
    response = await fetchCapabilitySource(url, policy);
  } catch (error) {
    if (error instanceof CapabilitySourcePolicyError) {
      throw new Error(`Burger Town application address was rejected: ${error.code}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Burger Town application address returned HTTP ${response.status}`);
  }
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function resolveReference(document: JsonObject, value: unknown): unknown {
  const object = objectValue(value);
  if (!object || typeof object.$ref !== 'string' || !object.$ref.startsWith('#/')) return value;
  return object.$ref
    .slice(2)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((current, part) => objectValue(current)?.[part], document);
}

function exampleForSchema(document: JsonObject, rawSchema: unknown): unknown {
  const schema = objectValue(resolveReference(document, rawSchema));
  if (!schema) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'array') {
    const item = exampleForSchema(document, schema.items);
    return item === undefined ? [] : [item];
  }
  const properties = objectValue(schema.properties);
  if (schema.type === 'object' || properties) {
    return Object.fromEntries(
      Object.entries(properties ?? {}).flatMap(([name, property]) => {
        const value = exampleForSchema(document, property);
        return value === undefined ? [] : [[name, value]];
      }),
    );
  }
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  return 'atlas-demo';
}

function parameterExample(document: JsonObject, rawParameter: unknown) {
  const parameter = objectValue(resolveReference(document, rawParameter));
  if (!parameter) return null;
  const value = parameter.example ?? exampleForSchema(document, parameter.schema) ?? 'atlas-demo';
  return {
    name: typeof parameter.name === 'string' ? parameter.name : '',
    location: parameter.in,
    required: parameter.required === true,
    value:
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
          ? `${value}`
          : (JSON.stringify(value) ?? 'atlas-demo'),
  };
}

function requestBodyFor(document: JsonObject, operation: JsonObject) {
  const requestBody = objectValue(resolveReference(document, operation.requestBody));
  const content = objectValue(requestBody?.content);
  const mediaType = objectValue(content?.['application/json']);
  const example = mediaType?.example ?? exampleForSchema(document, mediaType?.schema);
  return objectValue(example) ?? {};
}

function ownerFor(operation: JsonObject) {
  if (typeof operation['x-burgertown-api'] === 'string') return operation['x-burgertown-api'];
  const tag = Array.isArray(operation.tags) ? operation.tags[0] : undefined;
  return typeof tag === 'string' && tag.length > 0 ? tag : 'burger-town';
}

function operationsFromDocument(
  document: JsonObject,
  discovered: readonly DiscoveredCapability[],
  configuredPlan: z.output<typeof burgerTownPlanSchema>,
) {
  return discovered.map((capability) => {
    const fragment = capability.fragment;
    const operation = objectValue(fragment.operation) ?? {};
    const safety =
      operation['x-atlas-safety'] === undefined
        ? { idempotencyField: null, compensatedBy: null, irreversibleAfter: false }
        : providerSafetySchema.parse(operation['x-atlas-safety']);
    const method = z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      .parse(String(fragment.method).toUpperCase());
    const contractPath = z.string().startsWith('/').parse(fragment.path);
    const configured = configuredPlan.operations.find(
      (candidate) =>
        candidate.operationId === capability.identity.operationId &&
        candidate.method === method &&
        candidate.path === contractPath,
    );
    if (configured) return { ...configured, pollingEnabled: true, safety };

    const fixture = operation['x-atlas-polling'];
    if (fixture && typeof fixture === 'object') {
      const parsed = pollingFixtureSchema.parse(fixture);
      if (
        parsed.path.startsWith('//') ||
        parsed.expectedSuccess.status < 200 ||
        parsed.expectedSuccess.status > 299
      ) {
        throw new Error(`Invalid polling fixture for ${capability.identity.operationId}`);
      }
      return {
        ...parsed,
        expectedSuccess: { status: parsed.expectedSuccess.status },
        operationId: capability.identity.operationId,
        owner: ownerFor(operation),
        pollingEnabled: true,
        safety,
      };
    }

    const parameters = [
      ...(Array.isArray(fragment.pathParameters) ? fragment.pathParameters : []),
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ]
      .map((parameter) => parameterExample(document, parameter))
      .filter((parameter): parameter is NonNullable<typeof parameter> => parameter !== null);
    let path = contractPath;
    for (const parameter of parameters.filter(({ location }) => location === 'path')) {
      path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(parameter.value));
    }
    const query = new URLSearchParams();
    for (const parameter of parameters.filter(
      ({ location, required }) => location === 'query' && required,
    )) {
      query.set(parameter.name, parameter.value);
    }
    if ([...query].length > 0) path += `?${query.toString()}`;

    const documentedSuccess = Object.keys(objectValue(operation.responses) ?? {})
      .map(Number)
      .find((status) => status >= 200 && status <= 299);
    return {
      operationId: capability.identity.operationId,
      owner: ownerFor(operation),
      method,
      path,
      requestBody: requestBodyFor(document, operation),
      expectedSuccess: { status: documentedSuccess ?? 200 },
      recognizedError: {
        status: 400 as const,
        code: 'required_field_missing',
        codePath: ['code'],
        fieldPathPath: ['fieldPath'],
      },
      // Only parameter-free reads have a request we can safely and reliably infer.
      // Mutations and resource lookups require an explicit isolated polling fixture.
      pollingEnabled:
        fixture !== false &&
        method === 'GET' &&
        !contractPath.includes('{') &&
        !parameters.some(({ required }) => required),
      safety,
    };
  });
}

function annotationsFor(operations: ReturnType<typeof operationsFromDocument>) {
  return operations.map((operation) => ({
    capability: { operationId: operation.operationId },
    owner: operation.owner,
    secretAlias: null,
    businessSemantics: { sourceType: 'internal', provider: 'Burger Town' },
    ...operation.safety,
    fieldRenames: [],
  }));
}

async function approveCapabilities(
  client: PoolClient,
  organizationId: string,
  capabilityVersionIds: readonly string[],
  actorId: string,
) {
  await client.query(
    `INSERT INTO manifest_annotation_approvals
      (organization_id, manifest_annotation_id, approved_by)
     SELECT version.organization_id, version.manifest_annotation_id, $3
     FROM capability_versions version
     WHERE version.organization_id = $1
       AND version.capability_version_id = ANY($2::char(64)[])
     ON CONFLICT (organization_id, manifest_annotation_id) DO UPDATE
       SET revoked_at = NULL, approved_by = EXCLUDED.approved_by, approved_at = current_timestamp`,
    [organizationId, capabilityVersionIds, actorId],
  );
  await client.query(
    `INSERT INTO capability_approvals
      (organization_id, capability_version_id, approved_by)
     SELECT $1, unnest($2::char(64)[]), $3
     ON CONFLICT (organization_id, capability_version_id) DO UPDATE
       SET revoked_at = NULL, approved_by = EXCLUDED.approved_by, approved_at = current_timestamp`,
    [organizationId, capabilityVersionIds, actorId],
  );
}

async function installPoliciesAndPolling(
  client: PoolClient,
  input: {
    organizationId: string;
    environmentId: string;
    applicationUrl: string;
    actorId: string;
    operations: ReturnType<typeof operationsFromDocument>;
    capabilityVersionByOperation: ReadonlyMap<string, string>;
  },
) {
  const hostname = new URL(input.applicationUrl).hostname;
  for (const operation of input.operations) {
    const capabilityVersionId = input.capabilityVersionByOperation.get(operation.operationId)!;
    await client.query(
      `INSERT INTO capability_host_policies
        (organization_id, capability_identity_id, environment_id, hostname, approved_by)
       SELECT version.organization_id, version.capability_identity_id, $3, $4, $5
       FROM capability_versions version
       WHERE version.organization_id = $1 AND version.capability_version_id = $2
       ON CONFLICT (organization_id, capability_identity_id, environment_id, hostname)
       DO UPDATE SET revoked_at = NULL, approved_by = EXCLUDED.approved_by,
         approved_at = current_timestamp, allow_redirects = false`,
      [input.organizationId, capabilityVersionId, input.environmentId, hostname, input.actorId],
    );
    await client.query(
      `INSERT INTO capability_execution_bindings
        (organization_id, environment_id, capability_identity_id, base_url, configured_by)
       SELECT organization_id, $3, capability_identity_id, $4, $5
       FROM capability_versions
       WHERE organization_id = $1 AND capability_version_id = $2
       ON CONFLICT (organization_id, environment_id, capability_identity_id)
       DO UPDATE SET base_url = EXCLUDED.base_url, configured_by = EXCLUDED.configured_by,
         configured_at = current_timestamp`,
      [
        input.organizationId,
        capabilityVersionId,
        input.environmentId,
        input.applicationUrl,
        input.actorId,
      ],
    );
    const definitionKey = `burger-town:${operation.operationId}`;
    const latest = await client.query<{
      revision: number;
      enabled: boolean;
      capability_version_id: string;
      application_url: string;
      method: string;
      path: string;
      request_body: Record<string, unknown>;
      expected_success: Record<string, unknown>;
      recognized_error: Record<string, unknown>;
    }>(
      `SELECT revision, enabled, capability_version_id, application_url, method, path, request_body,
              expected_success, recognized_error
       FROM capability_polling_definitions
       WHERE organization_id = $1 AND environment_id = $2 AND definition_key = $3
       ORDER BY revision DESC
       LIMIT 1`,
      [input.organizationId, input.environmentId, definitionKey],
    );
    const previous = latest.rows[0];
    if (!operation.pollingEnabled && !previous) continue;
    const unchanged =
      previous?.enabled === operation.pollingEnabled &&
      previous?.capability_version_id.trim() === capabilityVersionId &&
      previous.application_url === input.applicationUrl &&
      previous.method === operation.method &&
      previous.path === operation.path &&
      canonicalJson(previous.request_body) === canonicalJson(operation.requestBody) &&
      canonicalJson(previous.expected_success) === canonicalJson(operation.expectedSuccess) &&
      canonicalJson(previous.recognized_error) === canonicalJson(operation.recognizedError);
    if (unchanged) continue;
    await client.query(
      `INSERT INTO capability_polling_definitions
        (organization_id, environment_id, capability_version_id, definition_key, revision,
         application_url, method, path, request_body, expected_success, recognized_error,
         configured_by, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.organizationId,
        input.environmentId,
        capabilityVersionId,
        definitionKey,
        (previous?.revision ?? 0) + 1,
        input.applicationUrl,
        operation.method,
        operation.path,
        operation.requestBody,
        operation.expectedSuccess,
        operation.recognizedError,
        input.actorId,
        operation.pollingEnabled,
      ],
    );
  }
}

export async function connectBurgerTown(
  pool: Pool,
  sourcePolicy: CapabilitySourcePolicy,
  rawInput: BurgerTownConnectionInput,
  options: {
    actorId: string;
    allowedApplicationUrls: readonly string[];
    allowedOpenApiUrls: readonly string[];
    plan: BurgerTownConnectionPlan;
    plannerModel?: Parameters<typeof addDiscoveryCoverage>[3];
    now?: () => Date;
  },
) {
  const input = burgerTownConnectionSchema.parse(rawInput);
  const plan = checkPlan(options.plan);
  requireAgreedAddress(
    input.applicationUrl,
    options.allowedApplicationUrls,
    'Burger Town application address',
  );
  requireAgreedAddress(input.openApiUrl, options.allowedOpenApiUrls, 'Burger Town OpenAPI address');
  const arazzoUrl = input.arazzoUrl ?? arazzoUrlBesideOpenApi(input.openApiUrl);
  requireAgreedAddress(
    arazzoUrl,
    options.allowedOpenApiUrls.map(arazzoUrlBesideOpenApi),
    'Burger Town Arazzo address',
  );
  await checkApplication(input.applicationUrl, sourcePolicy);
  const document = await fetchOpenApiDocument(input.openApiUrl, sourcePolicy);
  const arazzoYaml = await fetchArazzoDocument(arazzoUrl, sourcePolicy);
  const discovered = await validateAndDiscoverCapabilities('openapi', document, plan.serviceId);
  const operations = operationsFromDocument(document, discovered, plan);
  const annotations = annotationsFor(operations);

  const connected = await (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const confirmedAt = await resolveConfirmationTimestamp(
        client,
        input,
        plan.serviceId,
        document,
        annotations,
        options.now ?? (() => new Date()),
      );
      const discovery = await discoverCapabilitiesInTransaction(client, {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        serviceId: plan.serviceId,
        trigger: 'repository-push',
        source: {
          format: 'openapi',
          document,
          url: input.openApiUrl,
          evidence: {
            kind: 'human-confirmed',
            label: 'Burger Town OpenAPI',
            confirmedBy: options.actorId,
            confirmedAt,
          },
        },
        manifest: {
          source: {
            kind: 'human-confirmed',
            label: 'Burger Town prepared safety settings',
            confirmedBy: options.actorId,
            confirmedAt,
          },
          annotations,
        },
      });
      const capabilityVersionByOperation = new Map(
        discovery.capabilities.map((capability) => [
          capability.identity.operationId,
          capability.capabilityVersionId,
        ]),
      );
      const capabilityVersionIds = [...capabilityVersionByOperation.values()];
      await approveCapabilities(
        client,
        input.organizationId,
        capabilityVersionIds,
        options.actorId,
      );
      await installPoliciesAndPolling(client, {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        applicationUrl: input.applicationUrl,
        actorId: options.actorId,
        operations,
        capabilityVersionByOperation,
      });
      await installConnectedSandboxTargets(client, {
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        applicationUrl: input.applicationUrl,
        capabilityVersionIds,
        metadata: document['x-atlas-sandbox'],
        actorId: options.actorId,
      });
      await client.query(
        `INSERT INTO capability_monitoring_state (organization_id, environment_id, state)
       VALUES ($1, $2, 'stopped')
       ON CONFLICT (organization_id, environment_id) DO NOTHING`,
        [input.organizationId, input.environmentId],
      );
      let arazzoWorkflowCount = 0;
      if (arazzoYaml) {
        const stored = await saveCapabilityArchitecture(client, {
          organizationId: input.organizationId,
          environmentId: input.environmentId,
          serviceId: plan.serviceId,
          sourceUrl: arazzoUrl,
          documentYaml: arazzoYaml,
          confirmedAt: new Date(confirmedAt),
        });
        arazzoWorkflowCount = stored.workflows.length;
      }
      const monitoring = await client.query<{ state: string }>(
        `SELECT state FROM capability_monitoring_state
       WHERE organization_id = $1 AND environment_id = $2`,
        [input.organizationId, input.environmentId],
      );
      await client.query('COMMIT');
      return {
        ...discovery,
        pollingDefinitionCount: operations.filter(({ pollingEnabled }) => pollingEnabled).length,
        monitoringState: monitoring.rows[0]!.state,
        arazzoWorkflowCount,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  })();
  return {
    ...connected,
    ...(await addDiscoveryCoverage(pool, input.organizationId, connected, options.plannerModel)),
  };
}
