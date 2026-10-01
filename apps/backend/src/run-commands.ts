import { encryptedRunCommandPattern } from '@atlas/run-command-encryption';
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import { z } from 'zod';
import { responseSchemaSchema as objectSchemaSchema, type ObjectSchema } from '@atlas/workflow-ir';
import { readWorkflowCapabilityLossProtection } from './capability-loss-protection.js';
import { resolveWorkflowIdentityByName } from './workflow-catalog.js';

export const queueWebhookRunCommandSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    deliveryId: z.string().trim().min(1).max(255),
    payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    encryptedPayload: z.string().regex(encryptedRunCommandPattern),
    workflowId: z.string().min(1).optional(),
  })
  .strict();

export const queueApiRunCommandSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    workflowId: z.string().min(1),
    idempotencyKey: z.string().trim().min(1).max(255),
    payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    encryptedPayload: z.string().regex(encryptedRunCommandPattern),
  })
  .strict();

export const apiRunReadinessQuerySchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    workflowName: z.string().trim().min(1),
  })
  .strict();

export const webhookRunReadinessQuerySchema = z.strictObject({
  organizationId: z.string().min(1),
  environmentId: z.string().min(1),
  workflowId: z.string().min(1),
});

export const webhookDeliveryQuerySchema = webhookRunReadinessQuerySchema.extend({
  deliveryId: z.string().trim().min(1).max(255),
  payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Trigger types that share delivery-id dedup + payload-fingerprint conflict semantics. */
export const deliveryTriggeredRunTypes = ['webhook', 'api'] as const;
export type DeliveryTriggeredRunType = (typeof deliveryTriggeredRunTypes)[number];
const missingInputSchemaBlocker =
  'The active workflow does not declare an input schema for intake validation.';

export const queueDeliveryTriggeredRunCommandSchema = queueWebhookRunCommandSchema
  .extend({
    triggerType: z.enum(deliveryTriggeredRunTypes),
  })
  .strict();

export const runCommandResultSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    status: z.enum(['completed', 'failed']),
    error: z
      .enum(['run-start-failed', 'conflicting-run-input', 'invalid-trigger-payload'])
      .optional(),
    workflowRunId: z.string().min(1).optional(),
    intakeStatus: z.enum(['accepted', 'duplicate', 'conflict']).optional(),
    errorDetails: z
      .object({
        issues: z
          .array(z.object({ path: z.string().min(1), message: z.string().min(1) }).strict())
          .min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export class WebhookRunUnavailable extends Error {
  constructor(readonly blockers: readonly string[]) {
    super(blockers[0] ?? 'Webhook run intake is unavailable');
  }
}

export class WebhookDeliveryConflict extends Error {}

export class ApiWorkflowNameNotFound extends Error {}

export class ApiWorkflowNameAmbiguous extends Error {
  constructor(readonly workflowIds: readonly string[]) {
    super('Workflow name is ambiguous');
  }
}

async function readDeliveryCommand(
  pool: Pick<Pool, 'query'>,
  input: {
    organizationId: string;
    environmentId: string;
    deliveryId: string;
    triggerType: 'api' | 'webhook';
  },
) {
  const result = await pool.query<{
    command_id: string;
    status: 'queued' | 'dispatched' | 'completed' | 'failed';
    trigger_payload_fingerprint: string;
    workflow_id: string | null;
  }>(
    `SELECT command.command_id, command.status, command.trigger_payload_fingerprint,
            (SELECT approval.workflow_id FROM workflow_approvals approval
             WHERE approval.organization_id = command.organization_id
               AND approval.environment_id = command.environment_id
               AND approval.artifact_id = command.artifact_id
             ORDER BY approval.approved_at DESC LIMIT 1) AS workflow_id
     FROM workflow_run_commands command
     WHERE command.organization_id = $1 AND command.environment_id = $2
       AND command.trigger_type = $4 AND command.trigger_delivery_id = $3`,
    [input.organizationId, input.environmentId, input.deliveryId, input.triggerType],
  );
  return result.rows[0];
}

function repeatedDelivery(
  prior: NonNullable<Awaited<ReturnType<typeof readDeliveryCommand>>>,
  input: { workflowId?: string | undefined; payloadFingerprint: string },
) {
  if (input.workflowId && prior.workflow_id !== input.workflowId) {
    throw new WebhookDeliveryConflict('A delivery ID cannot identify different workflows');
  }
  if (prior.trigger_payload_fingerprint.trim() !== input.payloadFingerprint) {
    throw new WebhookDeliveryConflict('A delivery ID cannot identify different payloads');
  }
  return { commandId: prior.command_id, status: prior.status, duplicate: true as const };
}

export async function readWebhookDelivery(
  pool: Pick<Pool, 'query'>,
  input: z.infer<typeof webhookDeliveryQuerySchema>,
) {
  const prior = await readDeliveryCommand(pool, { ...input, triggerType: 'webhook' });
  return prior ? repeatedDelivery(prior, input) : undefined;
}

export async function queueWebhookRunCommand(
  pool: Pool,
  input: z.infer<typeof queueWebhookRunCommandSchema>,
) {
  return queueDeliveryTriggeredRunCommand(pool, { ...input, triggerType: 'webhook' });
}

export async function queueApiRunCommand(
  pool: Pool,
  input: z.infer<typeof queueApiRunCommandSchema>,
) {
  return queueDeliveryTriggeredRunCommand(pool, {
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    deliveryId: input.idempotencyKey,
    payloadFingerprint: input.payloadFingerprint,
    encryptedPayload: input.encryptedPayload,
    workflowId: input.workflowId,
    triggerType: 'api',
  });
}

export async function queueDeliveryTriggeredRunCommand(
  pool: Pool,
  input: z.infer<typeof queueDeliveryTriggeredRunCommandSchema>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${input.organizationId}|${input.environmentId}|${input.deliveryId}`,
    ]);
    const prior = await readDeliveryCommand(client, input);
    if (prior) {
      const repeated = repeatedDelivery(prior, input);
      await client.query('COMMIT');
      return repeated;
    }

    const readiness = await readRunIntakeReadiness(client, {
      organizationId: input.organizationId,
      environmentId: input.environmentId,
      workflowId: input.workflowId,
    });
    if (
      !readiness.ready ||
      !readiness.targetWorkerId ||
      !readiness.artifactId ||
      !readiness.runCommandPublicKey
    ) {
      throw new WebhookRunUnavailable(readiness.blockers);
    }
    const inputSchema = await readArtifactInputSchema(client, input, readiness.artifactId);
    if (!inputSchema) {
      throw new WebhookRunUnavailable([missingInputSchemaBlocker]);
    }
    const commandId = randomUUID();
    await client.query(
      `INSERT INTO workflow_run_commands
        (command_id, organization_id, environment_id, target_worker_id, artifact_id,
         encrypted_payload, trigger_type, trigger_delivery_id, trigger_payload_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        commandId,
        input.organizationId,
        input.environmentId,
        readiness.targetWorkerId,
        readiness.artifactId,
        input.encryptedPayload,
        input.triggerType,
        input.deliveryId,
        input.payloadFingerprint,
      ],
    );
    await client.query('COMMIT');
    return { commandId, status: 'queued' as const, duplicate: false as const };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimNextRunCommand(
  pool: Pool,
  scope: {
    readonly organizationId: string;
    readonly environmentId: string;
    readonly workerId: string;
  },
) {
  const result = await pool.query<{
    command_id: string;
    encrypted_payload: string;
    artifact_id: string;
    workflow_id: string | null;
    workflow_name: string | null;
    trigger_type: 'manual' | 'webhook' | 'schedule' | 'api';
    trigger_delivery_id: string | null;
    trigger_schedule_id: string | null;
    trigger_scheduled_for: Date | null;
    input_schema: unknown;
  }>(
    `UPDATE workflow_run_commands command
     SET status = 'dispatched', claimed_at = current_timestamp
     WHERE command_id = (
       SELECT command_id
       FROM workflow_run_commands
       WHERE organization_id = $1
         AND environment_id = $2
         AND target_worker_id = $3
         AND (status = 'queued' OR (status = 'dispatched' AND claimed_at < current_timestamp - interval '30 seconds'))
         AND NOT EXISTS (
           SELECT 1
           FROM workflow_approvals approval
           JOIN confirmed_workflow_capability_losses loss
             ON loss.organization_id = approval.organization_id
            AND loss.environment_id = approval.environment_id
            AND loss.workflow_version_id = approval.workflow_version_id
           WHERE approval.organization_id = workflow_run_commands.organization_id
             AND approval.environment_id = workflow_run_commands.environment_id
             AND approval.artifact_id = workflow_run_commands.artifact_id
             AND NOT EXISTS (
               SELECT 1 FROM active_workflow_capability_loss_overrides override
               WHERE override.organization_id = approval.organization_id
                 AND override.environment_id = approval.environment_id
                 AND override.workflow_version_id = approval.workflow_version_id
                 AND override.capability_version_id = loss.capability_version_id
             )
         )
       ORDER BY created_at, command_id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING command.command_id, command.encrypted_payload, command.artifact_id,
               command.trigger_type, command.trigger_delivery_id, command.trigger_schedule_id,
               command.trigger_scheduled_for,
               (SELECT approval.workflow_id
                FROM workflow_approvals approval
                WHERE approval.organization_id = command.organization_id
                  AND approval.environment_id = command.environment_id
                  AND approval.artifact_id = command.artifact_id
                ORDER BY approval.approved_at DESC
                LIMIT 1) AS workflow_id,
               (SELECT identity.name
                FROM workflow_approvals approval
                JOIN workflow_identities identity
                  ON identity.organization_id = approval.organization_id
                 AND identity.workflow_id = approval.workflow_id
                WHERE approval.organization_id = command.organization_id
                  AND approval.environment_id = command.environment_id
                  AND approval.artifact_id = command.artifact_id
                ORDER BY approval.approved_at DESC
                LIMIT 1) AS workflow_name,
               (SELECT approval.artifact_manifest->'workflow'->'executable'->'inputSchema'
                FROM workflow_approvals approval
                WHERE approval.organization_id = command.organization_id
                  AND approval.environment_id = command.environment_id
                  AND approval.artifact_id = command.artifact_id
                ORDER BY approval.approved_at DESC
                LIMIT 1) AS input_schema`,
    [scope.organizationId, scope.environmentId, scope.workerId],
  );
  const command = result.rows[0];
  return command
    ? {
        commandId: command.command_id,
        encryptedPayload: command.encrypted_payload,
        artifactId: command.artifact_id.trim(),
        ...(command.workflow_id ? { workflowId: command.workflow_id } : {}),
        workflowName: command.workflow_name ?? '',
        trigger:
          command.trigger_type === 'webhook'
            ? { type: 'webhook' as const, deliveryId: command.trigger_delivery_id! }
            : command.trigger_type === 'api'
              ? { type: 'api' as const, deliveryId: command.trigger_delivery_id! }
              : command.trigger_type === 'schedule'
                ? {
                    type: 'schedule' as const,
                    scheduleId: command.trigger_schedule_id!,
                    scheduledFor: command.trigger_scheduled_for!.toISOString(),
                  }
                : { type: 'manual' as const },
        inputSchema:
          command.input_schema === null
            ? undefined
            : objectSchemaSchema.parse(command.input_schema),
      }
    : undefined;
}

export async function recordRunCommandResult(
  pool: Pool,
  commandId: string,
  input: z.infer<typeof runCommandResultSchema>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE workflow_run_commands
       SET status = $4, completed_at = current_timestamp, error = $5,
           workflow_run_id = $6, intake_status = $7, error_details = $8
       WHERE command_id = $1 AND organization_id = $2 AND environment_id = $3
         AND status = 'dispatched'`,
      [
        commandId,
        input.organizationId,
        input.environmentId,
        input.status,
        input.error ?? null,
        input.workflowRunId ?? null,
        input.intakeStatus ?? null,
        input.errorDetails ?? null,
      ],
    );
    if ((result.rowCount ?? 0) > 0 && input.intakeStatus === 'duplicate' && input.workflowRunId) {
      await client.query(
        `UPDATE workflow_runs
         SET duplicate_submission_count = duplicate_submission_count + 1
         WHERE organization_id = $1 AND environment_id = $2 AND run_id = $3`,
        [input.organizationId, input.environmentId, input.workflowRunId],
      );
    }
    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function readRunIntakeReadiness(
  pool: Pick<Pool, 'query'>,
  scope: {
    readonly organizationId: string;
    readonly environmentId: string;
    readonly workflowVersionId?: string | undefined;
    readonly workflowId?: string | undefined;
  },
) {
  const result = await pool.query<{
    workflow_version_id: string | null;
    artifact_id: string | null;
    ir_version: number | null;
    run_command_public_key: string | null;
    worker_id: string | null;
  }>(
    `SELECT approval.workflow_version_id, approval.artifact_id,
            CASE
              WHEN jsonb_typeof(approval.artifact_manifest->'workflow'->'executable'->'irVersion')
                = 'number'
              THEN (approval.artifact_manifest->'workflow'->'executable'->>'irVersion')::integer
              ELSE NULL
            END AS ir_version,
            worker.run_command_public_key, worker.worker_id
     FROM environments environment
     LEFT JOIN workflow_approvals approval
       ON approval.organization_id = environment.organization_id
      AND approval.environment_id = environment.id
      AND approval.lifecycle_status = 'current'
      AND ($3::text IS NULL OR approval.workflow_version_id = $3)
      AND ($4::text IS NULL OR approval.workflow_id = $4)
     LEFT JOIN LATERAL (
       SELECT run_command_public_key, worker_id
       FROM environment_workers
       WHERE organization_id = environment.organization_id
         AND environment_id = environment.id
         AND run_command_public_key IS NOT NULL
         AND CASE
               WHEN jsonb_typeof(
                 approval.artifact_manifest->'workflow'->'executable'->'irVersion'
               ) = 'number'
               THEN (approval.artifact_manifest->'workflow'->'executable'->>'irVersion')::integer
                    BETWEEN minimum_ir_version AND maximum_ir_version
               ELSE false
             END
       ORDER BY declared_at DESC, worker_id
       LIMIT 1
     ) worker ON true
     WHERE environment.organization_id = $1 AND environment.id = $2
     ORDER BY approval.approved_at DESC NULLS LAST
     LIMIT 1`,
    [
      scope.organizationId,
      scope.environmentId,
      scope.workflowVersionId ?? null,
      scope.workflowId ?? null,
    ],
  );
  const row = result.rows[0];
  const blockers: string[] = [];
  if (!row?.workflow_version_id) blockers.push('No active workflow is available for new runs.');
  if (row?.workflow_version_id && !row.artifact_id) {
    blockers.push('The active workflow does not have a tested executable artifact.');
  }
  if (row?.artifact_id && row.ir_version === null) {
    blockers.push('The active tested workflow artifact does not declare an IR version.');
  } else if (row?.artifact_id && !row?.run_command_public_key) {
    blockers.push(
      `No customer worker in environment '${scope.environmentId}' supports workflow IR version ${row.ir_version}.`,
    );
  } else if (!row?.run_command_public_key) {
    blockers.push('No customer worker is ready to receive encrypted run input.');
  }
  const protection = row?.workflow_version_id
    ? await readWorkflowCapabilityLossProtection(pool, {
        organizationId: scope.organizationId,
        environmentId: scope.environmentId,
        workflowVersionId: row.workflow_version_id,
      })
    : { allowed: true, blockers: [], warnings: [], removedCapabilityVersionIds: [] };
  blockers.push(...protection.blockers);
  return {
    ready: blockers.length === 0,
    workflowVersionId: row?.workflow_version_id ?? null,
    artifactId: row?.artifact_id?.trim() ?? null,
    runCommandPublicKey: row?.run_command_public_key ?? null,
    targetWorkerId: row?.worker_id ?? null,
    blockers,
    ...(protection.warnings.length > 0 ? { warnings: protection.warnings } : {}),
    ...(protection.removedCapabilityVersionIds.length > 0
      ? { removedCapabilityVersionIds: protection.removedCapabilityVersionIds }
      : {}),
  };
}

export async function readApiRunReadinessByName(
  pool: Pick<Pool, 'query'>,
  scope: z.infer<typeof apiRunReadinessQuerySchema>,
) {
  const resolution = await resolveWorkflowIdentityByName(pool, {
    organizationId: scope.organizationId,
    name: scope.workflowName,
  });
  if (resolution.status === 'none') throw new ApiWorkflowNameNotFound();
  if (resolution.status === 'ambiguous') {
    throw new ApiWorkflowNameAmbiguous(resolution.workflowIds);
  }
  const readiness = await readRunIntakeReadiness(pool, {
    organizationId: scope.organizationId,
    environmentId: scope.environmentId,
    workflowId: resolution.workflowId,
  });
  const inputSchema = readiness.artifactId
    ? await readArtifactInputSchema(
        pool,
        { organizationId: scope.organizationId, environmentId: scope.environmentId },
        readiness.artifactId,
      )
    : undefined;
  const blockers = [
    ...readiness.blockers,
    ...(readiness.ready && !inputSchema ? [missingInputSchemaBlocker] : []),
  ];
  return {
    workflowId: resolution.workflowId,
    name: resolution.name,
    ready: blockers.length === 0,
    workflowVersionId: readiness.workflowVersionId,
    artifactId: readiness.artifactId,
    targetWorkerId: readiness.targetWorkerId,
    runCommandPublicKey: readiness.runCommandPublicKey,
    inputSchema: inputSchema ?? null,
    blockers,
    ...('warnings' in readiness && readiness.warnings ? { warnings: readiness.warnings } : {}),
    ...('removedCapabilityVersionIds' in readiness && readiness.removedCapabilityVersionIds
      ? { removedCapabilityVersionIds: readiness.removedCapabilityVersionIds }
      : {}),
  };
}

export async function readWebhookRunReadiness(
  pool: Pick<Pool, 'query'>,
  scope: z.infer<typeof webhookRunReadinessQuerySchema>,
) {
  const identity = await pool.query<{ name: string }>(
    `SELECT name FROM workflow_identities WHERE organization_id = $1 AND workflow_id = $2`,
    [scope.organizationId, scope.workflowId],
  );
  if (!identity.rows[0]) throw new ApiWorkflowNameNotFound();
  const readiness = await readRunIntakeReadiness(pool, scope);
  const inputSchema = readiness.artifactId
    ? await readArtifactInputSchema(pool, scope, readiness.artifactId)
    : undefined;
  const blockers = [
    ...readiness.blockers,
    ...(readiness.ready && !inputSchema ? [missingInputSchemaBlocker] : []),
  ];
  return {
    ...readiness,
    workflowId: scope.workflowId,
    name: identity.rows[0].name,
    ready: blockers.length === 0,
    inputSchema: inputSchema ?? null,
    blockers,
  };
}

async function readArtifactInputSchema(
  pool: Pick<Pool, 'query'>,
  scope: { readonly organizationId: string; readonly environmentId: string },
  artifactId: string,
): Promise<ObjectSchema | undefined> {
  const result = await pool.query<{ input_schema: unknown }>(
    `SELECT artifact_manifest->'workflow'->'executable'->'inputSchema' AS input_schema
     FROM workflow_approvals
     WHERE organization_id = $1 AND environment_id = $2 AND artifact_id = $3
     ORDER BY approved_at DESC
     LIMIT 1`,
    [scope.organizationId, scope.environmentId, artifactId],
  );
  const value = result.rows[0]?.input_schema;
  return value === null || value === undefined ? undefined : objectSchemaSchema.parse(value);
}

export async function readRunCommand(
  pool: Pool,
  commandId: string,
  scope: { readonly organizationId: string; readonly environmentId: string },
) {
  const result = await pool.query<{
    status: 'queued' | 'dispatched' | 'completed' | 'failed';
    error: string | null;
    workflow_run_id: string | null;
    intake_status: 'accepted' | 'duplicate' | 'conflict' | null;
    error_details: unknown;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT status, error, error_details, workflow_run_id, intake_status, created_at, completed_at
     FROM workflow_run_commands
     WHERE command_id = $1 AND organization_id = $2 AND environment_id = $3`,
    [commandId, scope.organizationId, scope.environmentId],
  );
  const row = result.rows[0];
  return row
    ? {
        commandId,
        status: row.status,
        error: row.error,
        workflowRunId: row.workflow_run_id,
        intakeStatus: row.intake_status,
        errorDetails: row.error_details,
        createdAt: row.created_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
      }
    : undefined;
}
