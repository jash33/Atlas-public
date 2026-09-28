import { z } from 'zod';

import { consoleConfig } from '../config.js';
import { consoleFetch, describeApiFailure } from '../shell/api.js';
import { createBuilderDocument, type BuilderDocument } from './builder-model.js';
import type { WorkflowReview } from './workflow.js';

export interface ManualWorkflowScope {
  organizationId: string;
  environmentId: string;
  workflowId: string;
}

const savedDocumentSchema = z.object({
  workflowId: z.string(),
  name: z.string(),
  revision: z.number().int().positive(),
  document: z.object({
    executable: z.unknown(),
    layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
    labels: z.record(z.string(), z.string()),
    notes: z.array(z.object({ id: z.string(), text: z.string(), x: z.number(), y: z.number() })),
    trigger: z.object({ type: z.enum(['manual', 'webhook']) }),
  }),
  updatedAt: z.string(),
});

export type SavedManualWorkflow = z.infer<typeof savedDocumentSchema>;

export interface ManualWorkflowVersion {
  workflowId: string;
  name: string;
  draft: Record<string, unknown>;
  review: WorkflowReview;
}

export type ManualWorkflowValidation = Omit<ManualWorkflowVersion, 'name'>;

export class ManualWorkflowValidationError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ stepId?: string; message: string }>,
  ) {
    super(message);
  }
}

function draftUrl(scope: ManualWorkflowScope) {
  return `${consoleConfig.backendUrl}/v1/workflow-editor-drafts/${encodeURIComponent(scope.workflowId)}`;
}

async function responseBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    if (response.status === 409) {
      throw new Error(
        typeof detail.message === 'string'
          ? detail.message
          : 'This draft changed in another session. Reload the saved draft before saving again.',
      );
    }
    if (response.status === 422 && Array.isArray(detail.diagnostics)) {
      const issues = detail.diagnostics.flatMap((value: unknown) => {
        if (
          !value ||
          typeof value !== 'object' ||
          !('message' in value) ||
          typeof value.message !== 'string'
        )
          return [];
        const stepId =
          'path' in value && typeof value.path === 'string'
            ? /steps\[([^\]]+)\]/.exec(value.path)?.[1]
            : undefined;
        return [{ message: value.message, ...(stepId ? { stepId } : {}) }];
      });
      throw new ManualWorkflowValidationError('Fix the issues below, then validate again.', issues);
    }
    throw new Error(describeApiFailure(response.status, body));
  }
  return body;
}

export async function loadManualWorkflow(
  scope: ManualWorkflowScope,
  signal: AbortSignal,
  token?: string,
) {
  const query = new URLSearchParams({
    organizationId: scope.organizationId,
    environmentId: scope.environmentId,
  });
  const response = await consoleFetch(`${draftUrl(scope)}?${query}`, {
    signal,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  if (response.status === 404) return undefined;
  return savedDocumentSchema.parse(await responseBody(response));
}

export async function saveManualWorkflow(
  scope: ManualWorkflowScope,
  input: { name: string; expectedRevision: number | null; document: BuilderDocument },
  token: string,
  signal: AbortSignal,
): Promise<SavedManualWorkflow> {
  const response = await consoleFetch(draftUrl(scope), {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: scope.organizationId,
      environmentId: scope.environmentId,
      ...input,
    }),
    signal,
  });
  return savedDocumentSchema.parse(await responseBody(response));
}

export async function createManualWorkflowVersion(
  scope: ManualWorkflowScope,
  input: { expectedRevision: number; projectionFingerprint: string },
  token: string,
  signal: AbortSignal,
): Promise<ManualWorkflowVersion> {
  const response = await consoleFetch(`${draftUrl(scope)}/versions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: scope.organizationId,
      environmentId: scope.environmentId,
      ...input,
    }),
    signal,
  });
  return (await responseBody(response)) as ManualWorkflowVersion;
}

export async function validateManualWorkflow(
  scope: ManualWorkflowScope,
  input: { document: BuilderDocument; projectionFingerprint: string },
  token: string,
  signal: AbortSignal,
): Promise<ManualWorkflowValidation> {
  const response = await consoleFetch(`${draftUrl(scope)}/validation`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      organizationId: scope.organizationId,
      environmentId: scope.environmentId,
      ...input,
    }),
    signal,
  });
  return (await responseBody(response)) as ManualWorkflowValidation;
}

/** Compare behavior without treating object key order or canvas positions as edits. */
export function workflowExecutableKey(executable: unknown): string {
  return JSON.stringify(sortedValue(executable));
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortedValue(child)]),
  );
}

export function mergeBuilderExecutable(
  document: BuilderDocument,
  executable: unknown,
): BuilderDocument {
  const imported = createBuilderDocument(executable);
  return { ...document, executable: imported.executable };
}

export function workflowEditSummary(before: unknown, after: unknown): string[] {
  const previous = stepRecords(before);
  const next = stepRecords(after);
  const changes: string[] = [];
  for (const [id, step] of next) {
    if (!previous.has(id)) changes.push(`Add ${id}`);
    else if (workflowExecutableKey(previous.get(id)) !== workflowExecutableKey(step)) {
      changes.push(`Change ${id}`);
    }
  }
  for (const id of previous.keys()) if (!next.has(id)) changes.push(`Remove ${id}`);
  if (changes.length === 0 && workflowExecutableKey(before) !== workflowExecutableKey(after)) {
    changes.push('Update workflow inputs or execution order');
  }
  return changes;
}

function stepRecords(value: unknown): Map<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || !('steps' in value) || !Array.isArray(value.steps)) {
    return new Map();
  }
  return new Map(
    value.steps.flatMap((step: unknown) =>
      step && typeof step === 'object' && 'id' in step && typeof step.id === 'string'
        ? [[step.id, step as Record<string, unknown>] as const]
        : [],
    ),
  );
}
