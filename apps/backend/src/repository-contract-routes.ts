import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { MembershipAuthorizer } from './admin-suite.js';
import {
  acceptRepositoryContractCandidate,
  connectGithubRepository,
  rejectRepositoryContractCandidate,
  repositoryReviewSchema,
} from './github-repository-checks.js';
import { readRepositoryCatalog } from './repository-contract-catalog.js';
import { queuedRepositoryProgress } from './repository-analysis-progress.js';

export function repositoryContractRoutes(
  pool: Pool,
  authorizer: MembershipAuthorizer | undefined,
  configured: boolean,
) {
  const app = new Hono();
  app.use('/organizations/:organizationId/repositories/*', async (context, next) => {
    const actor = await authorizer?.authorize({
      authorizationHeader: context.req.header('authorization'),
      organizationId: context.req.param('organizationId')!,
      action: context.req.method === 'GET' ? 'view-organization' : 'connect-capability-source',
    });
    if (!actor) return context.json({ error: 'repository-access-denied' }, 403);
    await next();
  });
  // Hono also matches the collection itself with this middleware pattern.
  app.onError((error, context) =>
    context.json(
      {
        error: 'repository-request-failed',
        message:
          error instanceof z.ZodError
            ? error.issues.map((issue) => issue.message).join('; ')
            : error.message,
      },
      400,
    ),
  );
  app.get('/organizations/:organizationId/repositories', async (context) => {
    const organizationId = context.req.param('organizationId');
    const connections = await pool.query(
      `SELECT connection.*,
      coalesce((SELECT jsonb_agg(target ORDER BY target.target_key) FROM repository_analysis_targets target WHERE target.connection_id=connection.id),'[]') AS targets,
      coalesce((SELECT jsonb_agg(candidate ORDER BY candidate.created_at DESC) FROM
        (SELECT id,branch,commit_sha,kind,status,candidate_hash,created_at,reviewed_by,reviewed_at FROM repository_contract_candidates WHERE connection_id=connection.id ORDER BY created_at DESC LIMIT 100) candidate),'[]') AS candidates
      FROM github_repository_connections connection WHERE organization_id=$1 ORDER BY created_at`,
      [organizationId],
    );
    return context.json({
      configured,
      connections: connections.rows,
      catalog: await readRepositoryCatalog(pool, organizationId),
    });
  });
  app.post('/organizations/:organizationId/repositories', async (context) => {
    if (!configured)
      return context.json(
        {
          error: 'repository-analysis-not-configured',
          message: 'Configure the backend OpenAI key and model to analyze repository code',
        },
        503,
      );
    const organizationId = context.req.param('organizationId');
    const actor = await authorizer!.authorize({
      authorizationHeader: context.req.header('authorization'),
      organizationId,
      action: 'connect-capability-source',
    });
    if (!actor) return context.json({ error: 'repository-access-denied' }, 403);
    const input = z.record(z.string(), z.unknown()).parse(await context.req.json());
    return context.json(
      await connectGithubRepository(pool, { ...input, organizationId }, actor.actorId),
      202,
    );
  });
  app.post('/organizations/:organizationId/repositories/:connectionId/check', async (context) => {
    if (!configured) return context.json({ error: 'repository-analysis-not-configured' }, 503);
    const result = await pool.query(
      `UPDATE github_repository_connections SET next_check_at=now(),
        progress=CASE WHEN progress->>'status'='running' THEN progress ELSE $3::jsonb END
        WHERE organization_id=$1 AND id=$2 RETURNING id,progress->>'status' AS status`,
      [
        context.req.param('organizationId'),
        z.uuid().parse(context.req.param('connectionId')),
        JSON.stringify(queuedRepositoryProgress()),
      ],
    );
    if (!result.rowCount) return context.json({ error: 'repository-not-found' }, 404);
    return context.json({ status: result.rows[0].status }, 202);
  });
  app.post(
    '/organizations/:organizationId/repositories/:connectionId/notifications',
    async (context) => {
      const { environmentId } = z
        .object({ environmentId: z.string().min(1).nullable() })
        .strict()
        .parse(await context.req.json());
      const result = await pool.query(
        `UPDATE github_repository_connections SET notify_environment_id=$3,last_notification_key=NULL
       WHERE organization_id=$1 AND id=$2 AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM environments WHERE organization_id=$1 AND id=$3
       )) RETURNING id`,
        [
          context.req.param('organizationId'),
          z.uuid().parse(context.req.param('connectionId')),
          environmentId,
        ],
      );
      if (!result.rowCount)
        return context.json({ message: 'Repository or notification environment not found' }, 404);
      return context.json({ environmentId });
    },
  );
  app.get('/organizations/:organizationId/repositories/:connectionId/history', async (context) => {
    const before = context.req.query('before');
    if (before !== undefined) z.string().regex(/^\d+$/).parse(before);
    const result = await pool.query(
      `SELECT run.id::text,run.target_key,run.commit_sha,run.status,run.started_at,run.finished_at,
      run.diagnostics,run.progress,candidate.id AS candidate_id
      FROM repository_analysis_runs run JOIN github_repository_connections connection ON connection.id=run.connection_id
      LEFT JOIN repository_contract_candidates candidate ON candidate.run_id=run.id
      WHERE connection.organization_id=$1 AND connection.id=$2 AND ($3::bigint IS NULL OR run.id<$3)
      ORDER BY run.id DESC LIMIT 100`,
      [
        context.req.param('organizationId'),
        z.uuid().parse(context.req.param('connectionId')),
        before ?? null,
      ],
    );
    return context.json({
      runs: result.rows,
      nextBefore: result.rows.length === 100 ? (result.rows.at(-1)!.id as string) : null,
    });
  });
  app.get(
    '/organizations/:organizationId/repositories/:connectionId/runs/:runId',
    async (context) => {
      const result = await pool.query(
        `SELECT run.* FROM repository_analysis_runs run
      JOIN github_repository_connections connection ON connection.id=run.connection_id
      WHERE connection.organization_id=$1 AND connection.id=$2 AND run.id=$3`,
        [
          context.req.param('organizationId'),
          z.uuid().parse(context.req.param('connectionId')),
          z.string().regex(/^\d+$/).parse(context.req.param('runId')),
        ],
      );
      if (!result.rows[0]) return context.json({ error: 'repository-run-not-found' }, 404);
      return context.json(result.rows[0]);
    },
  );
  app.post('/organizations/:organizationId/repositories/:connectionId/ingest', async (context) => {
    if (!configured) return context.json({ error: 'repository-analysis-not-configured' }, 503);
    const result = await pool.query(
      `UPDATE github_repository_connections SET ingestion_requested=true,
      ingestion_generation=ingestion_generation+1,next_check_at=now(),progress=$3 WHERE organization_id=$1 AND id=$2 RETURNING id`,
      [
        context.req.param('organizationId'),
        z.uuid().parse(context.req.param('connectionId')),
        JSON.stringify(queuedRepositoryProgress()),
      ],
    );
    if (!result.rowCount) return context.json({ error: 'repository-not-found' }, 404);
    return context.json({ status: 'queued' }, 202);
  });
  app.get(
    '/organizations/:organizationId/repositories/candidates/:candidateId',
    async (context) => {
      const result = await pool.query(
        `SELECT candidate.*,connection.repository FROM repository_contract_candidates candidate
      JOIN github_repository_connections connection ON connection.id=candidate.connection_id
      WHERE connection.organization_id=$1 AND candidate.id=$2`,
        [context.req.param('organizationId'), z.uuid().parse(context.req.param('candidateId'))],
      );
      if (!result.rows[0]) return context.json({ error: 'repository-candidate-not-found' }, 404);
      return context.json(result.rows[0]);
    },
  );
  for (const decision of ['accept', 'reject'] as const)
    app.post(
      `/organizations/:organizationId/repositories/candidates/:candidateId/${decision}`,
      async (context) => {
        const organizationId = context.req.param('organizationId');
        const actor = await authorizer!.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId,
          action: 'connect-capability-source',
        });
        if (!actor) return context.json({ error: 'repository-access-denied' }, 403);
        const input = {
          ...repositoryReviewSchema.parse(await context.req.json()),
          organizationId,
          candidateId: z.uuid().parse(context.req.param('candidateId')),
          reviewerId: actor.actorId,
        };
        return context.json(
          decision === 'accept'
            ? await acceptRepositoryContractCandidate(pool, input)
            : await rejectRepositoryContractCandidate(pool, input),
        );
      },
    );
  return app;
}
