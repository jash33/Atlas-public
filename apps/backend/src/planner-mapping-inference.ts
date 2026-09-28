import type { TransformationExpression } from '@atlas/workflow-ir';

export interface RecipeDataFlow {
  readonly sourceOperationId: string;
  readonly targetOperationId: string;
  readonly destinationField?: string;
}

export interface PriorStepOutput {
  readonly stepId: string;
  readonly operationId: string;
  readonly outputLeaves: ReadonlyArray<{
    readonly path: readonly string[];
    readonly type: string;
  }>;
}

export type MissingFieldInference =
  | { kind: 'stepOutput'; stepId: string; path: readonly string[] }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'input' }
  | { kind: 'ambiguous' };

export interface InferMissingFieldMappingInput {
  readonly field: string;
  readonly destinationType: string;
  readonly destinationEnumValues?: readonly (string | number)[];
  readonly destinationOperationId?: string;
  readonly developerRequest: string;
  readonly priorSteps: readonly PriorStepOutput[];
  readonly recipeDataFlows?: readonly RecipeDataFlow[];
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function requestTokens(request: string) {
  return request
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fieldNoun(field: string) {
  const match = /^(.+)_id$/i.exec(field);
  return match?.[1] ? normalizeToken(match[1]) : undefined;
}

function operationMentionsNoun(operationId: string, noun: string) {
  return normalizeToken(operationId).includes(noun);
}

function idLeavesForNoun(step: PriorStepOutput, noun: string) {
  const nounId = `${noun}id`;
  return step.outputLeaves.filter((leaf) => {
    if (leaf.type !== 'string') return false;
    const name = normalizeToken(leaf.path.at(-1) ?? '');
    return name === 'id' || name === nounId;
  });
}

function uniqueIdSource(
  steps: readonly PriorStepOutput[],
  noun: string,
): MissingFieldInference | undefined {
  const matches = steps.flatMap((step) => {
    const leaves = idLeavesForNoun(step, noun);
    const preferred =
      leaves.find((leaf) => normalizeToken(leaf.path.at(-1) ?? '') === `${noun}id`) ??
      (leaves.length === 1
        ? leaves[0]
        : leaves.find(
            (leaf) => leaf.path.length === 1 && normalizeToken(leaf.path[0] ?? '') === 'id',
          ));
    return preferred ? [{ stepId: step.stepId, path: preferred.path }] : [];
  });
  if (matches.length === 1) {
    return { kind: 'stepOutput', stepId: matches[0]!.stepId, path: matches[0]!.path };
  }
  if (matches.length > 1) return { kind: 'ambiguous' };
  return undefined;
}

function recipeIdSource(
  input: InferMissingFieldMappingInput,
  noun: string | undefined,
): MissingFieldInference | undefined {
  const destinationOperationId = input.destinationOperationId;
  if (!noun || !destinationOperationId || !input.recipeDataFlows) return undefined;
  const flows = input.recipeDataFlows.filter(
    (flow) =>
      flow.targetOperationId === destinationOperationId &&
      (flow.destinationField === undefined || flow.destinationField === input.field),
  );
  const sourceOperations = [...new Set(flows.map((flow) => flow.sourceOperationId))];
  if (sourceOperations.length !== 1) return undefined;
  const sourceSteps = input.priorSteps.filter((step) => step.operationId === sourceOperations[0]);
  if (sourceSteps.length === 0) return undefined;
  return uniqueIdSource(sourceSteps, noun);
}

function requestLiteral(
  request: string,
  enumValues: readonly (string | number)[] | undefined,
): MissingFieldInference | undefined {
  if (!enumValues || enumValues.length === 0) return undefined;
  const tokens = new Set(requestTokens(request).map(normalizeToken));
  const matches = enumValues.filter((value) => tokens.has(normalizeToken(String(value))));
  if (matches.length === 1) {
    return { kind: 'literal', value: matches[0]! };
  }
  return undefined;
}

/**
 * Fill a required destination field the developer did not name. Prefer a unique
 * prior-step id, then a unique enum word from the request, otherwise a runtime input.
 */
export function inferMissingFieldMapping(
  input: InferMissingFieldMappingInput,
): MissingFieldInference {
  input = {
    ...input,
    priorSteps: input.priorSteps.map((step) => ({
      ...step,
      outputLeaves: step.outputLeaves.filter(
        (leaf) =>
          leaf.type === input.destinationType ||
          (leaf.type === 'integer' && input.destinationType === 'number'),
      ),
    })),
  };
  const noun = fieldNoun(input.field);
  const recipeSource = recipeIdSource(input, noun);
  if (recipeSource) return recipeSource;
  if (noun) {
    const namedSources = input.priorSteps.filter((step) =>
      operationMentionsNoun(step.operationId, noun),
    );
    const wired = uniqueIdSource(namedSources.length > 0 ? namedSources : [], noun);
    if (wired) return wired;
  }
  const literal = requestLiteral(input.developerRequest, input.destinationEnumValues);
  if (literal) return literal;
  const namedSources = input.priorSteps.flatMap((step) =>
    step.outputLeaves
      .filter((leaf) => leaf.path.at(-1) === input.field)
      .map((leaf) => ({ kind: 'stepOutput' as const, stepId: step.stepId, path: leaf.path })),
  );
  if (namedSources.length === 1) return namedSources[0]!;
  if (namedSources.length > 1) return { kind: 'ambiguous' };
  return { kind: 'input' };
}

export function inferenceToExpression(
  field: string,
  inference: Exclude<MissingFieldInference, { kind: 'ambiguous' }>,
): TransformationExpression {
  if (inference.kind === 'stepOutput') {
    return { source: 'stepOutput', stepId: inference.stepId, path: [...inference.path] };
  }
  if (inference.kind === 'literal') {
    return { source: 'literal', value: inference.value };
  }
  return { source: 'input', path: [field] };
}
