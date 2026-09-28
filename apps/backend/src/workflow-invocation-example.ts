import { randomUUID } from 'node:crypto';
import { objectSchemaSchema, validateWorkflowInput, type JsonValue } from '@atlas/workflow-ir';
import type { Pool } from 'pg';
import { z } from 'zod';

const inputReference = z.object({
  source: z.literal('input'),
  path: z.array(z.union([z.string(), z.number()])),
});
const executableSchema = z.object({
  inputSchema: objectSchemaSchema,
  steps: z.array(
    z
      .object({
        capabilityVersionId: z.string().optional(),
        idempotency: z.object({ businessKey: z.unknown() }).optional(),
      })
      .passthrough(),
  ),
});

/** Only explicitly safe fixtures from a passed check of this active version and execution target. */
export async function readWorkflowInvocationExample(
  pool: Pick<Pool, 'query'>,
  scope: { organizationId: string; environmentId: string; workflowVersionId: string },
): Promise<Record<string, JsonValue> | null> {
  if (scope.environmentId !== 'development') return null;
  const result = await pool.query<{
    executable: unknown;
    capability_version_id: string;
    inputs: unknown;
  }>(
    `SELECT approval.artifact_manifest->'workflow'->'executable' AS executable,
            version.capability_version_id, profile.inputs
     FROM workflow_approvals approval
     JOIN workflow_environment_versions active
       ON active.organization_id = approval.organization_id
      AND active.environment_id = approval.environment_id
      AND active.workflow_version_id = approval.workflow_version_id AND active.is_active
     JOIN LATERAL (
       SELECT target_bindings FROM workflow_sandbox_test_runs
       WHERE organization_id = approval.organization_id AND environment_id = approval.environment_id
         AND workflow_version_id = approval.workflow_version_id AND ir_hash = approval.ir_hash
         AND status = 'passed'
       ORDER BY tested_at DESC LIMIT 1
     ) tested ON true
     CROSS JOIN LATERAL jsonb_array_elements(tested.target_bindings) binding
     JOIN capability_versions version
       ON version.organization_id = approval.organization_id
      AND version.capability_version_id = binding->>'capabilityVersionId'
     JOIN capability_sandbox_target_revisions target
       ON target.organization_id = approval.organization_id
      AND target.environment_id = approval.environment_id
      AND target.capability_version_id = version.capability_version_id
      AND target.target_key = binding->>'targetKey'
      AND target.revision = (binding->>'targetRevision')::int
     JOIN capability_execution_bindings execution
       ON execution.organization_id = approval.organization_id
      AND execution.environment_id = approval.environment_id
      AND execution.capability_identity_id = version.capability_identity_id
      AND execution.base_url = target.base_url
     JOIN capability_test_data_profile_versions profile
       ON profile.organization_id = approval.organization_id
      AND profile.capability_version_id = version.capability_version_id
      AND profile.profile_key = binding->>'testDataProfileKey'
      AND profile.version = (binding->>'testDataVersion')::int
      AND profile.safe_for_non_production
     WHERE approval.organization_id = $1 AND approval.environment_id = $2
       AND approval.workflow_version_id = $3`,
    [scope.organizationId, scope.environmentId, scope.workflowVersionId],
  );
  const parsed = executableSchema.safeParse(result.rows[0]?.executable);
  if (!parsed.success) return null;
  const workflow = parsed.data;
  const capabilities = workflow.steps.flatMap((step) =>
    step.capabilityVersionId ? [step.capabilityVersionId] : [],
  );
  if (capabilities.some((id) => !result.rows.some((row) => row.capability_version_id === id)))
    return null;

  // Match the sandbox runner's workflow-level fixtures, but reject conflicts instead of guessing.
  const payload: Record<string, JsonValue> = {};
  for (const row of result.rows) {
    const inputs = z.record(z.string(), z.json()).safeParse(row.inputs);
    if (!inputs.success) return null;
    for (const name of Object.keys(workflow.inputSchema.required)) {
      if (!Object.hasOwn(inputs.data, name)) continue;
      const value = inputs.data[name]!;
      if (Object.hasOwn(payload, name) && JSON.stringify(payload[name]) !== JSON.stringify(value))
        return null;
      Object.defineProperty(payload, name, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  if (validateWorkflowInput(payload, workflow.inputSchema).length) return null;

  // A key used only for idempotency can be fresh. Never randomize a provider lookup ID.
  const providerInputs = new Set<string>();
  const collect = (value: unknown): void => {
    const ref = inputReference.safeParse(value);
    if (ref.success) providerInputs.add(String(ref.data.path[0]));
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  for (const { idempotency: _idempotency, ...step } of workflow.steps) collect(step);
  const freshKeys = new Set<string>();
  for (const step of workflow.steps) {
    const ref = inputReference.safeParse(step.idempotency?.businessKey);
    if (ref.success && ref.data.path.length === 1) {
      const name = String(ref.data.path[0]);
      if (!providerInputs.has(name) && typeof payload[name] === 'string') freshKeys.add(name);
    }
  }
  for (const name of freshKeys) payload[name] = `demo-${randomUUID()}`;
  return payload;
}
