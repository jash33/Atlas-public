import {
  TRANSFORMATION_LIMITS,
  type JsonValue,
  type TransformationExpression,
  type GraphCondition,
} from '@atlas/workflow-ir';

const MISSING = Symbol('atlas.transformation.missing');
type EvaluatedValue = JsonValue | typeof MISSING;

export type TransformationEvaluationErrorCode =
  | 'TRANSFORM_MISSING_PATH'
  | 'TRANSFORM_DIVIDE_BY_ZERO'
  | 'TRANSFORM_OUTPUT_SIZE_LIMIT'
  | 'TRANSFORM_POLICY_VIOLATION';

export class TransformationEvaluationError extends Error {
  readonly code: TransformationEvaluationErrorCode;

  constructor(code: TransformationEvaluationErrorCode, message: string) {
    super(message);
    this.name = 'TransformationEvaluationError';
    this.code = code;
  }
}

export interface TransformationEvaluationContext {
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly stepOutputs: Readonly<Record<string, Readonly<Record<string, JsonValue>> | undefined>>;
}

export function evaluateTransformationArguments(
  arguments_: Readonly<Record<string, TransformationExpression>>,
  context: TransformationEvaluationContext,
): Readonly<Record<string, JsonValue>> {
  const variables = new Map<string, JsonValue>();
  const output = Object.fromEntries(
    Object.entries(arguments_).map(([name, expression]) => {
      const value = evaluate(expression, context, variables);
      if (value === MISSING) throw missingValue(`activity argument '${name}'`);
      return [name, value];
    }),
  );
  const encodedBytes = new TextEncoder().encode(JSON.stringify(output)).byteLength;
  if (encodedBytes > TRANSFORMATION_LIMITS.maxOutputBytes) {
    throw new TransformationEvaluationError(
      'TRANSFORM_OUTPUT_SIZE_LIMIT',
      `Transformed activity input exceeds ${TRANSFORMATION_LIMITS.maxOutputBytes} bytes`,
    );
  }
  return output;
}

export function evaluateTransformationExpression(
  expression: TransformationExpression,
  context: TransformationEvaluationContext,
): JsonValue {
  return evaluateTransformationArguments({ value: expression }, context).value!;
}

export function evaluateGraphCondition(
  condition: GraphCondition,
  context: TransformationEvaluationContext,
): boolean {
  if (condition.operator === 'exists') {
    return (
      evaluateTransformationExpression(
        { kind: 'call', function: 'exists', arguments: [condition.left] },
        context,
      ) === true
    );
  }
  const left = evaluateTransformationExpression(condition.left, context);
  if (!condition.right) throw policyViolation('Comparison is missing its right value');
  const right = evaluateTransformationExpression(condition.right, context);
  if (condition.operator === 'greaterThan' || condition.operator === 'lessThan') {
    if (
      typeof left !== 'number' ||
      typeof right !== 'number' ||
      !Number.isFinite(left) ||
      !Number.isFinite(right)
    ) {
      throw policyViolation('Numeric comparisons need finite number values');
    }
    return condition.operator === 'greaterThan' ? left > right : left < right;
  }
  const equal = equalJson(left, right);
  return condition.operator === 'equals' ? equal : !equal;
}

function equalJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]!))
    );
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key]!, right[key]!))
  );
}

function evaluate(
  expression: TransformationExpression,
  context: TransformationEvaluationContext,
  variables: ReadonlyMap<string, JsonValue>,
): EvaluatedValue {
  if ('source' in expression) {
    if (expression.source === 'literal') return expression.value;
    if (expression.source === 'input') return readPath(context.input, expression.path);
    return readPath(context.stepOutputs[expression.stepId], expression.path);
  }

  if (expression.kind === 'variable') {
    return readPath(variables.get(expression.name), expression.path);
  }
  if (expression.kind === 'object') {
    return Object.fromEntries(
      Object.entries(expression.fields).map(([name, child]) => {
        const value = evaluate(child, context, variables);
        if (value === MISSING) throw missingValue(`object field '${name}'`);
        return [name, value];
      }),
    );
  }
  if (expression.kind === 'array') {
    return expression.items.map((child, index) => {
      const value = evaluate(child, context, variables);
      if (value === MISSING) throw missingValue(`array item ${index}`);
      return value;
    });
  }
  if (expression.kind === 'map') {
    const items = evaluate(expression.items, context, variables);
    if (!Array.isArray(items)) throw policyViolation('Map input must be an array');
    if (
      items.length > expression.maxItems ||
      items.length > TRANSFORMATION_LIMITS.maxArrayMapItems
    ) {
      throw policyViolation(`Map input exceeds its ${expression.maxItems} item limit`);
    }
    return items.map((item, index) => {
      const scopedVariables = new Map(variables);
      scopedVariables.set(expression.itemVariable, item);
      const value = evaluate(expression.body, context, scopedVariables);
      if (value === MISSING) throw missingValue(`map result ${index}`);
      return value;
    });
  }
  if (expression.kind === 'conditional') {
    const condition = evaluate(expression.condition, context, variables);
    if (condition === MISSING) throw missingValue('conditional condition');
    if (typeof condition !== 'boolean') {
      throw policyViolation('Conditional condition must be a boolean');
    }
    return evaluate(condition ? expression.then : expression.else, context, variables);
  }

  const values = expression.arguments.map((argument) => evaluate(argument, context, variables));
  if (expression.function === 'exists') return values[0] !== MISSING;
  if (expression.function === 'default') return values[0] === MISSING ? values[1]! : values[0]!;
  if (values.some((value) => value === MISSING)) throw missingValue(`${expression.function} input`);

  if (expression.function === 'uppercase' || expression.function === 'lowercase') {
    const value = values[0];
    if (typeof value !== 'string') {
      throw policyViolation(`${expression.function} input must be a string`);
    }
    return expression.function === 'uppercase' ? value.toUpperCase() : value.toLowerCase();
  }
  if (expression.function === 'concat') {
    if (!values.every((value): value is string => typeof value === 'string')) {
      throw policyViolation('concat inputs must be strings');
    }
    return values.join('');
  }

  const left = values[0];
  const right = values[1];
  if (
    typeof left !== 'number' ||
    typeof right !== 'number' ||
    !Number.isFinite(left) ||
    !Number.isFinite(right)
  ) {
    throw policyViolation(`${expression.function} inputs must be finite numbers`);
  }
  if (expression.function === 'divide' && right === 0) {
    throw new TransformationEvaluationError(
      'TRANSFORM_DIVIDE_BY_ZERO',
      'Transformation attempted division by zero',
    );
  }
  const result = expression.function === 'divide' ? left / right : left * right;
  if (!Number.isFinite(result))
    throw policyViolation(`${expression.function} result is not finite`);
  return result;
}

function readPath(value: JsonValue | undefined, path: readonly string[]): EvaluatedValue {
  let current: JsonValue | undefined = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return MISSING;
    current = current[segment];
    if (current === undefined) return MISSING;
  }
  return current ?? (current === null ? null : MISSING);
}

function missingValue(location: string) {
  return new TransformationEvaluationError(
    'TRANSFORM_MISSING_PATH',
    `Transformation has no value for ${location}`,
  );
}

function policyViolation(message: string) {
  return new TransformationEvaluationError('TRANSFORM_POLICY_VIOLATION', message);
}
