import { transformationExpressionSchema, type TransformationExpression } from '@atlas/workflow-ir';

import { validateTransformation, type TransformationSchema } from './transformation-validation.js';
import {
  capabilityInputFields,
  capabilityOutputSchema,
  jsonSchemaToTransformationSchema,
  responseSchemaToTransformationSchema,
} from './workflow-validation.js';

export type MappingUnit = 'cents' | 'decimal-currency' | 'kilograms' | 'meters';

export type MappingSchema = TransformationSchema & {
  readonly unit?: MappingUnit;
  readonly enumValues?: readonly (string | number)[];
};

export interface MappingSource {
  readonly source: 'input' | 'stepOutput';
  readonly stepId?: string;
  readonly schema: MappingSchema;
}

export interface MappingEvidence {
  readonly sourcePath: readonly string[];
  readonly sourceType: string;
  readonly sourceUnit?: MappingUnit;
  readonly destinationType: string;
  readonly destinationUnit?: MappingUnit;
}

export interface PlannedMapping {
  readonly candidateId: string;
  readonly destinationPath: readonly string[];
  readonly expression: TransformationExpression;
  readonly evidence: MappingEvidence;
  readonly conversion?: string;
  readonly origin: 'requested' | 'inferred';
}

export interface MappingDiagnostic {
  readonly code: string;
  readonly destinationPath?: readonly string[];
  readonly message: string;
}

export interface MappingQuestion {
  readonly destinationPath: readonly string[];
  readonly question: string;
  readonly candidateIds: readonly string[];
}

export interface PlanApiMappingsInput {
  readonly intentFingerprint: string;
  readonly projectionFingerprint: string;
  readonly activeProjectionFingerprint: string;
  readonly sources: readonly MappingSource[];
  readonly destination: MappingSchema;
  readonly destinationCapability?: {
    readonly serviceId: string;
    readonly operationId: string;
  };
  readonly selections?: Readonly<Record<string, string>>;
  readonly sourceAliases?: Readonly<Record<string, readonly string[]>>;
  readonly inferredSourcePaths?: Readonly<Record<string, readonly (readonly string[])[]>>;
  readonly statedDestinationPaths?: readonly (readonly string[])[];
  readonly allowClassificationDowngrade?: boolean;
  readonly proposedArguments?: Readonly<Record<string, TransformationExpression>>;
}

export interface ProjectedMappingRequest {
  readonly sourceSteps: readonly {
    readonly stepId: string;
    readonly capabilityVersionId: string;
  }[];
  readonly destinationCapabilityVersionId: string;
  readonly destinationStepId: string;
  readonly selections?: Readonly<Record<string, string>>;
  readonly statedDestinationPaths?: readonly (readonly string[])[];
}

type WorkflowInputSchema = Parameters<typeof responseSchemaToTransformationSchema>[0];

interface MappingProjection {
  readonly fingerprint: string;
  readonly capabilities: readonly {
    readonly capabilityVersionId: string;
    readonly identity?: {
      readonly serviceId: string;
      readonly operationId: string;
    };
    readonly fragment: unknown;
    readonly annotation?: { readonly idempotencyField?: string | null };
  }[];
}

interface Leaf {
  readonly schema: MappingSchema;
  readonly path: readonly string[];
  readonly source?: MappingSource;
}

function childSchema(schema: TransformationSchema): MappingSchema {
  return schema as MappingSchema;
}

function leaves(schema: MappingSchema, path: readonly string[] = []): Leaf[] {
  if (schema.type !== 'object') return [{ schema, path }];
  return Object.entries(schema.required).flatMap(([name, child]) =>
    leaves(childSchema(child), [...path, name]),
  );
}

function sourceLeaves(sources: readonly MappingSource[]) {
  return sources.flatMap((source) => leaves(source.schema).map((leaf) => ({ ...leaf, source })));
}

function pathKey(path: readonly string[]) {
  return path.join('.');
}

function serviceLabel(serviceId: string) {
  return serviceId
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) =>
      word.toLowerCase() === 'api' ? 'API' : `${word[0]!.toUpperCase()}${word.slice(1)}`,
    )
    .join(' ');
}

function mappingQuestion(input: PlanApiMappingsInput, field: string) {
  if (!input.destinationCapability) {
    return `What should Atlas use for request field ${field}?`;
  }
  return `What should Atlas use for the ${input.destinationCapability.operationId} request field ${field} in the ${serviceLabel(input.destinationCapability.serviceId)} API?`;
}

function normalizedName(path: readonly string[]) {
  return (path.at(-1) ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function semanticTokens(path: readonly string[]) {
  return new Set(
    path.flatMap((segment) =>
      segment
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2),
    ),
  );
}

function sharesSemanticToken(source: readonly string[], destination: readonly string[]) {
  const sourceTokens = semanticTokens(source);
  return [...semanticTokens(destination)].some((token) => sourceTokens.has(token));
}

function currencyBaseName(path: readonly string[]) {
  return normalizedName(path).replace(/(?:incents|cents|minorunits|minorunit)$/, '');
}

function reference(leaf: Leaf): TransformationExpression {
  if (leaf.source?.source === 'stepOutput') {
    return { source: 'stepOutput', stepId: leaf.source.stepId!, path: [...leaf.path] };
  }
  return { source: 'input', path: [...leaf.path] };
}

function primitiveAssignable(source: MappingSchema, destination: MappingSchema) {
  return (
    source.type === destination.type || (source.type === 'integer' && destination.type === 'number')
  );
}

const unitConversions = {
  'cents->decimal-currency': {
    function: 'divide',
    factor: 100,
    explanation: 'Divide cents by 100 to produce decimal currency.',
  },
  'decimal-currency->cents': {
    function: 'multiply',
    factor: 100,
    explanation:
      'Multiply decimal currency by 100; fractional minor units may be lossy and require confirmation.',
  },
} as const;

function unitConversion(source?: MappingUnit, destination?: MappingUnit) {
  if (!source || !destination) return undefined;
  return unitConversions[`${source}->${destination}` as keyof typeof unitConversions];
}

function sameEnum(source: MappingSchema, destination: MappingSchema) {
  if (!source.enumValues && !destination.enumValues) return true;
  if (!source.enumValues || !destination.enumValues) return false;
  return (
    source.enumValues.length === destination.enumValues.length &&
    source.enumValues.every((value) => destination.enumValues!.includes(value))
  );
}

function candidate(
  source: Leaf,
  destination: Leaf,
  expression: TransformationExpression,
  conversion?: string,
  origin: PlannedMapping['origin'] = 'requested',
): PlannedMapping {
  const sourceIdentity =
    source.source?.source === 'stepOutput' ? `step:${source.source.stepId}` : 'input';
  const destinationKey = pathKey(destination.path);
  return {
    candidateId: `${destinationKey}<-${sourceIdentity}:${pathKey(source.path)}${conversion ? ':convert' : ''}`,
    destinationPath: destination.path,
    expression,
    evidence: {
      sourcePath: source.path,
      sourceType: source.schema.type,
      ...(source.schema.unit ? { sourceUnit: source.schema.unit } : {}),
      destinationType: destination.schema.type,
      ...(destination.schema.unit ? { destinationUnit: destination.schema.unit } : {}),
    },
    origin,
    ...(conversion ? { conversion } : {}),
  };
}

function buildCandidates(
  sourceFields: readonly Leaf[],
  destination: Leaf,
  sourceAlias?: readonly string[],
) {
  const aliasedSources = sourceAlias
    ? sourceFields.filter(
        (source) =>
          pathKey(source.path) === pathKey(sourceAlias) &&
          primitiveAssignable(source.schema, destination.schema) &&
          source.schema.unit === destination.schema.unit &&
          source.schema.case === destination.schema.case &&
          sameEnum(source.schema, destination.schema),
      )
    : [];
  if (aliasedSources.length > 0) {
    const inputs = aliasedSources.filter(({ source }) => source?.source !== 'stepOutput');
    const preferred = inputs.length === 1 ? inputs : aliasedSources;
    return preferred.map((source) =>
      candidate(source, destination, reference(source), undefined, 'inferred'),
    );
  }
  const exactName = sourceFields.filter(
    (source) => normalizedName(source.path) === normalizedName(destination.path),
  );
  const compatibleExact = exactName.filter(
    (source) =>
      primitiveAssignable(source.schema, destination.schema) &&
      source.schema.unit === destination.schema.unit &&
      source.schema.case === destination.schema.case &&
      sameEnum(source.schema, destination.schema),
  );
  if (compatibleExact.length > 0) {
    const stepOutputs = compatibleExact.filter(({ source }) => source?.source === 'stepOutput');
    const preferred =
      stepOutputs.length === 1 && compatibleExact.some(({ source }) => source?.source === 'input')
        ? stepOutputs
        : compatibleExact;
    return preferred.map((source) => candidate(source, destination, reference(source)));
  }

  const wrappedValues = sourceFields.filter(
    (source) =>
      normalizedName(source.path) === 'value' &&
      source.path.length > 1 &&
      normalizedName(source.path.slice(0, -1)) === normalizedName(destination.path) &&
      primitiveAssignable(source.schema, destination.schema) &&
      source.schema.unit === destination.schema.unit &&
      source.schema.case === destination.schema.case &&
      sameEnum(source.schema, destination.schema),
  );
  if (wrappedValues.length > 0) {
    return wrappedValues.map((source) => candidate(source, destination, reference(source)));
  }

  const caseConversions = exactName.filter(
    (source) =>
      source.schema.type === 'string' &&
      destination.schema.type === 'string' &&
      source.schema.case &&
      destination.schema.case &&
      source.schema.case !== destination.schema.case,
  );
  if (caseConversions.length > 0) {
    return caseConversions.map((source) =>
      candidate(
        source,
        destination,
        {
          kind: 'call',
          function: destination.schema.case === 'upper' ? 'uppercase' : 'lowercase',
          arguments: [reference(source)],
        },
        `Convert ${source.schema.case}case text to ${destination.schema.case}case.`,
      ),
    );
  }

  const currencyConversions = sourceFields.filter(
    (source) =>
      currencyBaseName(source.path) === currencyBaseName(destination.path) &&
      ['number', 'integer'].includes(source.schema.type) &&
      ['number', 'integer'].includes(destination.schema.type),
  );
  const convertedCurrencies = currencyConversions.flatMap((source) => {
    const conversion = unitConversion(source.schema.unit, destination.schema.unit);
    if (!conversion) return [];
    return [
      candidate(
        source,
        destination,
        {
          kind: 'call',
          function: conversion.function,
          arguments: [reference(source), { source: 'literal', value: conversion.factor }],
        },
        conversion.explanation,
      ),
    ];
  });
  if (convertedCurrencies.length > 0) return convertedCurrencies;
  return sourceFields
    .filter(
      (source) =>
        sharesSemanticToken(source.path, destination.path) &&
        primitiveAssignable(source.schema, destination.schema) &&
        source.schema.unit === destination.schema.unit &&
        source.schema.case === destination.schema.case &&
        sameEnum(source.schema, destination.schema),
    )
    .map((source) =>
      candidate(
        source,
        destination,
        reference(source),
        'Use a semantically related field after human confirmation.',
        'inferred',
      ),
    );
}

function validationContext(sources: readonly MappingSource[]) {
  return {
    workflowInput:
      sources.find(({ source }) => source === 'input')?.schema ??
      ({ type: 'object', required: {} } as const),
    stepOutputs: new Map(
      sources.flatMap((source) =>
        source.source === 'stepOutput' && source.stepId
          ? ([[source.stepId, source.schema]] as const)
          : [],
      ),
    ),
  };
}

function sameExpression(left: TransformationExpression, right: TransformationExpression) {
  if ('kind' in left || 'kind' in right) return false;
  if (left.source !== right.source) return false;
  if (left.source === 'literal') {
    return right.source === 'literal' && left.value === right.value;
  }
  if (left.source === 'input') {
    return right.source === 'input' && pathKey(left.path) === pathKey(right.path);
  }
  return (
    right.source === 'stepOutput' &&
    left.stepId === right.stepId &&
    pathKey(left.path) === pathKey(right.path)
  );
}

export function planApiMappings(input: PlanApiMappingsInput) {
  if (input.projectionFingerprint !== input.activeProjectionFingerprint) {
    return {
      status: 'manual_review' as const,
      intentFingerprint: input.intentFingerprint,
      projectionFingerprint: input.projectionFingerprint,
      resolvedMappings: [],
      candidateMappings: [],
      requiredQuestions: [],
      diagnostics: [
        {
          code: 'PROJECTION_DRIFT',
          message: 'The authorized capability projection changed during mapping clarification.',
        },
      ],
    };
  }

  const availableSources = sourceLeaves(input.sources);
  const resolvedMappings: PlannedMapping[] = [];
  const candidateMappings: PlannedMapping[] = [];
  const requiredQuestions: MappingQuestion[] = [];
  const diagnostics: MappingDiagnostic[] = [];
  const context = validationContext(input.sources);

  for (const destination of leaves(input.destination)) {
    const key = pathKey(destination.path);
    let proposed = input.proposedArguments?.[destination.path[0]!];
    for (const segment of destination.path.slice(1)) {
      proposed =
        proposed && 'kind' in proposed && proposed.kind === 'object'
          ? proposed.fields[segment]
          : undefined;
    }
    const sourceAlias = input.sourceAliases?.[key];
    const matchingName = availableSources.filter(
      (source) =>
        normalizedName(source.path) === normalizedName(destination.path) ||
        (sourceAlias !== undefined && pathKey(source.path) === pathKey(sourceAlias)),
    );
    const generatedOptions = buildCandidates(availableSources, destination, sourceAlias);
    const inferredPaths = input.inferredSourcePaths?.[key];
    const inferredOptions =
      generatedOptions.length === 0 && inferredPaths
        ? availableSources
            .filter((source) =>
              inferredPaths.some((path) => pathKey(source.path) === pathKey(path)),
            )
            .map((source) =>
              candidate(source, destination, reference(source), undefined, 'inferred'),
            )
        : [];
    const generatedOrInferred = generatedOptions.length > 0 ? generatedOptions : inferredOptions;
    const validatedOptions = generatedOrInferred.map((option) => ({
      option,
      validation: applicableDiagnostics(
        validateTransformation(option.expression, destination.schema, context, key),
        input.allowClassificationDowngrade,
      ),
    }));
    const rejectedDiagnostics = validatedOptions.flatMap(({ validation }) =>
      validation.map(({ code, message }) => ({
        code,
        destinationPath: destination.path,
        message,
      })),
    );
    const options = validatedOptions.flatMap(({ option, validation }) =>
      validation.length === 0 ? [option] : [],
    );
    const proposedEnumSafe =
      !destination.schema.enumValues ||
      (proposed &&
        'source' in proposed &&
        (proposed.source === 'literal'
          ? destination.schema.enumValues.some((value) => value === proposed.value)
          : availableSources.some(
              (source) =>
                source.source?.source === proposed.source &&
                (proposed.source !== 'stepOutput' || source.source?.stepId === proposed.stepId) &&
                pathKey(source.path) === pathKey(proposed.path) &&
                sameEnum(source.schema, destination.schema),
            )));
    if (
      options.length === 0 &&
      proposed &&
      proposedEnumSafe &&
      applicableDiagnostics(
        validateTransformation(proposed, destination.schema, context, key),
        input.allowClassificationDowngrade,
      ).length === 0
    ) {
      // Name matching cannot discover user-specified literals or differently named source paths.
      // The proposal still has to pass the same exact schema, source scope, and policy validation.
      resolvedMappings.push(
        withStatedOrigin(
          {
            candidateId: `${key}<-validated-proposal`,
            destinationPath: destination.path,
            expression: proposed,
            evidence: {
              sourcePath:
                'source' in proposed && proposed.source !== 'literal' ? proposed.path : [],
              sourceType: destination.schema.type,
              destinationType: destination.schema.type,
            },
            origin: 'inferred',
          },
          input.statedDestinationPaths,
        ),
      );
      continue;
    }
    if (options.length === 0) {
      diagnostics.push(...rejectedDiagnostics);
      if (
        matchingName.some(
          (source) => source.schema.enumValues && !sameEnum(source.schema, destination.schema),
        )
      ) {
        diagnostics.push({
          code: 'ENUM_MISMATCH',
          destinationPath: destination.path,
          message: `Source and destination enum values differ for '${key}'.`,
        });
      }
      if (
        matchingName.some(
          (source) =>
            source.schema.unit &&
            destination.schema.unit &&
            source.schema.unit !== destination.schema.unit &&
            !unitConversion(source.schema.unit, destination.schema.unit),
        )
      ) {
        diagnostics.push({
          code: 'INCOMPATIBLE_UNITS',
          destinationPath: destination.path,
          message: `Source and destination units are incompatible for '${key}'.`,
        });
      }
    }
    if (options.some(({ conversion }) => conversion?.includes('lossy'))) {
      diagnostics.push({
        code: 'LOSSY_TRANSFORM',
        destinationPath: destination.path,
        message: `A candidate for '${key}' may lose precision and requires human selection.`,
      });
    }
    const selectedId = input.selections?.[key];
    if (selectedId) {
      const selected = options.find(({ candidateId }) => candidateId === selectedId);
      if (!selected) {
        diagnostics.push({
          code: 'INVALID_MAPPING_SELECTION',
          destinationPath: destination.path,
          message: `The selected mapping for '${key}' is not an authorized candidate.`,
        });
        continue;
      }
      const expression = transformationExpressionSchema.parse(selected.expression);
      const validation = applicableDiagnostics(
        validateTransformation(expression, destination.schema, context, key),
        input.allowClassificationDowngrade,
      );
      if (validation.length > 0) {
        diagnostics.push(
          ...validation.map(({ code, message }) => ({
            code,
            destinationPath: destination.path,
            message,
          })),
        );
        continue;
      }
      resolvedMappings.push({ ...selected, expression, origin: 'requested' });
      continue;
    }

    if (proposed && options.some((option) => sameExpression(option.expression, proposed))) {
      const matching = options.find((option) => sameExpression(option.expression, proposed))!;
      resolvedMappings.push({ ...matching, expression: proposed, origin: 'requested' });
      continue;
    }

    if (options.length === 1 && !options[0]!.conversion) {
      resolvedMappings.push(withStatedOrigin(options[0]!, input.statedDestinationPaths));
      continue;
    }
    if (options.length > 0) {
      candidateMappings.push(...options);
      requiredQuestions.push({
        destinationPath: destination.path,
        question: mappingQuestion(input, key),
        candidateIds: options.map(({ candidateId }) => candidateId),
      });
      continue;
    }
    diagnostics.push({
      code: 'MISSING_REQUIRED_DESTINATION_FIELD',
      destinationPath: destination.path,
      message: `No compatible authorized source can materialize required destination field '${key}'.`,
    });
  }

  const impossible = diagnostics.some(({ code }) => code !== 'LOSSY_TRANSFORM');
  return {
    status: impossible
      ? ('impossible' as const)
      : requiredQuestions.length > 0
        ? ('clarification_required' as const)
        : ('ready' as const),
    intentFingerprint: input.intentFingerprint,
    projectionFingerprint: input.projectionFingerprint,
    resolvedMappings,
    candidateMappings,
    requiredQuestions,
    diagnostics,
  };
}

export function planProjectedApiMappings(input: {
  readonly intentFingerprint: string;
  readonly projection: MappingProjection;
  readonly activeProjectionFingerprint: string;
  /** What this workflow's caller sends, plus the inputs Atlas injects. Absent means no inputs. */
  readonly workflowInputSchema?: WorkflowInputSchema;
  readonly request: ProjectedMappingRequest;
  readonly allowClassificationDowngrade?: boolean;
  readonly proposedArguments?: Readonly<Record<string, TransformationExpression>>;
}) {
  const findCapability = (capabilityVersionId: string) =>
    input.projection.capabilities.find(
      (capability) => capability.capabilityVersionId === capabilityVersionId,
    );
  const destinationCapability = findCapability(input.request.destinationCapabilityVersionId);
  if (!destinationCapability) {
    return missingProjectedCapability(
      input.intentFingerprint,
      input.projection.fingerprint,
      input.request.destinationCapabilityVersionId,
    );
  }

  const destinationFragment = destinationCapability.fragment as Record<string, unknown>;
  const destinationRequired: Record<string, TransformationSchema> = {};
  const constantMappings: PlannedMapping[] = [];
  for (const [name, field] of capabilityInputFields(destinationFragment)) {
    if (!field.required) continue;
    const schema = jsonSchemaToTransformationSchema(destinationFragment, field.schema);
    if (!schema) continue;
    const constant = field.schema?.const;
    const constantValue =
      constant === null ||
      typeof constant === 'string' ||
      typeof constant === 'number' ||
      typeof constant === 'boolean'
        ? constant
        : undefined;
    if (constantValue !== undefined) {
      constantMappings.push({
        candidateId: `${name}<-schema-constant`,
        destinationPath: [name],
        expression: { source: 'literal', value: constantValue },
        evidence: {
          sourcePath: [],
          sourceType: typeof constantValue,
          destinationType: schema.type,
        },
        origin: 'inferred',
      });
      continue;
    }
    destinationRequired[name] = schema;
  }

  const sources: MappingSource[] = input.workflowInputSchema
    ? [
        {
          source: 'input',
          schema: responseSchemaToTransformationSchema(input.workflowInputSchema),
        },
      ]
    : [];
  for (const sourceStep of input.request.sourceSteps) {
    const capability = findCapability(sourceStep.capabilityVersionId);
    if (!capability) {
      return missingProjectedCapability(
        input.intentFingerprint,
        input.projection.fingerprint,
        sourceStep.capabilityVersionId,
      );
    }
    const fragment = capability.fragment as Record<string, unknown>;
    const schema = jsonSchemaToTransformationSchema(fragment, capabilityOutputSchema(fragment));
    if (schema) sources.push({ source: 'stepOutput', stepId: sourceStep.stepId, schema });
  }

  const inferredIdempotency = inferIdempotencySources(
    input.workflowInputSchema,
    destinationCapability.annotation?.idempotencyField,
    sources.filter((source) => source.source === 'stepOutput'),
  );
  const plan = planApiMappings({
    intentFingerprint: input.intentFingerprint,
    projectionFingerprint: input.projection.fingerprint,
    activeProjectionFingerprint: input.activeProjectionFingerprint,
    sources,
    destination: { type: 'object', required: destinationRequired },
    ...(destinationCapability.identity
      ? { destinationCapability: destinationCapability.identity }
      : {}),
    ...(input.request.selections ? { selections: input.request.selections } : {}),
    ...(input.request.statedDestinationPaths
      ? { statedDestinationPaths: input.request.statedDestinationPaths }
      : {}),
    sourceAliases: {
      eventId: ['atlasWorkflowRunId'],
      ...inferredIdempotency.aliases,
    },
    ...(inferredIdempotency.inferredSourcePaths
      ? { inferredSourcePaths: inferredIdempotency.inferredSourcePaths }
      : {}),
    ...(input.allowClassificationDowngrade ? { allowClassificationDowngrade: true } : {}),
    ...(input.proposedArguments ? { proposedArguments: input.proposedArguments } : {}),
  });
  return {
    ...plan,
    resolvedMappings: [...constantMappings, ...plan.resolvedMappings],
    ...(destinationCapability.annotation?.idempotencyField
      ? { idempotencyField: destinationCapability.annotation.idempotencyField }
      : {}),
  };
}

function withStatedOrigin(
  mapping: PlannedMapping,
  statedDestinationPaths?: readonly (readonly string[])[],
): PlannedMapping {
  if (!statedDestinationPaths) return mapping;
  const stated = statedDestinationPaths.some(
    (path) => pathKey(path) === pathKey(mapping.destinationPath),
  );
  return { ...mapping, origin: stated ? 'requested' : 'inferred' };
}

function inferIdempotencySources(
  inputSchema: WorkflowInputSchema | undefined,
  idempotencyField: string | null | undefined,
  priorStepSources: readonly MappingSource[] = [],
): {
  aliases: Record<string, readonly string[]>;
  inferredSourcePaths?: Readonly<Record<string, readonly (readonly string[])[]>>;
} {
  if (!idempotencyField) return { aliases: {} };
  const required = inputSchema?.required ?? {};
  const businessKeys = Object.entries(required).flatMap(([name, schema]) =>
    name !== 'atlasWorkflowRunId' &&
    schema &&
    typeof schema === 'object' &&
    schema.type === 'string'
      ? [name]
      : [],
  );
  if (businessKeys.length === 1) {
    return { aliases: { [idempotencyField]: [businessKeys[0]!] } };
  }
  if (businessKeys.length > 1) {
    // Several caller strings is common once leftover fields become inputs.
    // Atlas still owns the provider key; do not ask which leftover to reuse.
    return required.atlasWorkflowRunId
      ? { aliases: { [idempotencyField]: ['atlasWorkflowRunId'] } }
      : {
          aliases: {},
          inferredSourcePaths: { [idempotencyField]: businessKeys.map((name) => [name]) },
        };
  }
  const priorStepStrings = sourceLeaves(priorStepSources).filter(
    (leaf) => leaf.schema.type === 'string' && pathKey(leaf.path) !== 'atlasWorkflowRunId',
  );
  if (priorStepStrings.length === 1) {
    return { aliases: { [idempotencyField]: [...priorStepStrings[0]!.path] } };
  }
  if (priorStepStrings.length > 1) {
    return {
      aliases: {},
      inferredSourcePaths: { [idempotencyField]: priorStepStrings.map((leaf) => leaf.path) },
    };
  }
  return required.atlasWorkflowRunId
    ? { aliases: { [idempotencyField]: ['atlasWorkflowRunId'] } }
    : { aliases: {} };
}

function applicableDiagnostics(
  diagnostics: ReturnType<typeof validateTransformation>,
  allowClassificationDowngrade = false,
) {
  return allowClassificationDowngrade
    ? diagnostics.filter(({ code }) => code !== 'TRANSFORM_CLASSIFICATION_DOWNGRADE')
    : diagnostics;
}

function missingProjectedCapability(
  intentFingerprint: string,
  projectionFingerprint: string,
  capabilityVersionId: string,
) {
  return {
    status: 'manual_review' as const,
    intentFingerprint,
    projectionFingerprint,
    resolvedMappings: [],
    candidateMappings: [],
    requiredQuestions: [],
    diagnostics: [
      {
        code: 'CAPABILITY_NOT_FOUND_IN_PROJECTION',
        message: `Capability '${capabilityVersionId}' is absent from the authorized projection.`,
      },
    ],
  };
}
