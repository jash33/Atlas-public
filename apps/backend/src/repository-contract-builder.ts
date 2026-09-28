import { z } from 'zod';
import { repositoryServiceSchema } from './github-repository-source.js';
import { serviceEvidenceSchema } from './repository-service-discovery.js';

const objectSchema = z.record(z.string(), z.unknown());
export const codeEvidenceSchema = z
  .object({
    operationId: z.string().min(1),
    path: z.string().min(1),
    functionName: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    role: z.enum(['route', 'handler', 'validator', 'middleware', 'helper', 'database', 'example']),
    covers: z.array(z.enum(['request', 'response', 'route', 'relationship'])).min(1),
    quote: z.string().min(1),
  })
  .strict();
export const workflowEvidenceSchema = z
  .object({
    workflowId: z.string().min(1),
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    quote: z.string().min(1),
  })
  .strict();
export const extractedServiceSchema = z
  .object({
    serviceId: z.string().min(1),
    sourceRoot: repositoryServiceSchema.shape.root.optional(),
    serviceEvidence: z.array(serviceEvidenceSchema).min(1).max(6).optional(),
    openapi: objectSchema,
    arazzo: objectSchema.nullable(),
    evidence: z.array(codeEvidenceSchema).min(1),
    workflowEvidence: z.array(workflowEvidenceSchema),
    unresolvedQuestions: z.array(z.string().min(1)),
    dependenciesComplete: z.boolean(),
    inventory: z
      .object({ operationIds: z.array(z.string().min(1)), workflowIds: z.array(z.string().min(1)) })
      .strict()
      .optional(),
    supportingDocuments: z
      .array(
        z.object({ path: z.string(), sha: z.string(), verificationNotes: z.string() }).strict(),
      )
      .optional(),
  })
  .strict();
export const repositoryExtractionSchema = z
  .object({
    complete: z.boolean(),
    services: z.array(extractedServiceSchema).min(1),
  })
  .strict();
export type ExtractedRepositoryService = z.infer<typeof extractedServiceSchema>;
const draftSchema = repositoryExtractionSchema.extend({
  services: z
    .array(extractedServiceSchema.extend({ evidence: z.array(codeEvidenceSchema) }))
    .min(1),
});
// Keep the tool envelope strict even though OpenAPI has arbitrary property names.
const definitionSchema = z
  .string()
  .min(2)
  .max(12000)
  .describe(
    'One valid JSON object encoded as a string. Use named components for large shared definitions.',
  );
const sectionEvidenceSchema = codeEvidenceSchema.extend({ quote: z.string().min(1).max(400) });
const sectionWorkflowEvidenceSchema = workflowEvidenceSchema.extend({
  quote: z.string().min(1).max(400),
});

const operationsSchema = z
  .object({
    serviceId: z.string(),
    operations: z
      .array(
        z
          .object({
            path: z.string().startsWith('/'),
            method: z.enum(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']),
            definition: definitionSchema,
            evidence: z.array(sectionEvidenceSchema).min(1).max(12),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
const componentsSchema = z
  .object({
    serviceId: z.string(),
    components: z
      .array(
        z
          .object({
            kind: z.enum([
              'schemas',
              'parameters',
              'requestBodies',
              'responses',
              'headers',
              'securitySchemes',
            ]),
            name: z.string().min(1),
            definition: definitionSchema,
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
const workflowsSchema = z
  .object({
    serviceId: z.string(),
    workflows: z
      .array(
        z
          .object({
            definition: definitionSchema,
            evidence: z.array(sectionWorkflowEvidenceSchema).min(1).max(12),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict();
const reviewSchema = z
  .object({
    serviceId: z.string(),
    title: z.string().min(1),
    version: z.string().min(1),
    unresolvedQuestions: z.array(z.string().min(1)),
    dependenciesComplete: z.boolean(),
  })
  .strict();

const inventorySchema = z
  .object({
    serviceId: z.string(),
    operationIds: z.array(z.string().min(1)).min(1),
    workflowIds: z.array(z.string().min(1)),
  })
  .strict();

export const repositorySectionTools = [
  {
    name: 'write_service_inventory',
    schema: inventorySchema,
    description:
      'Record all operation IDs and supported workflow IDs identified in the source before finishing. Include every documented supported workflow even if it has not been written yet. Further calls can add IDs; they cannot remove earlier declarations. Atlas rejects missing definitions at completion.',
  },
  {
    name: 'write_operations',
    schema: operationsSchema,
    description:
      'Save up to three HTTP operations and their code citations. Encode each Operation Object as a JSON string in definition. Atlas places each under its separate path and method. Updates replace only the named operations. Do not include another path inside an Operation Object. Keep the whole call below 50,000 characters.',
  },
  {
    name: 'write_components',
    schema: componentsSchema,
    description:
      'Save up to five named OpenAPI components. Encode each definition as a JSON string. Reference them as #/components/schemas/Name (or the matching component kind). Atlas assembles the components object. Keep the whole call below 50,000 characters.',
  },
  {
    name: 'write_workflows',
    schema: workflowsSchema,
    description:
      'Save up to two complete supported Arazzo Workflow Objects, encoded as JSON strings in definition, and their source evidence. Include all steps, conditions, outputs and data mappings. Use direct operationId references and the OpenAPI source name api. Atlas assembles the Arazzo document.',
  },
  {
    name: 'write_service_review',
    schema: reviewSchema,
    description:
      'Set the title, version, unresolved questions and dependency completeness for a service. Required for every configured service before finishing. Does not approve anything.',
  },
].map(({ schema, ...definition }) => ({
  type: 'function',
  ...definition,
  strict: true,
  parameters: z.toJSONSchema(schema),
}));

export function createRepositoryContractDraft(serviceIds: string[]) {
  return {
    complete: false,
    services: serviceIds.map((serviceId) => ({
      serviceId,
      openapi: { openapi: '3.1.0', info: { title: serviceId, version: '1' }, paths: {} },
      arazzo: null,
      evidence: [],
      workflowEvidence: [],
      unresolvedQuestions: [],
      dependenciesComplete: false,
    })),
  };
}

function put(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
function objectField(target: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = Object.hasOwn(target, key) ? objectSchema.parse(target[key]) : {};
  put(target, key, value);
  return value;
}

/** Assemble bounded pieces without asking the model to repeat a service's entire document. */
export function writeRepositoryContractSection(
  document: unknown,
  toolName: string,
  input: unknown,
) {
  const draft = draftSchema.parse(structuredClone(document));
  const serviceId = z.object({ serviceId: z.string() }).parse(input).serviceId;
  const service = draft.services.find((entry) => entry.serviceId === serviceId);
  if (!service) throw new Error(`Unknown configured service: ${serviceId}`);
  if (JSON.stringify(input).length > 50000)
    throw new Error('Write smaller sections, at most 50,000 characters per call');
  if (toolName === 'write_service_inventory') {
    const inventory = inventorySchema.parse(input);
    service.inventory = {
      operationIds: [
        ...new Set([...(service.inventory?.operationIds ?? []), ...inventory.operationIds]),
      ],
      workflowIds: [
        ...new Set([...(service.inventory?.workflowIds ?? []), ...inventory.workflowIds]),
      ],
    };
  } else if (toolName === 'write_operations') {
    const { operations } = operationsSchema.parse(input);
    const paths = objectField(service.openapi, 'paths');
    for (const inputOperation of operations) {
      const operation = {
        ...inputOperation,
        definition: objectSchema.parse(JSON.parse(inputOperation.definition)),
      };
      const id = z.string().min(1).parse(operation.definition.operationId);
      if (operation.evidence.some((entry) => entry.operationId !== id))
        throw new Error(`Operation evidence must name ${id}`);
      if (Object.keys(operation.definition).some((key) => key.startsWith('/')))
        throw new Error('An operation cannot contain another HTTP path');
      const path = objectField(paths, operation.path);
      const previous = Object.hasOwn(path, operation.method)
        ? objectSchema.parse(path[operation.method]).operationId
        : undefined;
      put(path, operation.method, operation.definition);
      service.evidence = service.evidence
        .filter((entry) => entry.operationId !== previous && entry.operationId !== id)
        .concat(operation.evidence);
    }
  } else if (toolName === 'write_components') {
    const { components } = componentsSchema.parse(input);
    const target = objectField(service.openapi, 'components');
    for (const component of components)
      put(
        objectField(target, component.kind),
        component.name,
        objectSchema.parse(JSON.parse(component.definition)),
      );
  } else if (toolName === 'write_workflows') {
    const { workflows } = workflowsSchema.parse(input);
    service.arazzo ??= {
      arazzo: '1.0.0',
      info: { title: serviceId, version: '1' },
      sourceDescriptions: [{ name: 'api', url: 'openapi.json', type: 'openapi' }],
      workflows: [],
    };
    const saved = z.array(objectSchema).parse(service.arazzo.workflows);
    for (const inputWorkflow of workflows) {
      const workflow = {
        ...inputWorkflow,
        definition: objectSchema.parse(JSON.parse(inputWorkflow.definition)),
      };
      const id = z.string().min(1).parse(workflow.definition.workflowId);
      if (workflow.evidence.some((entry) => entry.workflowId !== id))
        throw new Error(`Workflow evidence must name ${id}`);
      const index = saved.findIndex((entry) => entry.workflowId === id);
      if (index < 0) saved.push(workflow.definition);
      else saved[index] = workflow.definition;
      service.workflowEvidence = service.workflowEvidence
        .filter((entry) => entry.workflowId !== id)
        .concat(workflow.evidence);
    }
    service.arazzo.workflows = saved;
  } else if (toolName === 'write_service_review') {
    const review = reviewSchema.parse(input);
    service.openapi.info = { title: review.title, version: review.version };
    service.unresolvedQuestions = review.unresolvedQuestions;
    service.dependenciesComplete = review.dependenciesComplete;
    if (service.arazzo) service.arazzo.info = { title: review.title, version: review.version };
  } else throw new Error('Unknown repository section tool');
  draft.complete = false;
  return draft;
}

export function repositoryDraftProgress(document: unknown) {
  const draft = draftSchema.parse(document);
  return draft.services.map((service) => ({
    serviceId: service.serviceId,
    operationIds: [...new Set(service.evidence.map((entry) => entry.operationId))],
    workflowIds: [...new Set(service.workflowEvidence.map((entry) => entry.workflowId))],
    componentNames: Object.entries(objectSchema.parse(service.openapi.components ?? {})).flatMap(
      ([kind, entries]) =>
        Object.keys(objectSchema.parse(entries)).map((name) => `${kind}/${name}`),
    ),
  }));
}
