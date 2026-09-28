import type { TransformationExpression } from '@atlas/workflow-ir';

export type DataClassification = 'public' | 'internal' | 'confidential' | 'secret' | 'restricted';

interface SchemaBase {
  readonly classification?: DataClassification;
  readonly nullable?: boolean;
  readonly unit?: 'cents' | 'decimal-currency' | 'kilograms' | 'meters';
  readonly enumValues?: readonly (string | number)[];
  readonly case?: 'lower' | 'upper';
}

export type TransformationSchema =
  | (SchemaBase & {
      readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'unknown';
    })
  | (SchemaBase & {
      readonly type: 'object';
      readonly required: Readonly<Record<string, TransformationSchema>>;
      readonly optional?: Readonly<Record<string, TransformationSchema>>;
    })
  | (SchemaBase & { readonly type: 'array'; readonly items: TransformationSchema });

export interface TransformationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly sourceType?: string;
  readonly destinationType?: string;
  readonly sourceClassification?: DataClassification;
  readonly destinationClassification?: DataClassification;
  readonly suggestedMappings?: readonly string[];
}

export interface TransformationValidationContext {
  readonly workflowInput: TransformationSchema;
  readonly stepOutputs: ReadonlyMap<string, TransformationSchema>;
  readonly destinationKind?: 'capabilityCall' | 'compensation' | 'publishEvent' | 'notify';
}

interface InferredValue {
  readonly schema: TransformationSchema;
  readonly mayBeMissing: boolean;
}

const classificationRank: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3,
  restricted: 4,
};

const secretLikeValue =
  /^(?:sk_(?:live|test)_|gh[pousr]_|AKIA|AIza|xox[baprs]-)|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

export function inspectTransformation(
  expression: TransformationExpression,
  context: TransformationValidationContext,
  path: string,
) {
  const diagnostics: TransformationDiagnostic[] = [];
  const inferred = inferExpression(expression, context, new Map(), path, diagnostics);
  return { inferred, diagnostics };
}

export function validateTransformation(
  expression: TransformationExpression,
  destination: TransformationSchema,
  context: TransformationValidationContext,
  path: string,
): TransformationDiagnostic[] {
  const diagnostics: TransformationDiagnostic[] = [];
  const inferred = inferExpression(expression, context, new Map(), path, diagnostics);
  if (!inferred) return enrichDiagnostics(diagnostics, destination);

  if (inferred.mayBeMissing) {
    diagnostics.push({
      code: 'TRANSFORM_OPTIONAL_VALUE_NOT_MATERIALIZED',
      path,
      message: 'The mapping may be missing; materialize it explicitly with default or exists.',
      sourceType: describeType(inferred.schema, true),
      destinationType: describeType(destination),
      suggestedMappings: ['default(value, fallback)', 'exists(value)'],
    });
    return enrichDiagnostics(diagnostics, destination);
  }

  validateAssignability(inferred.schema, destination, path, diagnostics, context.destinationKind);
  return enrichDiagnostics(diagnostics, destination);
}

function inferExpression(
  expression: TransformationExpression,
  context: TransformationValidationContext,
  variables: ReadonlyMap<string, TransformationSchema>,
  path: string,
  diagnostics: TransformationDiagnostic[],
): InferredValue | undefined {
  if ('source' in expression) {
    if (expression.source === 'literal') {
      if (typeof expression.value === 'string' && secretLikeValue.test(expression.value)) {
        diagnostics.push({
          code: 'SECRET_VALUE_OR_NON_ALIAS_LEAK',
          path,
          message: 'Secret-shaped literals are forbidden; capabilities bind worker-local aliases.',
          suggestedMappings: ['Use the capability secret alias instead of literal secret material'],
        });
      }
      return { schema: literalSchema(expression.value), mayBeMissing: false };
    }
    const root =
      expression.source === 'input'
        ? context.workflowInput
        : context.stepOutputs.get(expression.stepId);
    if (!root) {
      diagnostics.push(missingPathDiagnostic(path, expression.path, []));
      return undefined;
    }
    return resolvePath(root, expression.path, path, diagnostics);
  }
  if (expression.kind === 'variable') {
    const root = variables.get(expression.name);
    if (!root) {
      diagnostics.push({
        code: 'TRANSFORM_VARIABLE_NOT_BOUND',
        path,
        message: `Variable '${expression.name}' is not bound by an enclosing map.`,
      });
      return undefined;
    }
    return resolvePath(root, expression.path, path, diagnostics);
  }
  if (expression.kind === 'object') {
    const required: Record<string, TransformationSchema> = {};
    let missing = false;
    for (const [name, child] of Object.entries(expression.fields)) {
      const inferred = inferExpression(child, context, variables, `${path}.${name}`, diagnostics);
      if (!inferred) continue;
      required[name] = inferred.schema;
      missing ||= inferred.mayBeMissing;
    }
    return {
      schema: { type: 'object', required },
      mayBeMissing: missing,
    };
  }
  if (expression.kind === 'array') {
    const inferredItems = expression.items.flatMap((item, index) => {
      const inferred = inferExpression(item, context, variables, `${path}[${index}]`, diagnostics);
      return inferred ? [inferred] : [];
    });
    const itemSchema =
      inferredItems.length === 0
        ? ({ type: 'unknown' } as const)
        : commonSchema(inferredItems.map(({ schema }) => schema));
    if (!itemSchema) {
      diagnostics.push({
        code: 'TRANSFORM_ARRAY_ITEM_TYPE_MISMATCH',
        path,
        message: 'Array construction items do not have a common assignable type.',
        sourceType: inferredItems.map(({ schema }) => describeType(schema)).join(' | '),
        suggestedMappings: ['Map every array item to one common type'],
      });
      return undefined;
    }
    return {
      schema: { type: 'array', items: itemSchema },
      mayBeMissing: inferredItems.some(({ mayBeMissing }) => mayBeMissing),
    };
  }
  if (expression.kind === 'map') {
    const items = inferExpression(
      expression.items,
      context,
      variables,
      `${path}.items`,
      diagnostics,
    );
    if (!items) return undefined;
    if (items.schema.type !== 'array') {
      diagnostics.push(
        typeDiagnostic('TRANSFORM_MAP_REQUIRES_ARRAY', path, items.schema, {
          type: 'array',
          items: { type: 'null' },
        }),
      );
      return undefined;
    }
    const bodyVariables = new Map(variables);
    bodyVariables.set(expression.itemVariable, items.schema.items);
    const body = inferExpression(
      expression.body,
      context,
      bodyVariables,
      `${path}.body`,
      diagnostics,
    );
    if (!body) return undefined;
    return {
      schema: { type: 'array', items: body.schema },
      mayBeMissing: items.mayBeMissing || body.mayBeMissing,
    };
  }
  if (expression.kind === 'conditional') {
    const condition = inferExpression(
      expression.condition,
      context,
      variables,
      `${path}.condition`,
      diagnostics,
    );
    const thenValue = inferExpression(
      expression.then,
      context,
      variables,
      `${path}.then`,
      diagnostics,
    );
    const elseValue = inferExpression(
      expression.else,
      context,
      variables,
      `${path}.else`,
      diagnostics,
    );
    if (condition && condition.schema.type !== 'boolean') {
      diagnostics.push(
        typeDiagnostic('TRANSFORM_CONDITION_NOT_BOOLEAN', `${path}.condition`, condition.schema, {
          type: 'boolean',
        }),
      );
    }
    if (!thenValue || !elseValue) return undefined;
    const schema = commonSchema([thenValue.schema, elseValue.schema]);
    if (!schema) {
      diagnostics.push(
        typeDiagnostic('TRANSFORM_BRANCH_TYPE_MISMATCH', path, thenValue.schema, elseValue.schema),
      );
      return undefined;
    }
    return {
      schema: withClassification(schema, [condition?.schema.classification]),
      mayBeMissing: thenValue.mayBeMissing || elseValue.mayBeMissing,
    };
  }

  const values = expression.arguments.map((argument, index) =>
    inferExpression(argument, context, variables, `${path}.arguments[${index}]`, diagnostics),
  );
  if (values.some((value) => !value)) return undefined;
  const arguments_ = values as InferredValue[];
  if (expression.function === 'exists') {
    return {
      schema: withClassification({ type: 'boolean' }, [arguments_[0]!.schema.classification]),
      mayBeMissing: false,
    };
  }
  if (expression.function === 'default') {
    const common = commonSchema(arguments_.map(({ schema }) => schema));
    if (!common) {
      diagnostics.push(
        typeDiagnostic(
          'TRANSFORM_DEFAULT_TYPE_MISMATCH',
          path,
          arguments_[1]!.schema,
          arguments_[0]!.schema,
        ),
      );
      return undefined;
    }
    return { schema: common, mayBeMissing: arguments_[1]!.mayBeMissing };
  }
  const expectedType = ['divide', 'multiply'].includes(expression.function) ? 'number' : 'string';
  const invalid = arguments_.find(({ schema }) => !primitiveAssignable(schema.type, expectedType));
  if (invalid) {
    diagnostics.push(
      typeDiagnostic('TRANSFORM_BUILTIN_ARGUMENT_TYPE', path, invalid.schema, {
        type: expectedType,
      } as TransformationSchema),
    );
    return undefined;
  }
  return {
    schema: withClassification(
      { type: expectedType } as TransformationSchema,
      arguments_.map(({ schema }) => schema.classification),
    ),
    mayBeMissing: arguments_.some(({ mayBeMissing }) => mayBeMissing),
  };
}

function resolvePath(
  root: TransformationSchema,
  segments: readonly string[],
  diagnosticPath: string,
  diagnostics: TransformationDiagnostic[],
): InferredValue | undefined {
  let current = root;
  let mayBeMissing = false;
  let inheritedClassification = root.classification;
  for (const segment of segments) {
    if (current.type !== 'object') {
      diagnostics.push(missingPathDiagnostic(diagnosticPath, segments, []));
      return undefined;
    }
    const required = current.required[segment];
    const optional = current.optional?.[segment];
    const next = required ?? optional;
    if (!next) {
      diagnostics.push(
        missingPathDiagnostic(diagnosticPath, segments, [
          ...Object.keys(current.required),
          ...Object.keys(current.optional ?? {}),
        ]),
      );
      return undefined;
    }
    mayBeMissing ||= optional !== undefined;
    inheritedClassification = highestClassification(inheritedClassification, next.classification);
    current = next;
  }
  return {
    schema: inheritedClassification
      ? { ...current, classification: inheritedClassification }
      : current,
    mayBeMissing,
  };
}

function validateAssignability(
  source: TransformationSchema,
  destination: TransformationSchema,
  path: string,
  diagnostics: TransformationDiagnostic[],
  destinationKind?: TransformationValidationContext['destinationKind'],
  inheritedSourceClassification?: DataClassification,
  inheritedDestinationClassification?: DataClassification,
) {
  const sourceClassification = highestClassification(
    inheritedSourceClassification,
    source.classification,
  );
  const destinationClassification =
    highestClassification(inheritedDestinationClassification, destination.classification) ??
    'public';
  if (source.type === 'null') {
    if (destination.type !== 'null' && !destination.nullable) {
      diagnostics.push(typeDiagnostic('TRANSFORM_NULLABILITY_MISMATCH', path, source, destination));
    }
    return;
  }
  if (source.nullable && destination.type !== 'null' && !destination.nullable) {
    diagnostics.push(typeDiagnostic('TRANSFORM_NULLABILITY_MISMATCH', path, source, destination));
    return;
  }
  if (!primitiveAssignable(source.type, destination.type)) {
    diagnostics.push(typeDiagnostic('TRANSFORM_TYPE_MISMATCH', path, source, destination));
    return;
  }
  if (source.type === 'object' && destination.type === 'object') {
    for (const [name, destinationField] of Object.entries(destination.required)) {
      const sourceField = source.required[name];
      if (!sourceField) {
        diagnostics.push({
          code: 'TRANSFORM_REQUIRED_FIELD_MISSING',
          path: `${path}.${name}`,
          message: `Required destination field '${name}' is not fully materialized.`,
          sourceType: 'missing',
          destinationType: describeType(destinationField),
          suggestedMappings: [`Add '${name}' to the object transformation`],
        });
      } else {
        validateAssignability(
          sourceField,
          destinationField,
          `${path}.${name}`,
          diagnostics,
          destinationKind,
          sourceClassification,
          destinationClassification,
        );
      }
    }
    for (const [name, destinationField] of Object.entries(destination.optional ?? {})) {
      const sourceField = source.required[name] ?? source.optional?.[name];
      if (!sourceField) continue;
      validateAssignability(
        sourceField,
        destinationField,
        `${path}.${name}`,
        diagnostics,
        destinationKind,
        sourceClassification,
        destinationClassification,
      );
    }
    return;
  }
  if (source.type === 'array' && destination.type === 'array') {
    if (source.items.type !== 'unknown') {
      validateAssignability(
        source.items,
        destination.items,
        `${path}[]`,
        diagnostics,
        destinationKind,
        sourceClassification,
        destinationClassification,
      );
    }
    return;
  }
  if (
    sourceClassification &&
    classificationRank[sourceClassification] > classificationRank[destinationClassification]
  ) {
    diagnostics.push({
      code: 'TRANSFORM_CLASSIFICATION_DOWNGRADE',
      path,
      message: `Classification '${sourceClassification}' cannot flow to '${destinationClassification}'.`,
      sourceType: describeType(source),
      destinationType: describeType(destination),
      sourceClassification,
      destinationClassification,
      suggestedMappings: [`Map to a destination classified '${sourceClassification}' or higher`],
    });
  } else if (
    destinationKind === 'notify' &&
    sourceClassification &&
    classificationRank[sourceClassification] >= classificationRank.secret
  ) {
    diagnostics.push({
      code: 'TRANSFORM_SECRET_EXPOSURE',
      path,
      message: `Classification '${sourceClassification}' cannot be emitted to notifications or logs.`,
      sourceType: describeType(source),
      destinationType: describeType(destination),
      sourceClassification,
      destinationClassification,
      suggestedMappings: ['Remove the secret or restricted field from the notification'],
    });
  }
}

function primitiveAssignable(
  source: TransformationSchema['type'],
  destination: TransformationSchema['type'],
) {
  return (
    source === 'unknown' ||
    source === destination ||
    (source === 'integer' && destination === 'number')
  );
}

function commonSchema(schemas: readonly TransformationSchema[]): TransformationSchema | undefined {
  const first = schemas[0];
  if (!first) return undefined;
  const nonNull = schemas.filter((schema) => schema.type !== 'null');
  if (nonNull.length === 0) return { type: 'null', nullable: true };
  const representative = nonNull[0]!;
  if (
    !nonNull.every(
      (schema) =>
        primitiveAssignable(schema.type, representative.type) ||
        primitiveAssignable(representative.type, schema.type),
    )
  ) {
    return undefined;
  }
  const nullable = schemas.some((schema) => schema.type === 'null' || schema.nullable);
  const classification = highestClassification(...schemas.map((schema) => schema.classification));
  if (representative.type === 'array') {
    const arrays = nonNull as Array<Extract<TransformationSchema, { type: 'array' }>>;
    const items = commonSchema(arrays.map((schema) => schema.items));
    if (!items) return undefined;
    return {
      type: 'array',
      items,
      ...(nullable ? { nullable: true } : {}),
      ...(classification ? { classification } : {}),
    };
  }
  if (representative.type === 'object') {
    const objects = nonNull as Array<Extract<TransformationSchema, { type: 'object' }>>;
    const allNames = new Set(
      objects.flatMap((schema) => [
        ...Object.keys(schema.required),
        ...Object.keys(schema.optional ?? {}),
      ]),
    );
    const required: Record<string, TransformationSchema> = {};
    const optional: Record<string, TransformationSchema> = {};
    for (const name of allNames) {
      const present = objects.flatMap((schema) => {
        const child = schema.required[name] ?? schema.optional?.[name];
        return child ? [child] : [];
      });
      const child = commonSchema(present);
      if (!child) return undefined;
      const requiredInEveryBranch = objects.every((schema) => name in schema.required);
      (requiredInEveryBranch ? required : optional)[name] = child;
    }
    return {
      type: 'object',
      required,
      ...(Object.keys(optional).length ? { optional } : {}),
      ...(nullable ? { nullable: true } : {}),
      ...(classification ? { classification } : {}),
    };
  }
  const primitiveRepresentative =
    nonNull.some((schema) => schema.type === 'number') &&
    nonNull.every((schema) => schema.type === 'number' || schema.type === 'integer')
      ? ({ type: 'number' } as const)
      : representative;
  return {
    ...primitiveRepresentative,
    ...(nullable ? { nullable: true } : {}),
    ...(classification ? { classification } : {}),
  };
}

function literalSchema(value: unknown): TransformationSchema {
  if (value === null) return { type: 'null', nullable: true };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      items:
        value.length === 0
          ? { type: 'unknown' }
          : (commonSchema(value.map(literalSchema)) ?? { type: 'unknown' }),
    };
  }
  if (typeof value === 'object') {
    return {
      type: 'object',
      required: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [
          key,
          literalSchema(child),
        ]),
      ),
    };
  }
  if (typeof value === 'number') return { type: Number.isInteger(value) ? 'integer' : 'number' };
  return { type: typeof value as 'string' | 'boolean' };
}

function highestClassification(...values: Array<DataClassification | undefined>) {
  return values
    .filter((value): value is DataClassification => !!value)
    .sort((left, right) => classificationRank[right] - classificationRank[left])[0];
}

function withClassification<T extends TransformationSchema>(
  schema: T,
  values: ReadonlyArray<DataClassification | undefined>,
): T {
  const classification = highestClassification(schema.classification, ...values);
  return classification ? { ...schema, classification } : schema;
}

function describeType(schema: TransformationSchema, missing = false): string {
  return `${schema.type}${schema.nullable ? ' | null' : ''}${missing ? ' | missing' : ''}`;
}

function typeDiagnostic(
  code: string,
  path: string,
  source: TransformationSchema,
  destination: TransformationSchema,
): TransformationDiagnostic {
  return {
    code,
    path,
    message: `Source type '${describeType(source)}' is not assignable to destination type '${describeType(destination)}'.`,
    sourceType: describeType(source),
    destinationType: describeType(destination),
    suggestedMappings: [`Provide a value assignable to '${describeType(destination)}'`],
  };
}

function missingPathDiagnostic(
  path: string,
  sourcePath: readonly string[],
  validFields: readonly string[],
): TransformationDiagnostic {
  const suggestedMappings = [...validFields].sort().map((field) => `Use sibling field '${field}'`);
  return {
    code: 'TRANSFORM_SOURCE_PATH_NOT_FOUND',
    path,
    message: `Source path '${sourcePath.join('.')}' is absent from the pinned schema.`,
    sourceType: 'missing',
    suggestedMappings:
      suggestedMappings.length > 0
        ? suggestedMappings
        : ['Use an existing field from the pinned source schema'],
  };
}

function enrichDiagnostics(
  diagnostics: readonly TransformationDiagnostic[],
  destination: TransformationSchema,
): TransformationDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    sourceType: diagnostic.sourceType ?? 'unknown',
    destinationType: diagnostic.destinationType ?? describeType(destination),
    suggestedMappings:
      diagnostic.suggestedMappings && diagnostic.suggestedMappings.length > 0
        ? diagnostic.suggestedMappings
        : [`Provide a value assignable to '${describeType(destination)}'`],
  }));
}
