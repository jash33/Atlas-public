import { parse as parseYaml } from 'yaml';

const sandboxOperationIds = new Set(['resetSandbox']);
const stepOutputPattern = /\$steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g;

export type ArazzoRelationshipKind = 'data-flow' | 'execution-order';

export interface ParsedArazzoRelationship {
  kind: ArazzoRelationshipKind;
  workflowId: string;
  workflowName: string;
  sourceOperationId: string;
  targetOperationId: string;
  sourceStepId: string;
  targetStepId: string;
  destinationField?: string;
}

export interface ParsedArazzoWorkflow {
  workflowId: string;
  summary: string;
  description?: string;
}

export interface ParsedArazzoDocument {
  version: string;
  title: string;
  workflows: ParsedArazzoWorkflow[];
  relationships: ParsedArazzoRelationship[];
}

interface ArazzoStep {
  stepId: string;
  operationId: string;
  parameters?: unknown;
  requestBody?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Arazzo document is missing ${label}`);
  }
  return value.trim();
}

export function arazzoUrlBesideOpenApi(openApiUrl: string): string {
  const url = new URL(openApiUrl);
  if (/\/openapi\.json$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/openapi\.json$/i, '/arazzo.yaml');
    return url.href;
  }
  const directory = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${directory}arazzo.yaml`;
  return url.href;
}

function collectStepOutputReferences(
  value: unknown,
  onMatch: (stepId: string, outputName: string, field: string | undefined) => void,
  field?: string,
) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(stepOutputPattern)) {
      onMatch(match[1]!, match[2]!, field);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStepOutputReferences(entry, onMatch, field);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  if (typeof record.name === 'string' && 'value' in record) {
    collectStepOutputReferences(record.value, onMatch, record.name);
    return;
  }
  for (const [key, entry] of Object.entries(record)) {
    collectStepOutputReferences(entry, onMatch, key);
  }
}

function parseStep(value: unknown, workflowId: string): ArazzoStep {
  const step = asRecord(value);
  if (!step) throw new Error(`Arazzo workflow ${workflowId} has an invalid step`);
  return {
    stepId: requiredString(step.stepId, `a step id in ${workflowId}`),
    operationId: requiredString(step.operationId, `an operation id in ${workflowId}`),
    ...(step.parameters === undefined ? {} : { parameters: step.parameters }),
    ...(step.requestBody === undefined ? {} : { requestBody: step.requestBody }),
  };
}

export function parseArazzoDocument(text: string): ParsedArazzoDocument {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new Error('Arazzo document is not valid YAML');
  }
  const document = asRecord(raw);
  if (!document) throw new Error('Arazzo document must be a YAML object');
  const version = requiredString(document.arazzo, 'an arazzo version');
  if (!/^1\.0\.\d+$/.test(version)) {
    throw new Error('Arazzo document must use Arazzo 1.0');
  }
  const info = asRecord(document.info) ?? {};
  const title = requiredString(info.title, 'info.title');
  if (!Array.isArray(document.workflows) || document.workflows.length === 0) {
    throw new Error('Arazzo document must include at least one workflow');
  }

  const workflows: ParsedArazzoWorkflow[] = [];
  const relationships: ParsedArazzoRelationship[] = [];
  for (const entry of document.workflows) {
    const workflow = asRecord(entry);
    if (!workflow) throw new Error('Arazzo document has an invalid workflow');
    const workflowId = requiredString(workflow.workflowId, 'a workflowId');
    const summary =
      typeof workflow.summary === 'string' && workflow.summary.trim()
        ? workflow.summary.trim()
        : workflowId;
    const description =
      typeof workflow.description === 'string' && workflow.description.trim()
        ? workflow.description.trim()
        : undefined;
    workflows.push({
      workflowId,
      summary,
      ...(description ? { description } : {}),
    });
    const steps = Array.isArray(workflow.steps)
      ? workflow.steps.map((step) => parseStep(step, workflowId))
      : [];
    const architecturalSteps = steps.filter((step) => !sandboxOperationIds.has(step.operationId));
    const stepById = new Map(architecturalSteps.map((step) => [step.stepId, step]));
    for (let index = 1; index < architecturalSteps.length; index += 1) {
      const source = architecturalSteps[index - 1]!;
      const target = architecturalSteps[index]!;
      if (source.operationId === target.operationId) continue;
      relationships.push({
        kind: 'execution-order',
        workflowId,
        workflowName: summary,
        sourceOperationId: source.operationId,
        targetOperationId: target.operationId,
        sourceStepId: source.stepId,
        targetStepId: target.stepId,
      });
    }
    for (const target of architecturalSteps) {
      collectStepOutputReferences(
        [target.parameters, asRecord(target.requestBody)?.payload ?? target.requestBody],
        (sourceStepId, _outputName, destinationField) => {
          const source = stepById.get(sourceStepId);
          if (!source || source.operationId === target.operationId) return;
          relationships.push({
            kind: 'data-flow',
            workflowId,
            workflowName: summary,
            sourceOperationId: source.operationId,
            targetOperationId: target.operationId,
            sourceStepId: source.stepId,
            targetStepId: target.stepId,
            ...(destinationField ? { destinationField } : {}),
          });
        },
      );
    }
  }

  return { version, title, workflows, relationships };
}
