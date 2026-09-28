import type { DraftStage } from './draft-requests.js';
import {
  isCapabilityStep,
  createGraphCompiledWorkflowVersion,
  createCompiledWorkflowVersion,
  createTransformationCompiledWorkflowVersion,
  objectSchemaSchema,
  valueReferenceSchema,
  versionedCompiledWorkflowVersionSchema,
  type ObjectSchema,
  type TransformationExpression,
  type VersionedCompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import type { Pool } from 'pg';
import { z } from 'zod';

import { plannerRecipeHints, readCapabilityArchitecture } from './capability-architecture.js';
import { readPlannerCapabilityProjection } from './capability-catalog.js';
import type { TransformationSchema } from './transformation-validation.js';
import type { PotentialCoveragePlanningInput } from './potential-coverage.js';
import { canonicalJson, sha256, type ChangeClassification } from './capability-versioning.js';
import {
  issuePlanningContinuation,
  nextClarificationRound,
  verifyPlanningContinuation,
} from './planning-continuation.js';
import { recordPlanningTrace } from './planning-trace.js';
import { planProjectedApiMappings, type ProjectedMappingRequest } from './planner-mapping.js';
import {
  inferenceToExpression,
  inferMissingFieldMapping,
  type PriorStepOutput,
} from './planner-mapping-inference.js';
import { plannerCapabilityReferenceIndex } from './capability-reference-index.js';
import {
  proposedAnnotationSchema,
  verifiedReferencesInText,
  verifyDraftRequestAnnotations,
  type ProposedAnnotation,
} from './request-annotations.js';
import {
  atlasWorkflowRunIdInput,
  resolveWorkflowInputSchema,
  responseValueFromTransformationSchema,
  withBackendOwnedInputs,
} from './workflow-input-schema.js';
import {
  capabilityInputFields,
  capabilityOutputSchema,
  discardBackendOwnedDraftFields,
  jsonSchemaToTransformationSchema,
  validateWorkflowDraft,
  type ValidationReport,
} from './workflow-validation.js';

export const intentFrameSchema = z
  .object({
    version: z.literal(1),
    summary: z.string().min(1),
    requestedEffects: z
      .array(z.enum(['readRecord', 'mutateRecord', 'publishEvent', 'notify']))
      .min(1),
    mentionedSystems: z.array(z.string().min(1)),
    requiredInputs: z.array(z.string().min(1)),
    constraints: z.array(z.string().min(1)),
    ambiguities: z.array(
      z
        .object({
          slot: z.string().min(1),
          question: z.string().min(1),
          suggestedAnswers: z.array(z.string().min(1)).length(3),
        })
        .strict(),
    ),
    supported: z.boolean(),
    unsupportedReason: z.string().min(1).nullable(),
  })
  .strict();

export type IntentFrame = z.infer<typeof intentFrameSchema>;
export type PlannerProjection = Awaited<ReturnType<typeof readPlannerCapabilityProjection>>;

function groundedInterpretationAnnotations(input: {
  projection: PlannerProjection;
  text: string;
  context: string;
  intentFrame: IntentFrame;
  intentFingerprint: string;
}) {
  const runtimeInputs = input.intentFrame.requiredInputs.flatMap((inputName) => {
    const escaped = inputName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(
      `(?:accept|provide|supply|take|use)\\s+(?:the\\s+)?(${escaped})\\s+as\\s+(?:a\\s+)?runtime\\s+input`,
      'gi',
    );
    return [...input.text.matchAll(declaration)].flatMap((match) => {
      const matchedInput = match[1];
      if (!matchedInput || match.index === undefined) return [];
      const relativeStart = match[0].toLowerCase().indexOf(matchedInput.toLowerCase());
      const start = match.index + relativeStart;
      return [
        {
          start,
          end: start + matchedInput.length,
          text: input.text.slice(start, start + matchedInput.length),
          kind: 'runtimeInput' as const,
          inputName,
          evidence: {
            intentFingerprint: input.intentFingerprint,
            source: 'intentFrame.requiredInputs' as const,
          },
        },
      ];
    });
  });
  const capabilityReferences = verifiedReferencesInText({
    projection: input.projection,
    text: input.text,
    context: input.context,
  }).filter(
    (annotation) =>
      !runtimeInputs.some(
        (runtimeInput) =>
          annotation.start < runtimeInput.end && runtimeInput.start < annotation.end,
      ),
  );
  return [...runtimeInputs, ...capabilityReferences].sort(
    (left, right) => left.start - right.start,
  );
}

export function createIntentCapabilityIndex(projection: PlannerProjection) {
  const index = plannerCapabilityReferenceIndex(projection);
  if (index.status !== 'ok') {
    throw new Error('Cannot build intent capability context from an unavailable projection');
  }
  return {
    projectionFingerprint: projection.fingerprint,
    capabilities: index.references.map((reference) => ({
      capabilityVersionId: reference.capabilityVersionId,
      identity: reference.identity,
      ...(reference.observation ? { observation: reference.observation } : {}),
      owner: reference.owner,
      businessSemantics: reference.businessSemantics,
      ...(reference.userAnnotations.length ? { userAnnotations: reference.userAnnotations } : {}),
      ...(reference.summary ? { summary: reference.summary } : {}),
      ...(reference.description ? { description: reference.description } : {}),
      fields: reference.fields.map(({ direction, path, type, required, label }) => ({
        direction,
        path,
        type,
        required,
        label,
      })),
    })),
  };
}

export type IntentCapabilityIndex = ReturnType<typeof createIntentCapabilityIndex>;

function outputLeavesFromSchema(
  schema: TransformationSchema,
  path: readonly string[] = [],
): PriorStepOutput['outputLeaves'][number][] {
  if (schema.type !== 'object') return [{ path, type: schema.type }];
  return [
    { path, type: schema.type },
    ...Object.entries(schema.required).flatMap(([name, child]) =>
      outputLeavesFromSchema(child, [...path, name]),
    ),
  ];
}

function literalMatchesDestination(existing: unknown, schema: TransformationSchema) {
  if (!existing || typeof existing !== 'object' || !('source' in existing)) return false;
  const literal = existing as { source?: unknown; value?: unknown };
  if (literal.source !== 'literal') return false;
  const value = literal.value;
  if ('enumValues' in schema && schema.enumValues && schema.enumValues.length > 0) {
    return schema.enumValues.some((candidate) => candidate === value);
  }
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (schema.type === 'number') return typeof value === 'number';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return false;
}

function inputPathName(existing: object, field: string) {
  if (
    'path' in existing &&
    Array.isArray(existing.path) &&
    existing.path.length === 1 &&
    typeof existing.path[0] === 'string'
  ) {
    return existing.path[0];
  }
  return field;
}

function applyInferredFieldMappings(
  draft: VersionedCompiledWorkflowVersion,
  projection: PlannerProjection,
  developerRequest: string,
  recipeHints: ReturnType<typeof plannerRecipeHints>,
): VersionedCompiledWorkflowVersion {
  // Graph paths define available outputs; the sequential inference pass must not rewrite them.
  if (draft.executable.irVersion === 3) return draft;
  const recipeDataFlows = recipeHints?.connections.filter(
    (connection) => connection.kind === 'data-flow',
  );
  const declaredInputs = objectSchemaSchema.safeParse(draft.executable.inputSchema);
  const inputRequired: ObjectSchema['required'] = {
    ...withoutRunId(declaredInputs.success ? declaredInputs.data.required : {}),
  };
  const priorSteps: PriorStepOutput[] = [];
  const steps = draft.executable.steps.map((step) => {
    if (!isCapabilityStep(step)) return step;
    const capability = projection.capabilities.find(
      (candidate) => candidate.capabilityVersionId === step.capabilityVersionId,
    );
    const fragment = projectedFragment(projection, step.capabilityVersionId);
    if (!capability || !fragment) return step;
    const idempotencyField = capability.annotation.idempotencyField;
    const args = { ...step.arguments };
    for (const [field, definition] of capabilityInputFields(fragment)) {
      if (!definition.required || field === atlasWorkflowRunIdInput) continue;
      if (definition.schema?.const !== undefined) continue;
      if (idempotencyField && field === idempotencyField) continue;
      const existing = args[field];
      // Existing transformations are checked by mapping and workflow validation.
      // Missing-field inference must not replace them with new caller inputs.
      if (existing && 'kind' in existing) continue;
      const existingSource =
        existing && typeof existing === 'object' && 'source' in existing
          ? existing.source
          : undefined;
      const schema = jsonSchemaToTransformationSchema(fragment, definition.schema);
      if (!schema) continue;
      const value = responseValueFromTransformationSchema(schema);
      if (
        existing &&
        typeof existing === 'object' &&
        'source' in existing &&
        existing.source === 'stepOutput' &&
        'stepId' in existing &&
        'path' in existing
      ) {
        const source = priorSteps.find((prior) => prior.stepId === existing.stepId);
        if (
          source?.outputLeaves.some(
            (leaf) =>
              JSON.stringify(leaf.path) === JSON.stringify(existing.path) &&
              (leaf.type === schema.type || (leaf.type === 'integer' && schema.type === 'number')),
          )
        )
          continue;
        // A future step, missing response field, or incompatible type cannot supply this input.
        delete args[field];
      }
      if (
        existingSource === 'literal' &&
        existing &&
        typeof existing === 'object' &&
        literalMatchesDestination(existing, schema)
      ) {
        continue;
      }
      const inference = inferMissingFieldMapping({
        field,
        destinationType: schema.type,
        ...('enumValues' in schema && schema.enumValues
          ? { destinationEnumValues: schema.enumValues }
          : {}),
        destinationOperationId: capability.identity.operationId,
        developerRequest,
        priorSteps,
        ...(recipeDataFlows ? { recipeDataFlows } : {}),
      });
      if (existingSource === 'input' || existingSource === 'literal') {
        const inputName =
          existingSource === 'input' && existing && typeof existing === 'object'
            ? inputPathName(existing, field)
            : field;
        if (inference.kind === 'literal' || inference.kind === 'stepOutput') {
          args[field] = inferenceToExpression(field, inference);
          if (existingSource === 'input') {
            delete inputRequired[field];
            delete inputRequired[inputName];
          }
          continue;
        }
        if (existingSource === 'literal') {
          args[field] = inferenceToExpression(field, { kind: 'input' });
          if (value) inputRequired[field] = value;
          continue;
        }
        if (value) inputRequired[inputName] = inputRequired[inputName] ?? value;
        continue;
      }
      if (inference.kind === 'ambiguous') continue;
      args[field] = inferenceToExpression(field, inference);
      if (inference.kind === 'input') {
        if (value) inputRequired[field] = value;
      }
    }
    const output = jsonSchemaToTransformationSchema(fragment, capabilityOutputSchema(fragment));
    priorSteps.push({
      stepId: step.id,
      operationId: capability.identity.operationId,
      outputLeaves: output ? outputLeavesFromSchema(output) : [],
    });
    return { ...step, arguments: args };
  });
  return {
    ...draft,
    executable: {
      ...draft.executable,
      inputSchema: { required: inputRequired },
      steps,
    },
  } as VersionedCompiledWorkflowVersion;
}

function withoutRunId<T extends Record<string, unknown>>(required: T) {
  const { [atlasWorkflowRunIdInput]: _runId, ...rest } = required;
  return rest;
}
type MappingPlan = ReturnType<typeof planProjectedApiMappings>;
interface MappingResolution {
  readonly request: ProjectedMappingRequest;
  readonly plan: MappingPlan;
}

function mappingAnswer(
  candidateId: string,
  request: ProjectedMappingRequest,
  projection: PlannerProjection,
) {
  const source = candidateId.split('<-')[1]?.replace(/:convert$/, '') ?? candidateId;
  if (source.startsWith('input:')) {
    return `Use workflow input ${source.slice('input:'.length)}`;
  }
  if (source.startsWith('step:')) {
    const [, stepId, ...path] = source.split(':');
    const capabilityVersionId = request.sourceSteps.find(
      (sourceStep) => sourceStep.stepId === stepId,
    )?.capabilityVersionId;
    const operationId = projection.capabilities.find(
      (capability) => capability.capabilityVersionId === capabilityVersionId,
    )?.identity.operationId;
    return `Use ${operationId ?? stepId} response field ${path.join(':')}`;
  }
  return `Use ${source}`;
}

function mappingClarificationOptions(
  plan: MappingPlan,
  request: ProjectedMappingRequest,
  projection: PlannerProjection,
) {
  const question = plan.requiredQuestions[0];
  const candidateIds = question?.candidateIds ?? [];
  const suggestions = candidateIds.map((candidateId) =>
    mappingAnswer(candidateId, request, projection),
  );
  return {
    suggestedAnswers: [...new Set(suggestions)],
    suggestedAnswerSelections: candidateIds.map((candidateId) => ({
      answer: mappingAnswer(candidateId, request, projection),
      candidateId,
      destinationPath: [...(question?.destinationPath ?? [])],
    })),
  };
}

type RequestReferenceHint =
  | ProposedAnnotation
  | {
      start: number;
      end: number;
      text: string;
      kind: 'runtimeInput';
      inputName: string;
    };

interface PlanningContext {
  signal?: AbortSignal;
  intent: IntentFrame;
  intentFingerprint: string;
  projection: PlannerProjection;
  recipeHints?: ReturnType<typeof plannerRecipeHints>;
  referenceHints?: {
    references: readonly RequestReferenceHint[];
  };
  mappingResolutions?: readonly MappingResolution[];
  revisionContext?: RevisionContext;
  clarificationFallback?: {
    question: string;
    suggestedAnswers: string[];
  };
}

interface RepairContext extends PlanningContext {
  attempt: number;
  previousDraft: unknown;
  validation: ValidationReport;
}

export interface MigrationPlanningContext {
  readonly sourceWorkflow: VersionedCompiledWorkflowVersion;
  readonly requestedWorkflowVersionId: string;
  readonly fromCapabilityVersionId: string;
  readonly toCapabilityVersionId: string;
  readonly classification: ChangeClassification;
  readonly fieldChanges: readonly unknown[];
  readonly projection: PlannerProjection;
}

export interface PlannerModel {
  extractIntent(input: {
    signal?: AbortSignal;
    developerRequest: string;
    capabilityIndex: IntentCapabilityIndex;
    recipeHints?: PlanningContext['recipeHints'];
    referenceHints?: PlanningContext['referenceHints'];
    revisionContext?: RevisionContext;
  }): Promise<unknown>;
  draftWorkflow(input: PlanningContext): Promise<unknown>;
  repairWorkflow(input: RepairContext): Promise<unknown>;
  migrateWorkflow?(input: MigrationPlanningContext): Promise<unknown>;
  suggestPotentialCoverage?(input: PotentialCoveragePlanningInput): Promise<unknown>;
}

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const bindingShape = {
  intentFingerprint: fingerprintSchema,
  projectionFingerprint: fingerprintSchema,
};
const runtimeInputReferenceHintSchema = z
  .object({
    start: z.number().int(),
    end: z.number().int(),
    text: z.string().min(1),
    kind: z.literal('runtimeInput'),
    inputName: z.string().min(1),
  })
  .strict();
const referenceHintsSchema = z
  .object({
    references: z
      .array(z.union([proposedAnnotationSchema, runtimeInputReferenceHintSchema]))
      .min(1),
  })
  .strict();
const workflowDraftOutputSchema = z
  .object({
    kind: z.literal('workflowDraft'),
    ...bindingShape,
    draft: versionedCompiledWorkflowVersionSchema,
    clarifiedRequest: z.string().min(1).optional(),
    annotations: z.array(proposedAnnotationSchema).optional(),
  })
  .strict();
const clarificationOutputSchema = z
  .object({
    kind: z.literal('clarification'),
    ...bindingShape,
    question: z.string().min(1),
    suggestedAnswers: z.array(z.string().min(1)).length(3),
  })
  .strict();
const unsupportedOutputSchema = z
  .object({
    kind: z.literal('unsupported'),
    ...bindingShape,
    reason: z.string().min(1),
  })
  .strict();
const modelOutputSchema = z.discriminatedUnion('kind', [
  workflowDraftOutputSchema,
  clarificationOutputSchema,
  unsupportedOutputSchema,
]);
const repairableWorkflowDraftOutputSchema = z
  .object({
    kind: z.literal('workflowDraft'),
    ...bindingShape,
    draft: z.unknown(),
    clarifiedRequest: z.unknown().optional(),
    annotations: z.array(z.unknown()).optional(),
  })
  .passthrough();

const mappingSourceStepSchema = z
  .object({
    stepId: z.string().min(1),
    capabilityVersionId: z.string().min(1),
  })
  .strict();
const mappingRequestSchema = z
  .object({
    sourceSteps: z.array(mappingSourceStepSchema),
    destinationCapabilityVersionId: z.string().min(1),
    destinationStepId: z.string().min(1),
    selections: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();

const revisionContextSchema = z
  .object({
    previousRequest: z.string().min(1),
    draft: versionedCompiledWorkflowVersionSchema,
  })
  .strict();

export type RevisionContext = z.infer<typeof revisionContextSchema>;

export const intentFrameJsonSchema = z.toJSONSchema(intentFrameSchema, { target: 'draft-07' });

export const plannerOutputContractSchema = z.object({ result: modelOutputSchema }).strict();
export const plannerOutputJsonSchema = z.toJSONSchema(plannerOutputContractSchema, {
  target: 'draft-07',
});

export const planningRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1).default('production'),
    request: z.string().min(1),
    workflowVersionId: z.string().min(1),
    continuation: z.string().min(1).optional(),
    answer: z.string().min(1).optional(),
    referenceHints: referenceHintsSchema.optional(),
    mapping: z
      .object({
        intentFingerprint: fingerprintSchema,
        projectionFingerprint: fingerprintSchema,
        ...mappingRequestSchema.shape,
        history: z.array(mappingRequestSchema.required({ selections: true })).default([]),
        // The draft's own declared inputs, echoed back so earlier answers can be
        // replayed against the same input source. The final draft is still
        // validated against the inputs it declares.
        workflowInputSchema: objectSchemaSchema.optional(),
      })
      .strict()
      .optional(),
    revisionContext: revisionContextSchema.optional(),
    sandboxRepair: z
      .object({
        tests: z
          .array(
            z
              .object({
                status: z.enum(['passed', 'failed']).optional(),
                kind: z.string().min(1).optional(),
                stepId: z.string().min(1).nullable().optional(),
                capabilityVersionId: z.string().min(1).nullable().optional(),
                detail: z.string().optional(),
                expectation: z.string().optional(),
              })
              .passthrough(),
          )
          .min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.continuation) !== Boolean(value.answer)) {
      context.addIssue({
        code: 'custom',
        message: 'A continuation handle and answer must be sent together',
        path: value.continuation ? ['answer'] : ['continuation'],
      });
    }
    if (value.sandboxRepair && !value.revisionContext) {
      context.addIssue({
        code: 'custom',
        message: 'Sandbox contract repair requires the reviewed workflow',
        path: ['revisionContext'],
      });
    }
  });

function manualReview(reason: string, detail: string) {
  return { status: 'manual_review' as const, reason, detail };
}

function developerRequestWithAnswers(request: string, answers: readonly string[]) {
  if (answers.length === 0) return request;
  return `${request}\n\nClarification answers:\n${answers
    .map((answer, index) => `${index + 1}. ${answer}`)
    .join('\n')}`;
}

function issueClarification(input: {
  question: string;
  suggestedAnswers: readonly string[];
  suggestedAnswerSelections?: readonly {
    answer: string;
    candidateId: string;
    destinationPath: readonly string[];
  }[];
  suggestedAnswerActions?: readonly {
    answer: string;
    action: 'change-environment';
    environmentId: string;
  }[];
  reason:
    | 'missing-business-fact'
    | 'duplicate-field-candidates'
    | 'capability-drift'
    | 'mapping-impossible'
    | 'policy-denial'
    | 'repair-exhausted';
  intentFrame: IntentFrame;
  projection: PlannerProjection;
  request: z.infer<typeof planningRequestSchema>;
  actorId: string;
  intentFingerprint: string;
  projectionFingerprint: string;
  answers: readonly string[];
  issuedRounds: number;
  extra?: Record<string, unknown>;
}) {
  const round = nextClarificationRound(input.issuedRounds);
  if (!round) {
    return {
      httpStatus: 422 as const,
      body: manualReview(
        'clarification-exhausted',
        'Six clarification rounds did not produce a grounded request',
      ),
    };
  }
  return {
    httpStatus: 200 as const,
    body: {
      status: 'clarification_required' as const,
      reason: input.reason,
      question: input.question,
      questionAnnotations: verifiedReferencesInText({
        projection: input.projection,
        text: input.question,
        context: `${input.request.request} ${input.intentFrame.summary} ${input.answers.join(' ')}`,
      }),
      interpretedRequest: input.intentFrame.summary,
      interpretedRequestAnnotations: groundedInterpretationAnnotations({
        projection: input.projection,
        text: input.intentFrame.summary,
        context: `${input.request.request} ${input.answers.join(' ')}`,
        intentFrame: input.intentFrame,
        intentFingerprint: input.intentFingerprint,
      }),
      suggestedAnswers: input.suggestedAnswers,
      suggestedAnswerAnnotations: input.suggestedAnswers.map((answer) => ({
        answer,
        annotations: verifiedReferencesInText({
          projection: input.projection,
          text: answer,
          context: `${input.intentFrame.summary} ${input.question}`,
        }),
      })),
      ...(input.suggestedAnswerSelections
        ? { suggestedAnswerSelections: input.suggestedAnswerSelections }
        : {}),
      ...(input.suggestedAnswerActions
        ? { suggestedAnswerActions: input.suggestedAnswerActions }
        : {}),
      intentFrame: input.intentFrame,
      continuation: issuePlanningContinuation({
        v: 1,
        organizationId: input.request.organizationId,
        environmentId: input.request.environmentId,
        actorId: input.actorId,
        request: input.request.request,
        intentFingerprint: input.intentFingerprint,
        projectionFingerprint: input.projectionFingerprint,
        answers: [...input.answers],
        round,
      }),
      ...input.extra,
    },
  };
}

export function validationAdaptation(environmentId: string) {
  const switchAnswer = 'Switch to production and review this request';
  return {
    question: `Some requested operations or field mappings are not available in ${environmentId}. How should Atlas adapt the workflow?`,
    suggestedAnswers: [
      environmentId === 'development'
        ? switchAnswer
        : `Use only capabilities and fields authorized in ${environmentId}`,
      'Keep the valid parts and omit unavailable operations',
      'Simplify to the smallest valid workflow that satisfies the core request',
    ] as const,
    ...(environmentId === 'development'
      ? {
          suggestedAnswerActions: [
            {
              answer: switchAnswer,
              action: 'change-environment' as const,
              environmentId: 'production',
            },
          ],
        }
      : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function leafSchemaIssues(
  issue: unknown,
  prefix: Array<string | number> = [],
): Array<{ path: Array<string | number>; message: string }> {
  const detail = record(issue);
  if (!detail) return [];
  const ownPath = Array.isArray(detail.path)
    ? detail.path.filter(
        (part): part is string | number => typeof part === 'string' || typeof part === 'number',
      )
    : [];
  const path = [...prefix, ...ownPath];
  const branches = Array.isArray(detail.errors)
    ? detail.errors.filter((branch): branch is unknown[] => Array.isArray(branch))
    : [];
  if (branches.length > 0) {
    return branches
      .map((branch) => branch.flatMap((child) => leafSchemaIssues(child, path)))
      .sort((left, right) => left.length - right.length)[0]!;
  }
  return [{ path, message: typeof detail.message === 'string' ? detail.message : 'Invalid input' }];
}

function schemaParseDiagnostics(issues: readonly unknown[]): ValidationReport['diagnostics'] {
  const unique = new Map<string, { path: Array<string | number>; message: string }>();
  for (const issue of issues.flatMap((candidate) => leafSchemaIssues(candidate))) {
    unique.set(`${issue.path.join('.')}\u0000${issue.message}`, issue);
  }
  return [...unique.values()].map((issue) => ({
    kind: 'compileError' as const,
    code: 'SCHEMA_PARSE_FAILED',
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

function normalizePlannerObjectSchema(value: unknown) {
  const schema = record(value);
  if (
    !schema ||
    !record(schema.required) ||
    (schema.type !== undefined && schema.type !== 'object')
  ) {
    return value;
  }
  const { type: _redundantType, ...normalized } = schema;
  const required = record(normalized.required);
  return {
    ...normalized,
    ...(required
      ? {
          required: Object.fromEntries(
            Object.entries(required).map(([name, field]) => [
              name,
              normalizePlannerValueSchema(field),
            ]),
          ),
        }
      : {}),
  };
}

function normalizePlannerValueSchema(value: unknown): unknown {
  const schema = record(value);
  if (!schema) return value;
  const type = typeof schema.type === 'string' ? schema.type.toLowerCase() : undefined;
  if (type === 'float' || type === 'double') {
    return { ...schema, type: 'number' };
  }
  if (schema.type === undefined && record(schema.required)) {
    const normalized = record(normalizePlannerObjectSchema({ ...schema, type: 'object' }));
    return normalized ? { type: 'object', ...normalized } : value;
  }
  if (schema.type === 'object') {
    const normalized = record(normalizePlannerObjectSchema(schema));
    return normalized ? { type: 'object', ...normalized } : value;
  }
  if (schema.type === 'array') {
    return { ...schema, items: normalizePlannerValueSchema(schema.items) };
  }
  return value;
}

function projectedFragment(projection: PlannerProjection, capabilityVersionId: string) {
  return record(
    projection.capabilities.find(
      (candidate) => candidate.capabilityVersionId === capabilityVersionId,
    )?.fragment,
  );
}

function projectedResponseSchema(
  projection: PlannerProjection,
  capabilityVersionId: unknown,
): Record<string, unknown> | undefined {
  if (typeof capabilityVersionId !== 'string') return undefined;
  const fragment = projectedFragment(projection, capabilityVersionId);
  if (!fragment) return undefined;
  const output = jsonSchemaToTransformationSchema(fragment, capabilityOutputSchema(fragment));
  if (!output || output.type !== 'object') return undefined;
  const converted = responseValueFromTransformationSchema(output);
  return converted?.type === 'object' ? { required: converted.required } : undefined;
}

function exactProjectedCapabilityVersionId(
  projection: PlannerProjection,
  capabilityVersionId: unknown,
) {
  if (typeof capabilityVersionId !== 'string') return capabilityVersionId;
  if (
    projection.capabilities.some(
      (capability) => capability.capabilityVersionId === capabilityVersionId,
    )
  ) {
    return capabilityVersionId;
  }
  const matches = projection.capabilities.filter(
    (capability) =>
      capability.capabilityVersionId.length === capabilityVersionId.length + 1 &&
      capability.capabilityVersionId.startsWith(capabilityVersionId),
  );
  return matches.length === 1 ? matches[0]!.capabilityVersionId : capabilityVersionId;
}

function normalizePlannerDraftObjectSchemas(value: unknown, projection: PlannerProjection) {
  const draft = record(value);
  const executable = record(draft?.executable);
  if (!draft || !executable) return value;

  const normalizedExecutable = { ...executable };
  if (normalizedExecutable.irVersion === 1) {
    normalizedExecutable.irVersion = 2;
  }
  const injectedRunId = { source: 'input' as const, path: [atlasWorkflowRunIdInput] };
  if (Array.isArray(executable.steps)) {
    normalizedExecutable.steps = executable.steps.map((value) => {
      const step = record(value);
      if (!step) return value;
      if (!['capabilityCall', 'compensation', 'publishEvent', 'notify'].includes(String(step.kind)))
        return value;
      const capabilityVersionId = exactProjectedCapabilityVersionId(
        projection,
        step.capabilityVersionId,
      );
      const capability = projection.capabilities.find(
        (candidate) => candidate.capabilityVersionId === capabilityVersionId,
      );
      const authoritativeResponse = projectedResponseSchema(projection, capabilityVersionId);
      const arguments_ = record(step.arguments);
      const idempotencyField = capability?.annotation.idempotencyField;
      const declaredBusinessKey = idempotencyField ? arguments_?.[idempotencyField] : undefined;
      const parsedBusinessKey = valueReferenceSchema.safeParse(declaredBusinessKey);
      const businessKey = parsedBusinessKey.success ? parsedBusinessKey.data : injectedRunId;
      const { irreversibleAfter: _suppliedIrreversible, ...stepRest } = step;
      return {
        ...stepRest,
        ...(typeof capabilityVersionId === 'string' ? { capabilityVersionId } : {}),
        ...(!('idempotency' in step) && idempotencyField ? { idempotency: { businessKey } } : {}),
        ...(authoritativeResponse
          ? { responseSchema: authoritativeResponse }
          : 'responseSchema' in step
            ? { responseSchema: normalizePlannerObjectSchema(step.responseSchema) }
            : {}),
        inputSchema:
          'inputSchema' in stepRest
            ? normalizePlannerObjectSchema(stepRest.inputSchema)
            : { required: {} },
        ...(capability?.annotation.irreversibleAfter === true ? { irreversibleAfter: true } : {}),
      };
    });
  }
  // The caller-facing inputs: what the request declared, or leftover required
  // fields already mapped from input. Unmapped leftovers are filled after
  // inference, not dumped here, so later-step ids are not treated as caller inputs.
  normalizedExecutable.inputSchema = resolveWorkflowInputSchema(
    {
      inputSchema: normalizePlannerObjectSchema(executable.inputSchema),
      steps: Array.isArray(normalizedExecutable.steps)
        ? normalizedExecutable.steps.flatMap((value) => {
            const step = record(value);
            const arguments_ = record(step?.arguments);
            return step && typeof step.kind === 'string'
              ? [
                  {
                    kind: step.kind,
                    ...(typeof step.capabilityVersionId === 'string'
                      ? { capabilityVersionId: step.capabilityVersionId }
                      : {}),
                    ...(arguments_ ? { arguments: arguments_ } : {}),
                  },
                ]
              : [];
          })
        : [],
    },
    (capabilityVersionId) => projectedFragment(projection, capabilityVersionId),
    { includeUnmapped: false },
  );
  return { ...draft, executable: normalizedExecutable };
}

function replaceBackendOwnedDraftEnvelope(value: unknown) {
  const draft = record(value);
  if (!draft) return value;
  const placeholderHash = '0'.repeat(64);
  return {
    ...draft,
    workflowVersionId: 'model-placeholder',
    irHash: placeholderHash,
    executionRequirements: {
      organizationId: 'model-placeholder',
      workflowVersionId: 'model-placeholder',
      irHash: placeholderHash,
      requiredCapabilityVersionIds: [],
    },
  };
}

function sanitizeModelOutput(value: unknown, projection: PlannerProjection) {
  if (!value || typeof value !== 'object') return value;
  const output = value as Record<string, unknown>;
  if (output.kind !== 'workflowDraft') return value;
  const rawDraft = record(output.draft);
  const {
    clarifiedRequest: nestedClarifiedRequest,
    annotations: nestedAnnotations,
    ...draftWithoutPlanningOutput
  } = rawDraft ?? {};
  const annotations = Array.isArray(output.annotations)
    ? output.annotations
    : Array.isArray(nestedAnnotations)
      ? nestedAnnotations
      : undefined;
  return {
    ...output,
    ...(output.clarifiedRequest === undefined && typeof nestedClarifiedRequest === 'string'
      ? { clarifiedRequest: nestedClarifiedRequest }
      : {}),
    ...(annotations
      ? {
          annotations: annotations.map((value) => {
            const annotation = record(value);
            if (!annotation) return value;
            const capabilityVersionId = exactProjectedCapabilityVersionId(
              projection,
              annotation.capabilityVersionId,
            );
            return {
              ...annotation,
              ...(typeof capabilityVersionId === 'string' ? { capabilityVersionId } : {}),
            };
          }),
        }
      : {}),
    draft: replaceBackendOwnedDraftEnvelope(
      normalizePlannerDraftObjectSchemas(
        discardBackendOwnedDraftFields(rawDraft ? draftWithoutPlanningOutput : output.draft),
        projection,
      ),
    ),
  };
}

function verifyBinding(
  output: { intentFingerprint: string; projectionFingerprint: string },
  context: PlanningContext,
) {
  return (
    output.intentFingerprint === context.intentFingerprint &&
    output.projectionFingerprint === context.projection.fingerprint
  );
}

function sandboxRepairValidation(
  tests: ReadonlyArray<{
    status?: 'passed' | 'failed' | undefined;
    stepId?: string | null | undefined;
    detail?: string | undefined;
    expectation?: string | undefined;
  }>,
  projectionFingerprint: string,
): ValidationReport | undefined {
  const leaked = /irHash|fingerprint|capabilityVersionId|documentHash|suiteFingerprint/i;
  const diagnostics = tests.flatMap((test) => {
    if (test.status !== 'failed') return [];
    const detail = test.detail?.trim();
    const expectation = test.expectation?.trim();
    const problem = [detail, expectation].find(
      (value) => value && !leaked.test(value) && !/\b[a-f0-9]{32,}\b/i.test(value),
    );
    return [
      {
        kind: 'compileError' as const,
        code: 'PROVIDER_CONTRACT_MISMATCH',
        path: test.stepId ? `steps.${test.stepId}` : 'executable.steps',
        message: problem
          ? `${problem.replace(/[.!?]$/, '')}. Map every required provider field from a grounded input or prior step output. Do not ask for an idempotency key.`
          : 'Map every required provider field from a grounded input or prior step output. Do not ask for an idempotency key.',
      },
    ];
  });
  if (diagnostics.length === 0) return undefined;
  return {
    diagnostics,
    decision: {
      approvable: false,
      compileErrorCount: diagnostics.length,
      policyDenialCount: 0,
      warningCount: 0,
      blockingWarningCount: 0,
      approvalRequirementCount: 0,
      recomputedIrHash: null,
      policyVersion: 'sandbox-contract',
      projectionFingerprint,
    },
  };
}

function mappingPlansValidation(
  draft: VersionedCompiledWorkflowVersion,
  plans: readonly {
    mappingPlan: ReturnType<typeof planProjectedApiMappings>;
    request: ProjectedMappingRequest;
  }[],
  projectionFingerprint: string,
): ValidationReport | undefined {
  const diagnostics = plans.flatMap(({ mappingPlan, request }) => {
    const destination = draft.executable.steps.find(
      (step) =>
        isCapabilityStep(step) &&
        step.id === request.destinationStepId &&
        step.capabilityVersionId === request.destinationCapabilityVersionId,
    );
    return mappingPlan.resolvedMappings.flatMap((mapping) => {
      let actual: TransformationExpression | undefined =
        destination && isCapabilityStep(destination)
          ? (destination.arguments[mapping.destinationPath[0]!] as
              | TransformationExpression
              | undefined)
          : undefined;
      for (const segment of mapping.destinationPath.slice(1)) {
        actual =
          actual && 'kind' in actual && actual.kind === 'object'
            ? (actual as unknown as Extract<TransformationExpression, { kind: 'object' }>).fields[
                segment
              ]
            : undefined;
      }
      return canonicalJson(actual) === canonicalJson(mapping.expression)
        ? []
        : [
            {
              kind: 'compileError' as const,
              code: 'MAPPING_SELECTION_MISMATCH',
              path: `steps.${request.destinationStepId}.arguments.${mapping.destinationPath.join('.')}`,
              message:
                'The workflow draft changed or omitted a deterministically selected mapping.',
            },
          ];
    });
  });
  if (diagnostics.length === 0) return undefined;
  return {
    diagnostics,
    decision: {
      approvable: false,
      compileErrorCount: diagnostics.length,
      policyDenialCount: 0,
      warningCount: 0,
      blockingWarningCount: 0,
      approvalRequirementCount: 0,
      recomputedIrHash: null,
      policyVersion: 'mapping-selection',
      projectionFingerprint,
    },
  };
}

function applyMappingPlans(
  draft: VersionedCompiledWorkflowVersion,
  plans: readonly {
    mappingPlan: ReturnType<typeof planProjectedApiMappings>;
    request: ProjectedMappingRequest;
  }[],
): VersionedCompiledWorkflowVersion {
  const mappingOrigins = plans.flatMap(({ mappingPlan, request }) =>
    mappingPlan.resolvedMappings.map((mapping) => ({
      stepId: request.destinationStepId,
      destinationPath: [...mapping.destinationPath],
      origin: mapping.origin,
    })),
  );
  return versionedCompiledWorkflowVersionSchema.parse({
    ...draft,
    ...(mappingOrigins.length > 0 ? { mappingOrigins } : {}),
    executable: {
      ...draft.executable,
      steps: draft.executable.steps.map((step) => {
        if (!isCapabilityStep(step)) return step;
        const plan = plans.find(
          ({ request }) =>
            request.destinationStepId === step.id &&
            request.destinationCapabilityVersionId === step.capabilityVersionId,
        )?.mappingPlan;
        if (!plan) return step;
        const resolvedArguments: Record<string, TransformationExpression> = { ...step.arguments };
        function applyField(
          fields: Record<string, TransformationExpression>,
          path: readonly string[],
          expression: TransformationExpression,
        ) {
          const [field, ...remaining] = path;
          if (!field) return;
          if (remaining.length === 0) {
            fields[field] = expression;
            return;
          }
          const existing = fields[field];
          const children =
            existing && 'kind' in existing && existing.kind === 'object'
              ? { ...existing.fields }
              : {};
          applyField(children, remaining, expression);
          fields[field] = { kind: 'object', fields: children };
        }
        for (const mapping of plan.resolvedMappings) {
          applyField(resolvedArguments, mapping.destinationPath, mapping.expression);
        }
        const idempotencyField =
          'idempotencyField' in plan && typeof plan.idempotencyField === 'string'
            ? plan.idempotencyField
            : undefined;
        const idempotencyMapping =
          typeof idempotencyField === 'string'
            ? plan.resolvedMappings.find(
                (mapping) =>
                  mapping.destinationPath.length === 1 &&
                  mapping.destinationPath[0] === idempotencyField &&
                  'source' in mapping.expression,
              )
            : undefined;
        return {
          ...step,
          arguments: { ...step.arguments, ...resolvedArguments },
          ...(!step.idempotency && idempotencyMapping
            ? { idempotency: { businessKey: idempotencyMapping.expression } }
            : {}),
        };
      }),
    },
  });
}

function jsonPointerToPath(pointer: string): string[] {
  if (!pointer.startsWith('/')) return pointer ? [pointer] : [];
  return pointer
    .slice(1)
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

// Prompt-named destinations come from requestField annotations already produced
// by the planner (model output and reference hints). Atlas does not parse the
// prompt text itself to invent statedDestinationPaths.
function statedDestinationPathsFor(
  capabilityVersionId: string,
  hints: readonly RequestReferenceHint[],
): (readonly string[])[] | undefined {
  const paths = hints.flatMap((hint) => {
    if (hint.kind !== 'requestField' || hint.capabilityVersionId !== capabilityVersionId) return [];
    if (!hint.path) return [];
    const path = jsonPointerToPath(hint.path);
    return path.length > 0 ? [path] : [];
  });
  return paths.length > 0 ? paths : undefined;
}

function deriveDraftMappingPlans(
  draft: VersionedCompiledWorkflowVersion,
  context: PlanningContext,
  environmentId: string,
  statedFieldHints: readonly RequestReferenceHint[] = [],
) {
  const sourceSteps: ProjectedMappingRequest['sourceSteps'][number][] = [];
  const readyPlans: Array<{
    mappingPlan: ReturnType<typeof planProjectedApiMappings>;
    request: ProjectedMappingRequest;
  }> = [];
  if (draft.executable.irVersion === 3) return { status: 'ready' as const, readyPlans };
  for (const step of draft.executable.steps) {
    if (!isCapabilityStep(step)) continue;
    const statedDestinationPaths = statedDestinationPathsFor(
      step.capabilityVersionId,
      statedFieldHints,
    );
    const resolved =
      context.mappingResolutions?.find(
        ({ request: candidate }) =>
          candidate.destinationStepId === step.id &&
          candidate.destinationCapabilityVersionId === step.capabilityVersionId,
      )?.request ??
      ({
        sourceSteps,
        destinationCapabilityVersionId: step.capabilityVersionId,
        destinationStepId: step.id,
      } satisfies ProjectedMappingRequest);
    const request = {
      ...resolved,
      ...(statedDestinationPaths ? { statedDestinationPaths } : {}),
    };
    const mappingPlan = planProjectedApiMappings({
      intentFingerprint: context.intentFingerprint,
      projection: context.projection,
      activeProjectionFingerprint: context.projection.fingerprint,
      workflowInputSchema: withBackendOwnedInputs(draft.executable.inputSchema ?? { required: {} }),
      request,
      proposedArguments: step.arguments,
      ...(environmentId === 'development' ? { allowClassificationDowngrade: true } : {}),
    });
    if (mappingPlan.status === 'clarification_required') {
      return { status: 'clarification_required' as const, mappingPlan, request, readyPlans };
    }
    if (mappingPlan.status !== 'ready') {
      if (mappingPlan.status === 'manual_review') {
        return { status: 'unavailable' as const, readyPlans };
      }
      return { status: 'impossible' as const, mappingPlan, request, readyPlans };
    }
    readyPlans.push({ mappingPlan, request });
    sourceSteps.push({ stepId: step.id, capabilityVersionId: step.capabilityVersionId });
  }
  return { status: 'ready' as const, readyPlans };
}

function stopReason(validation: ValidationReport) {
  const correctableCodes = new Set([
    'CAPABILITY_NOT_ENABLED_APPROVED',
    'CAPABILITY_NOT_FOUND_IN_PROJECTION',
    'CAPABILITY_ORGANIZATION_MISMATCH',
    'CAPABILITY_VERSION_MISMATCH',
    'DESTINATION_FIELD_NOT_FOUND',
    'MISSING_IDEMPOTENCY_KEY_FOR_RETRYABLE_STEP',
    'RETRY_ON_NON_IDEMPOTENT_SIDE_EFFECT',
    'SCHEMA_PARSE_FAILED',
    'SCHEMA_TYPE_MISMATCH',
    'SOURCE_PATH_NOT_FOUND',
    'TICKET_007_STRUCTURAL_INVALID',
    'UNMAPPED_REQUIRED_FIELD',
  ]);
  if (
    validation.diagnostics.some(
      ({ kind, code }) => kind === 'policyDenial' && !correctableCodes.has(code),
    )
  ) {
    return 'policy-denial';
  }
  return undefined;
}

async function normalizeAndValidate(
  pool: Pool,
  request: z.infer<typeof planningRequestSchema>,
  projection: PlannerProjection,
  rawDraft: VersionedCompiledWorkflowVersion,
) {
  const draft = await (rawDraft.executable.irVersion === 3
    ? createGraphCompiledWorkflowVersion(
        request.workflowVersionId,
        request.organizationId,
        rawDraft.executable,
      )
    : rawDraft.executable.irVersion === 2
      ? createTransformationCompiledWorkflowVersion(
          request.workflowVersionId,
          request.organizationId,
          rawDraft.executable,
        )
      : createCompiledWorkflowVersion(
          request.workflowVersionId,
          request.organizationId,
          rawDraft.executable,
        ));
  const boundDraft = rawDraft.mappingOrigins
    ? { ...draft, mappingOrigins: rawDraft.mappingOrigins }
    : draft;
  const validation = await validateWorkflowDraft(
    pool,
    {
      organizationId: request.organizationId,
      environmentId: request.environmentId,
      proposedApproverRole: 'admin',
      projectionFingerprint: projection.fingerprint,
      draft: { ...rawDraft, ...boundDraft },
    },
    { purpose: 'draft' },
  );
  return { draft: boundDraft, validation };
}

export async function draftWorkflow(
  pool: Pool,
  model: PlannerModel,
  rawRequest: unknown,
  options: {
    actorId?: string;
    signal?: AbortSignal;
    onProgress?: (stage: DraftStage) => Promise<void>;
  } = {},
) {
  const progress = async (stage: DraftStage) => {
    options.signal?.throwIfAborted();
    await options.onProgress?.(stage);
    options.signal?.throwIfAborted();
  };
  const request = planningRequestSchema.parse(rawRequest);
  const actorId = options.actorId ?? 'unauthenticated-author';
  await recordPlanningTrace('planning.request.parsed', {
    organizationId: request.organizationId,
    environmentId: request.environmentId,
    workflowVersionId: request.workflowVersionId,
    hasContinuation: Boolean(request.continuation),
    hasAnswer: Boolean(request.answer),
    hasMapping: Boolean(request.mapping),
    hasRevisionContext: Boolean(request.revisionContext),
    hasSandboxRepair: Boolean(request.sandboxRepair),
  });
  let answers: string[] = [];
  let issuedRounds = 0;
  let boundIntentFingerprint: string | undefined;
  let boundProjectionFingerprint: string | undefined;
  if (request.continuation && request.answer) {
    const continuation = verifyPlanningContinuation(request.continuation, {
      organizationId: request.organizationId,
      environmentId: request.environmentId,
      actorId,
      request: request.request,
    });
    await recordPlanningTrace('planning.continuation.checked', {
      status: continuation.status,
      ...('reason' in continuation ? { reason: continuation.reason } : {}),
    });
    if (continuation.status !== 'ok') {
      const httpStatus = continuation.reason === 'continuation-context-mismatch' ? 403 : 409;
      return {
        httpStatus: httpStatus as 403 | 409,
        body: manualReview(
          continuation.reason === 'projection-drift' ? 'capability-drift' : continuation.reason,
          'The continuation handle is not valid for this planning attempt',
        ),
      };
    }
    answers = [...continuation.payload.answers, request.answer];
    issuedRounds = continuation.payload.round;
    boundIntentFingerprint = continuation.payload.intentFingerprint;
    boundProjectionFingerprint = continuation.payload.projectionFingerprint;
  }

  const projection = await readPlannerCapabilityProjection(
    pool,
    request.organizationId,
    request.environmentId,
  );
  const recipeHints = plannerRecipeHints(
    await readCapabilityArchitecture(pool, request.organizationId, request.environmentId),
  );
  await recordPlanningTrace('planning.projection.loaded', {
    projectionFingerprint: projection.fingerprint,
    capabilityCount: projection.capabilities.length,
    recipeHintCount: (recipeHints?.workflows.length ?? 0) + (recipeHints?.connections.length ?? 0),
    boundProjectionFingerprint: boundProjectionFingerprint ?? null,
  });
  if (boundProjectionFingerprint && boundProjectionFingerprint !== projection.fingerprint) {
    return {
      httpStatus: 409 as const,
      body: manualReview(
        'capability-drift',
        'The continuation is not bound to the active projection fingerprint',
      ),
    };
  }
  await progress('understanding');
  const rawIntent = await model.extractIntent({
    ...(options.signal ? { signal: options.signal } : {}),
    developerRequest: developerRequestWithAnswers(request.request, answers),
    capabilityIndex: createIntentCapabilityIndex(projection),
    ...(recipeHints ? { recipeHints } : {}),
    ...(request.referenceHints ? { referenceHints: request.referenceHints } : {}),
    ...(request.revisionContext && !request.sandboxRepair
      ? { revisionContext: request.revisionContext }
      : {}),
  });
  const extracted = intentFrameSchema.safeParse(rawIntent);
  await recordPlanningTrace('planning.intent.parsed', {
    success: extracted.success,
    rawIntent,
    ...(extracted.success ? {} : { issues: extracted.error.issues }),
  });
  if (!extracted.success) {
    return {
      httpStatus: 422 as const,
      body: manualReview('ambiguity', 'Intent extraction did not produce a typed IntentFrame'),
    };
  }
  const intent = extracted.data;
  if (!intent.supported) {
    return {
      httpStatus: 422 as const,
      body: {
        status: 'unsupported' as const,
        reason: intent.unsupportedReason ?? 'The request is outside the supported capability set',
      },
    };
  }

  const intentFingerprint = sha256(canonicalJson(intent));
  await recordPlanningTrace('planning.intent.bound', {
    intentFingerprint,
    projectionFingerprint: projection.fingerprint,
    supported: intent.supported,
    ambiguityCount: intent.ambiguities.length,
    requiredInputs: intent.requiredInputs,
  });
  const clarificationContext = {
    intentFrame: intent,
    projection,
    request,
    actorId,
    intentFingerprint,
    projectionFingerprint: projection.fingerprint,
    answers,
    issuedRounds,
  };
  let mappingResolutions: MappingResolution[] | undefined;
  if (request.mapping) {
    if (
      (request.mapping.intentFingerprint !== intentFingerprint &&
        request.mapping.intentFingerprint !== boundIntentFingerprint) ||
      request.mapping.projectionFingerprint !== projection.fingerprint
    ) {
      return {
        httpStatus: 409 as const,
        body: manualReview(
          'capability-drift',
          'The mapping selection is not bound to the active intent and projection fingerprints',
        ),
      };
    }
    const {
      intentFingerprint: _intent,
      projectionFingerprint: _projection,
      history,
      sourceSteps,
      destinationCapabilityVersionId,
      destinationStepId,
      selections,
      workflowInputSchema: echoedInputSchema,
    } = request.mapping;
    const current: ProjectedMappingRequest = {
      sourceSteps,
      destinationCapabilityVersionId,
      destinationStepId,
      ...(selections ? { selections } : {}),
    };
    const resolvedMappingRequests: ProjectedMappingRequest[] = [...history, current];
    mappingResolutions = [];
    for (const mappingRequest of resolvedMappingRequests) {
      const plan = planProjectedApiMappings({
        intentFingerprint,
        projection,
        activeProjectionFingerprint: projection.fingerprint,
        workflowInputSchema: withBackendOwnedInputs(
          echoedInputSchema ??
            request.revisionContext?.draft.executable.inputSchema ?? { required: {} },
        ),
        request: mappingRequest,
        ...(request.environmentId === 'development' ? { allowClassificationDowngrade: true } : {}),
      });
      await recordPlanningTrace('planning.mapping.selected', {
        destinationStepId: mappingRequest.destinationStepId,
        destinationCapabilityVersionId: mappingRequest.destinationCapabilityVersionId,
        status: plan.status,
        plan,
      });
      mappingResolutions.push({ request: mappingRequest, plan });
      if (plan.status === 'clarification_required') {
        return issueClarification({
          ...clarificationContext,
          question:
            plan.requiredQuestions[0]?.question ??
            'Which authorized source should provide the unmapped field?',
          ...mappingClarificationOptions(plan, mappingRequest, projection),
          reason: 'duplicate-field-candidates',
          extra: {
            ...plan,
            intentFrame: intent,
            mapping: {
              intentFingerprint,
              projectionFingerprint: projection.fingerprint,
              ...mappingRequest,
              history: resolvedMappingRequests.slice(
                0,
                resolvedMappingRequests.indexOf(mappingRequest),
              ),
              ...(echoedInputSchema ? { workflowInputSchema: echoedInputSchema } : {}),
            },
          },
        });
      }
      if (plan.status !== 'ready') {
        return issueClarification({
          ...clarificationContext,
          ...validationAdaptation(request.environmentId),
          reason: 'mapping-impossible',
          extra: { mappingPlan: plan },
        });
      }
    }
  }
  const context: PlanningContext = {
    ...(options.signal ? { signal: options.signal } : {}),
    intent,
    intentFingerprint,
    projection,
    ...(recipeHints ? { recipeHints } : {}),
    ...(request.referenceHints ? { referenceHints: request.referenceHints } : {}),
    ...(request.revisionContext && !request.sandboxRepair
      ? { revisionContext: request.revisionContext }
      : {}),
    ...(mappingResolutions?.length ? { mappingResolutions } : {}),
  };
  const sandboxValidation = request.sandboxRepair
    ? sandboxRepairValidation(request.sandboxRepair.tests, projection.fingerprint)
    : undefined;
  let previousDraft: unknown;
  let previousValidation: ValidationReport | undefined;
  await progress(sandboxValidation && request.revisionContext ? 'repairing' : 'building');
  await recordPlanningTrace('planning.model.dispatched', {
    operation: sandboxValidation && request.revisionContext ? 'sandbox-repair' : 'initial-draft',
    intentFingerprint,
    projectionFingerprint: projection.fingerprint,
  });
  let rawOutput =
    sandboxValidation && request.revisionContext
      ? await model.repairWorkflow({
          ...context,
          attempt: 1,
          previousDraft: request.revisionContext.draft,
          validation: sandboxValidation,
        })
      : await model.draftWorkflow(context);
  if (sandboxValidation && request.revisionContext) {
    previousDraft = request.revisionContext.draft;
    previousValidation = sandboxValidation;
  }
  let retriedClarification = false;

  for (let attempt = 0; attempt <= 3; attempt += 1) {
    await progress('validating');
    const sanitizedOutput = sanitizeModelOutput(rawOutput, projection);
    const output = modelOutputSchema.safeParse(sanitizedOutput);
    await recordPlanningTrace('planning.output.checked', {
      attempt,
      schemaValid: output.success,
      rawOutput,
      sanitizedOutput,
      ...(output.success ? { outputKind: output.data.kind } : { issues: output.error.issues }),
    });
    if (!output.success) {
      const repairable = repairableWorkflowDraftOutputSchema.safeParse(sanitizedOutput);
      if (!repairable.success) {
        return {
          httpStatus: 422 as const,
          body: manualReview(
            'planner-contract-invalid',
            'The planning model returned an invalid closed-schema response',
          ),
        };
      }
      if (!verifyBinding(repairable.data, context)) {
        return {
          httpStatus: 409 as const,
          body: manualReview(
            'capability-drift',
            'The model response is not bound to the active intent and projection fingerprints',
          ),
        };
      }
      previousDraft = repairable.data.draft;
      previousValidation = {
        diagnostics: schemaParseDiagnostics(output.error.issues),
        decision: {
          approvable: false,
          compileErrorCount: output.error.issues.length,
          policyDenialCount: 0,
          warningCount: 0,
          blockingWarningCount: 0,
          approvalRequirementCount: 0,
          recomputedIrHash: null,
          policyVersion: 'unknown',
          projectionFingerprint: projection.fingerprint,
        },
      };
    } else {
      if (!verifyBinding(output.data, context)) {
        return {
          httpStatus: 409 as const,
          body: manualReview(
            'capability-drift',
            'The model response is not bound to the active intent and projection fingerprints',
          ),
        };
      }
      if (output.data.kind === 'clarification') {
        if (!retriedClarification) {
          retriedClarification = true;
          await progress('building');
          await recordPlanningTrace('planning.clarification.retried', {
            attempt,
            question: output.data.question,
            suggestedAnswers: output.data.suggestedAnswers,
          });
          rawOutput = await model.draftWorkflow({
            ...context,
            clarificationFallback: {
              question: output.data.question,
              suggestedAnswers: output.data.suggestedAnswers,
            },
          });
          continue;
        }
        const reboundMapping = request.mapping
          ? {
              ...request.mapping,
              intentFingerprint,
              projectionFingerprint: projection.fingerprint,
            }
          : undefined;
        return issueClarification({
          ...clarificationContext,
          question: output.data.question,
          suggestedAnswers: output.data.suggestedAnswers,
          reason: 'missing-business-fact',
          ...(reboundMapping ? { extra: { mapping: reboundMapping } } : {}),
        });
      }
      if (output.data.kind === 'unsupported') {
        return {
          httpStatus: 422 as const,
          body: { status: 'unsupported' as const, reason: output.data.reason, intentFrame: intent },
        };
      }

      const inferredDraft = applyInferredFieldMappings(
        output.data.draft,
        projection,
        developerRequestWithAnswers(request.request, answers),
        context.recipeHints,
      );
      const derivedMappings = deriveDraftMappingPlans(
        inferredDraft,
        context,
        request.environmentId,
        [...(context.referenceHints?.references ?? []), ...(output.data.annotations ?? [])],
      );
      await recordPlanningTrace('planning.mapping.derived', {
        attempt,
        status: derivedMappings.status,
        derivedMappings,
      });
      if (derivedMappings.status === 'clarification_required') {
        return issueClarification({
          ...clarificationContext,
          question:
            derivedMappings.mappingPlan.requiredQuestions[0]?.question ??
            'Which authorized source should provide the unmapped field?',
          ...mappingClarificationOptions(
            derivedMappings.mappingPlan,
            derivedMappings.request,
            projection,
          ),
          reason: 'duplicate-field-candidates',
          extra: {
            ...derivedMappings.mappingPlan,
            intentFrame: intent,
            mapping: {
              intentFingerprint: context.intentFingerprint,
              projectionFingerprint: projection.fingerprint,
              ...derivedMappings.request,
              history: context.mappingResolutions?.map(({ request }) => request) ?? [],
              ...(inferredDraft.executable.inputSchema
                ? { workflowInputSchema: inferredDraft.executable.inputSchema }
                : {}),
            },
          },
        });
      }
      if (derivedMappings.status === 'impossible') {
        return issueClarification({
          ...clarificationContext,
          ...validationAdaptation(request.environmentId),
          reason: 'mapping-impossible',
          extra: { mappingPlan: derivedMappings.mappingPlan },
        });
      }

      const mappedDraft = applyMappingPlans(inferredDraft, derivedMappings.readyPlans);
      const selectedMappingValidation = mappingPlansValidation(
        mappedDraft,
        derivedMappings.readyPlans,
        projection.fingerprint,
      );
      const normalized = await normalizeAndValidate(pool, request, projection, mappedDraft);
      await recordPlanningTrace('planning.validation.completed', {
        attempt,
        validation: normalized.validation,
        normalizedDraft: normalized.draft,
        selectedMappingValidation: selectedMappingValidation ?? null,
      });
      if (normalized.validation.decision.approvable) {
        if (selectedMappingValidation) {
          previousDraft = mappedDraft;
          previousValidation = selectedMappingValidation;
        } else {
          const clarifiedRequest = output.data.clarifiedRequest ?? request.request;
          const verification = verifyDraftRequestAnnotations({
            projection,
            clarifiedRequest,
            originalRequest: request.request,
            answers,
            proposed: output.data.annotations ?? [],
          });
          await recordPlanningTrace('planning.annotations.checked', {
            attempt,
            verification,
          });
          if (verification.status === 'clarification_required') {
            return issueClarification({
              ...clarificationContext,
              question: verification.question,
              suggestedAnswers: verification.suggestedAnswers,
              reason: verification.reason,
            });
          }
          if (verification.status === 'rejected') {
            return {
              httpStatus: 422 as const,
              body: manualReview(verification.reason, verification.detail),
            };
          }
          return {
            httpStatus: 200 as const,
            body: {
              status: 'validated' as const,
              originalRequest: request.request,
              clarifiedRequest,
              annotations: verification.annotations,
              intentFrame: intent,
              intentFingerprint: context.intentFingerprint,
              projectionFingerprint: projection.fingerprint,
              draft: normalized.draft,
              validation: normalized.validation,
            },
          };
        }
      } else {
        const reason = stopReason(normalized.validation);
        if (reason)
          return issueClarification({
            ...clarificationContext,
            ...validationAdaptation(request.environmentId),
            reason,
            extra: { validation: normalized.validation },
          });
        previousDraft = mappedDraft;
        previousValidation = normalized.validation;
      }
    }

    if (attempt === 3) {
      return issueClarification({
        ...clarificationContext,
        ...validationAdaptation(request.environmentId),
        reason: 'repair-exhausted',
        extra: { validation: previousValidation },
      });
    }
    await progress('repairing');
    await recordPlanningTrace('planning.repair.dispatched', {
      attempt: attempt + 1,
      previousDraft,
      validation: previousValidation,
    });
    rawOutput = await model.repairWorkflow({
      ...context,
      attempt: attempt + 1,
      previousDraft,
      validation: previousValidation!,
    });
  }

  throw new Error('Unreachable planning state');
}
