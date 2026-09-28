import {
  isCapabilityStep,
  collectRevalidationActions,
  computeIrHash,
  validateCompiledWorkflowStructure,
  versionedCompiledWorkflowVersionSchema,
  type VersionedCompiledWorkflowVersion,
  type ResponseSchema,
  type ResponseValueSchema,
  type GraphExecutableWorkflow,
} from '@atlas/workflow-ir';
import type { Pool } from 'pg';
import { z } from 'zod';

import { readCapabilityCatalog, readPlannerCapabilityProjection } from './capability-catalog.js';
import {
  decideNewCompilationSelection,
  decideWorkflowApprovalSelection,
  loadCapabilitySelectionFacts,
} from './capability-selection.js';
import {
  validateTransformation,
  inspectTransformation,
  type DataClassification,
  type TransformationSchema,
} from './transformation-validation.js';
import { resolveWorkflowInputSchema, withBackendOwnedInputs } from './workflow-input-schema.js';

export type DiagnosticKind = 'compileError' | 'policyDenial' | 'warning' | 'approvalRequirement';

export interface ValidationDiagnostic {
  kind: DiagnosticKind;
  code: string;
  path: string;
  message: string;
}

export interface ApprovalDecision {
  approvable: boolean;
  compileErrorCount: number;
  policyDenialCount: number;
  warningCount: number;
  blockingWarningCount: number;
  approvalRequirementCount: number;
  recomputedIrHash: string | null;
  policyVersion: string;
  projectionFingerprint: string;
}

export interface ValidationReport {
  diagnostics: ValidationDiagnostic[];
  decision: ApprovalDecision;
}

const validationRequestSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    proposedApproverRole: z.string().min(1),
    projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    plannerAuthoredLiteralPaths: z.array(z.string().min(1)).default([]),
    draft: z.unknown(),
  })
  .strict();

const diagnosticKindOrder: Record<DiagnosticKind, number> = {
  compileError: 0,
  policyDenial: 1,
  warning: 2,
  approvalRequirement: 3,
};

const backendOwnedDraftFields = new Set([
  'approvalState',
  'approvedAt',
  'approvedBy',
  'compilerVersion',
  'createdAt',
  'executionGrant',
  'modelInvocation',
  'provenance',
  'status',
  'updatedAt',
]);

export function discardBackendOwnedDraftFields(value: unknown) {
  const draft = objectValue(value);
  if (!draft) return value;
  return Object.fromEntries(
    Object.entries(draft).filter(([key]) => !backendOwnedDraftFields.has(key)),
  );
}

function sortDiagnostics(diagnostics: ValidationDiagnostic[]) {
  const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
  return diagnostics.sort(
    (left, right) =>
      diagnosticKindOrder[left.kind] - diagnosticKindOrder[right.kind] ||
      compareText(left.path, right.path) ||
      compareText(left.code, right.code) ||
      compareText(left.message, right.message),
  );
}

function referencedCapabilityVersionIds(draft: VersionedCompiledWorkflowVersion) {
  return draft.executable.steps.flatMap((step) =>
    !isCapabilityStep(step)
      ? []
      : [{ stepId: step.id, capabilityVersionId: step.capabilityVersionId }],
  );
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function resolveSchema(fragment: JsonObject, value: unknown): JsonObject | undefined {
  const schema = objectValue(value);
  if (!schema) return undefined;
  if (typeof schema.$ref !== 'string') return schema;
  return objectValue(objectValue(fragment.references)?.[schema.$ref]);
}

export function capabilityInputFields(fragment: JsonObject) {
  const fields = new Map<string, { required: boolean; schema: JsonObject | undefined }>();
  const operation = objectValue(fragment.operation);
  const parameters = [
    ...(Array.isArray(fragment.pathParameters) ? fragment.pathParameters : []),
    ...(Array.isArray(operation?.parameters) ? operation.parameters : []),
  ];
  for (const value of parameters) {
    const parameter = objectValue(value);
    if (typeof parameter?.name !== 'string') continue;
    fields.set(parameter.name, {
      required: parameter.required === true,
      schema: resolveSchema(fragment, parameter.schema),
    });
  }
  const requestBody = objectValue(operation?.requestBody);
  const content = objectValue(requestBody?.content);
  const mediaType = content ? objectValue(Object.values(content)[0]) : undefined;
  const bodySchema = resolveSchema(fragment, mediaType?.schema);
  const channelMessages = objectValue(objectValue(fragment.channel)?.messages);
  const operationMessages = Array.isArray(operation?.messages) ? operation.messages : [];
  const referencedMessageKey = operationMessages
    .map(objectValue)
    .map((message) =>
      typeof message?.$ref === 'string' ? message.$ref.split('/').at(-1) : undefined,
    )
    .find((key) => key && channelMessages?.[key]);
  const projectedMessage = referencedMessageKey
    ? objectValue(channelMessages?.[referencedMessageKey])
    : objectValue(fragment.message);
  const messageSchema = resolveSchema(fragment, projectedMessage?.payload);
  const inputSchema = bodySchema ?? messageSchema;
  const properties = objectValue(inputSchema?.properties);
  const required = new Set(Array.isArray(inputSchema?.required) ? inputSchema.required : []);
  for (const [name, schema] of Object.entries(properties ?? {})) {
    fields.set(name, { required: required.has(name), schema: resolveSchema(fragment, schema) });
  }
  return fields;
}

export function capabilityOutputSchema(fragment: JsonObject) {
  const operation = objectValue(fragment.operation);
  const responses = objectValue(operation?.responses);
  const success = responses
    ? Object.entries(responses)
        .sort(([left], [right]) => left.localeCompare(right))
        .find(([status]) => /^2\d\d$/.test(status))?.[1]
    : undefined;
  const content = objectValue(objectValue(success)?.content);
  const mediaType = content ? objectValue(Object.values(content)[0]) : undefined;
  return resolveSchema(fragment, mediaType?.schema);
}

const dataClassifications = new Set<DataClassification>([
  'public',
  'internal',
  'confidential',
  'secret',
  'restricted',
]);

function dataClassification(value: unknown): DataClassification | undefined {
  return typeof value === 'string' && dataClassifications.has(value as DataClassification)
    ? (value as DataClassification)
    : undefined;
}

function responseValueToTransformationSchema(value: ResponseValueSchema): TransformationSchema {
  const classification = value.classification;
  if (value.type === 'object') {
    return {
      type: 'object',
      required: Object.fromEntries(
        Object.entries(value.required).map(([name, child]) => [
          name,
          responseValueToTransformationSchema(child),
        ]),
      ),
      ...(classification ? { classification } : {}),
    };
  }
  if (value.type === 'array') {
    return {
      type: 'array',
      items: responseValueToTransformationSchema(value.items),
      ...(classification ? { classification } : {}),
    };
  }
  return { type: value.type, ...(classification ? { classification } : {}) };
}

export function responseSchemaToTransformationSchema(value: ResponseSchema): TransformationSchema {
  return {
    type: 'object',
    required: Object.fromEntries(
      Object.entries(value.required).map(([name, child]) => [
        name,
        responseValueToTransformationSchema(child),
      ]),
    ),
  };
}

export function jsonSchemaToTransformationSchema(
  fragment: JsonObject,
  value: JsonObject | undefined,
): TransformationSchema | undefined {
  const schema = value ? resolveSchema(fragment, value) : undefined;
  if (!schema) return undefined;
  const rawType = schema.type;
  const nullable = Array.isArray(rawType) && rawType.includes('null');
  const type = Array.isArray(rawType) ? rawType.find((candidate) => candidate !== 'null') : rawType;
  const classification = dataClassification(schema['x-atlas-data-classification']);
  const unit = ['cents', 'decimal-currency', 'kilograms', 'meters'].includes(
    String(schema['x-atlas-unit']),
  )
    ? (schema['x-atlas-unit'] as NonNullable<TransformationSchema['unit']>)
    : undefined;
  const letterCase = ['lower', 'upper'].includes(String(schema['x-atlas-case']))
    ? (schema['x-atlas-case'] as 'lower' | 'upper')
    : undefined;
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter(
        (candidate): candidate is string | number =>
          typeof candidate === 'string' || typeof candidate === 'number',
      )
    : undefined;
  if (type === 'object') {
    const properties = objectValue(schema.properties) ?? {};
    const requiredNames = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((name): name is string => typeof name === 'string')
        : [],
    );
    const required: Record<string, TransformationSchema> = {};
    const optional: Record<string, TransformationSchema> = {};
    for (const [name, child] of Object.entries(properties)) {
      const converted = jsonSchemaToTransformationSchema(fragment, objectValue(child));
      if (converted) (requiredNames.has(name) ? required : optional)[name] = converted;
    }
    return {
      type: 'object',
      required,
      ...(Object.keys(optional).length ? { optional } : {}),
      ...(nullable ? { nullable: true } : {}),
      ...(classification ? { classification } : {}),
      ...(unit ? { unit } : {}),
      ...(enumValues ? { enumValues } : {}),
      ...(letterCase ? { case: letterCase } : {}),
    };
  }
  if (type === 'array') {
    const items = jsonSchemaToTransformationSchema(fragment, objectValue(schema.items));
    if (!items) return undefined;
    return {
      type: 'array',
      items,
      ...(nullable ? { nullable: true } : {}),
      ...(classification ? { classification } : {}),
      ...(unit ? { unit } : {}),
      ...(enumValues ? { enumValues } : {}),
      ...(letterCase ? { case: letterCase } : {}),
    };
  }
  if (!['string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) return undefined;
  return {
    type: type as 'string' | 'number' | 'integer' | 'boolean' | 'null',
    ...(nullable ? { nullable: true } : {}),
    ...(classification ? { classification } : {}),
    ...(unit ? { unit } : {}),
    ...(enumValues ? { enumValues } : {}),
    ...(letterCase ? { case: letterCase } : {}),
  };
}

function isPrivateOrMetadataHost(hostname: string) {
  const host = hostname.toLowerCase();
  return (
    ['localhost', '0.0.0.0', '127.0.0.1', '::1', 'metadata.google.internal'].includes(host) ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
  );
}

function capabilityMutates(fragment: JsonObject | undefined) {
  const method = fragment?.method;
  return typeof method === 'string' && !['get', 'head', 'options'].includes(method.toLowerCase());
}

async function readExecutionHosts(
  pool: Pool,
  organizationId: string,
  environmentId: string,
  capabilityVersionId: string,
) {
  const result = await pool.query<{ hostname: string; allow_redirects: boolean }>(
    `SELECT policy.hostname, policy.allow_redirects
     FROM capability_versions version
     JOIN capability_host_policies policy
       ON policy.organization_id = version.organization_id
       AND policy.capability_identity_id = version.capability_identity_id
     WHERE version.organization_id = $1 AND policy.environment_id = $2
       AND version.capability_version_id = $3
       AND policy.revoked_at IS NULL
     ORDER BY policy.hostname`,
    [organizationId, environmentId, capabilityVersionId],
  );
  return result.rows;
}

async function readValidationPolicy(pool: Pool, organizationId: string, environmentId: string) {
  const result = await pool.query<{ policy_version: string }>(
    `SELECT policy_version
     FROM organization_environment_policies
     WHERE organization_id = $1 AND environment_id = $2 AND revoked_at IS NULL`,
    [organizationId, environmentId],
  );
  return result.rows[0];
}

function graphRevalidationSteps(
  workflow: GraphExecutableWorkflow,
  targetId: string,
  failureId: string,
) {
  const next = new Map(
    workflow.steps.map((step) => [
      step.id,
      step.kind === 'condition'
        ? [step.whenTrue, step.whenFalse]
        : 'next' in step
          ? [step.next]
          : [],
    ]),
  );
  const previous = new Map<string, string[]>();
  for (const [id, targets] of next)
    for (const target of targets) previous.set(target, [...(previous.get(target) ?? []), id]);
  const reachable = (start: string, edges: ReadonlyMap<string, string[]>) => {
    const seen = new Set<string>();
    const pending = [start];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(edges.get(id) ?? []));
    }
    return seen;
  };
  const fromTarget = reachable(targetId, next);
  const toFailure = reachable(failureId, previous);
  return workflow.steps.filter((step) => fromTarget.has(step.id) && toFailure.has(step.id));
}

export async function validateWorkflowDraft(
  pool: Pool,
  rawRequest: unknown,
  options: { purpose?: 'draft' | 'approval' } = {},
): Promise<ValidationReport> {
  const request = validationRequestSchema.parse(rawRequest);
  const parsedDraft = versionedCompiledWorkflowVersionSchema.safeParse(
    discardBackendOwnedDraftFields(request.draft),
  );
  const projection = await readPlannerCapabilityProjection(
    pool,
    request.organizationId,
    request.environmentId,
  );
  const catalog = await readCapabilityCatalog(pool, request.organizationId, request.environmentId);
  const catalogByVersionId = new Map(
    catalog.map((capability) => [capability.capabilityVersionId, capability]),
  );
  const validationPolicy = await readValidationPolicy(
    pool,
    request.organizationId,
    request.environmentId,
  );
  const diagnostics: ValidationDiagnostic[] = [];
  const plannerAuthoredLiteralPaths = new Set(request.plannerAuthoredLiteralPaths);
  let recomputedIrHash: string | null = null;

  // Gate 1: schema parse.
  if (!parsedDraft.success) {
    for (const issue of parsedDraft.error.issues) {
      diagnostics.push({
        kind: 'compileError',
        code: 'SCHEMA_PARSE_FAILED',
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      });
    }
  } else {
    // Gate 2: IR-internal structure and hash.
    for (const issue of validateCompiledWorkflowStructure(parsedDraft.data.executable)) {
      diagnostics.push({
        kind: 'compileError',
        code: 'TICKET_007_STRUCTURAL_INVALID',
        path: issue.path,
        message: issue.message,
      });
    }
    recomputedIrHash = await computeIrHash(parsedDraft.data.executable);
    const recomputedCapabilityVersionIds = [
      ...new Set(
        referencedCapabilityVersionIds(parsedDraft.data).map(
          ({ capabilityVersionId }) => capabilityVersionId,
        ),
      ),
    ].sort();
    if (
      parsedDraft.data.irHash !== recomputedIrHash ||
      parsedDraft.data.executionRequirements.irHash !== recomputedIrHash
    ) {
      diagnostics.push({
        kind: 'compileError',
        code: 'TICKET_007_STRUCTURAL_INVALID',
        path: 'irHash',
        message: `Draft hash does not match the recomputed executable-content hash '${recomputedIrHash}'`,
      });
    }
    // Gate 3: recompute backend metadata.
    if (
      parsedDraft.data.executionRequirements.workflowVersionId !==
        parsedDraft.data.workflowVersionId ||
      JSON.stringify(parsedDraft.data.executionRequirements.requiredCapabilityVersionIds) !==
        JSON.stringify(recomputedCapabilityVersionIds)
    ) {
      diagnostics.push({
        kind: 'compileError',
        code: 'TICKET_007_STRUCTURAL_INVALID',
        path: 'executionRequirements',
        message: 'Draft execution requirements do not match recomputed backend metadata',
      });
    }
    // Gate 4: projection fingerprint freshness.
    if (request.projectionFingerprint !== projection.fingerprint) {
      diagnostics.push({
        kind: 'policyDenial',
        code: 'PROJECTION_FINGERPRINT_MISMATCH',
        path: 'projectionFingerprint',
        message: `The bound projection fingerprint does not match the current authorized projection`,
      });
    }
    // Gate 5: capability re-resolution.
    for (const reference of referencedCapabilityVersionIds(parsedDraft.data)) {
      const facts = await loadCapabilitySelectionFacts(
        pool,
        request.organizationId,
        reference.capabilityVersionId,
        request.environmentId,
      );
      if (!facts) {
        const existsForAnotherOrganization = await pool.query(
          `SELECT 1 FROM capability_versions
           WHERE capability_version_id = $1 AND organization_id <> $2 LIMIT 1`,
          [reference.capabilityVersionId, request.organizationId],
        );
        const organizationMismatch = (existsForAnotherOrganization.rowCount ?? 0) > 0;
        diagnostics.push({
          kind: 'policyDenial',
          code: organizationMismatch
            ? 'CAPABILITY_ORGANIZATION_MISMATCH'
            : 'CAPABILITY_NOT_FOUND_IN_PROJECTION',
          path: `executable.steps[${reference.stepId}].capabilityVersionId`,
          message: organizationMismatch
            ? `Capability version '${reference.capabilityVersionId}' belongs to another organization`
            : `Capability version '${reference.capabilityVersionId}' is absent from the authorized projection`,
        });
      } else {
        const selection =
          options.purpose === 'draft'
            ? decideNewCompilationSelection(facts)
            : decideWorkflowApprovalSelection(facts);
        const selectionDenials = selection.denials.filter(
          (denial) => denial !== 'capability-observation-stale',
        );
        if (selection.denials.includes('capability-observation-stale')) {
          diagnostics.push({
            kind: 'approvalRequirement',
            code: 'CAPABILITY_OBSERVATION_STALE',
            path: `executable.steps[${reference.stepId}].capabilityVersionId`,
            message: `This step uses the last known capability definition. Refresh its source successfully before approving the workflow. Drafting and editing are still available.`,
          });
        }
        if (selectionDenials.length > 0) {
          const superseded = selectionDenials.includes('superseded-version');
          diagnostics.push({
            kind: 'policyDenial',
            code: superseded ? 'CAPABILITY_VERSION_MISMATCH' : 'CAPABILITY_NOT_ENABLED_APPROVED',
            path: `executable.steps[${reference.stepId}].capabilityVersionId`,
            message: `Capability version '${reference.capabilityVersionId}' is not selectable: ${selectionDenials.join(', ')}`,
          });
        }
      }
    }

    // Gate 6: statically type- and policy-check mappings against exact pinned schemas.
    // Workflow inputs are the draft's own: declared, or leftover required fields from its steps.
    const workflowInput = responseSchemaToTransformationSchema(
      withBackendOwnedInputs(
        resolveWorkflowInputSchema(
          parsedDraft.data.executable,
          (capabilityVersionId) => catalogByVersionId.get(capabilityVersionId)?.fragment,
        ),
      ),
    );
    const stepOutputs = new Map<string, TransformationSchema>();
    for (const step of parsedDraft.data.executable.steps) {
      if (step.kind === 'transform') {
        stepOutputs.set(step.id, responseSchemaToTransformationSchema(step.responseSchema));
        continue;
      }
      if (!isCapabilityStep(step)) continue;
      const capability = catalogByVersionId.get(step.capabilityVersionId);
      const output = capability
        ? jsonSchemaToTransformationSchema(
            capability.fragment,
            capabilityOutputSchema(capability.fragment),
          )
        : undefined;
      if (output) stepOutputs.set(step.id, output);
    }
    for (const step of parsedDraft.data.executable.steps) {
      const path = `executable.steps[${step.id}]`;
      const context = { workflowInput, stepOutputs };
      const report = (issues: ReturnType<typeof validateTransformation>) => {
        for (const issue of issues) {
          if (
            request.environmentId === 'development' &&
            issue.code === 'TRANSFORM_CLASSIFICATION_DOWNGRADE'
          )
            continue;
          diagnostics.push({
            kind: 'policyDenial',
            code: issue.code,
            path: issue.path,
            message: issue.message,
          });
        }
      };
      if (step.kind === 'transform') {
        report(
          validateTransformation(
            { kind: 'object', fields: step.arguments },
            responseSchemaToTransformationSchema(step.responseSchema),
            context,
            `${path}.arguments`,
          ),
        );
      } else if (step.kind === 'condition') {
        const left = inspectTransformation(step.condition.left, context, `${path}.condition.left`);
        report(left.diagnostics);
        if (step.condition.operator !== 'exists') {
          const right =
            step.condition.right &&
            inspectTransformation(step.condition.right, context, `${path}.condition.right`);
          if (right) report(right.diagnostics);
          if (left.inferred?.mayBeMissing || right?.inferred?.mayBeMissing) {
            diagnostics.push({
              kind: 'policyDenial',
              code: 'CONDITION_VALUE_MAY_BE_MISSING',
              path: `${path}.condition`,
              message: 'Use a default for optional comparison values or an exists condition.',
            });
          }
          const leftType = left.inferred?.schema.type;
          const rightType = right?.inferred?.schema.type;
          const numeric = (type: string | undefined) => type === 'number' || type === 'integer';
          if (
            step.condition.operator === 'greaterThan' || step.condition.operator === 'lessThan'
              ? (leftType && !numeric(leftType)) || (rightType && !numeric(rightType))
              : leftType &&
                rightType &&
                leftType !== rightType &&
                !(numeric(leftType) && numeric(rightType))
          ) {
            diagnostics.push({
              kind: 'policyDenial',
              code: 'CONDITION_TYPE_MISMATCH',
              path: `${path}.condition`,
              message:
                'Comparison values must have matching types; greater than and less than require numbers.',
            });
          }
        }
      } else if (step.kind === 'terminal' && 'output' in step && step.output) {
        const output = inspectTransformation(step.output, context, `${path}.output`);
        report(output.diagnostics);
        if (
          output.inferred &&
          (output.inferred.schema.type !== 'object' || output.inferred.mayBeMissing)
        ) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'FINISH_OUTPUT_MUST_BE_OBJECT',
            path: `${path}.output`,
            message: 'Finish must return a defined object.',
          });
        }
      }
    }
    for (const step of parsedDraft.data.executable.steps) {
      if (!isCapabilityStep(step)) continue;
      const destinationCapability = catalogByVersionId.get(step.capabilityVersionId);
      if (!destinationCapability) continue;
      const inputFields = capabilityInputFields(destinationCapability.fragment);
      for (const [field, definition] of inputFields) {
        if (definition.required && !(field in step.arguments)) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'UNMAPPED_REQUIRED_FIELD',
            path: `executable.steps[${step.id}].arguments.${field}`,
            message: `Required capability input '${field}' is not mapped`,
          });
        }
      }
      for (const [field, expression] of Object.entries(step.arguments)) {
        const mappingPath = `executable.steps[${step.id}].arguments.${field}`;
        const definition = inputFields.get(field);
        if (!definition) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'DESTINATION_FIELD_NOT_FOUND',
            path: mappingPath,
            message: `Capability input schema has no field '${field}'`,
          });
          continue;
        }
        const destination = jsonSchemaToTransformationSchema(
          destinationCapability.fragment,
          definition.schema,
        );
        if (!destination) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'TRANSFORM_DESTINATION_SCHEMA_UNSUPPORTED',
            path: mappingPath,
            message: `Capability input '${field}' does not have a statically supported pinned schema`,
          });
          continue;
        }
        for (const issue of validateTransformation(
          expression,
          destination,
          { workflowInput, stepOutputs, destinationKind: step.kind },
          mappingPath,
        )) {
          // The local development pitch keeps schema/type checks but does not gate on classification.
          if (
            request.environmentId === 'development' &&
            issue.code === 'TRANSFORM_CLASSIFICATION_DOWNGRADE'
          ) {
            continue;
          }
          const legacyCode =
            parsedDraft.data.executable.irVersion === 1
              ? {
                  TRANSFORM_SOURCE_PATH_NOT_FOUND: 'SOURCE_PATH_NOT_FOUND',
                  TRANSFORM_TYPE_MISMATCH: 'SCHEMA_TYPE_MISMATCH',
                  TRANSFORM_NULLABILITY_MISMATCH: 'SCHEMA_TYPE_MISMATCH',
                  TRANSFORM_CLASSIFICATION_DOWNGRADE: 'DATA_CLASSIFICATION_DOWNGRADE',
                }[issue.code]
              : undefined;
          diagnostics.push({
            kind: 'policyDenial',
            code: legacyCode ?? issue.code,
            path: issue.path,
            message: `${issue.message}${
              issue.suggestedMappings?.length
                ? ` Suggested valid mappings: ${issue.suggestedMappings.join('; ')}.`
                : ''
            }`,
          });
        }
        if (plannerAuthoredLiteralPaths.has(mappingPath)) {
          diagnostics.push({
            kind: 'warning',
            code: 'literal-not-derived',
            path: mappingPath,
            message: 'Literal mappings are not derived from a trusted workflow source path',
          });
        }
      }
    }

    // Gate 7: policy.
    if (request.proposedApproverRole !== 'admin') {
      diagnostics.push({
        kind: 'policyDenial',
        code: 'RBAC_APPROVER_ROLE_DENIED',
        path: 'proposedApproverRole',
        message: `Role '${request.proposedApproverRole}' cannot approve a workflow`,
      });
    }
    if (
      !validationPolicy ||
      parsedDraft.data.executionRequirements.organizationId !== request.organizationId
    ) {
      diagnostics.push({
        kind: 'policyDenial',
        code: 'ORGANIZATION_NOT_AUTHORIZED_FOR_ENVIRONMENT',
        path: validationPolicy ? 'draft.executionRequirements.organizationId' : 'environmentId',
        message: validationPolicy
          ? 'Draft organization does not match the validation context'
          : `Organization '${request.organizationId}' is not authorized for environment '${request.environmentId}'`,
      });
    }
    for (const reference of referencedCapabilityVersionIds(parsedDraft.data)) {
      // An unknown pin is already diagnosed above; do not add a misleading host-policy cascade.
      if (!catalogByVersionId.has(reference.capabilityVersionId)) continue;
      const executionHosts = await readExecutionHosts(
        pool,
        request.organizationId,
        request.environmentId,
        reference.capabilityVersionId,
      );
      if (executionHosts.length === 0) {
        diagnostics.push({
          kind: 'policyDenial',
          code: 'EXECUTION_HOST_NOT_ALLOWLISTED',
          path: `executable.steps[${reference.stepId}]`,
          message: `Capability version '${reference.capabilityVersionId}' has no execution host allowed in environment '${request.environmentId}'`,
        });
      }
      for (const { hostname, allow_redirects: allowRedirects } of executionHosts) {
        if (isPrivateOrMetadataHost(hostname)) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'EXECUTION_HOST_DENIED_PATTERN',
            path: `executable.steps[${reference.stepId}]`,
            message: `Execution host '${hostname}' is private, loopback, link-local, or cloud metadata`,
          });
        }
        if (allowRedirects) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'EXECUTION_HOST_REDIRECTS_NOT_PERMITTED',
            path: `executable.steps[${reference.stepId}]`,
            message: `Execution host '${hostname}' permits redirects`,
          });
        }
      }
    }
    // Gate 8: safety.
    for (const step of parsedDraft.data.executable.steps) {
      if (!isCapabilityStep(step)) continue;
      const capability = catalogByVersionId.get(step.capabilityVersionId);
      const mutates = capabilityMutates(capability?.fragment);
      if (
        mutates &&
        step.retryPolicy &&
        step.retryPolicy.maximumAttempts > 1 &&
        (!step.idempotency || !capability?.annotation?.idempotencyField)
      ) {
        diagnostics.push({
          kind: 'policyDenial',
          code: 'MISSING_IDEMPOTENCY_KEY_FOR_RETRYABLE_STEP',
          path: `executable.steps[${step.id}]`,
          message:
            'A retryable side effect requires both capability and workflow idempotency declarations',
        });
        diagnostics.push({
          kind: 'policyDenial',
          code: 'RETRY_ON_NON_IDEMPOTENT_SIDE_EFFECT',
          path: `executable.steps[${step.id}]`,
          message: 'Retrying this side effect could repeat a write without a downstream key',
        });
      }
      if (step.retryPolicy && step.retryPolicy.maximumAttempts > 5) {
        diagnostics.push({
          kind: 'warning',
          code: 'WARN_HIGH_RETRY_ATTEMPT_COUNT',
          path: `executable.steps[${step.id}].retryPolicy.maximumAttempts`,
          message: `Retry attempt count '${step.retryPolicy.maximumAttempts}' exceeds the MVP review threshold`,
        });
      }
    }
    for (const step of parsedDraft.data.executable.steps) {
      if (!isCapabilityStep(step)) continue;
      const capability = catalogByVersionId.get(step.capabilityVersionId);
      if (step.kind !== 'compensation') {
        const draftIrreversible =
          step.kind === 'publishEvent' ? true : (step.irreversibleAfter ?? false);
        if (
          capability?.annotation &&
          draftIrreversible !== capability.annotation.irreversibleAfter
        ) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'IRREVERSIBLE_BOUNDARY_VIOLATION',
            path: `executable.steps[${step.id}].irreversibleAfter`,
            message: 'Draft irreversibility does not match the trusted capability annotation',
          });
        }
      }
      const expectedCompensation = capability?.annotation?.compensatedBy;
      const compensations = parsedDraft.data.executable.steps.filter(
        (candidate) => candidate.kind === 'compensation' && candidate.compensatesStepId === step.id,
      );
      const firstCompensation = compensations[0];
      const compensationIdentity =
        firstCompensation?.kind === 'compensation'
          ? catalogByVersionId.get(firstCompensation.capabilityVersionId)?.identity
          : undefined;
      const compensationIsComplete = expectedCompensation
        ? compensations.length === 1 &&
          compensationIdentity?.kind === expectedCompensation.kind &&
          compensationIdentity.serviceId === expectedCompensation.serviceId &&
          compensationIdentity.operationId === expectedCompensation.operationId &&
          (compensationIdentity.channelAddress ?? null) === expectedCompensation.channelAddress &&
          (compensationIdentity.messageKey ?? null) === expectedCompensation.messageKey
        : compensations.length === 0;
      if (!compensationIsComplete) {
        diagnostics.push({
          kind: 'policyDenial',
          code: 'COMPENSATION_INCOMPLETE',
          path: `executable.steps[${step.id}]`,
          message: 'Workflow compensation does not match the trusted capability edge',
        });
      }
    }
    const steps = parsedDraft.data.executable.steps;
    const stepIndexes = new Map(steps.map((step, index) => [step.id, index]));
    for (const [stepIndex, step] of steps.entries()) {
      if (!isCapabilityStep(step)) continue;
      for (const action of collectRevalidationActions(step.errorRouting)) {
        const targetIndex = action.targetStepId ? stepIndexes.get(action.targetStepId) : undefined;
        if (targetIndex === undefined) continue;
        if (parsedDraft.data.executable.irVersion !== 3 && targetIndex >= stepIndex) continue;
        const slice =
          parsedDraft.data.executable.irVersion === 3
            ? graphRevalidationSteps(parsedDraft.data.executable, action.targetStepId, step.id)
            : steps.slice(targetIndex, stepIndex + 1);
        const crossesIrreversibleBoundary = slice.some((sliceStep) => {
          if (!isCapabilityStep(sliceStep) || sliceStep.id === step.id) return false;
          return (
            catalogByVersionId.get(sliceStep.capabilityVersionId)?.annotation?.irreversibleAfter ===
            true
          );
        });
        const repeatsUnsafeSideEffect = slice.some((sliceStep) => {
          if (!isCapabilityStep(sliceStep) || sliceStep.id === step.id) return false;
          const capability = catalogByVersionId.get(sliceStep.capabilityVersionId);
          const mutates = capabilityMutates(capability?.fragment);
          return mutates && (!sliceStep.idempotency || !capability?.annotation?.idempotencyField);
        });
        if (crossesIrreversibleBoundary) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'REVALIDATION_SLICE_CROSSES_IRREVERSIBLE_BOUNDARY',
            path: `executable.steps[${step.id}].errorRouting`,
            message: `Revalidation from '${action.targetStepId}' crosses an irreversible capability`,
          });
        } else if (repeatsUnsafeSideEffect) {
          diagnostics.push({
            kind: 'policyDenial',
            code: 'REVALIDATION_SLICE_NOT_SAFE',
            path: `executable.steps[${step.id}].errorRouting`,
            message: `Revalidation from '${action.targetStepId}' would repeat a side effect without an idempotency declaration`,
          });
        }
      }
    }
  }

  // Gate 9: ordered diagnostics and ApprovalDecision.
  if (request.proposedApproverRole !== 'admin') {
    diagnostics.push({
      kind: 'approvalRequirement',
      code: 'APPROVAL_REQUIRES_ADMIN_ROLE',
      path: 'proposedApproverRole',
      message: 'Approval requires the admin role',
    });
  }
  sortDiagnostics(diagnostics);
  const compileErrorCount = diagnostics.filter(
    (diagnostic) => diagnostic.kind === 'compileError',
  ).length;
  const policyDenialCount = diagnostics.filter(
    (diagnostic) => diagnostic.kind === 'policyDenial',
  ).length;
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.kind === 'warning').length;
  const approvalRequirementCount = diagnostics.filter(
    (diagnostic) => diagnostic.kind === 'approvalRequirement',
  ).length;

  return {
    diagnostics,
    decision: {
      approvable: diagnostics.length === 0,
      compileErrorCount,
      policyDenialCount,
      warningCount,
      blockingWarningCount: warningCount,
      approvalRequirementCount,
      recomputedIrHash,
      policyVersion: validationPolicy?.policy_version ?? 'unavailable',
      projectionFingerprint: projection.fingerprint,
    },
  };
}
