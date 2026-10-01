import canonicalize from 'canonicalize';
import { z } from 'zod';

export const canonicalEnvironmentIds = ['development', 'production'] as const;
export type CanonicalEnvironmentId = (typeof canonicalEnvironmentIds)[number];

export const canonicalEnvironmentKinds = canonicalEnvironmentIds;
export type CanonicalEnvironmentKind = (typeof canonicalEnvironmentKinds)[number];

export const canonicalEnvironmentLabels = {
  development: 'Development',
  production: 'Production',
} as const satisfies Record<CanonicalEnvironmentId, string>;

export const canonicalEnvironmentIdSchema = z.enum(canonicalEnvironmentIds);
export const canonicalEnvironmentKindSchema = z.enum(canonicalEnvironmentKinds);

export const canonicalCapabilityComparisonStates = [
  'matching',
  'ahead',
  'different',
  'missing-in-production',
  'missing-in-development',
  'removed-in-development',
  'removed-in-production',
  'stale-in-development',
  'stale-in-production',
  'conflicting-in-development',
  'conflicting-in-production',
] as const;

export type CanonicalCapabilityComparisonState =
  (typeof canonicalCapabilityComparisonStates)[number];

export const capabilityComparisonStates = canonicalCapabilityComparisonStates;

export type CapabilityComparisonState = (typeof capabilityComparisonStates)[number];

export const capabilityOverviewRelationshipKindSchema = z.enum([
  'compensation',
  'data-flow',
  'execution-order',
]);

export const capabilityOverviewWorkflowLifecycles = [
  'active',
  'approved-inactive',
  'action-required',
  // Checks can change these statuses while the workflow remains active.
  'blocked',
  'testing',
  'draft',
  'awaiting-approval',
  'historical',
] as const;

export const capabilityOverviewWorkflowLifecycleSchema = z.enum(
  capabilityOverviewWorkflowLifecycles,
);

export type CapabilityOverviewWorkflowLifecycle = z.infer<
  typeof capabilityOverviewWorkflowLifecycleSchema
>;

const capabilityImpactPathSchema = z.array(
  z
    .object({
      kind: capabilityOverviewRelationshipKindSchema,
      fromStepId: z.string(),
      toStepId: z.string(),
      fromCapabilityVersionId: z.string(),
      toCapabilityVersionId: z.string(),
    })
    .strict(),
);

const capabilityImpactEvidenceSchema = z.union([
  z
    .object({
      discoveryId: z.string(),
      fromCapabilityVersionId: z.string(),
      fieldPath: z.string().optional(),
      sourceStepId: z.string().optional(),
      path: capabilityImpactPathSchema,
    })
    .strict(),
  z
    .object({
      runtimeMismatchId: z.string(),
      observationId: z.string(),
      capabilityVersionId: z.string(),
      status: z.number().int(),
      normalizedReason: z.literal('required-field-missing'),
      fieldPath: z.string(),
      observedAt: z.iso.datetime(),
      sourceStepId: z.string().optional(),
      path: capabilityImpactPathSchema,
    })
    .strict(),
]);

const capabilityImpactUsageSchema = z
  .object({
    workflowId: z.string(),
    workflowName: z.string(),
    workflowVersionId: z.string(),
    workflowLifecycle: capabilityOverviewWorkflowLifecycleSchema,
    currentState: z
      .object({
        isActive: z.boolean(),
        quarantine: z.enum(['not-recorded', 'active', 'cleared']),
        quarantineClearedAt: z.iso.datetime().optional(),
        replacementWorkflowVersionId: z.string().optional(),
        replacementActivatedAt: z.iso.datetime().optional(),
        blockedWorkflowStart: z
          .object({
            id: z.string(),
            toCapabilityVersionId: z.string(),
            blockedAt: z.iso.datetime(),
          })
          .strict()
          .optional(),
        latestFailedRun: z
          .object({
            runId: z.string(),
            failureType: z.string(),
            failedAt: z.iso.datetime(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    stepId: z.string(),
    capabilityVersionId: z.string(),
    reason: z.string(),
    evidence: capabilityImpactEvidenceSchema,
  })
  .strict();

const capabilityNodeImpactSchema = z
  .object({
    affected: z.boolean(),
    isSource: z.boolean(),
    affectedWorkflowCount: z.number().int().nonnegative(),
    usages: z.array(capabilityImpactUsageSchema),
  })
  .strict();

const capabilityImpactSourceSchema = z
  .object({
    capabilityIdentityId: z.string(),
    capabilityVersionId: z.string(),
    serviceId: z.string(),
    operationId: z.string(),
  })
  .strict();

const capabilityOverviewImpactSchema = z.union([
  z
    .object({
      type: z.literal('change'),
      id: z.string(),
      affectedWorkflowCount: z.number().int().nonnegative(),
      affectedStepCount: z.number().int().nonnegative(),
      currentlyExposedWorkflowCount: z.number().int().nonnegative().optional(),
      currentlyExposedStepCount: z.number().int().nonnegative().optional(),
      incompleteAnalysisCount: z.number().int().nonnegative(),
      analysis: z.enum(['complete', 'partial', 'unavailable']).optional(),
      recordedAt: z.iso.datetime().optional(),
      sources: z.array(capabilityImpactSourceSchema),
    })
    .strict(),
  z
    .object({
      type: z.literal('runtime-mismatch'),
      id: z.string(),
      affectedEndpointCount: z.number().int().nonnegative(),
      affectedWorkflowCount: z.number().int().nonnegative(),
      affectedStepCount: z.number().int().nonnegative(),
      currentlyExposedWorkflowCount: z.number().int().nonnegative().optional(),
      currentlyExposedStepCount: z.number().int().nonnegative().optional(),
      incompleteAnalysisCount: z.number().int().nonnegative(),
      analysis: z.enum(['complete', 'partial', 'unavailable']).optional(),
      recordedAt: z.iso.datetime().optional(),
      lastSeenAt: z.iso.datetime().optional(),
      occurrenceCount: z.number().int().nonnegative(),
      state: z.enum(['active', 'recovered']).optional(),
      recoveredAt: z.iso.datetime().optional(),
      sources: z.array(capabilityImpactSourceSchema),
    })
    .strict(),
]);

export const capabilityOverviewSchema = z
  .object({
    status: z.enum(['ready', 'empty', 'partial']),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    notices: z.array(z.string()),
    services: z.array(
      z
        .object({
          serviceId: z.string(),
          capabilityIdentityIds: z.array(z.string()),
        })
        .strict(),
    ),
    nodes: z.array(
      z
        .object({
          capabilityIdentityId: z.string(),
          capabilityVersionId: z.string(),
          kind: z.enum(['openapi', 'asyncapi']),
          serviceId: z.string(),
          operationId: z.string(),
          availability: z.enum(['available', 'removed']),
          freshness: z.enum(['fresh', 'stale']),
          sourceResolution: z.enum(['uncontested', 'conflicting', 'authoritative']),
          workflowLifecycles: z.array(capabilityOverviewWorkflowLifecycleSchema).optional(),
          impact: capabilityNodeImpactSchema.optional(),
        })
        .strict(),
    ),
    relationships: z.array(
      z
        .object({
          id: z.string(),
          kind: capabilityOverviewRelationshipKindSchema,
          sourceCapabilityIdentityId: z.string(),
          targetCapabilityIdentityId: z.string(),
          evidence: z
            .object({
              workflowId: z.string(),
              workflowName: z.string(),
              workflowVersionId: z.string(),
              sourceStepId: z.string(),
              targetStepId: z.string(),
              sourceCapabilityVersionId: z.string(),
              targetCapabilityVersionId: z.string(),
              workflowLifecycle: capabilityOverviewWorkflowLifecycleSchema,
              destinationField: z.string().optional(),
            })
            .strict(),
          impact: z
            .object({
              affected: z.literal(true),
              workflowVersionIds: z.array(z.string()),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    impact: capabilityOverviewImpactSchema.optional(),
  })
  .strict();

export type CapabilityOverview = z.infer<typeof capabilityOverviewSchema>;
export type CapabilityOverviewNode = CapabilityOverview['nodes'][number];
export type CapabilityOverviewRelationship = CapabilityOverview['relationships'][number];

export const capabilityArchitectureRelationshipKindSchema = z.enum([
  'data-flow',
  'execution-order',
]);

export const capabilityArchitectureSchema = z
  .object({
    status: z.enum(['ready', 'empty']),
    title: z.string(),
    sourceUrl: z.string().nullable(),
    notices: z.array(z.string()),
    workflows: z.array(
      z
        .object({
          workflowId: z.string(),
          summary: z.string(),
          description: z.string().optional(),
        })
        .strict(),
    ),
    nodes: z.array(
      z
        .object({
          operationId: z.string(),
          capabilityIdentityId: z.string().nullable(),
          catalogOperationId: z.string().optional(),
          capabilityVersionId: z.string().nullable(),
          serviceId: z.string().nullable(),
        })
        .strict(),
    ),
    relationships: z.array(
      z
        .object({
          id: z.string(),
          kind: capabilityArchitectureRelationshipKindSchema,
          workflowId: z.string(),
          workflowName: z.string(),
          sourceOperationId: z.string(),
          targetOperationId: z.string(),
          sourceStepId: z.string(),
          targetStepId: z.string(),
          destinationField: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

export type CapabilityArchitecture = z.infer<typeof capabilityArchitectureSchema>;

const identifierSchema = z.string().min(1);
const jsonPathSchema = z.array(z.string());
const temporalDurationSchema = z
  .string()
  .regex(
    /^\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?|w|weeks?|y|years?)$/i,
    'Use a Temporal-compatible duration such as "1 second" or "30s"',
  );

export const WORKFLOW_STEP_START_TO_CLOSE_TIMEOUT = '30 seconds';

export const valueReferenceSchema = z.discriminatedUnion('source', [
  z.strictObject({
    source: z.literal('input'),
    path: jsonPathSchema,
  }),
  z.strictObject({
    source: z.literal('stepOutput'),
    stepId: identifierSchema,
    path: jsonPathSchema,
  }),
  z.strictObject({
    source: z.literal('literal'),
    value: z.json(),
  }),
]);

export const TRANSFORMATION_LIMITS = {
  maxAstDepth: 32,
  maxNodeCount: 1_024,
  maxArrayMapItems: 1_000,
  maxOutputBytes: 256 * 1_024,
} as const;

const JSON_LITERAL_VALIDATION_LIMITS = {
  maxDepth: 64,
  maxNodeCount: 65_536,
} as const;

export type ValueReference = z.infer<typeof valueReferenceSchema>;
export type TransformationExpression =
  | ValueReference
  | { readonly kind: 'variable'; readonly name: string; readonly path: readonly string[] }
  | {
      readonly kind: 'object';
      readonly fields: Readonly<Record<string, TransformationExpression>>;
    }
  | { readonly kind: 'array'; readonly items: readonly TransformationExpression[] }
  | {
      readonly kind: 'map';
      readonly items: TransformationExpression;
      readonly itemVariable: string;
      readonly maxItems: number;
      readonly body: TransformationExpression;
    }
  | {
      readonly kind: 'call';
      readonly function:
        | 'uppercase'
        | 'lowercase'
        | 'concat'
        | 'default'
        | 'exists'
        | 'divide'
        | 'multiply';
      readonly arguments: readonly TransformationExpression[];
    }
  | {
      readonly kind: 'conditional';
      readonly condition: TransformationExpression;
      readonly then: TransformationExpression;
      readonly else: TransformationExpression;
    };

/** Walks every node in a validated transformation expression exactly once. */
export function visitTransformationExpression(
  expression: unknown,
  visitor: (node: Readonly<Record<string, unknown>>) => void,
): void {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return;
  const node = expression as Readonly<Record<string, unknown>>;
  visitor(node);
  const children =
    node.kind === 'object'
      ? Object.values((node.fields as Readonly<Record<string, unknown>> | undefined) ?? {})
      : node.kind === 'array'
        ? Array.isArray(node.items)
          ? node.items
          : []
        : node.kind === 'map'
          ? [node.items, node.body]
          : node.kind === 'call'
            ? Array.isArray(node.arguments)
              ? node.arguments
              : []
            : node.kind === 'conditional'
              ? [node.condition, node.then, node.else]
              : [];
  for (const child of children) visitTransformationExpression(child, visitor);
}

const expressionNodeSchema: z.ZodType<TransformationExpression> = z.lazy(() => {
  const expressionArray = z.array(expressionNodeSchema);
  const callSchema = z.discriminatedUnion('function', [
    z.strictObject({
      kind: z.literal('call'),
      function: z.enum(['uppercase', 'lowercase', 'exists']),
      arguments: expressionArray.length(1),
    }),
    z.strictObject({
      kind: z.literal('call'),
      function: z.enum(['default', 'divide', 'multiply']),
      arguments: expressionArray.length(2),
    }),
    z.strictObject({
      kind: z.literal('call'),
      function: z.literal('concat'),
      arguments: expressionArray.min(1).max(32),
    }),
  ]);
  return z.union([
    valueReferenceSchema,
    z.strictObject({ kind: z.literal('variable'), name: identifierSchema, path: jsonPathSchema }),
    z.strictObject({
      kind: z.literal('object'),
      fields: z.record(z.string(), expressionNodeSchema),
    }),
    z.strictObject({ kind: z.literal('array'), items: expressionArray }),
    z.strictObject({
      kind: z.literal('map'),
      items: expressionNodeSchema,
      itemVariable: identifierSchema,
      maxItems: z.number().int().positive().max(TRANSFORMATION_LIMITS.maxArrayMapItems),
      body: expressionNodeSchema,
    }),
    callSchema,
    z.strictObject({
      kind: z.literal('conditional'),
      condition: expressionNodeSchema,
      then: expressionNodeSchema,
      else: expressionNodeSchema,
    }),
  ]);
});

const boundedExpressionSchema = z.unknown().superRefine((expression, ctx) => {
  const pending: Array<{
    readonly node: unknown;
    readonly depth: number;
    readonly kind: 'expression' | 'literal';
  }> = [{ node: expression, depth: 1, kind: 'expression' }];
  let expressionNodeCount = 0;
  let literalNodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.kind === 'literal') {
      literalNodeCount += 1;
      if (literalNodeCount > JSON_LITERAL_VALIDATION_LIMITS.maxNodeCount) {
        ctx.addIssue({
          code: 'custom',
          message: `JSON literal contains more than ${JSON_LITERAL_VALIDATION_LIMITS.maxNodeCount} values`,
        });
        return;
      }
      if (current.depth > JSON_LITERAL_VALIDATION_LIMITS.maxDepth) {
        ctx.addIssue({
          code: 'custom',
          message: `JSON literal exceeds nesting limit ${JSON_LITERAL_VALIDATION_LIMITS.maxDepth}`,
        });
        return;
      }
      for (const child of unparsedJsonChildren(current.node)) {
        pending.push({ node: child, depth: current.depth + 1, kind: 'literal' });
      }
      continue;
    }

    expressionNodeCount += 1;
    if (expressionNodeCount > TRANSFORMATION_LIMITS.maxNodeCount) {
      ctx.addIssue({
        code: 'custom',
        message: `Expression contains more than ${TRANSFORMATION_LIMITS.maxNodeCount} nodes`,
      });
      return;
    }
    if (current.depth > TRANSFORMATION_LIMITS.maxAstDepth) {
      ctx.addIssue({
        code: 'custom',
        message: `Expression exceeds AST depth limit ${TRANSFORMATION_LIMITS.maxAstDepth}`,
      });
      return;
    }
    const literal = unparsedLiteralCandidate(current.node);
    if (literal.found) {
      pending.push({ node: literal.value, depth: 1, kind: 'literal' });
      if (isStructurallyValidLiteralLeaf(current.node)) continue;
    }
    if (isStructurallyValidPathLeaf(current.node)) continue;
    for (const child of unparsedExpressionChildren(current.node)) {
      pending.push({ node: child, depth: current.depth + 1, kind: 'expression' });
    }
  }
});

function unparsedLiteralCandidate(
  value: unknown,
): { readonly found: false } | { readonly found: true; readonly value: unknown } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { found: false };
  const node = value as Record<string, unknown>;
  return node.source === 'literal' && 'value' in node
    ? { found: true, value: node.value }
    : { found: false };
}

function isStructurallyValidLiteralLeaf(value: unknown) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).source === 'literal' &&
    hasOnlyKeys(value as Record<string, unknown>, ['source', 'value'])
  );
}

function isStructurallyValidPathLeaf(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  const validPath = Array.isArray(node.path) && node.path.every((part) => typeof part === 'string');
  if (node.source === 'input') return validPath && hasOnlyKeys(node, ['source', 'path']);
  return (
    node.source === 'stepOutput' &&
    typeof node.stepId === 'string' &&
    node.stepId.length > 0 &&
    validPath &&
    hasOnlyKeys(node, ['source', 'stepId', 'path'])
  );
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => key in value);
}

function unparsedJsonChildren(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? Object.values(value) : [];
}

function unparsedExpressionChildren(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const node = value as Record<string, unknown>;
  if (node.kind === 'object' && node.fields && typeof node.fields === 'object') {
    return Object.values(node.fields);
  }
  if (node.kind === 'array') return Array.isArray(node.items) ? node.items : [];
  if (node.kind === 'map') return [node.items, node.body];
  if (node.kind === 'call') return Array.isArray(node.arguments) ? node.arguments : [];
  if (node.kind === 'conditional') return [node.condition, node.then, node.else];
  return [];
}

const lexicallyScopedExpressionSchema = expressionNodeSchema.superRefine((expression, ctx) => {
  const visit = (
    node: TransformationExpression,
    variables: ReadonlySet<string>,
    path: Array<string | number>,
  ) => {
    if ('source' in node) return;
    if (node.kind === 'variable') {
      if (!variables.has(node.name)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `Variable '${node.name}' is not bound by an enclosing map`,
        });
      }
      return;
    }
    if (node.kind === 'object') {
      for (const [name, value] of Object.entries(node.fields)) {
        visit(value, variables, [...path, 'fields', name]);
      }
      return;
    }
    if (node.kind === 'array') {
      node.items.forEach((value, index) => visit(value, variables, [...path, 'items', index]));
      return;
    }
    if (node.kind === 'map') {
      visit(node.items, variables, [...path, 'items']);
      const bodyVariables = new Set(variables);
      bodyVariables.add(node.itemVariable);
      visit(node.body, bodyVariables, [...path, 'body']);
      return;
    }
    if (node.kind === 'call') {
      node.arguments.forEach((value, index) =>
        visit(value, variables, [...path, 'arguments', index]),
      );
      return;
    }
    visit(node.condition, variables, [...path, 'condition']);
    visit(node.then, variables, [...path, 'then']);
    visit(node.else, variables, [...path, 'else']);
  };
  visit(expression, new Set(), []);
});

export const transformationExpressionSchema = boundedExpressionSchema.pipe(
  lexicallyScopedExpressionSchema,
);

// Shared by approval, execution, and sandbox checks: retries must be explicit.
export const DEFAULT_STEP_MAXIMUM_ATTEMPTS = 1;

export const retryPolicySchema = z.strictObject({
  initialInterval: temporalDurationSchema,
  backoffCoefficient: z.number().positive(),
  maximumInterval: temporalDurationSchema,
  maximumAttempts: z.number().int().positive(),
  nonRetryableErrorTypes: z.array(identifierSchema),
  failureBuckets: z
    .record(z.string(), z.enum(['permanent-validation', 'permanent-operational']))
    .optional(),
});

export const idempotencyDeclarationSchema = z.strictObject({
  businessKey: valueReferenceSchema,
});

const terminalFailureStateSchema = z.enum([
  'validation_failed',
  'manual_review',
  'repair_required',
]);
export type FailureAction =
  | {
      readonly kind: 'land' | 'compensateThenLand' | 'preserveAndLand';
      readonly outcome: 'validation_failed' | 'manual_review' | 'repair_required';
      readonly reasonCode: string;
    }
  | {
      readonly kind: 'revalidateFrom';
      readonly targetStepId: string;
      readonly maxRevalidations: number;
      readonly onExhausted: FailureAction;
    };

export interface ErrorRouting {
  readonly rules: ReadonlyArray<{
    readonly errorTypes: readonly string[];
    readonly action: FailureAction;
  }>;
  readonly defaultAction: FailureAction;
}

const failureActionSchema: z.ZodType<FailureAction> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('land'),
      outcome: terminalFailureStateSchema,
      reasonCode: identifierSchema,
    }),
    z.strictObject({
      kind: z.literal('compensateThenLand'),
      outcome: terminalFailureStateSchema,
      reasonCode: identifierSchema,
    }),
    z.strictObject({
      kind: z.literal('preserveAndLand'),
      outcome: terminalFailureStateSchema,
      reasonCode: identifierSchema,
    }),
    z.strictObject({
      kind: z.literal('revalidateFrom'),
      targetStepId: identifierSchema,
      maxRevalidations: z.number().int().positive(),
      onExhausted: failureActionSchema,
    }),
  ]),
);
export const errorRoutingSchema: z.ZodType<ErrorRouting> = z.strictObject({
  rules: z.array(
    z.strictObject({
      errorTypes: z.array(identifierSchema).min(1),
      action: failureActionSchema,
    }),
  ),
  defaultAction: failureActionSchema,
});

export type ResponseValueSchema =
  | {
      readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'null';
      readonly classification?:
        | 'public'
        | 'internal'
        | 'confidential'
        | 'secret'
        | 'restricted'
        | undefined;
    }
  | {
      readonly type: 'object';
      readonly required: Readonly<Record<string, ResponseValueSchema>>;
      readonly classification?:
        | 'public'
        | 'internal'
        | 'confidential'
        | 'secret'
        | 'restricted'
        | undefined;
    }
  | {
      readonly type: 'array';
      readonly items: ResponseValueSchema;
      readonly classification?:
        | 'public'
        | 'internal'
        | 'confidential'
        | 'secret'
        | 'restricted'
        | undefined;
    };

const dataClassificationSchema = z
  .enum(['public', 'internal', 'confidential', 'secret', 'restricted'])
  .optional();

const responseValueSchema: z.ZodType<ResponseValueSchema> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({
      type: z.enum(['string', 'number', 'integer', 'boolean', 'null']),
      classification: dataClassificationSchema,
    }),
    z.strictObject({
      type: z.literal('object'),
      required: z.record(z.string(), responseValueSchema),
      classification: dataClassificationSchema,
    }),
    z.strictObject({
      type: z.literal('array'),
      items: responseValueSchema,
      classification: dataClassificationSchema,
    }),
  ]),
);

export const objectSchemaSchema = z.strictObject({
  required: z.record(z.string(), responseValueSchema),
});

// Retained for callers that use this shape specifically as a step response contract.
export const responseSchemaSchema = objectSchemaSchema;

const activityStepFields = {
  id: identifierSchema,
  capabilityVersionId: identifierSchema,
  arguments: z.record(z.string(), valueReferenceSchema),
  result: identifierSchema.optional(),
  retryPolicy: retryPolicySchema.optional(),
  idempotency: idempotencyDeclarationSchema.optional(),
  responseSchema: responseSchemaSchema.optional(),
  irreversibleAfter: z.boolean().optional(),
  errorRouting: errorRoutingSchema.optional(),
};

export const compiledStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('capabilityCall'),
    ...activityStepFields,
  }),
  z.strictObject({
    kind: z.literal('compensation'),
    ...activityStepFields,
    compensatesStepId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('publishEvent'),
    ...activityStepFields,
  }),
  z.strictObject({
    kind: z.literal('notify'),
    ...activityStepFields,
  }),
  z.strictObject({
    kind: z.literal('terminal'),
    id: identifierSchema,
    state: z.enum(['completed', 'validation_failed', 'manual_review', 'repair_required']),
  }),
]);

const transformationActivityStepFields = {
  ...activityStepFields,
  arguments: z.record(z.string(), transformationExpressionSchema),
  inputSchema: objectSchemaSchema,
};

export const transformationStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('capabilityCall'), ...transformationActivityStepFields }),
  z.strictObject({
    kind: z.literal('compensation'),
    ...transformationActivityStepFields,
    compensatesStepId: identifierSchema,
  }),
  z.strictObject({ kind: z.literal('publishEvent'), ...transformationActivityStepFields }),
  z.strictObject({ kind: z.literal('notify'), ...transformationActivityStepFields }),
  z.strictObject({
    kind: z.literal('terminal'),
    id: identifierSchema,
    state: z.enum(['completed', 'validation_failed', 'manual_review', 'repair_required']),
  }),
]);

export const executableWorkflowSchema = z.strictObject({
  irVersion: z.literal(1),
  inputSchema: objectSchemaSchema.optional(),
  steps: z.array(compiledStepSchema).min(1),
});

export const transformationExecutableWorkflowSchema = z.strictObject({
  irVersion: z.literal(2),
  inputSchema: objectSchemaSchema.optional(),
  steps: z.array(transformationStepSchema).min(1),
});

export const graphConditionSchema = z
  .strictObject({
    left: transformationExpressionSchema,
    operator: z.enum(['equals', 'notEquals', 'greaterThan', 'lessThan', 'exists']),
    right: transformationExpressionSchema.optional(),
  })
  .superRefine((condition, context) => {
    if (condition.operator !== 'exists' && !condition.right) {
      context.addIssue({
        code: 'custom',
        path: ['right'],
        message: 'This comparison needs a right value',
      });
    }
    if (condition.operator === 'exists' && condition.right) {
      context.addIssue({
        code: 'custom',
        path: ['right'],
        message: 'Exists only takes a left value',
      });
    }
  });

export const MAX_WORKFLOW_SLEEP_MS = 30 * 24 * 60 * 60 * 1_000;

export const graphStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('capabilityCall'),
    ...transformationActivityStepFields,
    next: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('publishEvent'),
    ...transformationActivityStepFields,
    next: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('notify'),
    ...transformationActivityStepFields,
    next: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('compensation'),
    ...transformationActivityStepFields,
    compensatesStepId: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('transform'),
    id: identifierSchema,
    arguments: z.record(z.string(), transformationExpressionSchema),
    responseSchema: objectSchemaSchema,
    next: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('sleep'),
    id: identifierSchema,
    durationMs: z.number().int().positive().max(MAX_WORKFLOW_SLEEP_MS),
    next: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('condition'),
    id: identifierSchema,
    condition: graphConditionSchema,
    whenTrue: identifierSchema,
    whenFalse: identifierSchema,
  }),
  z.strictObject({
    kind: z.literal('terminal'),
    id: identifierSchema,
    state: z.enum(['completed', 'validation_failed', 'manual_review', 'repair_required']),
    output: transformationExpressionSchema.optional(),
  }),
]);

export const graphExecutableWorkflowSchema = z.strictObject({
  irVersion: z.literal(3),
  inputSchema: objectSchemaSchema.optional(),
  startStepId: identifierSchema,
  steps: z.array(graphStepSchema).min(1).max(1_000),
});

export const versionedExecutableWorkflowSchema = z.discriminatedUnion('irVersion', [
  executableWorkflowSchema,
  transformationExecutableWorkflowSchema,
  graphExecutableWorkflowSchema,
]);

export const executionRequirementsSchema = z.strictObject({
  organizationId: identifierSchema,
  workflowVersionId: identifierSchema,
  irHash: z.string().regex(/^[a-f0-9]{64}$/),
  requiredCapabilityVersionIds: z.array(identifierSchema),
});

export const mappingOriginSchema = z.enum(['requested', 'inferred']);

export const mappingOriginBindingSchema = z.strictObject({
  stepId: identifierSchema,
  destinationPath: jsonPathSchema,
  origin: mappingOriginSchema,
});

export const compiledWorkflowVersionSchema = z.strictObject({
  workflowVersionId: identifierSchema,
  irHash: z.string().regex(/^[a-f0-9]{64}$/),
  executionRequirements: executionRequirementsSchema,
  executable: executableWorkflowSchema,
  mappingOrigins: z.array(mappingOriginBindingSchema).optional(),
});

export const transformationCompiledWorkflowVersionSchema = z.strictObject({
  workflowVersionId: identifierSchema,
  irHash: z.string().regex(/^[a-f0-9]{64}$/),
  executionRequirements: executionRequirementsSchema,
  executable: transformationExecutableWorkflowSchema,
  mappingOrigins: z.array(mappingOriginBindingSchema).optional(),
});

export const graphCompiledWorkflowVersionSchema = z.strictObject({
  workflowVersionId: identifierSchema,
  irHash: z.string().regex(/^[a-f0-9]{64}$/),
  executionRequirements: executionRequirementsSchema,
  executable: graphExecutableWorkflowSchema,
  mappingOrigins: z.array(mappingOriginBindingSchema).optional(),
});

export const versionedCompiledWorkflowVersionSchema = z.union([
  compiledWorkflowVersionSchema,
  transformationCompiledWorkflowVersionSchema,
  graphCompiledWorkflowVersionSchema,
]);

// The runtime validator and model tool contract are projections of this same schema.
export const compiledWorkflowVersionJsonSchema = z.toJSONSchema(
  versionedCompiledWorkflowVersionSchema,
  {
    target: 'draft-07',
  },
);

export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type ObjectSchema = z.infer<typeof objectSchemaSchema>;
export type ResponseSchema = ObjectSchema;
export type CompiledStep = z.infer<typeof compiledStepSchema>;
export type TransformationStep = z.infer<typeof transformationStepSchema>;
export type GraphStep = z.infer<typeof graphStepSchema>;
export type GraphCondition = z.infer<typeof graphConditionSchema>;
export type GraphExecutableWorkflow = z.infer<typeof graphExecutableWorkflowSchema>;
export type GraphCompiledWorkflowVersion = z.infer<typeof graphCompiledWorkflowVersionSchema>;
export type CapabilityStep = Extract<
  CompiledStep | TransformationStep | GraphStep,
  { capabilityVersionId: string }
>;

export function isCapabilityStep(
  step: CompiledStep | TransformationStep | GraphStep,
): step is CapabilityStep {
  return (
    step.kind === 'capabilityCall' ||
    step.kind === 'publishEvent' ||
    step.kind === 'notify' ||
    step.kind === 'compensation'
  );
}

/** Every expression on a step, including conditions and the final output. */
export function workflowStepExpressions(
  step: CompiledStep | TransformationStep | GraphStep,
): Readonly<Record<string, TransformationExpression>> {
  if (step.kind === 'terminal')
    return 'output' in step && step.output ? { output: step.output } : {};
  if (step.kind === 'sleep') return {};
  if (step.kind === 'condition')
    return {
      'condition.left': step.condition.left,
      ...(step.condition.right ? { 'condition.right': step.condition.right } : {}),
    };
  return step.arguments;
}
export type ExecutableWorkflow = z.infer<typeof executableWorkflowSchema>;
export type TransformationExecutableWorkflow = z.infer<
  typeof transformationExecutableWorkflowSchema
>;
export type VersionedExecutableWorkflow = z.infer<typeof versionedExecutableWorkflowSchema>;
export type ExecutionRequirements = z.infer<typeof executionRequirementsSchema>;
export type CompiledWorkflowVersion = z.infer<typeof compiledWorkflowVersionSchema>;
export type TransformationCompiledWorkflowVersion = z.infer<
  typeof transformationCompiledWorkflowVersionSchema
>;
export type VersionedCompiledWorkflowVersion = z.infer<
  typeof versionedCompiledWorkflowVersionSchema
>;
export type JsonValue = z.infer<ReturnType<typeof z.json>>;

export interface WorkflowInputValidationIssue {
  readonly path: string;
  readonly message: string;
}

export function validateWorkflowInput(
  value: unknown,
  schema: ObjectSchema,
): WorkflowInputValidationIssue[] {
  const issues: WorkflowInputValidationIssue[] = [];
  validateObject(value, schema.required, '$', issues);
  return issues;
}

function validateObject(
  value: unknown,
  required: ObjectSchema['required'],
  path: string,
  issues: WorkflowInputValidationIssue[],
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({ path, message: 'Expected object.' });
    return;
  }
  const record = value as Record<string, unknown>;
  for (const [field, fieldSchema] of Object.entries(required)) {
    const fieldPath = `${path}.${field}`;
    if (!(field in record)) {
      issues.push({ path: fieldPath, message: 'Required value is missing.' });
      continue;
    }
    validateWorkflowInputValue(record[field], fieldSchema, fieldPath, issues);
  }
}

function validateWorkflowInputValue(
  value: unknown,
  schema: ObjectSchema['required'][string],
  path: string,
  issues: WorkflowInputValidationIssue[],
) {
  if (schema.type === 'object') {
    validateObject(value, schema.required, path, issues);
    return;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push({ path, message: 'Expected array.' });
      return;
    }
    value.forEach((item, index) =>
      validateWorkflowInputValue(item, schema.items, `${path}[${index}]`, issues),
    );
    return;
  }
  const valid =
    schema.type === 'null'
      ? value === null
      : schema.type === 'integer'
        ? typeof value === 'number' && Number.isInteger(value)
        : typeof value === schema.type;
  if (!valid) issues.push({ path, message: `Expected ${schema.type}.` });
}

export type RevalidationAction = Extract<FailureAction, { kind: 'revalidateFrom' }>;

export function collectRevalidationActions(errorRouting: ErrorRouting | undefined) {
  if (!errorRouting) return [];
  const found: RevalidationAction[] = [];
  const visit = (action: FailureAction) => {
    if (action.kind === 'revalidateFrom') found.push(action);
    if (action.kind === 'revalidateFrom') visit(action.onExhausted);
  };
  for (const rule of errorRouting.rules) visit(rule.action);
  visit(errorRouting.defaultAction);
  return found;
}

export type WorkflowGraphEdgeKind = 'next' | 'mapping' | 'compensation' | 'revalidation';

export interface WorkflowGraphNode {
  stepId: string;
  kind: string;
  irreversible: boolean;
  retryPolicy: RetryPolicy | null;
  terminalState: string | null;
}

export interface WorkflowGraphEdge {
  fromStepId: string;
  toStepId: string;
  kind: WorkflowGraphEdgeKind;
  label?: string;
  origin?: 'requested' | 'inferred';
  maxRevalidations?: number;
}

export function buildWorkflowGraph(
  workflow: {
    executable: Pick<VersionedExecutableWorkflow, 'steps'> & { irVersion?: number };
    mappingOrigins?:
      | readonly {
          stepId: string;
          destinationPath: readonly string[];
          origin: 'requested' | 'inferred';
        }[]
      | undefined;
  } | null,
): { nodes: WorkflowGraphNode[]; edges: WorkflowGraphEdge[] } {
  if (!workflow) return { nodes: [], edges: [] };
  const nodes = workflow.executable.steps.map((step) => ({
    stepId: step.id,
    kind: step.kind,
    irreversible: isCapabilityStep(step) && step.irreversibleAfter === true,
    retryPolicy: isCapabilityStep(step) ? (step.retryPolicy ?? null) : null,
    terminalState: step.kind === 'terminal' ? step.state : null,
  }));
  const primarySteps = workflow.executable.steps.filter((step) => step.kind !== 'compensation');
  const explicitRoutes =
    workflow.executable.irVersion === 3 ||
    primarySteps.some((step) => 'next' in step || step.kind === 'condition');
  const edges: WorkflowGraphEdge[] = explicitRoutes
    ? primarySteps.flatMap((step): WorkflowGraphEdge[] => {
        if (step.kind === 'condition')
          return [
            { fromStepId: step.id, toStepId: step.whenTrue, kind: 'next', label: 'True' },
            { fromStepId: step.id, toStepId: step.whenFalse, kind: 'next', label: 'Otherwise' },
          ];
        return 'next' in step ? [{ fromStepId: step.id, toStepId: step.next, kind: 'next' }] : [];
      })
    : primarySteps.slice(1).map((step, index) => ({
        fromStepId: primarySteps[index]!.id,
        toStepId: step.id,
        kind: 'next',
      }));
  for (const step of workflow.executable.steps) {
    for (const [argument, reference] of Object.entries(workflowStepExpressions(step))) {
      const origin = workflow.mappingOrigins?.find(
        (binding) =>
          binding.stepId === step.id &&
          binding.destinationPath.length === 1 &&
          binding.destinationPath[0] === argument,
      )?.origin;
      for (const sourceStepId of expressionStepOutputIds(reference)) {
        edges.push({
          fromStepId: sourceStepId,
          toStepId: step.id,
          kind: 'mapping',
          label: argument,
          ...(origin ? { origin } : {}),
        });
      }
    }
    if (step.kind === 'compensation') {
      edges.push({
        fromStepId: step.compensatesStepId,
        toStepId: step.id,
        kind: 'compensation',
      });
    }
    for (const action of collectRevalidationActions(
      isCapabilityStep(step) ? step.errorRouting : undefined,
    )) {
      edges.push({
        fromStepId: step.id,
        toStepId: action.targetStepId,
        kind: 'revalidation',
        maxRevalidations: action.maxRevalidations,
      });
    }
  }
  return { nodes, edges };
}

function expressionStepOutputIds(expression: unknown): string[] {
  const stepIds: string[] = [];
  visitTransformationExpression(expression, (node) => {
    if (node.source === 'stepOutput' && typeof node.stepId === 'string') stepIds.push(node.stepId);
  });
  return stepIds;
}

export interface WorkflowStructureIssue {
  path: string;
  message: string;
}

export function validateCompiledWorkflowStructure(
  executable: VersionedExecutableWorkflow,
): WorkflowStructureIssue[] {
  if (executable.irVersion === 3) return validateGraphWorkflowStructure(executable);
  const issues: WorkflowStructureIssue[] = [];
  const stepIndexes = new Map<string, number>();
  for (const [index, step] of executable.steps.entries()) {
    if (stepIndexes.has(step.id)) {
      issues.push({
        path: `executable.steps[${step.id}].id`,
        message: `Step id '${step.id}' is duplicated`,
      });
    } else {
      stepIndexes.set(step.id, index);
    }
  }
  for (const [index, step] of executable.steps.entries()) {
    if (step.kind === 'terminal') continue;
    for (const [argument, expression] of Object.entries(step.arguments)) {
      for (const stepId of collectStepOutputReferences(expression)) {
        const referencedIndex = stepIndexes.get(stepId);
        if (referencedIndex === undefined || referencedIndex >= index) {
          issues.push({
            path: `executable.steps[${step.id}].arguments.${argument}`,
            message: `Step output '${stepId}' must reference an earlier step`,
          });
        }
      }
    }
    if (step.kind === 'compensation') {
      const compensatedIndex = stepIndexes.get(step.compensatesStepId);
      if (compensatedIndex === undefined || compensatedIndex >= index) {
        issues.push({
          path: `executable.steps[${step.id}].compensatesStepId`,
          message: `Compensation target '${step.compensatesStepId}' must be an earlier step`,
        });
      }
    }
    for (const action of collectRevalidationActions(step.errorRouting)) {
      const targetIndex = stepIndexes.get(action.targetStepId);
      if (targetIndex === undefined || targetIndex >= index) {
        issues.push({
          path: `executable.steps[${step.id}].errorRouting`,
          message: `Revalidation target '${action.targetStepId}' must be an earlier step`,
        });
      }
    }
  }
  return issues;
}

function validateGraphWorkflowStructure(
  executable: GraphExecutableWorkflow,
): WorkflowStructureIssue[] {
  const issues: WorkflowStructureIssue[] = [];
  const issue = (id: string, field: string, message: string) =>
    issues.push({ path: `executable.steps[${id}].${field}`, message });
  const steps = new Map<string, GraphStep>();
  for (const step of executable.steps) {
    if (steps.has(step.id)) issue(step.id, 'id', `Step id '${step.id}' is duplicated`);
    steps.set(step.id, step);
  }
  const ordinary = executable.steps.filter((step) => step.kind !== 'compensation');
  const targets = (step: GraphStep): string[] =>
    step.kind === 'condition' ? [step.whenTrue, step.whenFalse] : 'next' in step ? [step.next] : [];
  const incoming = new Map<string, Set<string>>();
  for (const step of ordinary) {
    for (const target of targets(step)) {
      if (!steps.has(target) || steps.get(target)?.kind === 'compensation') {
        issue(step.id, 'next', `Connection '${target}' must point to an executable step`);
        continue;
      }
      const sources = incoming.get(target) ?? new Set<string>();
      sources.add(step.id);
      incoming.set(target, sources);
    }
  }
  if (
    !steps.has(executable.startStepId) ||
    steps.get(executable.startStepId)?.kind === 'compensation'
  ) {
    issues.push({
      path: 'executable.startStepId',
      message: 'Start must point to an executable step',
    });
  }
  const reachable = new Set<string>();
  const pending = [executable.startStepId];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const step = steps.get(id);
    if (step && step.kind !== 'compensation') pending.push(...targets(step));
  }
  for (const step of ordinary)
    if (!reachable.has(step.id)) issue(step.id, 'id', 'Step cannot be reached from Start');
  if (!ordinary.some((step) => step.kind === 'terminal' && reachable.has(step.id))) {
    issues.push({ path: 'executable.steps', message: 'Workflow needs a reachable Finish step' });
  }
  // Process each node only after all incoming routes. The common ancestors are the
  // only outputs that exist regardless of which condition route was selected.
  const counts = new Map(ordinary.map((step) => [step.id, incoming.get(step.id)?.size ?? 0]));
  const ready = ordinary.filter((step) => counts.get(step.id) === 0).map((step) => step.id);
  const ancestors = new Map<string, Set<string>>();
  let visited = 0;
  while (ready.length) {
    const id = ready.pop()!;
    visited += 1;
    const sources = [...(incoming.get(id) ?? [])];
    const firstSource = sources[0];
    const common = new Set(firstSource ? [...(ancestors.get(firstSource) ?? []), firstSource] : []);
    for (const source of sources.slice(1)) {
      for (const candidate of common)
        if (candidate !== source && !ancestors.get(source)?.has(candidate))
          common.delete(candidate);
    }
    ancestors.set(id, common);
    for (const next of new Set(targets(steps.get(id)!))) {
      if (!counts.has(next)) continue;
      counts.set(next, counts.get(next)! - 1);
      if (counts.get(next) === 0) ready.push(next);
    }
  }
  if (visited !== ordinary.length) {
    issues.push({
      path: 'executable.steps',
      message: 'Connections cannot contain a cycle; use bounded failure recovery to repeat a step',
    });
  }
  for (const step of executable.steps) {
    const available = new Set(ancestors.get(step.id) ?? []);
    if (step.kind === 'compensation') {
      const target = steps.get(step.compensatesStepId);
      if (!target || !isCapabilityStep(target) || target.kind === 'compensation') {
        issue(step.id, 'compensatesStepId', 'Compensation must target a capability step');
      }
      available.clear();
      for (const id of ancestors.get(step.compensatesStepId) ?? []) available.add(id);
      available.add(step.compensatesStepId);
    }
    const expressions = {
      ...workflowStepExpressions(step),
      ...(isCapabilityStep(step) && step.idempotency
        ? { 'idempotency.businessKey': step.idempotency.businessKey }
        : {}),
    };
    for (const [field, expression] of Object.entries(expressions)) {
      for (const id of collectStepOutputReferences(expression)) {
        const source = steps.get(id);
        if (
          !available.has(id) ||
          !source ||
          (source.kind !== 'transform' &&
            (!isCapabilityStep(source) || source.kind === 'compensation'))
        ) {
          issue(
            step.id,
            field,
            `Output '${id}' must be available on every route reaching this step`,
          );
        }
      }
    }
    if (isCapabilityStep(step)) {
      for (const action of collectRevalidationActions(step.errorRouting)) {
        if (step.kind === 'compensation' || !ancestors.get(step.id)?.has(action.targetStepId)) {
          issue(
            step.id,
            'errorRouting',
            `Revalidation target '${action.targetStepId}' must run before this step on every route`,
          );
        }
      }
    }
    if (step.kind === 'condition') {
      const left = graphExpressionType(step.condition.left, executable.inputSchema, steps);
      const right = step.condition.right
        ? graphExpressionType(step.condition.right, executable.inputSchema, steps)
        : undefined;
      const numeric = (type: string | undefined) =>
        type === undefined || type === 'number' || type === 'integer';
      if (
        (step.condition.operator === 'greaterThan' || step.condition.operator === 'lessThan') &&
        (!numeric(left) || !numeric(right))
      ) {
        issue(step.id, 'condition', 'Numeric comparisons need number values');
      }
      if (
        (step.condition.operator === 'equals' || step.condition.operator === 'notEquals') &&
        left &&
        right &&
        left !== right &&
        !(numeric(left) && numeric(right))
      ) {
        issue(step.id, 'condition', 'Compared values must have matching types');
      }
    }
    if (step.kind === 'terminal' && step.output) {
      const type = graphExpressionType(step.output, executable.inputSchema, steps);
      if (type && type !== 'object') issue(step.id, 'output', 'Finish must return an object');
    }
  }
  return issues;
}

function graphExpressionType(
  expression: TransformationExpression,
  input: ObjectSchema | undefined,
  steps: ReadonlyMap<string, GraphStep>,
): ResponseValueSchema['type'] | undefined {
  if ('source' in expression) {
    if (expression.source === 'literal') {
      const value = expression.value;
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      if (typeof value === 'object') return 'object';
      return typeof value as 'string' | 'number' | 'boolean';
    }
    const source = expression.source === 'input' ? undefined : steps.get(expression.stepId);
    const schema =
      expression.source === 'input'
        ? input
        : source && 'responseSchema' in source
          ? source.responseSchema
          : undefined;
    if (!schema) return undefined;
    let current: ResponseValueSchema | undefined = { type: 'object', required: schema.required };
    for (const part of expression.path)
      current = current?.type === 'object' ? current.required[part] : undefined;
    return current?.type;
  }
  if (expression.kind === 'variable') return undefined;
  if (expression.kind === 'object') return 'object';
  if (expression.kind === 'array' || expression.kind === 'map') return 'array';
  if (expression.kind === 'conditional') {
    const then = graphExpressionType(expression.then, input, steps);
    return then === graphExpressionType(expression.else, input, steps) ? then : undefined;
  }
  if (expression.function === 'exists') return 'boolean';
  if (expression.function === 'multiply' || expression.function === 'divide') return 'number';
  if (expression.function === 'default')
    return graphExpressionType(expression.arguments[1]!, input, steps);
  return 'string';
}

export function collectStepOutputReferences(expression: TransformationExpression): string[] {
  const found = new Set<string>();
  const visit = (node: TransformationExpression) => {
    if ('source' in node) {
      if (node.source === 'stepOutput') found.add(node.stepId);
      return;
    }
    if (node.kind === 'variable') return;
    if (node.kind === 'object') {
      Object.values(node.fields).forEach(visit);
      return;
    }
    if (node.kind === 'array') {
      node.items.forEach(visit);
      return;
    }
    if (node.kind === 'map') {
      visit(node.items);
      visit(node.body);
      return;
    }
    if (node.kind === 'call') {
      node.arguments.forEach(visit);
      return;
    }
    visit(node.condition);
    visit(node.then);
    visit(node.else);
  };
  visit(expression);
  return [...found].sort();
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function computeIrHash(executable: VersionedExecutableWorkflow): Promise<string> {
  const parsed = versionedExecutableWorkflowSchema.parse(executable);
  const canonicalJson = canonicalize(parsed);
  if (canonicalJson === undefined) {
    throw new TypeError('Executable workflow cannot be represented as canonical JSON');
  }
  return sha256Hex(canonicalJson);
}

export async function deriveStableId(namespace: string, parts: readonly JsonValue[]) {
  const canonicalJson = canonicalize({ namespace, parts });
  if (canonicalJson === undefined) {
    throw new TypeError('Stable ID input cannot be represented as canonical JSON');
  }
  return `${namespace}:${await sha256Hex(canonicalJson)}`;
}

export async function createCompiledWorkflowVersion(
  workflowVersionId: string,
  organizationId: string,
  executable: ExecutableWorkflow,
): Promise<CompiledWorkflowVersion> {
  const parsedExecutable = executableWorkflowSchema.parse(executable);
  return compiledWorkflowVersionSchema.parse(
    await createCompiledWorkflowEnvelope(workflowVersionId, organizationId, parsedExecutable),
  );
}

export async function createTransformationCompiledWorkflowVersion(
  workflowVersionId: string,
  organizationId: string,
  executable: TransformationExecutableWorkflow,
): Promise<TransformationCompiledWorkflowVersion> {
  const parsedExecutable = transformationExecutableWorkflowSchema.parse(executable);
  return transformationCompiledWorkflowVersionSchema.parse(
    await createCompiledWorkflowEnvelope(workflowVersionId, organizationId, parsedExecutable),
  );
}

export async function createGraphCompiledWorkflowVersion(
  workflowVersionId: string,
  organizationId: string,
  executable: GraphExecutableWorkflow,
): Promise<GraphCompiledWorkflowVersion> {
  const parsed = graphExecutableWorkflowSchema.parse(executable);
  const issues = validateCompiledWorkflowStructure(parsed);
  if (issues.length > 0)
    throw new TypeError(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  return graphCompiledWorkflowVersionSchema.parse(
    await createCompiledWorkflowEnvelope(workflowVersionId, organizationId, parsed),
  );
}

async function createCompiledWorkflowEnvelope(
  workflowVersionId: string,
  organizationId: string,
  executable: VersionedExecutableWorkflow,
) {
  const irHash = await computeIrHash(executable);
  return {
    workflowVersionId,
    irHash,
    executionRequirements: {
      organizationId,
      workflowVersionId,
      irHash,
      requiredCapabilityVersionIds: requiredCapabilityVersionIds(executable),
    },
    executable,
  };
}

export function verifyCompiledWorkflowVersionIntegrity(
  workflow: CompiledWorkflowVersion,
): Promise<CompiledWorkflowVersion>;
export function verifyCompiledWorkflowVersionIntegrity(
  workflow: TransformationCompiledWorkflowVersion,
): Promise<TransformationCompiledWorkflowVersion>;
export function verifyCompiledWorkflowVersionIntegrity(
  workflow: GraphCompiledWorkflowVersion,
): Promise<GraphCompiledWorkflowVersion>;
export function verifyCompiledWorkflowVersionIntegrity(
  workflow: VersionedCompiledWorkflowVersion,
): Promise<VersionedCompiledWorkflowVersion>;
export async function verifyCompiledWorkflowVersionIntegrity(
  workflow: VersionedCompiledWorkflowVersion,
): Promise<VersionedCompiledWorkflowVersion> {
  const parsed = versionedCompiledWorkflowVersionSchema.parse(workflow);
  if (parsed.executable.irVersion === 3) {
    const issues = validateCompiledWorkflowStructure(parsed.executable);
    if (issues.length)
      throw new TypeError(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }
  const actualIrHash = await computeIrHash(parsed.executable);
  if (parsed.irHash !== actualIrHash) throw new TypeError('Compiled workflow irHash mismatch');

  const expectedRequirements: ExecutionRequirements = {
    organizationId: parsed.executionRequirements.organizationId,
    workflowVersionId: parsed.workflowVersionId,
    irHash: parsed.irHash,
    requiredCapabilityVersionIds: requiredCapabilityVersionIds(parsed.executable),
  };
  if (canonicalize(parsed.executionRequirements) !== canonicalize(expectedRequirements)) {
    throw new TypeError('Compiled workflow executionRequirements mismatch');
  }
  return parsed;
}

function requiredCapabilityVersionIds(executable: VersionedExecutableWorkflow): string[] {
  return [
    ...new Set(
      executable.steps.flatMap((step) =>
        isCapabilityStep(step) ? [step.capabilityVersionId] : [],
      ),
    ),
  ].sort();
}
