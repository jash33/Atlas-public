import {
  createTransformationCompiledWorkflowVersion,
  createGraphCompiledWorkflowVersion,
  graphExecutableWorkflowSchema,
  isCapabilityStep,
  errorRoutingSchema,
  executableWorkflowSchema,
  idempotencyDeclarationSchema,
  objectSchemaSchema,
  responseSchemaSchema,
  retryPolicySchema,
  transformationExpressionSchema,
  transformationExecutableWorkflowSchema,
  valueReferenceSchema,
  validateCompiledWorkflowStructure,
  visitTransformationExpression,
  type CompiledWorkflowVersion,
} from '@atlas/workflow-ir';
import canonicalize from 'canonicalize';
import { isAlias, isNode, parseDocument, stringify, type ParsedNode } from 'yaml';
import { z } from 'zod';

import { sha256 } from './capability-versioning.js';
import { atlasWorkflowRunIdInput, resolveWorkflowInputSchema } from './workflow-input-schema.js';

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SOURCE_DEPTH = 32;
const MAX_STEPS = 256;

export interface WorkflowSourceProjection {
  readonly fingerprint: string;
  readonly capabilities: ReadonlyArray<{
    readonly capabilityVersionId: string;
    readonly identity: {
      readonly kind: string;
      readonly serviceId: string;
      readonly operationId: string;
      readonly channelAddress?: string;
      readonly messageKey?: string;
    };
    readonly annotation: {
      readonly irreversibleAfter?: boolean | null;
      readonly idempotencyField?: string | null;
    };
    /** Pinned operation document; used to derive inputs when the source declares none. */
    readonly fragment?: unknown;
  }>;
}

export interface WorkflowSourceDiagnostic {
  readonly kind: 'compileError';
  readonly code: WorkflowSourceDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

type WorkflowSourceDiagnosticCode =
  | 'CAPABILITY_NAME_AMBIGUOUS'
  | 'CAPABILITY_NOT_FOUND_IN_PROJECTION'
  | 'LEGACY_IR_SCHEMA_INVALID'
  | 'LEGACY_IR_STRUCTURE_INVALID'
  | 'PROJECTION_FINGERPRINT_MISMATCH'
  | 'SOURCE_DEPTH_LIMIT'
  | 'SOURCE_SCHEMA_INVALID'
  | 'SOURCE_SIZE_LIMIT'
  | 'STEP_DEPENDENCY_CYCLE'
  | 'STEP_ID_DUPLICATE'
  | 'STEP_REFERENCE_FORWARD'
  | 'STEP_REFERENCE_MISSING'
  | 'YAML_ALIAS_FORBIDDEN'
  | 'YAML_CUSTOM_TAG'
  | 'YAML_PARSE_FAILED';

interface WorkflowCompilationContext {
  readonly organizationId: string;
  readonly workflowVersionId: string;
  readonly projection: WorkflowSourceProjection;
}

const activitySourceFields = {
  id: z.string().min(1),
  capability: z.string().min(1),
  arguments: z.record(z.string(), transformationExpressionSchema),
  inputSchema: objectSchemaSchema.optional(),
  result: z.string().min(1).optional(),
  retryPolicy: retryPolicySchema.optional(),
  idempotency: idempotencyDeclarationSchema.optional(),
  responseSchema: responseSchemaSchema.optional(),
  irreversibleAfter: z.boolean().optional(),
  errorRouting: errorRoutingSchema.optional(),
};

const sourceStepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('capabilityCall'), ...activitySourceFields }),
  z.strictObject({
    kind: z.literal('compensation'),
    ...activitySourceFields,
    compensatesStepId: z.string().min(1),
  }),
  z.strictObject({ kind: z.literal('publishEvent'), ...activitySourceFields }),
  z.strictObject({ kind: z.literal('notify'), ...activitySourceFields }),
  z.strictObject({
    kind: z.literal('terminal'),
    id: z.string().min(1),
    state: z.enum(['completed', 'validation_failed', 'manual_review', 'repair_required']),
  }),
]);

const sequentialWorkflowSourceSchema = z.strictObject({
  formatVersion: z.literal('atlas-source/v1'),
  projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  workflow: z.strictObject({
    irVersion: z.literal(2).default(2),
    inputSchema: objectSchemaSchema.nullable().optional(),
    steps: z.array(sourceStepSchema).min(1).max(MAX_STEPS),
  }),
});

const workflowSourceSchema = z.union([
  sequentialWorkflowSourceSchema,
  z.strictObject({
    formatVersion: z.literal('atlas-source/v1'),
    projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    workflow: graphExecutableWorkflowSchema,
  }),
]);

type WorkflowSource = z.infer<typeof workflowSourceSchema>;
type SourceStep = z.infer<typeof sequentialWorkflowSourceSchema>['workflow']['steps'][number];

export type WorkflowSourceCompilation =
  | {
      readonly success: true;
      readonly workflow:
        | CompiledWorkflowVersion
        | import('@atlas/workflow-ir').TransformationCompiledWorkflowVersion
        | import('@atlas/workflow-ir').GraphCompiledWorkflowVersion;
      readonly provenance: {
        readonly sourceFormatVersion: 'atlas-source/v1' | 'compiled-workflow-json/v1';
        readonly sourceSha256: string;
        readonly projectionFingerprint: string;
        readonly compiler: { readonly name: 'atlas-workflow-compiler'; readonly version: '1' };
      };
      readonly diagnostics: readonly [];
    }
  | { readonly success: false; readonly diagnostics: readonly WorkflowSourceDiagnostic[] };

export function renderWorkflowSource(
  workflow:
    | CompiledWorkflowVersion
    | import('@atlas/workflow-ir').TransformationCompiledWorkflowVersion
    | import('@atlas/workflow-ir').GraphCompiledWorkflowVersion,
  projection: WorkflowSourceProjection,
) {
  if (workflow.executable.irVersion === 3) {
    return stringify(
      {
        formatVersion: 'atlas-source/v1',
        projectionFingerprint: projection.fingerprint,
        workflow: workflow.executable,
      },
      { indent: 2, lineWidth: 0 },
    );
  }
  const capabilities = new Map(
    projection.capabilities.map((capability) => [capability.capabilityVersionId, capability]),
  );
  const steps = workflow.executable.steps.map((step) => {
    if (!isCapabilityStep(step)) return step;
    const capability = capabilities.get(step.capabilityVersionId);
    if (!capability) {
      throw new TypeError(
        `Capability version '${step.capabilityVersionId}' is absent from the source projection`,
      );
    }
    const { capabilityVersionId: _pin, ...authored } = step;
    return {
      ...authored,
      capability: capability.capabilityVersionId,
    };
  });
  return stringify(
    {
      formatVersion: 'atlas-source/v1',
      projectionFingerprint: projection.fingerprint,
      workflow: {
        irVersion: workflow.executable.irVersion,
        inputSchema: workflow.executable.inputSchema ?? null,
        steps,
      },
    },
    { indent: 2, lineWidth: 0 },
  );
}

export async function compileWorkflowSource(
  input: unknown,
  context: WorkflowCompilationContext,
): Promise<WorkflowSourceCompilation> {
  if (typeof input !== 'string') return compileLegacyJson(input, context);
  const parsed = parseSource(input);
  if (!parsed.success) return parsed;
  const source = parsed.source;
  const diagnostics: WorkflowSourceDiagnostic[] = [];
  if (source.projectionFingerprint !== context.projection.fingerprint) {
    diagnostics.push(
      diagnostic(
        'PROJECTION_FINGERPRINT_MISMATCH',
        'projectionFingerprint',
        'The source was authored against a stale capability projection',
      ),
    );
  }
  if (source.workflow.irVersion === 3) {
    if (diagnostics.length) return failure(diagnostics);
    const compiled = await compileLegacyJson(source.workflow, context);
    return compiled.success
      ? success(
          compiled.workflow,
          'atlas-source/v1',
          sha256(canonicalSource(source)),
          context.projection.fingerprint,
        )
      : compiled;
  }
  diagnostics.push(...dependencyDiagnostics(source.workflow.steps));

  const compiledSteps: unknown[] = [];
  for (const [index, step] of source.workflow.steps.entries()) {
    if (step.kind === 'terminal') {
      compiledSteps.push(step);
      continue;
    }
    const candidates = resolveCapability(step.capability, context.projection);
    if (candidates.length !== 1) {
      diagnostics.push(
        diagnostic(
          candidates.length === 0
            ? 'CAPABILITY_NOT_FOUND_IN_PROJECTION'
            : 'CAPABILITY_NAME_AMBIGUOUS',
          `workflow.steps[${index}].capability`,
          candidates.length === 0
            ? `Capability '${step.capability}' is absent from the authorized projection`
            : `Capability '${step.capability}' does not identify exactly one authorized capability`,
        ),
      );
      continue;
    }
    const capability = candidates[0]!;
    const { capability: _name, irreversibleAfter: _suppliedIrreversible, ...authored } = step;
    compiledSteps.push({
      ...withDefaultIdempotency(authored, capability.annotation.idempotencyField),
      capabilityVersionId: capability.capabilityVersionId,
      inputSchema: authored.inputSchema ?? { required: {} },
      ...(capability.annotation.irreversibleAfter === true
        ? { irreversibleAfter: true }
        : capability.annotation.irreversibleAfter === false && 'irreversibleAfter' in step
          ? { irreversibleAfter: false }
          : {}),
    });
  }
  if (diagnostics.length > 0) return failure(diagnostics);

  // Inputs are the source's own declaration, or leftover required request
  // fields from every step when the source declares none.
  const executable = {
    irVersion: 2,
    inputSchema: resolveWorkflowInputSchema(
      {
        inputSchema: source.workflow.inputSchema ?? undefined,
        steps: compiledSteps.flatMap((value) => {
          const step = value as {
            kind?: unknown;
            capabilityVersionId?: unknown;
            arguments?: Record<string, unknown>;
          };
          return typeof step.kind === 'string'
            ? [
                {
                  kind: step.kind,
                  ...(typeof step.capabilityVersionId === 'string'
                    ? { capabilityVersionId: step.capabilityVersionId }
                    : {}),
                  ...(step.arguments ? { arguments: step.arguments } : {}),
                },
              ]
            : [];
        }),
      },
      (capabilityVersionId) => {
        const fragment = context.projection.capabilities.find(
          (capability) => capability.capabilityVersionId === capabilityVersionId,
        )?.fragment;
        return fragment && typeof fragment === 'object' && !Array.isArray(fragment)
          ? (fragment as Record<string, unknown>)
          : undefined;
      },
    ),
    steps: compiledSteps,
  };
  const workflow = await createTransformationCompiledWorkflowVersion(
    context.workflowVersionId,
    context.organizationId,
    transformationExecutableWorkflowSchema.parse(executable),
  );
  return success(
    workflow,
    'atlas-source/v1',
    sha256(canonicalSource(source)),
    context.projection.fingerprint,
  );
}

function parseSource(
  sourceText: string,
):
  | { success: true; source: WorkflowSource }
  | { success: false; diagnostics: readonly WorkflowSourceDiagnostic[] } {
  if (Buffer.byteLength(sourceText, 'utf8') > MAX_SOURCE_BYTES) {
    return failure([
      diagnostic('SOURCE_SIZE_LIMIT', '(root)', `Source exceeds ${MAX_SOURCE_BYTES} UTF-8 bytes`),
    ]);
  }
  const document = parseDocument(sourceText, {
    customTags: [],
    prettyErrors: false,
    uniqueKeys: true,
    version: '1.2',
  });
  const syntaxDiagnostics = document.errors.map((error) =>
    diagnostic('YAML_PARSE_FAILED', '(root)', error.message),
  );
  const nodeDiagnostics: WorkflowSourceDiagnostic[] = [];
  inspectYamlNode(document.contents, 0, nodeDiagnostics, new Set());
  if (syntaxDiagnostics.length > 0 || nodeDiagnostics.length > 0) {
    return failure([...syntaxDiagnostics, ...nodeDiagnostics]);
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    return failure([
      diagnostic(
        'YAML_PARSE_FAILED',
        '(root)',
        error instanceof Error ? error.message : String(error),
      ),
    ]);
  }
  const parsed = workflowSourceSchema.safeParse(value);
  if (!parsed.success) {
    return failure(
      parsed.error.issues.map((issue) =>
        diagnostic('SOURCE_SCHEMA_INVALID', issue.path.join('.') || '(root)', issue.message),
      ),
    );
  }
  return { success: true, source: parsed.data };
}

function inspectYamlNode(
  value: unknown,
  depth: number,
  diagnostics: WorkflowSourceDiagnostic[],
  seen: Set<unknown>,
) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (depth > MAX_SOURCE_DEPTH) {
    diagnostics.push(
      diagnostic('SOURCE_DEPTH_LIMIT', '(root)', `Source nesting exceeds ${MAX_SOURCE_DEPTH}`),
    );
    return;
  }
  if (isAlias(value)) {
    diagnostics.push(diagnostic('YAML_ALIAS_FORBIDDEN', '(root)', 'YAML aliases are forbidden'));
    return;
  }
  if (isNode(value)) {
    const tag = (value as ParsedNode & { tag?: string }).tag;
    if (tag?.startsWith('!')) {
      diagnostics.push(
        diagnostic('YAML_CUSTOM_TAG', '(root)', `Custom YAML tag '${tag}' is forbidden`),
      );
    }
  }
  const record = value as Record<string, unknown>;
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) inspectYamlNode(item, depth + 1, diagnostics, seen);
    } else {
      inspectYamlNode(child, depth + 1, diagnostics, seen);
    }
  }
}

async function compileLegacyJson(
  input: unknown,
  context: WorkflowCompilationContext,
): Promise<WorkflowSourceCompilation> {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const executableValue = record && 'executable' in record ? record.executable : input;
  const graph = graphExecutableWorkflowSchema.safeParse(executableValue);
  const transformation = transformationExecutableWorkflowSchema.safeParse(executableValue);
  const versionOne = executableWorkflowSchema.safeParse(executableValue);
  const parsedExecutable = graph.success
    ? graph.data
    : transformation.success
      ? transformation.data
      : versionOne.success
        ? transformationExecutableWorkflowSchema.parse({
            ...versionOne.data,
            irVersion: 2,
            steps: versionOne.data.steps.map((step) =>
              step.kind === 'terminal' ? step : { ...step, inputSchema: { required: {} } },
            ),
          })
        : undefined;
  if (!parsedExecutable) {
    const issues =
      executableValue &&
      typeof executableValue === 'object' &&
      'irVersion' in executableValue &&
      executableValue.irVersion === 3 &&
      !graph.success
        ? graph.error.issues
        : transformation.success
          ? []
          : transformation.error.issues;
    return failure(
      issues.map((issue) =>
        diagnostic('LEGACY_IR_SCHEMA_INVALID', issue.path.join('.') || '(root)', issue.message),
      ),
    );
  }
  const capabilities = new Map(
    context.projection.capabilities.map((capability) => [
      capability.capabilityVersionId,
      capability,
    ]),
  );
  const diagnostics: WorkflowSourceDiagnostic[] = [];
  const steps = parsedExecutable.steps.map((step, index) => {
    if (!isCapabilityStep(step)) return step;
    const capability = capabilities.get(step.capabilityVersionId);
    if (!capability) {
      diagnostics.push(
        diagnostic(
          'CAPABILITY_NOT_FOUND_IN_PROJECTION',
          `executable.steps[${index}].capabilityVersionId`,
          `Capability version '${step.capabilityVersionId}' is absent from the authorized projection`,
        ),
      );
      return step;
    }
    const { irreversibleAfter: _supplied, ...rest } = step;
    return {
      ...withDefaultIdempotency(rest, capability.annotation.idempotencyField),
      ...(typeof capability.annotation.irreversibleAfter === 'boolean'
        ? { irreversibleAfter: capability.annotation.irreversibleAfter }
        : {}),
    };
  });
  if (diagnostics.length > 0) return failure(diagnostics);
  const normalizedExecutable = (
    parsedExecutable.irVersion === 3
      ? graphExecutableWorkflowSchema
      : transformationExecutableWorkflowSchema
  ).parse({
    ...parsedExecutable,
    steps,
  });
  const structureIssues = validateCompiledWorkflowStructure(normalizedExecutable);
  if (structureIssues.length > 0) {
    return failure(
      structureIssues.map((issue) =>
        diagnostic('LEGACY_IR_STRUCTURE_INVALID', issue.path, issue.message),
      ),
    );
  }
  const workflow =
    normalizedExecutable.irVersion === 3
      ? await createGraphCompiledWorkflowVersion(
          context.workflowVersionId,
          context.organizationId,
          normalizedExecutable,
        )
      : await createTransformationCompiledWorkflowVersion(
          context.workflowVersionId,
          context.organizationId,
          normalizedExecutable,
        );
  return success(
    workflow,
    'compiled-workflow-json/v1',
    sha256(canonicalSource(normalizedExecutable)),
    context.projection.fingerprint,
  );
}

export function withDefaultIdempotency<
  T extends {
    idempotency?: z.infer<typeof idempotencyDeclarationSchema> | undefined;
    arguments: Readonly<Record<string, unknown>>;
  },
>(step: T, field: string | null | undefined) {
  if (step.idempotency || !field) return step;
  const mappedKey = valueReferenceSchema.safeParse(step.arguments[field]);
  return {
    ...step,
    idempotency: {
      businessKey: mappedKey.success
        ? mappedKey.data
        : { source: 'input' as const, path: [atlasWorkflowRunIdInput] },
    },
  };
}

function resolveCapability(name: string, projection: WorkflowSourceProjection) {
  return projection.capabilities.filter(
    (capability) =>
      capability.capabilityVersionId === name || capabilityNames(capability.identity).has(name),
  );
}

function capabilityNames(identity: WorkflowSourceProjection['capabilities'][number]['identity']) {
  const names = [identity.operationId, `${identity.serviceId}:${identity.operationId}`];
  if (identity.channelAddress && identity.messageKey) {
    names.push(
      `${identity.serviceId}:${identity.channelAddress}:${identity.messageKey}:${identity.operationId}`,
    );
  }
  return new Set(names);
}

function dependencyDiagnostics(steps: readonly SourceStep[]) {
  const diagnostics: WorkflowSourceDiagnostic[] = [];
  const indexes = new Map<string, number>();
  steps.forEach((step, index) => {
    if (indexes.has(step.id)) {
      diagnostics.push(
        diagnostic(
          'STEP_ID_DUPLICATE',
          `workflow.steps[${index}].id`,
          `Step id '${step.id}' is duplicated`,
        ),
      );
    } else indexes.set(step.id, index);
  });
  const dependencies = new Map<string, string[]>();
  for (const step of steps) dependencies.set(step.id, stepDependencies(step));
  const cyclic = cycleMembers(dependencies);
  if (cyclic.size > 0) {
    diagnostics.push(
      diagnostic(
        'STEP_DEPENDENCY_CYCLE',
        'workflow.steps',
        `Step dependency cycle contains: ${[...cyclic].sort().join(', ')}`,
      ),
    );
  }
  steps.forEach((step, index) => {
    for (const dependency of stepDependencies(step)) {
      const dependencyIndex = indexes.get(dependency);
      if (dependencyIndex === undefined) {
        diagnostics.push(
          diagnostic(
            'STEP_REFERENCE_MISSING',
            `workflow.steps[${index}]`,
            `Step '${step.id}' references missing step '${dependency}'`,
          ),
        );
      } else if (dependencyIndex >= index) {
        diagnostics.push(
          diagnostic(
            'STEP_REFERENCE_FORWARD',
            `workflow.steps[${index}]`,
            `Step '${step.id}' references non-prior step '${dependency}'`,
          ),
        );
      }
    }
  });
  return diagnostics;
}

function stepDependencies(step: SourceStep) {
  if (step.kind === 'terminal') return [];
  const dependencies = Object.values(step.arguments).flatMap(expressionStepDependencies);
  if (step.kind === 'compensation') dependencies.push(step.compensatesStepId);
  const visitAction = (action: z.infer<typeof errorRoutingSchema>['defaultAction']) => {
    if (action.kind !== 'revalidateFrom') return;
    dependencies.push(action.targetStepId);
    visitAction(action.onExhausted);
  };
  if (step.errorRouting) {
    step.errorRouting.rules.forEach(({ action }) => visitAction(action));
    visitAction(step.errorRouting.defaultAction);
  }
  return [...new Set(dependencies)];
}

function expressionStepDependencies(expression: unknown): string[] {
  const dependencies: string[] = [];
  visitTransformationExpression(expression, (node) => {
    if (node.source === 'stepOutput' && typeof node.stepId === 'string')
      dependencies.push(node.stepId);
  });
  return dependencies;
}

function cycleMembers(graph: ReadonlyMap<string, readonly string[]>) {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const cyclic = new Set<string>();
  const visit = (node: string, path: string[]) => {
    if (visiting.has(node)) {
      path.slice(path.indexOf(node)).forEach((member) => cyclic.add(member));
      return;
    }
    if (visited.has(node) || !graph.has(node)) return;
    visiting.add(node);
    for (const child of graph.get(node) ?? []) visit(child, [...path, child]);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of graph.keys()) visit(node, [node]);
  return cyclic;
}

function diagnostic(
  code: WorkflowSourceDiagnosticCode,
  path: string,
  message: string,
): WorkflowSourceDiagnostic {
  return { kind: 'compileError', code, path, message };
}

function canonicalSource(value: unknown) {
  const canonical = canonicalize(value);
  if (canonical === undefined) {
    throw new TypeError('Workflow source cannot be represented as canonical JSON');
  }
  return canonical;
}

function failure(diagnostics: readonly WorkflowSourceDiagnostic[]) {
  return {
    success: false as const,
    diagnostics: [...diagnostics].sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.code.localeCompare(right.code) ||
        left.message.localeCompare(right.message),
    ),
  };
}

function success(
  workflow:
    | CompiledWorkflowVersion
    | import('@atlas/workflow-ir').TransformationCompiledWorkflowVersion
    | import('@atlas/workflow-ir').GraphCompiledWorkflowVersion,
  sourceFormatVersion: 'atlas-source/v1' | 'compiled-workflow-json/v1',
  sourceSha256: string,
  projectionFingerprint: string,
): WorkflowSourceCompilation {
  return {
    success: true,
    workflow,
    provenance: {
      sourceFormatVersion,
      sourceSha256,
      projectionFingerprint,
      compiler: { name: 'atlas-workflow-compiler', version: '1' },
    },
    diagnostics: [],
  };
}
