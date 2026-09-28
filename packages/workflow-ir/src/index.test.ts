import { describe, expect, it } from 'vitest';

import {
  buildWorkflowGraph,
  canonicalCapabilityComparisonStates,
  capabilityComparisonStates,
  canonicalEnvironmentIdSchema,
  canonicalEnvironmentLabels,
  compiledWorkflowVersionJsonSchema,
  compiledWorkflowVersionSchema,
  createCompiledWorkflowVersion,
  createTransformationCompiledWorkflowVersion,
  deriveStableId,
  retryPolicySchema,
  responseSchemaSchema,
  TRANSFORMATION_LIMITS,
  transformationExpressionSchema,
  validateCompiledWorkflowStructure,
  validateWorkflowInput,
  verifyCompiledWorkflowVersionIntegrity,
  versionedExecutableWorkflowSchema,
} from './index.js';

describe('environment contracts', () => {
  it('makes Development and Production canonical', () => {
    expect(canonicalEnvironmentIdSchema.options).toEqual(['development', 'production']);
    expect(canonicalEnvironmentLabels).toEqual({
      development: 'Development',
      production: 'Production',
    });
  });

  it('accepts only canonical environment identities', () => {
    expect(canonicalEnvironmentIdSchema.safeParse('production-like').success).toBe(false);
    expect(canonicalEnvironmentIdSchema.safeParse('staging').success).toBe(false);
  });

  it('exposes only canonical Production comparison states', () => {
    expect(canonicalCapabilityComparisonStates).toContain('missing-in-production');
    expect(canonicalCapabilityComparisonStates).toContain('conflicting-in-production');
    expect(canonicalCapabilityComparisonStates).not.toContain('missing-in-production-like');
    expect(capabilityComparisonStates).toBe(canonicalCapabilityComparisonStates);
  });
});

describe('CompiledWorkflowVersion', () => {
  it('hashes executable content with RFC 8785 canonical JSON', async () => {
    const executable = {
      irVersion: 1 as const,
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall' as const,
          capabilityVersionId: 'payment.get@v1',
          arguments: {
            paymentId: { source: 'input' as const, path: ['paymentId'] },
          },
          result: 'payment',
        },
        {
          id: 'settle-invoice',
          kind: 'capabilityCall' as const,
          capabilityVersionId: 'billing.settle@v1',
          arguments: {
            invoiceId: {
              source: 'stepOutput' as const,
              stepId: 'load-payment',
              path: ['invoiceId'],
            },
          },
        },
      ],
    };

    const version = await createCompiledWorkflowVersion(
      'payment-to-billing@1',
      'org_atlas_demo',
      executable,
    );

    expect(version.irHash).toBe('ea5e065d9cfc298ab279c4a5618514b98ce45b665a4c238e674911e428d99a19');
    expect(version.executable).toEqual(executable);
  });

  it('keeps requested and inferred origins on mapping edges without hashing them', async () => {
    const executable = {
      irVersion: 1 as const,
      steps: [
        {
          id: 'load-payment',
          kind: 'capabilityCall' as const,
          capabilityVersionId: 'payment.get@v1',
          arguments: {
            paymentId: { source: 'input' as const, path: ['paymentId'] },
          },
        },
        {
          id: 'create-intent',
          kind: 'capabilityCall' as const,
          capabilityVersionId: 'stripe.intent@v1',
          arguments: {
            amount: { source: 'stepOutput' as const, stepId: 'load-payment', path: ['amount'] },
            currency: { source: 'stepOutput' as const, stepId: 'load-payment', path: ['currency'] },
            'Idempotency-Key': { source: 'input' as const, path: ['paymentId'] },
          },
        },
      ],
    };
    const version = await createCompiledWorkflowVersion(
      'payment-to-intent@1',
      'org_atlas_demo',
      executable,
    );
    const withOrigins = compiledWorkflowVersionSchema.parse({
      ...version,
      mappingOrigins: [
        { stepId: 'create-intent', destinationPath: ['amount'], origin: 'requested' },
        { stepId: 'create-intent', destinationPath: ['currency'], origin: 'requested' },
        { stepId: 'create-intent', destinationPath: ['Idempotency-Key'], origin: 'inferred' },
      ],
    });

    expect(withOrigins.irHash).toBe(version.irHash);
    expect(buildWorkflowGraph(withOrigins).edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'mapping',
          label: 'amount',
          origin: 'requested',
        }),
        expect.objectContaining({
          kind: 'mapping',
          label: 'currency',
          origin: 'requested',
        }),
      ]),
    );
    expect(
      buildWorkflowGraph(withOrigins).edges.find((edge) => edge.label === 'Idempotency-Key'),
    ).toBeUndefined();
    expect(withOrigins.mappingOrigins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          destinationPath: ['Idempotency-Key'],
          origin: 'inferred',
        }),
      ]),
    );
  });

  it('accepts only the closed MVP step union', () => {
    const parsed = compiledWorkflowVersionSchema.safeParse({
      workflowVersionId: 'invalid@1',
      irHash: '0'.repeat(64),
      executionRequirements: {
        organizationId: 'org_atlas_demo',
        workflowVersionId: 'invalid@1',
        irHash: '0'.repeat(64),
        requiredCapabilityVersionIds: [],
      },
      executable: {
        irVersion: 1,
        steps: [{ id: 'dynamic-code', kind: 'script', source: 'return process.env' }],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it('rejects retry durations that the Temporal runtime cannot parse', () => {
    const policy = {
      initialInterval: '1 second',
      backoffCoefficient: 2,
      maximumInterval: '30s',
      maximumAttempts: 3,
      nonRetryableErrorTypes: [],
    };

    expect(retryPolicySchema.safeParse(policy).success).toBe(true);
    expect(retryPolicySchema.safeParse({ ...policy, initialInterval: 'PT1S' }).success).toBe(false);
  });

  it('derives namespaced stable IDs with RFC 8785 and SHA-256', async () => {
    await expect(
      deriveStableId('atlas.idempotency', ['begin-invoice-settlement', 'pay_1']),
    ).resolves.toBe(
      'atlas.idempotency:159510773d9c4fa2b870f6b8e7b8489ea2a9c823503a4e12746515e744ddcc36',
    );
  });

  it('validates workflow input against nested required fields and declared types', () => {
    const schema = {
      required: {
        paymentId: { type: 'string' as const },
        context: {
          type: 'object' as const,
          required: { retry: { type: 'boolean' as const } },
        },
      },
    };

    expect(
      validateWorkflowInput({ paymentId: 'pay_1', context: { retry: false } }, schema),
    ).toEqual([]);
    expect(validateWorkflowInput({ paymentId: 1, context: {} }, schema)).toEqual([
      { path: '$.paymentId', message: 'Expected string.' },
      { path: '$.context.retry', message: 'Required value is missing.' },
    ]);
  });

  it('preserves integer input contracts and rejects fractional values without coercion', () => {
    const schema = responseSchemaSchema.parse({ required: { quantity: { type: 'integer' } } });
    expect(validateWorkflowInput({ quantity: 2 }, schema)).toEqual([]);
    expect(validateWorkflowInput({ quantity: 1.5 }, schema)).toEqual([
      { path: '$.quantity', message: 'Expected integer.' },
    ]);
    expect(validateWorkflowInput({ quantity: '2' }, schema)).toEqual([
      { path: '$.quantity', message: 'Expected integer.' },
    ]);
  });
});

describe('workflow IR v2 transformations', () => {
  const transformedArgument = {
    kind: 'object' as const,
    fields: {
      customer: {
        kind: 'call' as const,
        function: 'uppercase' as const,
        arguments: [{ source: 'stepOutput' as const, stepId: 'load', path: ['customerName'] }],
      },
      amount: {
        kind: 'call' as const,
        function: 'divide' as const,
        arguments: [
          { source: 'stepOutput' as const, stepId: 'load', path: ['amountCents'] },
          { source: 'literal' as const, value: 100 },
        ],
      },
      tags: {
        kind: 'map' as const,
        items: { source: 'input' as const, path: ['tags'] },
        itemVariable: 'tag',
        maxItems: 20,
        body: {
          kind: 'call' as const,
          function: 'lowercase' as const,
          arguments: [{ kind: 'variable' as const, name: 'tag', path: [] }],
        },
      },
    },
  };

  it('derives the runtime schema and JSON Schema from the same recursive expression schema', () => {
    expect(transformationExpressionSchema.safeParse(transformedArgument).success).toBe(true);
    expect(
      versionedExecutableWorkflowSchema.safeParse({
        irVersion: 2,
        steps: [
          {
            id: 'send',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.send@v2',
            inputSchema: { required: {} },
            arguments: { payload: transformedArgument },
          },
        ],
      }).success,
    ).toBe(true);
    expect(JSON.stringify(compiledWorkflowVersionJsonSchema)).toContain('itemVariable');
    expect(
      versionedExecutableWorkflowSchema.safeParse({
        irVersion: 2,
        steps: [
          {
            id: 'send',
            kind: 'capabilityCall',
            capabilityVersionId: 'billing.send@v2',
            arguments: { payload: transformedArgument },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('hashes v2 transformations reproducibly with canonical JSON', async () => {
    const executable = {
      irVersion: 2 as const,
      steps: [
        {
          id: 'send',
          kind: 'capabilityCall' as const,
          capabilityVersionId: 'billing.send@v2',
          inputSchema: { required: {} },
          arguments: { payload: transformedArgument },
        },
      ],
    };

    const first = await createTransformationCompiledWorkflowVersion(
      'workflow@2',
      'org',
      executable,
    );
    const second = await createTransformationCompiledWorkflowVersion(
      'workflow@2',
      'org',
      executable,
    );

    expect(first).toEqual(second);
    expect(first.irHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyCompiledWorkflowVersionIntegrity(first)).resolves.toEqual(first);
  });

  it('keeps every v1 value reference valid and hash-stable', async () => {
    const executable = {
      irVersion: 1 as const,
      steps: [
        {
          id: 'load',
          kind: 'capabilityCall' as const,
          capabilityVersionId: 'payment.get@v1',
          arguments: { paymentId: { source: 'input' as const, path: ['paymentId'] } },
        },
      ],
    };
    const first = await createCompiledWorkflowVersion('workflow@1', 'org', executable);
    const second = await createCompiledWorkflowVersion('workflow@1', 'org', executable);

    expect(first).toEqual(second);
    expect(first.executable).toEqual(executable);
  });

  it('rejects expressions beyond the fixed depth, node, map, and output limits', () => {
    let tooDeep: unknown = { source: 'literal', value: 'leaf' };
    for (let depth = 0; depth <= TRANSFORMATION_LIMITS.maxAstDepth; depth += 1) {
      tooDeep = { kind: 'array', items: [tooDeep] };
    }
    expect(transformationExpressionSchema.safeParse(tooDeep).success).toBe(false);

    const tooManyNodes = {
      kind: 'array',
      items: Array.from({ length: TRANSFORMATION_LIMITS.maxNodeCount + 1 }, () => ({
        source: 'literal',
        value: null,
      })),
    };
    expect(transformationExpressionSchema.safeParse(tooManyNodes).success).toBe(false);

    expect(
      transformationExpressionSchema.safeParse({
        kind: 'map',
        items: { source: 'input', path: ['items'] },
        itemVariable: 'item',
        maxItems: TRANSFORMATION_LIMITS.maxArrayMapItems + 1,
        body: { kind: 'variable', name: 'item', path: [] },
      }).success,
    ).toBe(false);
    expect(TRANSFORMATION_LIMITS.maxOutputBytes).toBeGreaterThan(0);
  });

  it('fails total validation before an attacker-controlled tree can exhaust the call stack', () => {
    let hostile: unknown = { source: 'literal', value: 'leaf' };
    for (let depth = 0; depth < 10_000; depth += 1) {
      hostile = { kind: 'array', items: [hostile] };
    }

    expect(() => transformationExpressionSchema.safeParse(hostile)).not.toThrow();
    expect(transformationExpressionSchema.safeParse(hostile).success).toBe(false);

    const disguisedHostile = {
      source: 'input',
      path: [],
      kind: 'array',
      items: [hostile],
    };
    expect(() => transformationExpressionSchema.safeParse(disguisedHostile)).not.toThrow();
    expect(transformationExpressionSchema.safeParse(disguisedHostile).success).toBe(false);

    let deeplyNestedLiteral: unknown = 'leaf';
    for (let depth = 0; depth < 10_000; depth += 1) deeplyNestedLiteral = [deeplyNestedLiteral];
    const literalExpression = { source: 'literal', value: deeplyNestedLiteral };
    expect(() => transformationExpressionSchema.safeParse(literalExpression)).not.toThrow();
    expect(transformationExpressionSchema.safeParse(literalExpression).success).toBe(false);
    const malformedLiteralExpression = { ...literalExpression, extra: true };
    expect(() =>
      transformationExpressionSchema.safeParse(malformedLiteralExpression),
    ).not.toThrow();
    expect(transformationExpressionSchema.safeParse(malformedLiteralExpression).success).toBe(
      false,
    );
  });

  it('keeps idempotency keys on the legacy stable-reference contract', () => {
    const transformedIdempotency = {
      irVersion: 2,
      steps: [
        {
          id: 'send',
          kind: 'capabilityCall',
          capabilityVersionId: 'billing.send@v2',
          inputSchema: { required: {} },
          arguments: {},
          idempotency: { businessKey: transformedArgument },
        },
      ],
    };

    expect(versionedExecutableWorkflowSchema.safeParse(transformedIdempotency).success).toBe(false);
  });

  it('rejects unbound lexical variables and invalid deterministic built-in arity', () => {
    expect(
      transformationExpressionSchema.safeParse({ kind: 'variable', name: 'item', path: [] })
        .success,
    ).toBe(false);
    expect(
      transformationExpressionSchema.safeParse({
        kind: 'call',
        function: 'divide',
        arguments: [{ source: 'literal', value: 10 }],
      }).success,
    ).toBe(false);
  });

  it('finds prior-step dependencies nested inside transformations', () => {
    const executable = versionedExecutableWorkflowSchema.parse({
      irVersion: 2,
      steps: [
        {
          id: 'send',
          kind: 'capabilityCall',
          capabilityVersionId: 'billing.send@v2',
          inputSchema: { required: {} },
          arguments: {
            payload: {
              kind: 'object',
              fields: {
                invoiceId: { source: 'stepOutput', stepId: 'load', path: ['invoiceId'] },
              },
            },
          },
        },
        {
          id: 'load',
          kind: 'capabilityCall',
          capabilityVersionId: 'payment.get@v1',
          inputSchema: { required: {} },
          arguments: {},
        },
      ],
    });

    expect(validateCompiledWorkflowStructure(executable)).toEqual([
      {
        path: 'executable.steps[send].arguments.payload',
        message: "Step output 'load' must reference an earlier step",
      },
    ]);
  });
});
