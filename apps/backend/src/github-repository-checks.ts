import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalJson, sha256 } from './capability-versioning.js';
import {
  createRepositoryProgressReporter,
  notifyRepositoryAnalysis,
  queuedRepositoryProgress,
  repositoryProgressCounts,
} from './repository-analysis-progress.js';

import {
  githubConnectionSchema,
  type GithubRepositorySource,
  type RepositoryService,
  type RepositoryTarget,
} from './github-repository-source.js';
import {
  extractRepositoryContracts,
  RepositoryExtractionError,
  validateRepositoryExtraction,
  type ExtractedRepositoryService,
  type RepositoryExtractor,
} from './repository-contract-extraction.js';
import { applyRepositoryRequestResponseChanges } from './repository-contract-normalization.js';
import {
  candidateApprovalContent,
  operationIds,
  publishRepositoryContractCandidate,
  readAcceptedRepositoryContracts,
  repositoryBaselineHash,
  repositoryCandidateHash,
  repositoryContractChanges,
  requireRepositoryReviewer,
  selectedContractHash,
  type RepositoryCandidate,
} from './repository-contract-catalog.js';

export interface RepositoryAnalysisServices {
  source: GithubRepositorySource;
  extractor: RepositoryExtractor;
}
interface Connection {
  id: string;
  organization_id: string;
  repository: string;
  branches: string[];
  services: RepositoryService[];
  ingestion_requested: boolean;
  ingestion_generation: number;
}

export async function connectGithubRepository(pool: Pool, input: unknown, actorId: string) {
  const request = githubConnectionSchema.parse(input);
  await requireRepositoryReviewer(pool, request.organizationId, actorId);
  const row = await pool.query<{ id: string }>(
    `INSERT INTO github_repository_connections
    (id,organization_id,repository,branches,services,created_by,progress) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (organization_id,repository) DO NOTHING RETURNING id`,
    [
      randomUUID(),
      request.organizationId,
      request.repository,
      request.branches,
      JSON.stringify(request.services),
      actorId,
      JSON.stringify(queuedRepositoryProgress()),
    ],
  );
  if (!row.rows[0])
    throw new Error('This repository is already connected; review its saved connection');
  return { connectionId: row.rows[0].id, status: 'queued' as const };
}

async function connectionLock(client: PoolClient, connectionId: string) {
  const result = await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 274)) AS acquired',
    [connectionId],
  );
  return result.rows[0]!.acquired;
}
async function releaseConnectionLock(client: PoolClient, connectionId: string) {
  await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 274))', [connectionId]);
}
const message = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 2000) : 'Repository analysis failed';

async function checkTarget(
  client: PoolClient,
  connection: Connection,
  target: RepositoryTarget,
  services: RepositoryAnalysisServices,
  progress: ReturnType<typeof createRepositoryProgressReporter>,
) {
  const accepted = await readAcceptedRepositoryContracts(client, connection.id, target.branch);
  // Pull requests cannot introduce an initial catalog. Save previews only after a branch is accepted.
  if (target.pullRequest && !accepted.length)
    return { target: target.key, status: 'awaiting-initial-approval' };
  const baselineHash = repositoryBaselineHash(accepted);
  const extractor = services.extractor;
  const initialIngestion = connection.ingestion_requested && !target.pullRequest;
  const existing = await client.query<{
    id: string;
    status: string;
    retry_at: Date | null;
    diagnostics: string[];
  }>(
    `SELECT id::text,status,retry_at,diagnostics FROM repository_analysis_runs
    WHERE connection_id=$1 AND target_key=$2 AND commit_sha=$3 AND base_commit_sha=$4 AND baseline_hash=$5
      AND extractor_version=$6 AND model=$7 AND prompt_version=$8 AND ingestion_generation=$9`,
    [
      connection.id,
      target.key,
      target.commit,
      target.baseCommit,
      baselineHash,
      extractor.version,
      extractor.model,
      extractor.promptVersion,
      connection.ingestion_generation,
    ],
  );
  let runId = existing.rows[0]?.id;
  if (existing.rows[0]?.status === 'succeeded') {
    await client.query(
      `UPDATE repository_analysis_targets SET last_successful_at=now(),last_attempt_at=now(),last_error=NULL,
      last_successful_run_id=$3,last_successful_commit=$4
      WHERE connection_id=$1 AND target_key=$2`,
      [connection.id, target.key, existing.rows[0].id, target.commit],
    );
    if (!target.pullRequest)
      await client.query(
        `UPDATE repository_contract_candidates SET status='superseded'
      WHERE connection_id=$1 AND branch=$2 AND status='review' AND run_id<>$3`,
        [connection.id, target.branch, existing.rows[0].id],
      );
    return { target: target.key, status: 'unchanged' };
  }
  if (existing.rows[0]?.retry_at && existing.rows[0].retry_at > new Date())
    return {
      target: target.key,
      status: 'retry-pending',
      message: existing.rows[0].diagnostics[0] ?? 'Waiting to retry the failed analysis.',
    };
  if (runId) {
    await client.query(
      `UPDATE repository_analysis_runs SET status='running',attempt=attempt+1,started_at=now(),finished_at=NULL,retry_at=NULL WHERE id=$1`,
      [runId],
    );
  } else {
    const run = await client.query<{ id: string }>(
      `INSERT INTO repository_analysis_runs
      (connection_id,target_key,branch,pull_request,commit_sha,base_commit_sha,baseline_hash,extractor_version,model,prompt_version,status,ingestion_generation)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running',$11) RETURNING id::text`,
      [
        connection.id,
        target.key,
        target.branch,
        target.pullRequest ?? null,
        target.commit,
        target.baseCommit,
        baselineHash,
        extractor.version,
        extractor.model,
        extractor.promptVersion,
        connection.ingestion_generation,
      ],
    );
    runId = run.rows[0]!.id;
  }
  await client.query(
    `INSERT INTO repository_analysis_targets (connection_id,target_key,last_attempt_at)
    VALUES ($1,$2,now()) ON CONFLICT (connection_id,target_key) DO UPDATE SET last_attempt_at=now()`,
    [connection.id, target.key],
  );
  try {
    await progress.report({
      status: 'running',
      phase: 'connecting',
      runId,
      targetKey: target.key,
      servicesFound: 0,
      sourceFiles: 0,
      filesRead: 0,
      operationsDrafted: 0,
      operationsDiscovered: null,
      workflowsDrafted: 0,
      message: `Reading source for ${target.pullRequest ? `pull request #${target.pullRequest}` : target.branch}.`,
    });
    const snapshot = await services.source.snapshot(
      connection.repository,
      target.commit,
      connection.services,
    );
    await progress.report({
      phase: 'discovering',
      sourceFiles: snapshot.files.length,
      servicesFound: snapshot.services.length,
      message: `Found ${snapshot.files.length} source files. Looking for API services and routes.`,
    });
    const cached = await client.query<{ generated_documents: unknown }>(
      `SELECT generated_documents FROM repository_analysis_runs
      WHERE connection_id=$1 AND commit_sha=$2 AND extractor_version=$3 AND model=$4 AND prompt_version=$5
      AND status='succeeded' AND generated_documents IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [connection.id, target.commit, extractor.version, extractor.model, extractor.promptVersion],
    );
    const memory = await client.query<{ analysis_memory: unknown }>(
      `SELECT analysis_memory FROM repository_analysis_runs
       WHERE connection_id=$1 AND target_key=$2 AND extractor_version=$3 AND model=$4
         AND prompt_version=$5 AND ingestion_generation=$6 AND analysis_memory IS NOT NULL
         AND (status IN ('succeeded','failed') OR id=$7) AND id <= $7
       ORDER BY id DESC LIMIT 1`,
      [
        connection.id,
        target.key,
        extractor.version,
        extractor.model,
        extractor.promptVersion,
        connection.ingestion_generation,
        runId,
      ],
    );
    const raw =
      (!initialIngestion ? cached.rows[0]?.generated_documents : undefined) ??
      (await extractRepositoryContracts(
        extractor,
        snapshot,
        Object.fromEntries(
          accepted.map((contract) => [contract.service_id, operationIds(contract.openapi)]),
        ),
        {
          previous: memory.rows[0]?.analysis_memory,
          progress: (update) => progress.report(update),
          async checkpoint(value) {
            await client.query(
              'UPDATE repository_analysis_runs SET analysis_memory=$2 WHERE id=$1',
              [runId, JSON.stringify(value)],
            );
          },
        },
      ));
    // Retain raw generated documents even when validation subsequently fails.
    await client.query(
      'UPDATE repository_analysis_runs SET generated_documents=$2,document_hash=$3 WHERE id=$1',
      [runId, JSON.stringify(raw), sha256(canonicalJson(raw))],
    );
    await progress.report({
      phase: 'checking',
      ...repositoryProgressCounts(raw),
      message: 'Checking contracts, source references and changes to accepted definitions.',
    });
    const extraction = await validateRepositoryExtraction(raw, snapshot);
    const changes = await repositoryContractChanges(
      client,
      connection.organization_id,
      accepted,
      extraction.services,
    );
    let documents: ExtractedRepositoryService[] = extraction.services;
    if (accepted.length && !initialIngestion) {
      documents = await Promise.all(
        accepted.map(async (before) => {
          const generated = extraction.services.find(
            (service) => service.serviceId === before.service_id,
          )!;
          const ids = operationIds(before.openapi);
          const changed = changes.some((change) => change.serviceId === before.service_id);
          return {
            ...generated,
            openapi: changed
              ? await applyRepositoryRequestResponseChanges(
                  before.service_id,
                  before.openapi,
                  generated.openapi,
                )
              : before.openapi,
            arazzo: before.arazzo,
            evidence: generated.evidence.filter((entry) => ids.includes(entry.operationId)),
            // Periodic Arazzo stays exactly as approved, including its evidence.
            workflowEvidence: before.arazzo
              ? ((
                  await client.query<{ documents: ExtractedRepositoryService[] }>(
                    'SELECT documents FROM repository_contract_candidates WHERE id=$1',
                    [before.candidate_id],
                  )
                ).rows[0]!.documents.find((entry) => entry.serviceId === before.service_id)
                  ?.workflowEvidence ?? [])
              : [],
          };
        }),
      );
    }
    const requestResponseHash = await selectedContractHash(documents);
    const current = (
      await services.source.targets(connection.repository, connection.branches)
    ).find((entry) => entry.key === target.key);
    if (!current || current.commit !== target.commit || current.baseCommit !== target.baseCommit) {
      await client.query(
        `UPDATE repository_analysis_runs SET status='outdated',finished_at=now(),diagnostics=$2 WHERE id=$1`,
        [runId, JSON.stringify(['The branch or pull request moved while it was being analyzed'])],
      );
      await progress.report({
        status: 'outdated',
        message: 'The branch changed during analysis. Another check is scheduled.',
      });
      return { target: target.key, status: 'outdated' };
    }
    await client.query('BEGIN');
    try {
      await client.query('DELETE FROM repository_operation_dependencies WHERE run_id=$1', [runId]);
      for (const service of extraction.services)
        for (const evidence of service.evidence) {
          await client.query(
            `INSERT INTO repository_operation_dependencies
          (run_id,service_id,operation_id,path,function_name,start_line,end_line,blob_sha,role)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
            [
              runId,
              service.serviceId,
              evidence.operationId,
              evidence.path,
              evidence.functionName,
              evidence.startLine,
              evidence.endLine,
              snapshot.files.find((file) => file.path === evidence.path)!.sha,
              evidence.role,
            ],
          );
        }
      if (!target.pullRequest)
        await client.query(
          `UPDATE repository_contract_candidates SET status='superseded'
        WHERE connection_id=$1 AND branch=$2 AND status='review' AND run_id<>$3`,
          [connection.id, target.branch, runId],
        );
      let candidateId: string | undefined;
      if (!accepted.length || initialIngestion || changes.length) {
        const content = {
          connection_id: connection.id,
          branch: target.branch,
          commit_sha: target.commit,
          base_commit_sha: target.baseCommit,
          kind: target.pullRequest
            ? ('preview' as const)
            : accepted.length && !initialIngestion
              ? ('periodic' as const)
              : ('initial' as const),
          baseline_hash: baselineHash,
          documents,
          changes,
        };
        candidateId = randomUUID();
        await client.query(
          `INSERT INTO repository_contract_candidates
          (id,run_id,connection_id,branch,commit_sha,base_commit_sha,kind,status,candidate_hash,request_response_hash,baseline_hash,documents,changes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (run_id) DO NOTHING`,
          [
            candidateId,
            runId,
            connection.id,
            target.branch,
            target.commit,
            target.baseCommit,
            content.kind,
            target.pullRequest ? 'preview' : 'review',
            repositoryCandidateHash(content),
            requestResponseHash,
            baselineHash,
            JSON.stringify(documents),
            JSON.stringify(changes),
          ],
        );
      }
      await client.query(
        `UPDATE repository_analysis_runs SET status='succeeded',finished_at=now(),diagnostics=$2,request_response_hash=$3 WHERE id=$1`,
        [
          runId,
          JSON.stringify(extraction.services.flatMap((service) => service.unresolvedQuestions)),
          requestResponseHash,
        ],
      );
      await client.query(
        `UPDATE repository_analysis_targets SET last_successful_run_id=$3,last_successful_commit=$4,
        last_successful_at=now(),last_error=NULL WHERE connection_id=$1 AND target_key=$2`,
        [connection.id, target.key, runId, target.commit],
      );
      await progress.report({
        status: 'succeeded',
        phase: 'complete',
        message: candidateId
          ? 'Contracts are ready for review. Nothing has been published.'
          : 'The accepted contracts are unchanged.',
      });
      await client.query('COMMIT');
      return {
        target: target.key,
        status: candidateId ? 'review' : 'unchanged',
        ...(candidateId ? { candidateId } : {}),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    if (error instanceof RepositoryExtractionError)
      await client.query(
        'UPDATE repository_analysis_runs SET generated_documents=$2,document_hash=$3 WHERE id=$1',
        [
          runId,
          JSON.stringify(error.generatedDocuments),
          sha256(canonicalJson(error.generatedDocuments)),
        ],
      );
    await client.query(
      `UPDATE repository_analysis_runs SET status='failed',finished_at=now(),diagnostics=$2,
      retry_at=now()+least(attempt*interval '1 minute',interval '1 hour') WHERE id=$1`,
      [runId, JSON.stringify([message(error)])],
    );
    await client.query(
      `UPDATE repository_analysis_targets SET last_error=$3 WHERE connection_id=$1 AND target_key=$2`,
      [connection.id, target.key, message(error)],
    );
    await progress.report({ status: 'failed', message: message(error) });
    return { target: target.key, status: 'failed', message: message(error) };
  }
}

export async function checkGithubRepositoryUpdates(
  pool: Pool,
  connectionId: string,
  services: RepositoryAnalysisServices,
) {
  const client = await pool.connect();
  let locked = false;
  let progress: ReturnType<typeof createRepositoryProgressReporter> | undefined;
  let generation: number | undefined;
  try {
    locked = await connectionLock(client, connectionId);
    if (!locked) return { status: 'already-running', targets: [] };
    const connection = (
      await client.query<Connection>(
        'SELECT * FROM github_repository_connections WHERE id=$1 AND enabled',
        [connectionId],
      )
    ).rows[0];
    if (!connection) throw new Error('Repository connection not found');
    generation = connection.ingestion_generation;
    progress = createRepositoryProgressReporter(client, connection.id, generation);
    await progress.report({
      phase: 'connecting',
      message: 'Checking public repository access and tracked branches.',
    });
    const targets = await services.source.targets(connection.repository, connection.branches);
    const results = [];
    for (const target of targets)
      results.push(await checkTarget(client, connection, target, services, progress));
    const failed = results.some(
      (result) => result.status === 'failed' || result.status === 'retry-pending',
    );
    const outdated = results.some((result) => result.status === 'outdated');
    const failedResult = results.find(
      (result) => result.status === 'failed' || result.status === 'retry-pending',
    );
    const failureMessage =
      failedResult && 'message' in failedResult ? failedResult.message : undefined;
    await client.query(
      `UPDATE github_repository_connections SET last_checked_at=now(),last_error=$2,
      next_check_at=now()+$3::interval,ingestion_requested=CASE WHEN $4 THEN ingestion_requested ELSE false END WHERE id=$1 AND ingestion_generation=$5`,
      [
        connectionId,
        failed
          ? (failureMessage ??
            'One or more repository checks failed; last accepted definitions are retained')
          : null,
        failed || outdated ? '1 minute' : '1 hour',
        failed || outdated,
        connection.ingestion_generation,
      ],
    );
    const candidates = results.flatMap((result) =>
      'candidateId' in result && result.candidateId ? [result.candidateId] : [],
    );
    const failedProgress = failedResult
      ? (
          await client.query<{ progress: Record<string, unknown> }>(
            `SELECT progress FROM repository_analysis_runs WHERE connection_id=$1 AND target_key=$2
       AND ingestion_generation=$3 AND status='failed' ORDER BY started_at DESC,id DESC LIMIT 1`,
            [connectionId, failedResult.target, generation],
          )
        ).rows[0]?.progress
      : undefined;
    await progress.report(
      {
        ...failedProgress,
        status: failed ? 'failed' : outdated ? 'outdated' : 'succeeded',
        ...(!failed && !outdated ? { phase: 'complete' as const } : {}),
        message: failed
          ? (failureMessage ??
            'One or more checks failed. The last accepted contracts are retained.')
          : outdated
            ? 'The branch changed during analysis. Another check is scheduled.'
            : candidates.length
              ? 'Contracts are ready for review. Nothing has been published.'
              : 'Repository check complete. No contract changes found.',
      },
      { connectionOnly: true },
    );
    await notifyRepositoryAnalysis(client, connectionId, generation, {
      failed,
      message: failed
        ? (failureMessage ?? 'Repository analysis failed.')
        : 'New repository contracts are ready for review.',
      candidates,
    });
    return { status: failed ? 'failed' : 'checked', targets: results };
  } catch (error) {
    if (locked) {
      await client.query(
        `UPDATE github_repository_connections SET last_checked_at=now(),last_error=$2,next_check_at=now()+interval '1 minute' WHERE id=$1 AND ($3::integer IS NULL OR ingestion_generation=$3)`,
        [connectionId, message(error), generation ?? null],
      );
      const failedRun = await client.query<{ id: string }>(
        `INSERT INTO repository_analysis_runs
        (connection_id,target_key,branch,commit_sha,baseline_hash,extractor_version,model,prompt_version,status,finished_at,retry_at,diagnostics,ingestion_generation)
        SELECT id,'fetch','', '', '',$2,$3,$4,'failed',now(),now()+interval '1 minute',$5,coalesce($6,ingestion_generation) FROM github_repository_connections WHERE id=$1
        ON CONFLICT (connection_id,target_key,commit_sha,base_commit_sha,baseline_hash,extractor_version,model,prompt_version,ingestion_generation)
        DO UPDATE SET attempt=repository_analysis_runs.attempt+1,status='failed',started_at=now(),finished_at=now(),retry_at=now()+interval '1 minute',diagnostics=EXCLUDED.diagnostics RETURNING id::text`,
        [
          connectionId,
          services.extractor.version,
          services.extractor.model,
          services.extractor.promptVersion,
          JSON.stringify([message(error)]),
          generation ?? null,
        ],
      );
      await progress?.report({
        status: 'failed',
        ...(failedRun.rows[0] ? { runId: failedRun.rows[0].id } : {}),
        message: message(error),
      });
      if (generation !== undefined)
        await notifyRepositoryAnalysis(client, connectionId, generation, {
          failed: true,
          message: message(error),
          candidates: [],
        });
    }
    return { status: 'failed', message: message(error), targets: [] };
  } finally {
    if (locked) await releaseConnectionLock(client, connectionId);
    client.release();
  }
}

export const repositoryReviewSchema = z
  .object({ candidateHash: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeQuestions: z.boolean() })
  .strict();
export async function acceptRepositoryContractCandidate(
  pool: Pool,
  input: {
    organizationId: string;
    candidateId: string;
    candidateHash: string;
    reviewerId: string;
    acknowledgeQuestions: boolean;
  },
) {
  const client = await pool.connect();
  let connectionId: string | undefined;
  let locked = false;
  try {
    await requireRepositoryReviewer(client, input.organizationId, input.reviewerId);
    const found = await client.query<RepositoryCandidate & { repository: string }>(
      `SELECT candidate.*,connection.repository FROM repository_contract_candidates candidate
      JOIN github_repository_connections connection ON connection.id=candidate.connection_id WHERE candidate.id=$1 AND connection.organization_id=$2`,
      [input.candidateId, input.organizationId],
    );
    if (!found.rows[0]) throw new Error('Repository candidate not found');
    connectionId = found.rows[0].connection_id;
    locked = await connectionLock(client, connectionId);
    if (!locked) throw new Error('A repository check is running; review again when it finishes');
    await client.query('BEGIN');
    try {
      const candidate = (
        await client.query<RepositoryCandidate>(
          'SELECT * FROM repository_contract_candidates WHERE id=$1 FOR UPDATE',
          [input.candidateId],
        )
      ).rows[0]!;
      const currentRequest = await client.query(
        `SELECT 1 FROM repository_analysis_runs run JOIN github_repository_connections connection ON connection.id=run.connection_id
        WHERE run.id=$1 AND run.ingestion_generation=connection.ingestion_generation`,
        [candidate.run_id],
      );
      if (!currentRequest.rowCount)
        throw new Error('A new ingestion was requested; review its result when it completes');
      if (candidate.kind === 'preview' || candidate.status !== 'review')
        throw new Error('Only a pending tracked-branch candidate can be accepted');
      if (
        candidate.candidate_hash.trim() !== input.candidateHash ||
        repositoryCandidateHash(candidateApprovalContent(candidate)) !== input.candidateHash
      )
        throw new Error('The candidate changed; review the exact documents again');
      const baseline = await readAcceptedRepositoryContracts(
        client,
        connectionId,
        candidate.branch,
      );
      if (repositoryBaselineHash(baseline) !== candidate.baseline_hash)
        throw new Error('Accepted definitions changed; run a fresh repository check');
      const latest = (
        await client.query<{ last_successful_run_id: string }>(
          `SELECT last_successful_run_id::text FROM repository_analysis_targets
        WHERE connection_id=$1 AND target_key=$2`,
          [connectionId, `branch:${candidate.branch}`],
        )
      ).rows[0];
      if (latest?.last_successful_run_id !== String(candidate.run_id))
        throw new Error('A newer repository result exists; review it instead');
      if (
        candidate.documents.some((service) => service.unresolvedQuestions.length) &&
        !input.acknowledgeQuestions
      )
        throw new Error('Review and acknowledge the unresolved questions before acceptance');
      if (
        candidate.kind === 'periodic' &&
        !(
          await repositoryContractChanges(
            client,
            input.organizationId,
            baseline,
            candidate.documents,
          )
        ).length
      )
        throw new Error('Periodic acceptance requires a request or response change');
      const published = await publishRepositoryContractCandidate(client, {
        organizationId: input.organizationId,
        repository: found.rows[0].repository,
        candidate,
        reviewerId: input.reviewerId,
      });
      await client.query(
        `UPDATE repository_contract_candidates SET status='accepted',reviewed_by=$2,reviewed_at=now() WHERE id=$1`,
        [candidate.id, input.reviewerId],
      );
      await client.query(
        'UPDATE github_repository_connections SET next_check_at=now() WHERE id=$1',
        [connectionId],
      );
      await client.query('COMMIT');
      return {
        candidateId: candidate.id,
        sourceCommit: candidate.commit_sha,
        acceptedBy: input.reviewerId,
        services: published,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    if (locked && connectionId) await releaseConnectionLock(client, connectionId);
    client.release();
  }
}

export async function rejectRepositoryContractCandidate(
  pool: Pool,
  input: { organizationId: string; candidateId: string; candidateHash: string; reviewerId: string },
) {
  await requireRepositoryReviewer(pool, input.organizationId, input.reviewerId);
  const result = await pool.query(
    `UPDATE repository_contract_candidates candidate SET status='rejected',reviewed_by=$4,reviewed_at=now()
    FROM github_repository_connections connection WHERE candidate.connection_id=connection.id AND connection.organization_id=$1
    AND candidate.id=$2 AND candidate.candidate_hash=$3 AND candidate.status='review'`,
    [input.organizationId, input.candidateId, input.candidateHash, input.reviewerId],
  );
  if (!result.rowCount) throw new Error('The candidate is no longer awaiting this review');
  return { rejected: true };
}

export function startGithubRepositoryChecks(
  pool: Pool,
  services: RepositoryAnalysisServices,
  intervalMs = 5_000,
) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const connections = await pool.query<{ id: string }>(
        'SELECT id FROM github_repository_connections WHERE enabled AND next_check_at<=now() ORDER BY next_check_at LIMIT 20',
      );
      for (const connection of connections.rows)
        await checkGithubRepositoryUpdates(pool, connection.id, services);
    } catch (error) {
      console.error('Repository check scheduler failed', error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
