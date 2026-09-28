import { objectSchemaSchema, type ObjectSchema } from '@atlas/workflow-ir';

import type { TransformationSchema } from './transformation-validation.js';
import { capabilityInputFields, jsonSchemaToTransformationSchema } from './workflow-validation.js';

type JsonObject = Record<string, unknown>;
type ResponseValue = ObjectSchema['required'][string];

/**
 * Atlas sets this on every run from the run command id. Callers never send it,
 * so it stays out of the caller-facing input schema but is always available to
 * mappings and validation.
 */
export const atlasWorkflowRunIdInput = 'atlasWorkflowRunId';

const runIdInput: ResponseValue = { type: 'string', classification: 'internal' };

/** Convert a pinned transformation schema into the compiled input-schema value shape. */
export function responseValueFromTransformationSchema(
  schema: TransformationSchema,
): ResponseValue | undefined {
  const classification = schema.classification ? { classification: schema.classification } : {};
  if (schema.type === 'object') {
    const required: Record<string, ResponseValue> = {};
    for (const [name, child] of Object.entries(schema.required)) {
      const converted = responseValueFromTransformationSchema(child);
      if (!converted) return undefined;
      required[name] = converted;
    }
    return { type: 'object', required, ...classification };
  }
  if (schema.type === 'array') {
    const items = responseValueFromTransformationSchema(schema.items);
    return items ? { type: 'array', items, ...classification } : undefined;
  }
  const type = schema.type;
  if (type === 'unknown') return undefined;
  return schema.classification ? { type, classification: schema.classification } : { type };
}

function inputNameFor(
  field: string,
  argument: unknown,
  includeUnmapped: boolean,
): string | undefined {
  if (!argument || typeof argument !== 'object') return includeUnmapped ? field : undefined;
  const reference = argument as { source?: unknown; path?: unknown };
  // A fixed value or a prior step's response is not something the caller sends.
  if (reference.source === 'literal' || reference.source === 'stepOutput') return undefined;
  if (reference.source === 'input' && Array.isArray(reference.path)) {
    const [name, ...rest] = reference.path;
    if (typeof name === 'string' && rest.length === 0) return name;
  }
  return includeUnmapped ? field : undefined;
}

/**
 * The required request fields of one capability, shaped as a workflow input
 * schema. Used when a request names no runtime inputs: leftover required
 * fields become what the caller must send. When the step's arguments are
 * known, fields filled by a fixed value or a prior step are skipped and
 * fields read from `input.x` are named `x`.
 */
export function inputSchemaFromCapabilityRequirements(
  fragment: JsonObject,
  stepArguments: Readonly<Record<string, unknown>> = {},
  options: { includeUnmapped?: boolean } = {},
): ObjectSchema {
  const includeUnmapped = options.includeUnmapped !== false;
  const required: Record<string, ResponseValue> = {};
  for (const [field, definition] of capabilityInputFields(fragment)) {
    if (!definition.required || field === atlasWorkflowRunIdInput) continue;
    if (definition.schema?.const !== undefined) continue;
    const name = inputNameFor(field, stepArguments[field], includeUnmapped);
    if (!name || name === atlasWorkflowRunIdInput) continue;
    const schema = jsonSchemaToTransformationSchema(fragment, definition.schema);
    if (!schema) continue;
    const value = responseValueFromTransformationSchema(schema);
    if (value) required[name] = value;
  }
  return { required };
}

export function withoutBackendOwnedInputs(schema: ObjectSchema): ObjectSchema {
  const { [atlasWorkflowRunIdInput]: _runId, ...required } = schema.required;
  return { required };
}

/** The inputs a mapping may read: what the caller sends plus what Atlas injects. */
export function withBackendOwnedInputs(schema: ObjectSchema): ObjectSchema {
  return { required: { ...schema.required, [atlasWorkflowRunIdInput]: runIdInput } };
}

export interface WorkflowInputSchemaSource {
  readonly inputSchema?: unknown;
  readonly steps: ReadonlyArray<{
    readonly kind: string;
    readonly capabilityVersionId?: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }>;
}

function mergeRequired(
  left: Record<string, ResponseValue>,
  right: Record<string, ResponseValue>,
): Record<string, ResponseValue> {
  return { ...left, ...right };
}

/**
 * The caller-facing input schema for one workflow. Nothing here comes from
 * environment policy: a workflow declares its inputs, or inherits leftover
 * required fields from every step.
 */
export function resolveWorkflowInputSchema(
  executable: WorkflowInputSchemaSource,
  fragmentFor: (capabilityVersionId: string) => JsonObject | undefined,
  options: { includeUnmapped?: boolean } = {},
): ObjectSchema {
  const declared = objectSchemaSchema.safeParse(executable.inputSchema);
  if (declared.success) {
    const own = withoutBackendOwnedInputs(declared.data);
    if (Object.keys(own.required).length > 0) return own;
  }
  let required: Record<string, ResponseValue> = {};
  for (const step of executable.steps) {
    if (step.kind === 'terminal' || !step.capabilityVersionId) continue;
    const fragment = fragmentFor(step.capabilityVersionId);
    if (!fragment) continue;
    required = mergeRequired(
      required,
      inputSchemaFromCapabilityRequirements(fragment, step.arguments, options).required,
    );
  }
  return { required };
}
