import AjvModule from 'ajv';
import addFormatsModule from 'ajv-formats';

import type {
  WorkflowSandboxProviderContractWire,
  WorkflowSandboxTargetBindingWire,
} from '@atlas/demo-estate';
import { StepActivityError, type StepInvocation } from '@atlas/runtime-ports';
import type { JsonValue, VersionedCompiledWorkflowVersion } from '@atlas/workflow-ir';

import {
  createPublishInvoicePaidHttpRequest,
  createStripePaymentIntentHttpRequest,
} from './demo-capability-activities.js';

export interface StepObservation {
  readonly stepId: string;
  readonly capabilityVersionId: string;
  readonly serializedRequest: Readonly<Record<string, JsonValue>>;
  readonly response: unknown;
  readonly status: number;
}

const schemaValidator = addFormatsModule.default(
  new AjvModule.default({ allErrors: true, strict: false }),
);

export async function seedSandboxTarget(
  fetchImplementation: typeof globalThis.fetch,
  baseUrl: string,
  targetState: Readonly<WorkflowSandboxTargetBindingWire['targetState']>,
  resourcesPath = '/__control/resources',
  expectedHostname = new URL(baseUrl).hostname,
) {
  const url = new URL(resourcesPath, `${baseUrl.replace(/\/$/, '')}/`);
  if (url.hostname !== expectedHostname) throw new Error('Sandbox target setup host mismatch');
  const response = await fetchImplementation(url, {
    method: 'PUT',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(targetState),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    throw new Error(`Sandbox target setup redirect denied${location ? ` (${location})` : ''}`);
  }
  if (!response.ok) throw new Error(`Sandbox target seed failed (${response.status})`);
}

export async function invokeSandboxProvider(
  fetchImplementation: typeof globalThis.fetch,
  baseUrl: string,
  contract: WorkflowSandboxProviderContractWire,
  invocation: StepInvocation,
  observations: StepObservation[],
  target?: { readonly authorization?: string; readonly expectedHostname?: string },
) {
  if (!contract.path || !contract.method) throw new StepActivityError('MissingProviderRoute');
  const requestInput: Record<string, JsonValue> = { ...invocation.input };
  if (contract.idempotencyField && requestInput.idempotencyKey !== undefined) {
    requestInput[contract.idempotencyField] ??= requestInput.idempotencyKey;
    if (contract.idempotencyField !== 'idempotencyKey') delete requestInput.idempotencyKey;
  }
  let url: URL;
  let init: RequestInit;
  let serializedRequest: Record<string, JsonValue>;

  if (contract.operationId === 'PostPaymentIntents') {
    const idempotencyKey =
      requestInput.idempotencyKey ?? requestInput['Idempotency-Key'] ?? 'atlas-sandbox-key';
    const normalizedInput: Record<string, JsonValue> = {
      ...requestInput,
      idempotencyKey,
    };
    [url, init] = createStripePaymentIntentHttpRequest(baseUrl, normalizedInput);
    serializedRequest = {
      amount: normalizedInput.amount!,
      currency: normalizedInput.currency!,
      'Idempotency-Key': idempotencyKey,
    };
  } else if (contract.operationId === 'publishInvoicePaid') {
    [url, init] = createPublishInvoicePaidHttpRequest(baseUrl, requestInput);
    serializedRequest = JSON.parse(String(init.body)) as Record<string, JsonValue>;
  } else {
    let path = contract.path;
    serializedRequest = {};
    for (const [name, value] of Object.entries(requestInput)) {
      const token = `{${name}}`;
      if (path.includes(token)) {
        path = path.replaceAll(token, encodeURIComponent(providerScalar(value)));
        serializedRequest[name] = value;
        delete requestInput[name];
      }
    }
    Object.assign(serializedRequest, requestInput);
    url = new URL(path.replace(/^\//, ''), `${baseUrl.replace(/\/$/, '')}/`);
    init = {
      method: contract.method.toUpperCase(),
      redirect: 'manual',
      ...(contract.method.toLowerCase() === 'get'
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(requestInput),
          }),
    };
  }

  const headers = new Headers(init.headers);
  headers.set('x-atlas-sandbox-step-id', invocation.stepId);
  if (target?.authorization) {
    headers.set('authorization', `Bearer ${target.authorization}`);
  } else if (contract.serviceId === 'slack' || contract.serviceId === 'hubspot') {
    headers.set('authorization', 'Bearer atlas-sandbox-token');
  }
  init = { ...init, headers };
  if (target?.expectedHostname && url.hostname !== target.expectedHostname) {
    throw new StepActivityError('SandboxTargetHostMismatch');
  }
  const observationIndex =
    observations.push({
      stepId: invocation.stepId,
      capabilityVersionId: invocation.capabilityVersionId,
      serializedRequest,
      response: null,
      status: 408,
    }) - 1;
  let response: Response;
  try {
    response = await fetchImplementation(url, init);
  } catch {
    throw new StepActivityError('SandboxTargetUnreachable');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new StepActivityError('SandboxTargetRedirectDenied');
  }
  const output: unknown = response.headers.get('content-type')?.includes('json')
    ? await response.json()
    : null;
  observations[observationIndex] = {
    stepId: invocation.stepId,
    capabilityVersionId: invocation.capabilityVersionId,
    serializedRequest,
    response: output,
    status: response.status,
  };
  if (!response.ok) throw new StepActivityError(providerErrorType(output));
  if (!isRecord(output)) throw new StepActivityError('ResponseSchemaMismatch');
  return output as Readonly<Record<string, JsonValue>>;
}

function providerErrorType(output: unknown) {
  if (!isRecord(output)) return 'DownstreamRequestFailed';
  if (typeof output.error === 'string') return output.error;
  if (typeof output.category === 'string') return output.category;
  const error = isRecord(output.error) ? output.error : undefined;
  return typeof error?.type === 'string' ? error.type : 'DownstreamRequestFailed';
}

export function sampleWorkflowInput(workflow: VersionedCompiledWorkflowVersion) {
  const schema = isRecord(workflow.executable.inputSchema)
    ? workflow.executable.inputSchema
    : undefined;
  const required = isRecord(schema?.required) ? schema.required : {};
  return Object.fromEntries(
    Object.entries(required).map(([name, fieldSchema]) => [name, sampleValue(fieldSchema, name)]),
  ) as Readonly<Record<string, JsonValue>>;
}

export function matchesPinnedSchema(value: unknown, schema: unknown): boolean {
  if (!isRecord(schema)) return true;
  try {
    return schemaValidator.validate(schema, value) as boolean;
  } catch {
    return false;
  }
}

function sampleValue(schemaValue: unknown, name: string): JsonValue {
  const schema = isRecord(schemaValue) ? schemaValue : {};
  if (schema.example !== undefined) return schema.example as JsonValue;
  if (schema.const !== undefined) return schema.const as JsonValue;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0] as JsonValue;
  if (name.toLowerCase().includes('version')) return 1;
  if (schema.type === 'number' || schema.type === 'integer') return 100;
  if (schema.type === 'boolean') return true;
  if (name.toLowerCase() === 'paymentid') return 'pay_sandbox';
  if (name.toLowerCase() === 'invoiceid') return 'inv_sandbox';
  return 'atlas-test';
}

function providerScalar(value: JsonValue): string {
  if (value === null || typeof value === 'object') {
    throw new StepActivityError('InvalidProviderScalar');
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
