import type { Pool } from 'pg';
import { z } from 'zod';

import { readPlannerCapabilityProjection } from './capability-catalog.js';
import { saveWorkflowCatalogVersion } from './workflow-catalog.js';
import { buildWorkflowReview } from './workflow-console.js';
import { compileWorkflowSource, type WorkflowSourceDiagnostic } from './workflow-source.js';

const id = z.string().trim().min(1).max(200);
const position = z.strictObject({ x: z.number().finite(), y: z.number().finite() });

// A working draft may be incomplete, but still has bounded JSON storage.
const boundedJson = z.unknown().superRefine((value, context) => {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++count > 20_000 || current.depth > 32) {
      context.addIssue({ code: 'custom', message: 'Draft is too large or deeply nested' });
      return;
    }
    if (current.value && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) {
        pending.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > 256 * 1024) {
    context.addIssue({ code: 'custom', message: 'Draft must be at most 256 KiB' });
  }
});

export const workflowEditorDocumentSchema = boundedJson.pipe(
  z.strictObject({
    executable: z
      .unknown()
      .refine((value) => value !== undefined, 'Workflow definition is required'),
    layout: z.record(id, position).refine((value) => Object.keys(value).length <= 256),
    labels: z.record(id, z.string().max(200)).refine((value) => Object.keys(value).length <= 256),
    notes: z.array(z.strictObject({ id, text: z.string().max(4000), ...position.shape })).max(100),
    trigger: z.strictObject({ type: z.enum(['manual', 'webhook']) }),
  }),
);

export const workflowEditorScopeSchema = z.strictObject({ organizationId: id, environmentId: id });
export const workflowEditorSaveSchema = workflowEditorScopeSchema.extend({
  name: z.string().trim().min(1).max(200),
  expectedRevision: z.number().int().min(1).nullable(),
  document: workflowEditorDocumentSchema,
});
export const workflowEditorVersionSchema = workflowEditorScopeSchema.extend({
  expectedRevision: z.number().int().min(1),
  projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const workflowEditorValidationSchema = workflowEditorScopeSchema.extend({
  document: workflowEditorDocumentSchema,
  projectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export class WorkflowEditorDraftNotFound extends Error {}
export class WorkflowEditorDraftConflict extends Error {}
export class WorkflowEditorCompilationFailed extends Error {
  constructor(readonly diagnostics: readonly WorkflowSourceDiagnostic[]) {
    super('The workflow definition needs changes before it can be validated');
  }
}

interface DraftRow {
  workflow_id: string;
  name: string;
  revision: number;
  document: z.infer<typeof workflowEditorDocumentSchema>;
  updated_at: Date;
}

function draftResponse(row: DraftRow) {
  return {
    workflowId: row.workflow_id,
    name: row.name,
    revision: row.revision,
    document: row.document,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listWorkflowEditorDrafts(
  pool: Pick<Pool, 'query'>,
  scope: z.infer<typeof workflowEditorScopeSchema>,
) {
  const result = await pool.query<Omit<DraftRow, 'document'>>(
    `SELECT workflow_id, name, revision, updated_at FROM workflow_editor_drafts
     WHERE organization_id = $1 AND environment_id = $2
     ORDER BY updated_at DESC, workflow_id LIMIT 100`,
    [scope.organizationId, scope.environmentId],
  );
  return {
    drafts: result.rows.map((row) => ({
      workflowId: row.workflow_id,
      name: row.name,
      revision: row.revision,
      updatedAt: row.updated_at.toISOString(),
    })),
  };
}

export async function readWorkflowEditorDraft(
  pool: Pick<Pool, 'query'>,
  scope: z.infer<typeof workflowEditorScopeSchema> & { workflowId: string },
) {
  id.parse(scope.workflowId);
  const result = await pool.query<DraftRow>(
    `SELECT workflow_id, name, revision, document, updated_at FROM workflow_editor_drafts
     WHERE organization_id = $1 AND environment_id = $2 AND workflow_id = $3`,
    [scope.organizationId, scope.environmentId, scope.workflowId],
  );
  const row = result.rows[0];
  if (!row)
    throw new WorkflowEditorDraftNotFound('Working draft was not found in this environment');
  return draftResponse(row);
}

export async function saveWorkflowEditorDraft(
  pool: Pick<Pool, 'query'>,
  input: z.infer<typeof workflowEditorSaveSchema> & { workflowId: string },
) {
  id.parse(input.workflowId);
  const values = [
    input.organizationId,
    input.environmentId,
    input.workflowId,
    input.name,
    input.document,
  ];
  const result =
    input.expectedRevision === null
      ? await pool.query<DraftRow>(
          `INSERT INTO workflow_editor_drafts (organization_id, environment_id, workflow_id, name, document)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, environment_id, workflow_id) DO NOTHING
         RETURNING workflow_id, name, revision, document, updated_at`,
          values,
        )
      : await pool.query<DraftRow>(
          `UPDATE workflow_editor_drafts SET name = $4, document = $5,
           revision = revision + 1, updated_at = current_timestamp
         WHERE organization_id = $1 AND environment_id = $2 AND workflow_id = $3 AND revision = $6
         RETURNING workflow_id, name, revision, document, updated_at`,
          [...values, input.expectedRevision],
        );
  const row = result.rows[0];
  if (!row)
    throw new WorkflowEditorDraftConflict('This draft changed. Reload it before saving again.');
  return draftResponse(row);
}

export async function createWorkflowEditorVersion(
  pool: Pool,
  input: z.infer<typeof workflowEditorVersionSchema> & { workflowId: string },
) {
  const saved = await readWorkflowEditorDraft(pool, input);
  if (saved.revision !== input.expectedRevision) {
    throw new WorkflowEditorDraftConflict(
      'This draft changed. Reload it before creating a version.',
    );
  }
  const { draft, review } = await validateWorkflowEditorDocument(pool, {
    ...input,
    document: saved.document,
  });
  await saveWorkflowCatalogVersion(
    pool,
    {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workflowId: input.workflowId,
      name: saved.name,
      status: 'draft',
      draft,
    },
    input.expectedRevision,
  );
  return { draft, review, workflowId: input.workflowId, name: saved.name };
}

export async function validateWorkflowEditorDocument(
  pool: Pool,
  input: z.infer<typeof workflowEditorValidationSchema> & { workflowId: string },
) {
  id.parse(input.workflowId);
  const projection = await readPlannerCapabilityProjection(
    pool,
    input.organizationId,
    input.environmentId,
  );
  if (projection.fingerprint !== input.projectionFingerprint) {
    throw new WorkflowEditorDraftConflict(
      'Available capabilities changed. Refresh before validating the workflow.',
    );
  }
  const compilation = await compileWorkflowSource(input.document.executable, {
    organizationId: input.organizationId,
    workflowVersionId: input.workflowId,
    projection,
  });
  if (!compilation.success) throw new WorkflowEditorCompilationFailed(compilation.diagnostics);
  // Only executable content determines version identity. Canvas edits reuse existing checks.
  const workflowVersionId = `${input.workflowId}@builder-${compilation.workflow.irHash}`;
  const draft = {
    ...compilation.workflow,
    workflowVersionId,
    executionRequirements: { ...compilation.workflow.executionRequirements, workflowVersionId },
  };
  const review = await buildWorkflowReview(pool, {
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    projectionFingerprint: input.projectionFingerprint,
    draft,
  });
  return { workflowId: input.workflowId, draft, review };
}
