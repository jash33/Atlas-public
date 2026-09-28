import {
  workflowSandboxProviderModes,
  workflowSandboxTestKinds,
  type WorkflowSandboxOutcomeWire,
} from '@atlas/demo-estate';
import type { Hono } from 'hono';
import { z } from 'zod';

import { serviceOperations } from './operations.js';

const suiteSchema = z.object({
  organizationId: z.string().min(1).default('org_atlas'),
  environmentId: z.string().min(1).default('production'),
  workflowVersionId: z.string().min(1),
  irHash: z.string().regex(/^[a-f0-9]{64}$/),
  workflow: z.object({
    executable: z.object({
      inputSchema: z.unknown().optional(),
      steps: z.array(z.record(z.string(), z.unknown())),
    }),
  }),
  providerContracts: z.array(
    z.object({
      capabilityVersionId: z.string().min(1),
      serviceId: z.string().min(1),
      operationId: z.string().min(1),
      documentHash: z.string().regex(/^[a-f0-9]{64}$/),
      provider: z.string().min(1),
      mode: z.enum(workflowSandboxProviderModes),
      method: z.string().nullable(),
      path: z.string().nullable(),
      requestSchema: z.unknown(),
      responseSchema: z.unknown(),
    }),
  ),
  tests: z.array(
    z.object({
      testId: z.string().min(1),
      kind: z.enum(workflowSandboxTestKinds),
      stepId: z.string().nullable(),
      capabilityVersionId: z.string().nullable(),
      expectation: z.string().min(1),
      requestSample: z.record(z.string(), z.unknown()).nullable(),
      expectedResponseSchema: z.unknown(),
      failureErrorType: z.string().min(1).optional(),
    }),
  ),
});

export type ParsedWorkflowSandboxSuite = z.infer<typeof suiteSchema>;
export type ParsedWorkflowSandboxTest = ParsedWorkflowSandboxSuite['tests'][number];
type UnboundWorkflowSandboxOutcome = Omit<
  WorkflowSandboxOutcomeWire,
  'workerVersion' | 'runtimeVersion'
>;

function documentContainsOperation(document: unknown, operationId: string): boolean {
  if (!document || typeof document !== 'object') return false;
  if (Array.isArray(document)) {
    return document.some((value) => documentContainsOperation(value, operationId));
  }
  const record = document as Record<string, unknown>;
  if (record.operationId === operationId || Object.hasOwn(record, operationId)) return true;
  return Object.values(record).some((value) => documentContainsOperation(value, operationId));
}

export async function runWorkflowSandboxSuite(
  rawSuite: unknown,
  documents: Record<string, unknown>,
  execute: (
    suite: ParsedWorkflowSandboxSuite,
    test: ParsedWorkflowSandboxTest,
  ) => Promise<{
    passed: boolean;
    detail: string;
    executionMethods: WorkflowSandboxOutcomeWire['executionMethods'];
  }>,
): Promise<{ outcomes: UnboundWorkflowSandboxOutcome[] }> {
  const suite = suiteSchema.parse(rawSuite);
  const unsupportedContracts = new Set(
    suite.providerContracts
      .filter((contract) => {
        const document = documents[contract.serviceId];
        if (!documentContainsOperation(document, contract.operationId)) return true;
        if (contract.mode !== 'official-test') return false;
        const connection = (document as Record<string, unknown>)?.['x-atlas-connection'];
        return (
          !connection ||
          typeof connection !== 'object' ||
          (connection as Record<string, unknown>).mode !== 'official-test'
        );
      })
      .map((contract) => contract.capabilityVersionId),
  );
  const outcomes: UnboundWorkflowSandboxOutcome[] = [];
  for (const test of suite.tests) {
    if (test.kind === 'compatibility') {
      const contract = test.capabilityVersionId
        ? suite.providerContracts.find(
            ({ capabilityVersionId }) => capabilityVersionId === test.capabilityVersionId,
          )
        : undefined;
      const document = contract ? documents[contract.serviceId] : undefined;
      const compatible =
        contract !== undefined &&
        documentContainsOperation(document, contract.operationId) &&
        responseMatchesSchema(test.requestSample, contract.requestSchema) &&
        JSON.stringify(test.expectedResponseSchema) === JSON.stringify(contract.responseSchema);
      outcomes.push({
        testId: test.testId,
        status: compatible ? 'passed' : 'failed',
        executionMethods: ['static-validation'],
        detail: compatible
          ? 'The generated request and expected response match the pinned schemas without executing a service.'
          : 'The generated shapes are not compatible with the pinned schemas.',
      });
      continue;
    }
    const supported =
      test.capabilityVersionId === null
        ? unsupportedContracts.size === 0
        : !unsupportedContracts.has(test.capabilityVersionId);
    if (!supported) {
      outcomes.push({
        testId: test.testId,
        status: 'failed',
        executionMethods: ['static-validation'],
        detail: 'The selected provider sandbox does not expose the pinned operation.',
      });
      continue;
    }
    const result = await execute(suite, test);
    outcomes.push({
      testId: test.testId,
      status: result.passed ? 'passed' : 'failed',
      executionMethods: result.executionMethods,
      detail: result.detail,
    });
  }
  return { outcomes };
}

function responseMatchesSchema(value: unknown, schemaValue: unknown): boolean {
  const schema = recordValue(schemaValue);
  if (!schema) return true;
  if (schema.const !== undefined && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === 'object' || schema.properties) {
    const record = recordValue(value);
    if (!record) return false;
    if (
      Array.isArray(schema.required) &&
      schema.required.some((property) => typeof property === 'string' && !(property in record))
    ) {
      return false;
    }
    const properties = recordValue(schema.properties) ?? {};
    return Object.entries(properties).every(
      ([property, child]) =>
        !(property in record) || responseMatchesSchema(record[property], child),
    );
  }
  if (schema.type === 'array') {
    return Array.isArray(value) && value.every((item) => responseMatchesSchema(item, schema.items));
  }
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'null') return value === null;
  return true;
}

export async function executeProviderSandboxCase(
  suite: ParsedWorkflowSandboxSuite,
  testCase: ParsedWorkflowSandboxTest,
  providerFactory: (onRemoteSandboxRequest: (serviceId: string) => void) => Hono,
): Promise<{
  passed: boolean;
  detail: string;
  executionMethods: WorkflowSandboxOutcomeWire['executionMethods'];
}> {
  if (testCase.kind !== 'authentication') {
    return {
      passed: false,
      detail: 'Workflow behavior checks must execute through the customer worker and Temporal.',
      executionMethods: ['static-validation'],
    };
  }
  const contract = testCase.capabilityVersionId
    ? suite.providerContracts.find(
        ({ capabilityVersionId }) => capabilityVersionId === testCase.capabilityVersionId,
      )
    : undefined;
  if (!contract) {
    return {
      passed: false,
      detail: 'Pinned provider contract was not found.',
      executionMethods: ['static-validation'],
    };
  }

  const executionMethods = new Set<WorkflowSandboxOutcomeWire['executionMethods'][number]>([
    'local-test-service',
  ]);
  const provider = providerFactory(() => executionMethods.add('remote-sandbox'));
  const unauthenticated = await invokeProvider(provider, contract, testCase.requestSample, false);
  const authenticated = await invokeProvider(provider, contract, testCase.requestSample, true);
  const passed = unauthenticated.status === 401 && authenticated.ok;
  return {
    passed,
    detail: passed
      ? 'Missing credentials were rejected and sandbox credentials succeeded.'
      : `Authentication responses were ${unauthenticated.status}/${authenticated.status}.`,
    executionMethods: [...executionMethods],
  };
}

async function invokeProvider(
  provider: Hono,
  target: ParsedWorkflowSandboxSuite['providerContracts'][number],
  sample: Record<string, unknown> | null,
  authenticated: boolean,
) {
  const operation = Object.values(serviceOperations).find(
    (candidate) => candidate.operationId === target.operationId,
  );
  if (!operation) return new Response(null, { status: 501 });
  const input = sample ?? {};
  let path: string = operation.path;
  for (const [name, value] of Object.entries(input)) {
    path = path.replace(`:${name}`, encodeURIComponent(String(value)));
  }
  const headers = new Headers();
  if (authenticated && target.serviceId === 'stripe') {
    headers.set('authorization', 'Basic c2tfdGVzdF9hdGxhczph');
    const idempotencyKey = input['Idempotency-Key'];
    headers.set(
      'idempotency-key',
      typeof idempotencyKey === 'string' ? idempotencyKey : 'atlas-sandbox-key',
    );
  } else if (authenticated && (target.serviceId === 'slack' || target.serviceId === 'hubspot')) {
    headers.set('authorization', 'Bearer atlas-sandbox-token');
  }
  const bodyInput = Object.fromEntries(
    Object.entries(input).filter(([name]) => !operation.path.includes(`:${name}`)),
  );
  let body: string | undefined;
  if (operation.method !== 'get') {
    if (target.serviceId === 'stripe') {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      body = new URLSearchParams(
        Object.fromEntries(Object.entries(bodyInput).map(([name, value]) => [name, String(value)])),
      ).toString();
    } else {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(bodyInput);
    }
  }
  return provider.request(path, {
    method: operation.method.toUpperCase(),
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
