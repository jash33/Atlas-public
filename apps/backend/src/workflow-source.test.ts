import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  compileWorkflowSource,
  renderWorkflowSource,
  type WorkflowSourceProjection,
} from './workflow-source.js';

const projection: WorkflowSourceProjection = {
  fingerprint: 'a'.repeat(64),
  capabilities: [
    {
      capabilityVersionId: 'payment-get@immutable-v1',
      identity: { kind: 'openapi', serviceId: 'payment-api', operationId: 'getPayment' },
      annotation: { irreversibleAfter: false },
      // A source that declares no inputs inherits this step's required request fields.
      fragment: {
        operation: {
          parameters: [
            { name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } },
          ],
        },
        references: {},
      },
    },
    {
      capabilityVersionId: 'billing-pay@immutable-v3',
      identity: { kind: 'openapi', serviceId: 'billing-api', operationId: 'markInvoicePaid' },
      annotation: { irreversibleAfter: true },
    },
  ],
};

const validSource = `
formatVersion: atlas-source/v1
projectionFingerprint: ${'a'.repeat(64)}
workflow:
  steps:
    - id: load-payment
      kind: capabilityCall
      capability: payment-api:getPayment
      arguments:
        paymentId:
          source: input
          path: [paymentId]
      result: payment
    - id: mark-paid
      kind: capabilityCall
      capability: billing-api:markInvoicePaid
      arguments:
        invoiceId:
          source: stepOutput
          stepId: load-payment
          path: [invoiceId]
    - id: complete
      kind: terminal
      state: completed
`;

const hostileFixtureRoot = new URL('./fixtures/hostile-workflow-source/', import.meta.url);

function hostileFixture(filename: string) {
  return readFileSync(new URL(filename, hostileFixtureRoot), 'utf8');
}

describe('the workflow source compiler boundary', () => {
  it.each([2, 3] as const)(
    'adds duplicate protection when revalidating IR v%s without a retry policy',
    async (irVersion) => {
      const executable = {
        irVersion,
        ...(irVersion === 3 ? { startStepId: 'first' } : {}),
        inputSchema: { required: { orderId: { type: 'string' } } },
        steps: [
          {
            id: 'first',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing-pay@immutable-v3',
            inputSchema: { required: {} },
            arguments: {},
            ...(irVersion === 3 ? { next: 'second' } : {}),
          },
          {
            id: 'second',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing-pay@immutable-v3',
            inputSchema: { required: {} },
            arguments: {},
            idempotency: { businessKey: { source: 'input', path: ['orderId'] } },
            ...(irVersion === 3 ? { next: 'read' } : {}),
          },
          {
            id: 'read',
            kind: 'capabilityCall',
            capabilityVersionId: 'payment-get@immutable-v1',
            inputSchema: { required: {} },
            arguments: {},
            ...(irVersion === 3 ? { next: 'done' } : {}),
          },
          { id: 'done', kind: 'terminal', state: 'completed' },
        ],
      };
      const original = structuredClone(executable);
      const result = await compileWorkflowSource(executable, {
        organizationId: 'org_atlas',
        workflowVersionId: 'revalidated',
        projection: {
          ...projection,
          capabilities: projection.capabilities.map((capability) => ({
            ...capability,
            annotation: {
              ...capability.annotation,
              ...(capability.identity.serviceId === 'billing-api'
                ? { idempotencyField: 'idempotency_key' }
                : {}),
            },
          })),
        },
      });
      expect(result).toMatchObject({
        success: true,
        workflow: {
          executable: {
            steps: [
              { idempotency: { businessKey: { source: 'input', path: ['atlasWorkflowRunId'] } } },
              { idempotency: { businessKey: { source: 'input', path: ['orderId'] } } },
              { id: 'read' },
              { id: 'done' },
            ],
          },
        },
      });
      if (!result.success) throw new Error('Expected revalidation to succeed');
      expect(result.workflow.executable.steps[2]).not.toHaveProperty('idempotency');
      expect(result.workflow.executable.inputSchema).toEqual(executable.inputSchema);
      expect(executable).toEqual(original);
    },
  );

  it('adds duplicate protection to YAML without changing explicitly mapped keys', async () => {
    const result = await compileWorkflowSource(validSource, {
      organizationId: 'org_atlas',
      workflowVersionId: 'yaml-duplicate-protection',
      projection: {
        ...projection,
        capabilities: projection.capabilities.map((capability) => ({
          ...capability,
          annotation: { ...capability.annotation, idempotencyField: 'paymentId' },
        })),
      },
    });
    expect(result).toMatchObject({
      success: true,
      workflow: {
        executable: {
          steps: [
            { idempotency: { businessKey: { source: 'input', path: ['paymentId'] } } },
            { idempotency: { businessKey: { source: 'input', path: ['atlasWorkflowRunId'] } } },
            { kind: 'terminal' },
          ],
        },
      },
    });
  });

  it('reproducibly resolves names and derives all backend-owned IR fields', async () => {
    const first = await compileWorkflowSource(validSource, {
      organizationId: 'org_atlas',
      workflowVersionId: 'payment-to-billing@1',
      projection,
    });
    const second = await compileWorkflowSource(validSource, {
      organizationId: 'org_atlas',
      workflowVersionId: 'payment-to-billing@1',
      projection,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      success: true,
      workflow: {
        workflowVersionId: 'payment-to-billing@1',
        executionRequirements: {
          organizationId: 'org_atlas',
          workflowVersionId: 'payment-to-billing@1',
          requiredCapabilityVersionIds: ['billing-pay@immutable-v3', 'payment-get@immutable-v1'],
        },
        executable: {
          irVersion: 2,
          inputSchema: { required: { paymentId: { type: 'string' } } },
          steps: [
            { capabilityVersionId: 'payment-get@immutable-v1' },
            { capabilityVersionId: 'billing-pay@immutable-v3', irreversibleAfter: true },
            { kind: 'terminal' },
          ],
        },
      },
      provenance: {
        sourceFormatVersion: 'atlas-source/v1',
        projectionFingerprint: 'a'.repeat(64),
        compiler: { name: 'atlas-workflow-compiler', version: '1' },
      },
    });
    expect(first.success && first.workflow.irHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.success && first.provenance.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('compiles explicit API transformations from reviewable Atlas YAML into IR v2', async () => {
    const source = `
formatVersion: atlas-source/v1
projectionFingerprint: ${'a'.repeat(64)}
workflow:
  irVersion: 2
  steps:
    - id: load-payment
      kind: capabilityCall
      capability: payment-api:getPayment
      inputSchema:
        required:
          paymentId: { type: string }
      arguments:
        paymentId: { source: input, path: [paymentId] }
    - id: settle-invoice
      kind: capabilityCall
      capability: billing-api:markInvoicePaid
      inputSchema:
        required:
          invoiceId: { type: string }
          payment:
            type: object
            required:
              amount: { type: number }
              currency: { type: string }
      arguments:
        invoiceId: { source: stepOutput, stepId: load-payment, path: [invoice_id] }
        payment:
          kind: object
          fields:
            amount:
              kind: call
              function: divide
              arguments:
                - { source: stepOutput, stepId: load-payment, path: [amount_cents] }
                - { source: literal, value: 100 }
            currency:
              kind: call
              function: uppercase
              arguments:
                - { source: stepOutput, stepId: load-payment, path: [currency] }
`;

    const result = await compileWorkflowSource(source, {
      organizationId: 'org_atlas',
      workflowVersionId: 'mapping-demo@1',
      projection,
    });

    expect(result).toMatchObject({
      success: true,
      workflow: {
        executable: {
          irVersion: 2,
          steps: [
            { capabilityVersionId: 'payment-get@immutable-v1' },
            {
              capabilityVersionId: 'billing-pay@immutable-v3',
              arguments: {
                payment: {
                  fields: {
                    amount: { function: 'divide' },
                    currency: { function: 'uppercase' },
                  },
                },
              },
            },
          ],
        },
      },
    });
    if (!result.success) throw new Error('Expected the mapping source to compile');
    const rendered = renderWorkflowSource(result.workflow, projection);
    const roundTrip = await compileWorkflowSource(rendered, {
      organizationId: 'org_atlas',
      workflowVersionId: 'mapping-demo@1',
      projection,
    });
    expect(roundTrip.success && roundTrip.workflow.irHash).toBe(result.workflow.irHash);
  });

  it.each([
    ['malformed YAML', hostileFixture('01-malformed.atlas.yaml'), 'YAML_PARSE_FAILED'],
    ['aliases', hostileFixture('02-alias.atlas.yaml'), 'YAML_ALIAS_FORBIDDEN'],
    ['custom tags', hostileFixture('03-custom-tag.atlas.yaml'), 'YAML_CUSTOM_TAG'],
    ['dynamic URLs', hostileFixture('04-dynamic-url.atlas.yaml'), 'SOURCE_SCHEMA_INVALID'],
    [
      'executable content',
      hostileFixture('05-executable-content.atlas.yaml'),
      'SOURCE_SCHEMA_INVALID',
    ],
    [
      'backend-owned fields',
      hostileFixture('06-backend-owned-fields.atlas.yaml'),
      'SOURCE_SCHEMA_INVALID',
    ],
  ])(
    'rejects hostile %s input with structured diagnostics',
    async (_name, source, expectedCode) => {
      expect.hasAssertions();
      await expectStructuredDiagnostic(source, expectedCode);
    },
  );

  it('rejects fabricated capabilities and stale planner projections', async () => {
    const fabricated = await compileWorkflowSource(
      validSource.replace('payment-api:getPayment', 'payment-api:invented'),
      { organizationId: 'org_atlas', workflowVersionId: 'wf@1', projection },
    );
    const stale = await compileWorkflowSource(
      validSource.replace(
        /^projectionFingerprint:.*$/m,
        `projectionFingerprint: ${'b'.repeat(64)}`,
      ),
      {
        organizationId: 'org_atlas',
        workflowVersionId: 'wf@1',
        projection,
      },
    );

    expect(fabricated.diagnostics.map(({ code }) => code)).toContain(
      'CAPABILITY_NOT_FOUND_IN_PROJECTION',
    );
    expect(stale.diagnostics.map(({ code }) => code)).toContain('PROJECTION_FINGERPRINT_MISMATCH');
  });

  it('bounds source bytes, nesting depth, and step count', async () => {
    expect.hasAssertions();
    const oversized = `${validSource}\n# ${'x'.repeat(256 * 1024)}`;
    const tooManySteps = `
formatVersion: atlas-source/v1
projectionFingerprint: ${'a'.repeat(64)}
workflow:
  steps:
${Array.from({ length: 257 }, (_, index) => `    - { id: terminal-${index}, kind: terminal, state: completed }`).join('\n')}
`;
    const tooDeep = `
formatVersion: atlas-source/v1
projectionFingerprint: ${'a'.repeat(64)}
workflow:
  steps:
    - id: complete
      kind: terminal
      state: ${'['.repeat(40)}completed${']'.repeat(40)}
`;

    await expectStructuredDiagnostic(oversized, 'SOURCE_SIZE_LIMIT');
    await expectStructuredDiagnostic(tooManySteps, 'SOURCE_SCHEMA_INVALID');
    await expectStructuredDiagnostic(tooDeep, 'SOURCE_DEPTH_LIMIT');
  });

  it('rejects missing, forward, and cyclic step dependencies', async () => {
    expect.hasAssertions();
    const forward = validSource.replace('stepId: load-payment', 'stepId: complete');
    const missing = validSource.replace('stepId: load-payment', 'stepId: absent');
    const cyclic = validSource.replace(
      'source: input\n          path: [paymentId]',
      'source: stepOutput\n          stepId: mark-paid\n          path: [paymentId]',
    );

    await expectCodes(forward, ['STEP_REFERENCE_FORWARD']);
    await expectCodes(missing, ['STEP_REFERENCE_MISSING']);
    await expectCodes(cyclic, ['STEP_DEPENDENCY_CYCLE']);
  });

  it('keeps existing JSON IR inputs working while ignoring supplied hashes and requirements', async () => {
    const yamlResult = await compileWorkflowSource(validSource, {
      organizationId: 'org_atlas',
      workflowVersionId: 'wf@1',
      projection,
    });
    if (!yamlResult.success) throw new Error('fixture did not compile');
    const legacy = {
      ...yamlResult.workflow,
      irHash: '0'.repeat(64),
      executionRequirements: {
        organizationId: 'attacker',
        workflowVersionId: 'fabricated',
        irHash: '0'.repeat(64),
        requiredCapabilityVersionIds: ['fabricated'],
      },
    };

    const result = await compileWorkflowSource(legacy, {
      organizationId: 'org_atlas',
      workflowVersionId: 'wf@2',
      projection,
    });

    expect(result).toMatchObject({
      success: true,
      workflow: {
        workflowVersionId: 'wf@2',
        executionRequirements: { organizationId: 'org_atlas', workflowVersionId: 'wf@2' },
      },
    });
    expect(result.success && result.workflow.irHash).not.toBe('0'.repeat(64));
  });

  it('validates dependency structure for legacy JSON IR before assigning trusted fields', async () => {
    const yamlResult = await compileWorkflowSource(validSource, {
      organizationId: 'org_atlas',
      workflowVersionId: 'wf@1',
      projection,
    });
    if (!yamlResult.success) throw new Error('fixture did not compile');
    const invalidLegacy = structuredClone(yamlResult.workflow.executable);
    const referencedStep = invalidLegacy.steps[1];
    if (referencedStep?.kind !== 'capabilityCall') throw new Error('fixture step changed');
    referencedStep.arguments.invoiceId = {
      source: 'stepOutput',
      stepId: 'absent',
      path: ['invoiceId'],
    };

    const result = await compileWorkflowSource(invalidLegacy, {
      organizationId: 'org_atlas',
      workflowVersionId: 'wf@2',
      projection,
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain('LEGACY_IR_STRUCTURE_INVALID');
  });

  it('uses JCS for stable source provenance independent of Unicode key insertion order', async () => {
    const firstSource = validSource.replace(
      'arguments:\n        paymentId:',
      'arguments:\n        "ä": { source: literal, value: first }\n        "ä": { source: literal, value: second }\n        paymentId:',
    );
    const secondSource = validSource.replace(
      'arguments:\n        paymentId:',
      'arguments:\n        "ä": { source: literal, value: second }\n        "ä": { source: literal, value: first }\n        paymentId:',
    );

    const first = await compileWorkflowSource(firstSource, {
      organizationId: 'org_atlas',
      workflowVersionId: 'wf@1',
      projection,
    });
    const second = await compileWorkflowSource(secondSource, {
      organizationId: 'org_atlas',
      workflowVersionId: 'wf@1',
      projection,
    });

    expect(first.success && first.provenance.sourceSha256).toBe(
      second.success && second.provenance.sourceSha256,
    );
  });

  it('rejects undocumented partially qualified capability names', async () => {
    const asyncProjection: WorkflowSourceProjection = {
      ...projection,
      capabilities: [
        ...projection.capabilities,
        {
          capabilityVersionId: 'event@immutable-v1',
          identity: {
            kind: 'asyncapi',
            serviceId: 'events',
            operationId: 'publish',
            channelAddress: 'invoice.paid',
          },
          annotation: { irreversibleAfter: true },
        },
      ],
    };
    const source = validSource.replace('payment-api:getPayment', 'events:invoice.paid:publish');

    const result = await compileWorkflowSource(source, {
      organizationId: 'org_atlas',
      workflowVersionId: 'wf@1',
      projection: asyncProjection,
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      'CAPABILITY_NOT_FOUND_IN_PROJECTION',
    );
  });
});

async function expectCodes(source: string, expected: string[]) {
  const result = await compileWorkflowSource(source, {
    organizationId: 'org_atlas',
    workflowVersionId: 'wf@1',
    projection,
  });
  expect(result.success).toBe(false);
  expect(result.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(expected));
}

async function expectStructuredDiagnostic(source: string, code: string) {
  const result = await compileWorkflowSource(source, {
    organizationId: 'org_atlas',
    workflowVersionId: 'wf@1',
    projection,
  });
  expect(result).toMatchObject({
    success: false,
    diagnostics: expect.arrayContaining([
      {
        kind: 'compileError',
        code,
        path: expect.any(String),
        message: expect.any(String),
      },
    ]),
  });
}
