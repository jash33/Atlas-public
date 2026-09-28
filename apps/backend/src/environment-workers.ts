import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';

import { workerIrReadiness } from './workflow-activation-readiness.js';

export const environmentWorkerDeclarationSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
    workerId: z.string().min(1),
    runCommandPublicKey: z.string().min(1).optional(),
    supportedIrVersions: z
      .object({
        minimum: z.number().int().positive(),
        maximum: z.number().int().positive(),
      })
      .refine(({ minimum, maximum }) => maximum >= minimum, {
        message: 'maximum IR version must be at least the minimum',
      }),
  })
  .strict();

export class WorkerIrVersionUnsupported extends Error {
  readonly code = 'worker-ir-version-unsupported';
}

export async function declareEnvironmentWorker(pool: Pool, input: unknown) {
  const declaration = environmentWorkerDeclarationSchema.parse(input);
  await pool.query(
    `INSERT INTO environment_workers
       (organization_id, environment_id, worker_id, minimum_ir_version, maximum_ir_version,
        run_command_public_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, environment_id, worker_id) DO UPDATE
       SET minimum_ir_version = EXCLUDED.minimum_ir_version,
         maximum_ir_version = EXCLUDED.maximum_ir_version,
         run_command_public_key = COALESCE(EXCLUDED.run_command_public_key,
           environment_workers.run_command_public_key),
         declared_at = current_timestamp`,
    [
      declaration.organizationId,
      declaration.environmentId,
      declaration.workerId,
      declaration.supportedIrVersions.minimum,
      declaration.supportedIrVersions.maximum,
      declaration.runCommandPublicKey ?? null,
    ],
  );
  return declaration;
}

export async function assertEnvironmentWorkersSupportIr(
  client: PoolClient,
  organizationId: string,
  environmentId: string,
  irVersion: number,
) {
  const workers = await client.query<{
    worker_id: string;
    minimum_ir_version: number;
    maximum_ir_version: number;
  }>(
    `SELECT worker_id, minimum_ir_version, maximum_ir_version
     FROM environment_workers
     WHERE organization_id = $1 AND environment_id = $2
     ORDER BY worker_id
     FOR SHARE`,
    [organizationId, environmentId],
  );
  const readiness = workerIrReadiness(
    workers.rows.map((worker) => ({
      workerId: worker.worker_id,
      minimumIrVersion: worker.minimum_ir_version,
      maximumIrVersion: worker.maximum_ir_version,
    })),
    irVersion,
    environmentId,
  );
  if (readiness.blockers[0]) {
    throw new WorkerIrVersionUnsupported(readiness.blockers[0].message);
  }
}
