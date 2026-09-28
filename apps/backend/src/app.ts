import { deleteCapability } from './capability-deletion.js';
import { recordRunCompletion, runCompletionSchema } from './run-completion.js';
import {
  capabilityUserAnnotationSchema,
  createCapabilityUserAnnotation,
  deleteCapabilityUserAnnotation,
  updateCapabilityUserAnnotation,
} from './capability-user-annotations.js';
import { DraftRequests } from './draft-requests.js';
import {
  createWorkflowEditorVersion,
  listWorkflowEditorDrafts,
  readWorkflowEditorDraft,
  saveWorkflowEditorDraft,
  validateWorkflowEditorDocument,
  workflowEditorSaveSchema,
  workflowEditorScopeSchema,
  workflowEditorVersionSchema,
  workflowEditorValidationSchema,
  WorkflowEditorCompilationFailed,
  WorkflowEditorDraftConflict,
  WorkflowEditorDraftNotFound,
} from './workflow-editor-drafts.js';
import { WorkflowSandboxTestRequests } from './workflow-sandbox-test-requests.js';
import { notificationStream } from './notification-stream.js';
import { registeredSourcePolicy } from './registered-source-policy.js';
import { planningRequestSchema } from './workflow-planning.js';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  configureWorkflowSandboxRetestPolicy,
  readWorkflowSandboxTestHistory,
  workflowSandboxRetestPolicySchema,
} from './automatic-workflow-retests.js';
import {
  declareEnvironmentWorker,
  environmentWorkerDeclarationSchema,
  WorkerIrVersionUnsupported,
} from './environment-workers.js';
import { WorkflowQuarantined } from './workflow-quarantine.js';
import { auditHistoryQuerySchema, readAuditHistory } from './audit-history.js';
import {
  approveCapabilitySafety,
  capabilityHostPolicyRouteSchema,
  capabilityHostPolicySchema,
  capabilitySafetyApprovalSchema,
  type MembershipAuthorizer,
  membershipUpdateSchema,
  organizationSettingsSchema,
  readAdminSuite,
  revokeCapabilityHostPolicy,
  secretReferenceSchema,
  updateOrganizationSettings,
  updateMembershipRole,
  LastOrganizationAdmin,
  MembershipAdminRequired,
  upsertCapabilityHostPolicy,
  upsertSecretReference,
} from './admin-suite.js';

import {
  discoverCapabilities,
  ingestCapabilities,
  readCapabilityDiscovery,
  readCapabilityDiscoveries,
  readCapabilityVersion,
  readWorkflowDependencies,
} from './capability-ingestion.js';
import {
  disconnectCapabilitySource,
  markCapabilitySourceObservationsStale,
  readCapabilitySourceRegistrations,
  rediscoverRegisteredCapabilitySource,
  rediscoveryRequestSchema,
  requestCapabilityRediscovery,
  summarizeCapabilitySourceEvidence,
} from './capability-rediscovery.js';
import {
  readCapabilityCatalog,
  readCapabilityComparisonCatalog,
  readPlannerCapabilityProjection,
} from './capability-catalog.js';
import { capabilityOverviewQuerySchema, readCapabilityOverview } from './capability-overview.js';
import { readCapabilityArchitecture } from './capability-architecture.js';
import { repositoryContractRoutes } from './repository-contract-routes.js';
import {
  burgerTownMonitoringScopeSchema,
  BurgerTownMonitoringUnavailable,
  type BurgerTownMonitor,
} from './burger-town-monitor.js';
import {
  capabilitySourceAuthoritySchema,
  designateCapabilitySourceAuthority,
} from './capability-source-conflicts.js';
import {
  readWorkflowCatalog,
  readWorkflowCatalogDetail,
  readWorkflowCatalogVersion,
  saveWorkflowCatalogVersion,
  saveWorkflowCatalogVersionSchema,
  workflowCatalogQuerySchema,
  WorkflowCatalogVersionConflict,
  WorkflowCatalogWorkflowNotFound,
} from './workflow-catalog.js';
import { sha256 } from './capability-versioning.js';
import { plannerCapabilityReferenceIndex } from './capability-reference-index.js';
import { readCapabilitySelection, readPinnedExecutionSelection } from './capability-selection.js';
import {
  type CapabilitySourcePolicy,
  CapabilitySourcePolicyError,
  materializeRemoteCapabilitySource,
} from './source-policy.js';
import { validateWorkflowDraft } from './workflow-validation.js';
import {
  correctWorkflowMigrationCandidate,
  generateWorkflowMigrationCandidate,
  readWorkflowMigrationCandidate,
  WorkflowMigrationCandidateNotFound,
  WorkflowMigrationCorrectionRejected,
  WorkflowMigrationPlannerRequired,
  WorkflowMigrationSourceNotFound,
  WorkflowMigrationVersionIdentityConflict,
  WorkflowMigrationActivationConflict,
  WorkflowMigrationRollbackConflict,
  activateWorkflowMigrationCandidate,
  rollbackWorkflowActivation,
} from './workflow-migration.js';
import { PlannerUnavailableError } from './openai-planner-model.js';
import {
  credentialFingerprint,
  type PlanningTraceStore,
  runWithPlanningTrace,
  serializeTraceError,
} from './planning-trace.js';
import { draftWorkflow, type PlannerModel } from './workflow-planning.js';
import type { PlanningAuthorizer } from './planning-authorization.js';
import { compileWorkflowSource } from './workflow-source.js';
import {
  approveWorkflow,
  executionGrantRequestSchema,
  issueApprovedExecutionGrant,
  readApprovedWorkflow,
  workflowApprovalRequestSchema,
  WorkflowApprovalConflict,
  ExecutionArtifactMismatch,
  type WorkflowExecutionServices,
} from './workflow-approval.js';
import {
  buildWorkflowReview,
  compareWorkflowVersions,
  createWorkflowEdit,
  readWorkflowVersionHistory,
  readWorkflowLifecycle,
  workflowLifecycleQuerySchema,
  workflowVersionDiffQuerySchema,
  workflowVersionHistoryQuerySchema,
  workflowReviewRequestSchema,
  workflowEditRequestSchema,
  WorkflowMigrationDiffNotFound,
  WorkflowReviewCandidateConflict,
  WorkflowVersionNotFound,
} from './workflow-console.js';
import {
  claimNextRepairCommand,
  queueWorkflowRunRepair,
  readWorkflowRun,
  readWorkflowRuns,
  recordRepairCommandResult,
  recordWorkflowRunOutcome,
  recordWorkflowStepAttempt,
  repairCommandResultSchema,
  runOutcomeSchema,
  runRepairRequestSchema,
  runsQuerySchema,
  stepAttemptSchema,
  WorkflowRunNotFound,
  WorkflowRunRepairRejected,
} from './workflow-runs.js';
import {
  readWorkflowSandboxReadiness,
  runWorkflowSandboxTests,
  workflowSandboxReadinessQuerySchema,
  workflowSandboxRequestSchema,
  WorkflowSandboxTestsUnavailable,
  WorkflowSandboxExecutionFailed,
  type WorkflowSandboxExecutor,
} from './workflow-sandbox.js';
import { readApprovedTemporalWorkflowArtifact } from './workflow-artifact.js';
import {
  readAtlasBundleExecutionPolicy,
  readLatestAtlasBundleVerificationEvent,
  readAtlasWorkflowBundle,
  recordAtlasBundleVerificationEvent,
} from './workflow-bundle-execution.js';
import {
  apiRunReadinessQuerySchema,
  ApiWorkflowNameAmbiguous,
  ApiWorkflowNameNotFound,
  claimNextRunCommand,
  queueApiRunCommand,
  queueApiRunCommandSchema,
  queueWebhookRunCommand,
  queueWebhookRunCommandSchema,
  readApiRunReadinessByName,
  readWebhookRunReadiness,
  webhookRunReadinessQuerySchema,
  readWebhookDelivery,
  webhookDeliveryQuerySchema,
  readRunCommand,
  recordRunCommandResult,
  runCommandResultSchema,
  WebhookDeliveryConflict,
  WebhookRunUnavailable,
} from './run-commands.js';
import {
  capabilityLossOverrideSchema,
  CapabilityLossOverrideConflict,
  CapabilityLossOverrideNotFound,
  createCapabilityLossOverride,
  revokeCapabilityLossOverride,
  revokeCapabilityLossOverrideSchema,
  WorkflowCapabilityLossBlocked,
} from './capability-loss-protection.js';
import {
  createWorkflowSchedule,
  readWorkflowSchedules,
  updateWorkflowSchedule,
  workflowScheduleCreateSchema,
  WorkflowScheduleNotFound,
  workflowSchedulesQuerySchema,
  workflowScheduleUpdateSchema,
} from './workflow-schedules.js';
import type { ProviderConditionRepairer } from './provider-condition-repair.js';
import {
  capabilitySandboxTargetSchema,
  capabilityTestDataProfileSchema,
  configureCapabilitySandboxTarget,
  configureCapabilityTestDataProfile,
  InvalidSandboxTarget,
} from './capability-sandbox-targets.js';
import {
  clearNotifications,
  clearNotificationsSchema,
  createNotification,
  createNotificationSchema,
  markNotificationRead,
  notificationsQuerySchema,
  readNotificationSchema,
  readNotifications,
  resolveNotification,
  resolveNotificationSchema,
} from './notifications.js';
import { connectBurgerTown, type BurgerTownConnectionPlan } from './burger-town-connection.js';
import {
  recordRunLifecycleEnded,
  recordRunLifecycleStarted,
  runLifecycleEventSchema,
} from './run-lifecycle.js';
import { formatUsageReportCsv, readUsageReport, usageReportQuerySchema } from './usage-report.js';

const runScopeSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .strict();

// Only the caller's query string should produce a 400. Zod failures raised later while reading
// stored rows are server-side data problems and must not be reported as a bad request.
class InvalidRunQuery extends Error {
  constructor(readonly issues: z.ZodError['issues']) {
    super('Invalid run query');
  }
}

function parseRunQuery<Schema extends z.ZodType>(schema: Schema, input: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new InvalidRunQuery(parsed.error.issues);
  return parsed.data;
}

const providerConditionRepairSchema = runScopeSchema
  .extend({ repairedCapabilityVersionId: z.string().min(1) })
  .strict();

const workflowCompilationRequestSchema = runScopeSchema
  .extend({
    workflowVersionId: z.string().min(1),
    source: z.unknown(),
  })
  .strict();

const healthResponseSchema = z.object({
  service: z.literal('backend'),
  status: z.literal('ok'),
});

// TODO(#148-transition-removal): remove this stale-client boundary after the local rename window.
const retiredProductionLikeEnvironmentId = 'production-like';
const renamedEnvironmentResponse = {
  error: 'environment-renamed',
  environmentId: retiredProductionLikeEnvironmentId,
  replacementEnvironmentId: 'production',
} as const;

function bodyCarriesRetiredEnvironmentId(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.environmentId === retiredProductionLikeEnvironmentId) return true;
  return (
    Array.isArray(body.environmentIds) &&
    body.environmentIds.includes(retiredProductionLikeEnvironmentId)
  );
}

async function requestCarriesRetiredEnvironment(context: Context): Promise<boolean> {
  const url = new URL(context.req.url);
  if (url.searchParams.getAll('environmentId').includes(retiredProductionLikeEnvironmentId)) {
    return true;
  }
  if (url.pathname.split('/').includes(retiredProductionLikeEnvironmentId)) return true;

  if (context.req.method === 'GET' || context.req.method === 'HEAD') return false;
  try {
    return bodyCarriesRetiredEnvironmentId(await context.req.raw.clone().json());
  } catch {
    return false;
  }
}

async function planningAuthorizationFailure(
  planningAuthorizer: PlanningAuthorizer | undefined,
  authorizationHeader: string | undefined,
  body: unknown,
) {
  if (!planningAuthorizer) {
    return { body: { error: 'planning-authorization-not-configured' }, status: 503 as const };
  }
  const actorRole = await planningAuthorizer.authorize({ authorizationHeader, body });
  return actorRole ? undefined : { body: { error: 'author-role-required' }, status: 403 as const };
}
const pinnedExecutionSelectionSchema = z
  .object({
    organizationId: z.string().min(1),
    approvedCapabilityVersionIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

const sourceConnectionScopeSchema = z
  .object({
    organizationId: z.string().min(1),
    environmentId: z.string().min(1),
  })
  .passthrough();

const databaseIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);

function bindHumanConfirmation(input: unknown, actorId: string, confirmedAt: string): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const request = input as Record<string, unknown>;
  const source = request.source as Record<string, unknown> | undefined;
  const manifest = request.manifest as Record<string, unknown> | undefined;
  const manifestSource = manifest?.source as Record<string, unknown> | undefined;
  const bind = (evidence: Record<string, unknown> | undefined) =>
    evidence?.kind === 'human-confirmed'
      ? { kind: 'human-confirmed', label: evidence.label, confirmedBy: actorId, confirmedAt }
      : evidence;
  return {
    ...request,
    ...(source
      ? {
          source: {
            ...source,
            ...('evidence' in source
              ? { evidence: bind(source.evidence as Record<string, unknown>) }
              : {}),
          },
        }
      : {}),
    ...(manifest ? { manifest: { ...manifest, source: bind(manifestSource) } } : {}),
  };
}

export function createApp(
  pool?: Pool,
  sourcePolicy: CapabilitySourcePolicy = { allowedHosts: [] },
  plannerModel?: PlannerModel,
  planningAuthorizer?: PlanningAuthorizer,
  workflowExecutionServices?: WorkflowExecutionServices,
  membershipAuthorizer?: MembershipAuthorizer,
  options: {
    customerAuth?: {
      routes: Hono;
      middleware: MiddlewareHandler;
      currentActor?: () => { actorId: string } | undefined;
    };
    demoAuth?: { routes: Hono };
    allowLegacySourceRoutes?: boolean;
    repositoryAnalysisConfigured?: boolean;
    burgerTownAllowedApplicationUrls?: readonly string[];
    burgerTownAllowedOpenApiUrls?: readonly string[];
    burgerTownPlan?: BurgerTownConnectionPlan;
    burgerTownSourcePolicy?: CapabilitySourcePolicy;
    burgerTownMonitor?: BurgerTownMonitor;
    planningTraceStore?: PlanningTraceStore;
    providerConditionRepairer?: ProviderConditionRepairer;
    workflowSandboxExecutor?: WorkflowSandboxExecutor;
    workflowSandboxTimeoutMs?: number;
  } = {},
) {
  const draftRequests = pool ? new DraftRequests(pool) : undefined;
  const sandboxTestRequests =
    pool && options.workflowSandboxExecutor
      ? new WorkflowSandboxTestRequests<Awaited<ReturnType<typeof runWorkflowSandboxTests>>>(
          options.workflowSandboxTimeoutMs ?? 2 * 60_000,
        )
      : undefined;
  const rediscoveryPolicy = registeredSourcePolicy(sourcePolicy, {
    serviceId: options.burgerTownPlan?.serviceId,
    urls: options.burgerTownAllowedOpenApiUrls,
    policy: options.burgerTownSourcePolicy,
  });
  const application = new Hono()
    .use(
      '/v1/*',
      cors({
        origin: (origin) =>
          !options.customerAuth && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
            ? origin
            : undefined,
      }),
    )
    .use('/v1/*', async (context, next) => {
      if (await requestCarriesRetiredEnvironment(context)) {
        return context.json(renamedEnvironmentResponse, 400);
      }
      await next();
    })
    .get('/health', (context) =>
      context.json(
        healthResponseSchema.parse({
          service: 'backend',
          status: 'ok',
        }),
      ),
    );

  if (options.customerAuth) {
    application.route('/', options.customerAuth.routes);
    application.use('/v1/*', options.customerAuth.middleware);
  } else if (options.demoAuth) {
    application.use(
      '/auth/*',
      cors({
        origin: (origin) =>
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : undefined,
        credentials: true,
      }),
    );
    application.route('/', options.demoAuth.routes);
  } else {
    application.use(
      '/auth/session',
      cors({
        origin: (origin) =>
          /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : undefined,
      }),
    );
    application.get('/auth/session', (context) => {
      context.header('Cache-Control', 'no-store');
      return context.json({ mode: 'demo' });
    });
  }

  if (!pool) return application;

  application.route(
    '/v1',
    repositoryContractRoutes(
      pool,
      membershipAuthorizer,
      options.repositoryAnalysisConfigured ?? false,
    ),
  );

  async function configureSandboxResource<T extends { organizationId: string }>(
    context: Context,
    schema: z.ZodType<T>,
    operation: (request: T, actorId: string) => Promise<unknown>,
    errorCode: string,
  ) {
    if (!workflowExecutionServices) {
      return Response.json({ error: 'workflow-sandbox-not-configured' }, { status: 503 });
    }
    try {
      const request = schema.parse(await context.req.json());
      const actor = await workflowExecutionServices.approvalAuthorizer.authorize({
        authorizationHeader: context.req.header('authorization'),
        organizationId: request.organizationId,
      });
      if (!actor) return Response.json({ error: 'admin-role-required' }, { status: 403 });
      return Response.json(await operation(request, actor.actorId), { status: 201 });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof InvalidSandboxTarget) {
        return Response.json({ error: errorCode, message: error.message }, { status: 400 });
      }
      throw error;
    }
  }

  async function authorizeOrganizationAdmin(
    authorizationHeader: string | undefined,
    organizationId: string,
  ) {
    if (!membershipAuthorizer) {
      return {
        denial: {
          body: { error: 'organization-authorization-not-configured' },
          status: 503 as const,
        },
      };
    }
    const actor = await membershipAuthorizer.authorize({
      authorizationHeader,
      organizationId,
      action: 'manage-organization',
    });
    return actor
      ? { actor }
      : { denial: { body: { error: 'admin-role-required' }, status: 403 as const } };
  }

  async function sendUsageReport(context: Context, format: 'json' | 'csv') {
    const parsed = usageReportQuerySchema.safeParse({
      organizationId: context.req.query('organizationId'),
      environmentId: context.req.query('environmentId'),
      workflowId: context.req.query('workflowId') || undefined,
      periodStart: context.req.query('periodStart'),
      periodEnd: context.req.query('periodEnd'),
      timeZone: context.req.query('timeZone'),
    });
    if (!parsed.success) {
      return context.json(
        { error: 'invalid-usage-report-query', issues: parsed.error.issues },
        400,
      );
    }
    const authorized = await authorizeOrganizationAdmin(
      context.req.header('authorization'),
      parsed.data.organizationId,
    );
    if (authorized.denial) {
      return context.json(authorized.denial.body, authorized.denial.status);
    }
    const report = await readUsageReport(pool!, parsed.data);
    if (format === 'csv') {
      return new Response(formatUsageReportCsv(report), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="atlas-usage.csv"',
        },
      });
    }
    return context.json(report);
  }

  async function authorizeWorkerScope(context: Context) {
    if (!workflowExecutionServices) {
      return { denial: context.json({ error: 'workflow-fetch-not-configured' }, 503) };
    }
    const organizationId = context.req.query('organizationId');
    const environmentId = context.req.query('environmentId');
    if (!organizationId || !environmentId) {
      return {
        denial: context.json({ error: 'organizationId-and-environmentId-required' }, 400),
      };
    }
    const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
      authorizationHeader: context.req.header('authorization'),
      organizationId,
      environmentId,
    });
    return authorized
      ? { scope: { organizationId, environmentId } }
      : { denial: context.json({ error: 'worker-authorization-required' }, 403) };
  }

  async function authorizeSourceConnection(
    authorizationHeader: string | undefined,
    body: unknown,
    action: 'connect-capability-source' | 'view-organization' = 'connect-capability-source',
  ) {
    const scope = sourceConnectionScopeSchema.parse(body);
    if (!membershipAuthorizer) {
      return {
        denial: {
          body: { error: 'source-authorization-not-configured' },
          status: 503 as const,
        },
      };
    }
    const actor = await membershipAuthorizer.authorize({
      authorizationHeader,
      organizationId: scope.organizationId,
      action,
    });
    if (!actor) {
      return {
        denial: { body: { error: 'source-author-role-required' }, status: 403 as const },
      };
    }
    const environment = await pool!.query(
      `SELECT 1 FROM environments WHERE organization_id = $1 AND id = $2`,
      [scope.organizationId, scope.environmentId],
    );
    if (!environment.rows[0]) {
      return {
        denial: { body: { error: 'source-environment-not-authorized' }, status: 403 as const },
      };
    }
    return { actor, scope };
  }

  async function authorizeOrganizationViewer(
    authorizationHeader: string | undefined,
    organizationId: string,
  ) {
    if (!membershipAuthorizer) {
      return {
        denial: {
          body: { error: 'organization-authorization-not-configured' },
          status: 503 as const,
        },
      };
    }
    const actor = await membershipAuthorizer.authorize({
      authorizationHeader,
      organizationId,
      action: 'view-organization',
    });
    return actor
      ? { actor }
      : { denial: { body: { error: 'organization-membership-required' }, status: 403 as const } };
  }

  async function authorizeCapabilityAnnotator(
    authorizationHeader: string | undefined,
    organizationId: string,
  ) {
    if (!membershipAuthorizer) {
      return {
        denial: {
          body: { error: 'organization-authorization-not-configured' },
          status: 503 as const,
        },
      };
    }
    const actor = await membershipAuthorizer.authorize({
      authorizationHeader,
      organizationId,
      action: 'annotate-capability',
    });
    return actor
      ? { actor }
      : { denial: { body: { error: 'organization-membership-required' }, status: 403 as const } };
  }

  return application
    .get('/v1/notifications/stream', async (context) => {
      const parsed = notificationsQuerySchema.safeParse({
        organizationId: context.req.query('organizationId'),
        environmentId: context.req.query('environmentId'),
      });
      if (!parsed.success) return context.json({ error: 'invalid-notifications-query' }, 400);
      const authorization = await authorizeOrganizationViewer(
        context.req.header('authorization'),
        parsed.data.organizationId,
      );
      if ('denial' in authorization)
        return context.json(authorization.denial.body, authorization.denial.status);
      return notificationStream(pool, parsed.data, context.req.raw.signal);
    })
    .get('/v1/notifications', async (context) => {
      try {
        const query = notificationsQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const authorization = await authorizeOrganizationViewer(
          context.req.header('authorization'),
          query.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        return context.json(await readNotifications(pool, query));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-notifications-query', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .delete('/v1/notifications', async (context) => {
      try {
        const body = clearNotificationsSchema.parse(await context.req.json());
        const authorization = await authorizeOrganizationViewer(
          context.req.header('authorization'),
          body.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        return context.json(await clearNotifications(pool, body.organizationId));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-notification-clear', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/notifications', async (context) => {
      try {
        const notification = createNotificationSchema.parse(await context.req.json());
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          notification.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        return context.json(await createNotification(pool, notification), 201);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-notification', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .patch('/v1/notifications/:notificationId/read', async (context) => {
      try {
        const body = readNotificationSchema.parse(await context.req.json());
        const authorization = await authorizeOrganizationViewer(
          context.req.header('authorization'),
          body.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        const notification = await markNotificationRead(
          pool,
          context.req.param('notificationId'),
          body.organizationId,
        );
        return notification
          ? context.json(notification)
          : context.json({ error: 'notification-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-notification-read', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .patch('/v1/notifications/:notificationId/resolve', async (context) => {
      try {
        const body = resolveNotificationSchema.parse(await context.req.json());
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          body.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        const notification = await resolveNotification(
          pool,
          context.req.param('notificationId'),
          body.organizationId,
          authorization.actor.actorId,
          body.reason,
        );
        return notification
          ? context.json(notification)
          : context.json({ error: 'notification-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-notification-resolution', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .post('/v1/capability-versions/:capabilityVersionId/safety-approval', async (context) => {
      if (!membershipAuthorizer) {
        return context.json({ error: 'organization-authorization-not-configured' }, 503);
      }
      try {
        const { organizationId } = capabilitySafetyApprovalSchema.parse(await context.req.json());
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId,
          action: 'approve-capability-safety',
        });
        if (!actor) return context.json({ error: 'admin-role-required' }, 403);
        const approval = await approveCapabilitySafety(
          pool,
          organizationId,
          context.req.param('capabilityVersionId'),
          actor.actorId,
        );
        return approval
          ? context.json(approval, 201)
          : context.json({ error: 'capability-version-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-capability-safety-approval', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .get('/v1/organizations/:organizationId/admin-suite', async (context) => {
      const authorization = await authorizeOrganizationViewer(
        context.req.header('authorization'),
        context.req.param('organizationId'),
      );
      if ('denial' in authorization) {
        return context.json(authorization.denial.body, authorization.denial.status);
      }
      const suite = await readAdminSuite(pool, context.req.param('organizationId'));
      return suite ? context.json(suite) : context.json({ error: 'organization-not-found' }, 404);
    })
    .put(
      '/v1/organizations/:organizationId/environments/:environmentId/capability-host-policies/:capabilityIdentityId/:hostname',
      async (context) => {
        const route = capabilityHostPolicyRouteSchema.safeParse({
          organizationId: context.req.param('organizationId'),
          environmentId: context.req.param('environmentId'),
          capabilityIdentityId: context.req.param('capabilityIdentityId'),
          hostname: context.req.param('hostname'),
        });
        if (!route.success) {
          return context.json(
            { error: 'invalid-capability-host-policy', issues: route.error.issues },
            400,
          );
        }
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          route.data.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        try {
          const policy = capabilityHostPolicySchema.parse(await context.req.json());
          const saved = await upsertCapabilityHostPolicy(pool, {
            ...route.data,
            ...policy,
            actorId: authorization.actor.actorId,
          });
          return saved
            ? context.json(saved)
            : context.json({ error: 'environment-or-capability-not-found' }, 404);
        } catch (error) {
          if (error instanceof z.ZodError) {
            return context.json(
              { error: 'invalid-capability-host-policy', issues: error.issues },
              400,
            );
          }
          throw error;
        }
      },
    )
    .delete(
      '/v1/organizations/:organizationId/environments/:environmentId/capability-host-policies/:capabilityIdentityId/:hostname',
      async (context) => {
        const route = capabilityHostPolicyRouteSchema.safeParse({
          organizationId: context.req.param('organizationId'),
          environmentId: context.req.param('environmentId'),
          capabilityIdentityId: context.req.param('capabilityIdentityId'),
          hostname: context.req.param('hostname'),
        });
        if (!route.success) {
          return context.json(
            { error: 'invalid-capability-host-policy', issues: route.error.issues },
            400,
          );
        }
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          route.data.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        const revoked = await revokeCapabilityHostPolicy(pool, {
          ...route.data,
          actorId: authorization.actor.actorId,
        });
        return revoked ? context.body(null, 204) : context.json({ error: 'policy-not-found' }, 404);
      },
    )
    .patch('/v1/organizations/:organizationId/settings', async (context) => {
      const organizationId = context.req.param('organizationId');
      const authorization = await authorizeOrganizationAdmin(
        context.req.header('authorization'),
        organizationId,
      );
      if ('denial' in authorization) {
        return context.json(authorization.denial.body, authorization.denial.status);
      }
      try {
        const settings = organizationSettingsSchema.parse(await context.req.json());
        const updated = await updateOrganizationSettings(
          pool,
          organizationId,
          settings,
          authorization.actor.actorId,
        );
        return updated
          ? context.json(updated)
          : context.json({ error: 'organization-or-environment-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-organization-settings', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .put('/v1/organizations/:organizationId/users/:userId/membership', async (context) => {
      const organizationId = context.req.param('organizationId');
      const authorization = await authorizeOrganizationAdmin(
        context.req.header('authorization'),
        organizationId,
      );
      if ('denial' in authorization) {
        return context.json(authorization.denial.body, authorization.denial.status);
      }
      try {
        const { role } = membershipUpdateSchema.parse(await context.req.json());
        const membership = await updateMembershipRole(
          pool,
          organizationId,
          context.req.param('userId'),
          role,
          authorization.actor.actorId,
          Boolean(options.customerAuth),
        );
        return membership
          ? context.json(membership)
          : context.json({ error: 'membership-not-found' }, 404);
      } catch (error) {
        if (error instanceof LastOrganizationAdmin) {
          return context.json({ error: 'last-administrator', message: error.message }, 409);
        }
        if (error instanceof MembershipAdminRequired) {
          return context.json({ error: 'permission-denied', message: error.message }, 403);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-membership', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .put(
      '/v1/organizations/:organizationId/environments/:environmentId/secret-references/:alias',
      async (context) => {
        const organizationId = context.req.param('organizationId');
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        try {
          const reference = secretReferenceSchema.parse(await context.req.json());
          const saved = await upsertSecretReference(pool, {
            organizationId,
            environmentId: context.req.param('environmentId'),
            alias: context.req.param('alias'),
            description: reference.description,
            actorId: authorization.actor.actorId,
          });
          return saved
            ? context.json(saved)
            : context.json({ error: 'environment-not-found' }, 404);
        } catch (error) {
          if (error instanceof z.ZodError) {
            return context.json({ error: 'invalid-secret-reference', issues: error.issues }, 400);
          }
          throw error;
        }
      },
    )
    .get('/v1/audit-entries', async (context) => {
      try {
        const query = auditHistoryQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        return context.json(await readAuditHistory(pool, query));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-audit-history-query', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/environment-workers', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'environment-worker-registration-not-configured' }, 503);
      }
      try {
        const declaration = environmentWorkerDeclarationSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: declaration.organizationId,
          environmentId: declaration.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        await declareEnvironmentWorker(pool, declaration);
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-environment-worker', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/workflow-migration-candidates', async (context) => {
      try {
        const body = await context.req.json();
        const authorizationFailure = await planningAuthorizationFailure(
          planningAuthorizer,
          context.req.header('authorization'),
          body,
        );
        if (authorizationFailure) {
          return context.json(authorizationFailure.body, authorizationFailure.status);
        }
        return context.json(
          await generateWorkflowMigrationCandidate(pool, plannerModel, body),
          201,
        );
      } catch (error) {
        if (error instanceof WorkflowMigrationSourceNotFound) {
          return context.json({ error: 'workflow-migration-source-not-found' }, 404);
        }
        if (error instanceof WorkflowMigrationVersionIdentityConflict) {
          return context.json({ error: 'workflow-migration-version-id-must-be-new' }, 409);
        }
        if (error instanceof WorkflowMigrationPlannerRequired) {
          return context.json({ error: 'workflow-migration-planner-required' }, 503);
        }
        if (error instanceof PlannerUnavailableError) {
          return context.json(
            error.code
              ? { error: 'planner-unavailable', reason: error.code }
              : { error: 'planner-unavailable' },
            503,
          );
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-migration', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/workflow-migration-candidates/:candidateId', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      try {
        const candidate = await readWorkflowMigrationCandidate(
          pool,
          organizationId,
          context.req.param('candidateId'),
        );
        return candidate ? context.json(candidate) : context.json({ error: 'not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-migration-query', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .patch('/v1/workflow-migration-candidates/:candidateId', async (context) => {
      try {
        const body = await context.req.json();
        const authorizationFailure = await planningAuthorizationFailure(
          planningAuthorizer,
          context.req.header('authorization'),
          body,
        );
        if (authorizationFailure) {
          return context.json(authorizationFailure.body, authorizationFailure.status);
        }
        return context.json(
          await correctWorkflowMigrationCandidate(pool, context.req.param('candidateId'), body),
        );
      } catch (error) {
        if (error instanceof WorkflowMigrationCandidateNotFound) {
          return context.json({ error: 'workflow-migration-candidate-not-found' }, 404);
        }
        if (error instanceof WorkflowMigrationCorrectionRejected) {
          return context.json(
            { error: 'workflow-migration-correction-rejected', message: error.message },
            409,
          );
        }
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-migration-correction', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .post('/v1/workflow-migration-candidates/:candidateId/activation', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'workflow-activation-not-configured' }, 503);
      }
      try {
        const body = z
          .object({ organizationId: z.string().min(1), environmentId: z.string().min(1) })
          .strict()
          .parse(await context.req.json());
        const actor = await workflowExecutionServices.approvalAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: body.organizationId,
        });
        if (!actor) return context.json({ error: 'admin-role-required' }, 403);
        return context.json(
          await activateWorkflowMigrationCandidate(
            pool,
            context.req.param('candidateId'),
            body.organizationId,
            body.environmentId,
            actor.actorId,
          ),
        );
      } catch (error) {
        if (error instanceof WorkerIrVersionUnsupported) {
          return context.json({ error: error.code, message: error.message }, 409);
        }
        if (error instanceof WorkflowMigrationActivationConflict) {
          return context.json(
            { error: 'workflow-activation-conflict', message: error.message },
            409,
          );
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-activation', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/workflow-activations/:activationId/rollback', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'workflow-rollback-not-configured' }, 503);
      }
      try {
        const body = z
          .object({ organizationId: z.string().min(1), environmentId: z.string().min(1) })
          .strict()
          .parse(await context.req.json());
        const actor = await workflowExecutionServices.approvalAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: body.organizationId,
        });
        if (!actor) return context.json({ error: 'admin-role-required' }, 403);
        return context.json(
          await rollbackWorkflowActivation(
            pool,
            context.req.param('activationId'),
            body.organizationId,
            body.environmentId,
            actor.actorId,
          ),
        );
      } catch (error) {
        if (error instanceof WorkflowMigrationRollbackConflict) {
          return context.json({ error: 'workflow-rollback-conflict', message: error.message }, 409);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-rollback', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/workflow-versions', async (context) => {
      try {
        const query = workflowVersionHistoryQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        return context.json(await readWorkflowVersionHistory(pool, query));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-version-query', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .get('/v1/workflow-editor-drafts', async (context) => {
      try {
        const scope = workflowEditorScopeSchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const failure = await planningAuthorizationFailure(
          planningAuthorizer,
          context.req.header('authorization'),
          scope,
        );
        if (failure) return context.json(failure.body, failure.status);
        return context.json(await listWorkflowEditorDrafts(pool, scope));
      } catch (error) {
        if (error instanceof z.ZodError)
          return context.json(
            { error: 'invalid-workflow-editor-drafts-query', issues: error.issues },
            400,
          );
        throw error;
      }
    })
    .get('/v1/workflow-editor-drafts/:workflowId', async (context) => {
      try {
        const scope = workflowEditorScopeSchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const failure = await planningAuthorizationFailure(
          planningAuthorizer,
          context.req.header('authorization'),
          scope,
        );
        if (failure) return context.json(failure.body, failure.status);
        return context.json(
          await readWorkflowEditorDraft(pool, {
            ...scope,
            workflowId: context.req.param('workflowId'),
          }),
        );
      } catch (error) {
        if (error instanceof WorkflowEditorDraftNotFound)
          return context.json({ error: 'workflow-editor-draft-not-found' }, 404);
        if (error instanceof z.ZodError)
          return context.json(
            { error: 'invalid-workflow-editor-draft', issues: error.issues },
            400,
          );
        throw error;
      }
    })
    .put('/v1/workflow-editor-drafts/:workflowId', async (context) => {
      try {
        const request = workflowEditorSaveSchema.parse(await context.req.json());
        const failure = await planningAuthorizationFailure(
          planningAuthorizer,
          context.req.header('authorization'),
          request,
        );
        if (failure) return context.json(failure.body, failure.status);
        return context.json(
          await saveWorkflowEditorDraft(pool, {
            ...request,
            workflowId: context.req.param('workflowId'),
          }),
        );
      } catch (error) {
        if (error instanceof WorkflowEditorDraftConflict)
          return context.json(
            { error: 'workflow-editor-draft-conflict', message: error.message },
            409,
          );
        if (error instanceof z.ZodError)
          return context.json(
            { error: 'invalid-workflow-editor-draft', issues: error.issues },
            400,
          );
        throw error;
      }
    })
    .post('/v1/workflow-editor-drafts/:workflowId/validation', async (context) => {
      try {
        const request = workflowEditorValidationSchema.parse(await context.req.json());
        const failure = await planningAuthorizationFailure(
          planningAuthorizer,
          context.req.header('authorization'),
          request,
        );
        if (failure) return context.json(failure.body, failure.status);
        return context.json(
          await validateWorkflowEditorDocument(pool, {
            ...request,
            workflowId: context.req.param('workflowId'),
          }),
        );
      } catch (error) {
        if (error instanceof WorkflowEditorDraftConflict)
          return context.json(
            { error: 'workflow-editor-draft-conflict', message: error.message },
            409,
          );
        if (error instanceof WorkflowEditorCompilationFailed)
          return context.json(
            {
              error: 'workflow-editor-compilation-failed',
              message: error.message,
              diagnostics: error.diagnostics,
            },
            422,
          );
        if (error instanceof z.ZodError)
          return context.json(
            { error: 'invalid-workflow-editor-validation', issues: error.issues },
            400,
          );
        throw error;
      }
    })
    .post('/v1/workflow-editor-drafts/:workflowId/versions', async (context) => {
      try {
        const request = workflowEditorVersionSchema.parse(await context.req.json());
        const failure = await planningAuthorizationFailure(
          planningAuthorizer,
          context.req.header('authorization'),
          request,
        );
        if (failure) return context.json(failure.body, failure.status);
        return context.json(
          await createWorkflowEditorVersion(pool, {
            ...request,
            workflowId: context.req.param('workflowId'),
          }),
          201,
        );
      } catch (error) {
        if (error instanceof WorkflowEditorDraftNotFound)
          return context.json({ error: 'workflow-editor-draft-not-found' }, 404);
        if (
          error instanceof WorkflowEditorDraftConflict ||
          error instanceof WorkflowCatalogVersionConflict
        )
          return context.json(
            { error: 'workflow-editor-draft-conflict', message: error.message },
            409,
          );
        if (error instanceof WorkflowEditorCompilationFailed)
          return context.json(
            {
              error: 'workflow-editor-compilation-failed',
              message: error.message,
              diagnostics: error.diagnostics,
            },
            422,
          );
        if (error instanceof z.ZodError)
          return context.json(
            { error: 'invalid-workflow-editor-version', issues: error.issues },
            400,
          );
        throw error;
      }
    })
    .get('/v1/workflow-catalog', async (context) => {
      try {
        const query = workflowCatalogQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        return context.json(await readWorkflowCatalog(pool, query));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-catalog-query', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .get('/v1/workflow-catalog/:workflowId', async (context) => {
      try {
        const scope = workflowCatalogQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        return context.json(
          await readWorkflowCatalogDetail(pool, {
            ...scope,
            workflowId: context.req.param('workflowId'),
          }),
        );
      } catch (error) {
        if (error instanceof WorkflowCatalogWorkflowNotFound) {
          return context.json({ error: 'workflow-not-found-in-scope' }, 404);
        }
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-catalog-detail-query', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .get('/v1/workflow-catalog/:workflowId/versions/:workflowVersionId', async (context) => {
      try {
        const scope = workflowCatalogQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        return context.json(
          await readWorkflowCatalogVersion(pool, {
            ...scope,
            workflowId: context.req.param('workflowId'),
            workflowVersionId: context.req.param('workflowVersionId'),
          }),
        );
      } catch (error) {
        if (error instanceof WorkflowCatalogWorkflowNotFound) {
          return context.json({ error: 'workflow-version-not-found-in-scope' }, 404);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-catalog-version-query' }, 400);
        }
        throw error;
      }
    })
    .post('/v1/workflow-catalog/versions', async (context) => {
      if (!planningAuthorizer) {
        return context.json({ error: 'planning-authorization-not-configured' }, 503);
      }
      try {
        const request = saveWorkflowCatalogVersionSchema.parse(await context.req.json());
        const actorRole = await planningAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          body: request,
        });
        if (!actorRole) return context.json({ error: 'author-role-required' }, 403);
        if (request.status === 'active' || request.status === 'approved-inactive') {
          return context.json({ error: 'workflow-approval-route-required' }, 403);
        }
        return context.json(await saveWorkflowCatalogVersion(pool, request), 201);
      } catch (error) {
        if (error instanceof WorkflowCatalogVersionConflict) {
          return context.json(
            { error: 'workflow-catalog-version-conflict', message: error.message },
            409,
          );
        }
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-catalog-version', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .get('/v1/workflow-lifecycle', async (context) => {
      try {
        const query = workflowLifecycleQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        return context.json(await readWorkflowLifecycle(pool, query));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-lifecycle-query', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .get('/v1/workflow-version-diffs', async (context) => {
      try {
        const query = workflowVersionDiffQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
          fromVersionId: context.req.query('fromVersionId'),
          toVersionId: context.req.query('toVersionId'),
        });
        return context.json(await compareWorkflowVersions(pool, query));
      } catch (error) {
        if (error instanceof WorkflowVersionNotFound) {
          return context.json({ error: 'workflow-version-not-found' }, 404);
        }
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-version-diff', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .post('/v1/workflow-reviews', async (context) => {
      try {
        const request = workflowReviewRequestSchema.parse(await context.req.json());
        return context.json(await buildWorkflowReview(pool, request));
      } catch (error) {
        if (error instanceof WorkflowMigrationDiffNotFound) {
          return context.json({ error: 'migration-capability-diff-not-found' }, 404);
        }
        if (error instanceof WorkflowReviewCandidateConflict) {
          return context.json({ error: 'workflow-review-candidate-conflict' }, 409);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-review', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/workflow-edits', async (context) => {
      try {
        const request = workflowEditRequestSchema.parse(await context.req.json());
        return context.json(await createWorkflowEdit(pool, request));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-edit', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/runs', async (context) => {
      try {
        const query = parseRunQuery(runsQuerySchema, {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
          state: context.req.query('state'),
          intakeReference: context.req.query('intakeReference'),
        });
        return context.json(await readWorkflowRuns(pool, query));
      } catch (error) {
        if (error instanceof InvalidRunQuery) {
          return context.json({ error: 'invalid-runs-query', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/usage-report', (context) => sendUsageReport(context, 'json'))
    .get('/v1/usage-report.csv', (context) => sendUsageReport(context, 'csv'))
    .get('/v1/runs/:runId', async (context) => {
      try {
        const scope = parseRunQuery(runScopeSchema, {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const run = await readWorkflowRun(pool, context.req.param('runId'), scope);
        return run ? context.json(run) : context.json({ error: 'run-not-found' }, 404);
      } catch (error) {
        if (error instanceof InvalidRunQuery) {
          return context.json({ error: 'invalid-run-query', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/workflow-schedules', async (context) => {
      if (!membershipAuthorizer) {
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      }
      try {
        const request = workflowScheduleCreateSchema.parse(await context.req.json());
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        return context.json(await createWorkflowSchedule(pool, request, actor.actorId), 201);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-schedule', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/workflow-schedules', async (context) => {
      if (!membershipAuthorizer) {
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      }
      try {
        const query = workflowSchedulesQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: query.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        return context.json(await readWorkflowSchedules(pool, query));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-workflow-schedule-query', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .patch('/v1/workflow-schedules/:scheduleId', async (context) => {
      if (!membershipAuthorizer) {
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      }
      try {
        const request = workflowScheduleUpdateSchema.parse(await context.req.json());
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        return context.json(
          await updateWorkflowSchedule(pool, context.req.param('scheduleId'), request),
        );
      } catch (error) {
        if (error instanceof WorkflowScheduleNotFound) {
          return context.json({ error: 'workflow-schedule-not-found' }, 404);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-schedule', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/capability-loss-overrides', async (context) => {
      try {
        const request = capabilityLossOverrideSchema.parse(await context.req.json());
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          request.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        return context.json(
          await createCapabilityLossOverride(pool, request, authorization.actor.actorId),
          201,
        );
      } catch (error) {
        if (error instanceof CapabilityLossOverrideConflict) {
          return context.json(
            { error: 'capability-loss-override-conflict', message: error.message },
            409,
          );
        }
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-capability-loss-override', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .post('/v1/capability-loss-overrides/:overrideId/revocation', async (context) => {
      try {
        const request = revokeCapabilityLossOverrideSchema.parse(await context.req.json());
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          request.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        await revokeCapabilityLossOverride(
          pool,
          context.req.param('overrideId'),
          request,
          authorization.actor.actorId,
        );
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof CapabilityLossOverrideNotFound) {
          return context.json({ error: 'capability-loss-override-not-found' }, 404);
        }
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-capability-loss-override-revocation', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .post('/v1/webhook-runs', async (context) => {
      if (!membershipAuthorizer) {
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      }
      try {
        const request = queueWebhookRunCommandSchema.parse(await context.req.json());
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        return context.json(await queueWebhookRunCommand(pool, request), 202);
      } catch (error) {
        if (error instanceof WebhookDeliveryConflict) {
          return context.json({ error: 'conflicting-webhook-delivery' }, 409);
        }
        if (error instanceof WebhookRunUnavailable) {
          return context.json({ error: 'webhook-run-unavailable', blockers: error.blockers }, 409);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-webhook-payload', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/webhook-runs/deliveries/:deliveryId', async (context) => {
      if (!membershipAuthorizer)
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      try {
        const scope = parseRunQuery(webhookDeliveryQuerySchema, {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
          workflowId: context.req.query('workflowId'),
          payloadFingerprint: context.req.query('payloadFingerprint'),
          deliveryId: context.req.param('deliveryId'),
        });
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: scope.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        const delivery = await readWebhookDelivery(pool, scope);
        return delivery
          ? context.json(delivery)
          : context.json({ error: 'webhook-delivery-not-found' }, 404);
      } catch (error) {
        if (error instanceof WebhookDeliveryConflict)
          return context.json({ error: 'conflicting-webhook-delivery' }, 409);
        if (error instanceof InvalidRunQuery)
          return context.json({ error: 'invalid-run-query', issues: error.issues }, 400);
        throw error;
      }
    })
    .get('/v1/webhook-run-readiness', async (context) => {
      if (!membershipAuthorizer)
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      try {
        const scope = parseRunQuery(webhookRunReadinessQuerySchema, {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
          workflowId: context.req.query('workflowId'),
        });
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: scope.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        return context.json(await readWebhookRunReadiness(pool, scope));
      } catch (error) {
        if (error instanceof ApiWorkflowNameNotFound)
          return context.json({ error: 'unknown-workflow-id' }, 404);
        if (error instanceof InvalidRunQuery)
          return context.json({ error: 'invalid-run-query', issues: error.issues }, 400);
        throw error;
      }
    })
    .get('/v1/api-run-readiness', async (context) => {
      if (!membershipAuthorizer) {
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      }
      try {
        const scope = parseRunQuery(apiRunReadinessQuerySchema, {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
          workflowName: context.req.query('workflowName'),
        });
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: scope.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        return context.json(await readApiRunReadinessByName(pool, scope));
      } catch (error) {
        if (error instanceof ApiWorkflowNameNotFound) {
          return context.json({ error: 'unknown-workflow-name' }, 404);
        }
        if (error instanceof ApiWorkflowNameAmbiguous) {
          return context.json(
            { error: 'ambiguous-workflow-name', workflowIds: error.workflowIds },
            409,
          );
        }
        if (error instanceof InvalidRunQuery) {
          return context.json({ error: 'invalid-run-query', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/api-runs', async (context) => {
      if (!membershipAuthorizer) {
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      }
      try {
        const request = queueApiRunCommandSchema.parse(await context.req.json());
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        return context.json(await queueApiRunCommand(pool, request), 202);
      } catch (error) {
        if (error instanceof WebhookDeliveryConflict) {
          return context.json({ error: 'conflicting-api-delivery' }, 409);
        }
        if (error instanceof WebhookRunUnavailable) {
          return context.json({ error: 'api-run-unavailable', blockers: error.blockers }, 409);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-api-payload', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/run-command-status/:commandId', async (context) => {
      if (!membershipAuthorizer) {
        return context.json({ error: 'run-intake-authorization-not-configured' }, 503);
      }
      try {
        const scope = parseRunQuery(runScopeSchema, {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: scope.organizationId,
          action: 'start-workflow-run',
        });
        if (!actor) return context.json({ error: 'run-intake-authorization-required' }, 403);
        const command = await readRunCommand(pool, context.req.param('commandId'), scope);
        return command
          ? context.json(command)
          : context.json({ error: 'run-command-not-found' }, 404);
      } catch (error) {
        if (error instanceof InvalidRunQuery) {
          return context.json({ error: 'invalid-run-query', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/run-commands/next', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'run-command-polling-not-configured' }, 503);
      }
      try {
        const scope = runScopeSchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const workerId = z.string().min(1).parse(context.req.query('workerId'));
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          ...scope,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const command = await claimNextRunCommand(pool, { ...scope, workerId });
        return command ? context.json(command) : context.body(null, 204);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-run-command-query', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .patch('/v1/run-commands/:commandId', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'run-command-polling-not-configured' }, 503);
      }
      try {
        const input = runCommandResultSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: input.organizationId,
          environmentId: input.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const recorded = await recordRunCommandResult(pool, context.req.param('commandId'), input);
        return recorded
          ? context.body(null, 204)
          : context.json({ error: 'run-command-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-run-command-result', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/runs/:runId/attempts', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'run-reporting-not-configured' }, 503);
      }
      try {
        const input = stepAttemptSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: input.organizationId,
          environmentId: input.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const recorded = await recordWorkflowStepAttempt(pool, context.req.param('runId'), input);
        return recorded ? context.body(null, 204) : context.json({ error: 'run-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-step-attempt', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/runs/:runId/provider-condition-repair', async (context) => {
      if (!workflowExecutionServices?.repairAuthorizer || !options.providerConditionRepairer) {
        return context.json({ error: 'provider-condition-repair-not-configured' }, 503);
      }
      try {
        const request = providerConditionRepairSchema.parse(await context.req.json());
        const actor = await workflowExecutionServices.repairAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
          action: 'retry_step',
        });
        if (!actor) return context.json({ error: 'operator-role-required' }, 403);
        const run = await readWorkflowRun(pool, context.req.param('runId'), request);
        if (!run) return context.json({ error: 'run-not-found' }, 404);
        if (
          !run.controls.retryStep.enabled ||
          run.controls.retryStep.repairedCapabilityVersionId !== request.repairedCapabilityVersionId
        ) {
          return context.json({ error: 'provider-condition-repair-rejected' }, 409);
        }
        if (
          !(await options.providerConditionRepairer.repair(request.repairedCapabilityVersionId))
        ) {
          return context.json({ error: 'provider-condition-repair-failed' }, 502);
        }
        await pool.query(
          `INSERT INTO audit_entries
            (organization_id, environment_id, event_type, subject_type, subject_id, actor_id,
             details)
           VALUES ($1, $2, 'repair', 'workflow-run', $3, $4, $5)`,
          [
            request.organizationId,
            request.environmentId,
            context.req.param('runId'),
            actor.actorId,
            {
              operation: 'provider-condition-repaired',
              repairedCapabilityVersionId: request.repairedCapabilityVersionId,
            },
          ],
        );
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-provider-condition-repair' }, 400);
        }
        throw error;
      }
    })
    .post('/v1/runs/:runId/repairs', async (context) => {
      if (!workflowExecutionServices?.repairAuthorizer) {
        return context.json({ error: 'run-repair-not-configured' }, 503);
      }
      try {
        const request = runRepairRequestSchema.parse(await context.req.json());
        const actor = await workflowExecutionServices.repairAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
          action: request.action,
        });
        if (!actor) return context.json({ error: 'operator-role-required' }, 403);
        return context.json(
          await queueWorkflowRunRepair(pool, context.req.param('runId'), request, actor),
          202,
        );
      } catch (error) {
        if (error instanceof WorkflowRunNotFound) {
          return context.json({ error: 'run-not-found' }, 404);
        }
        if (error instanceof WorkflowRunRepairRejected) {
          return context.json({ error: 'run-repair-rejected', message: error.message }, 409);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-run-repair', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/runs/:runId/completion', async (context) => {
      if (!workflowExecutionServices)
        return context.json({ error: 'run-reporting-not-configured' }, 503);
      try {
        const input = runCompletionSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: input.organizationId,
          environmentId: input.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const recorded = await recordRunCompletion(pool, context.req.param('runId'), input);
        return recorded ? context.body(null, 204) : context.json({ error: 'run-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError)
          return context.json({ error: 'invalid-run-completion', issues: error.issues }, 400);
        throw error;
      }
    })
    .patch('/v1/runs/:runId/state', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'run-reporting-not-configured' }, 503);
      }
      try {
        const input = runOutcomeSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: input.organizationId,
          environmentId: input.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const recorded = await recordWorkflowRunOutcome(pool, context.req.param('runId'), input);
        return recorded ? context.body(null, 204) : context.json({ error: 'run-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-run-outcome', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/runs/:runId/lifecycle', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'run-reporting-not-configured' }, 503);
      }
      try {
        const input = runLifecycleEventSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: input.organizationId,
          environmentId: input.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const runId = context.req.param('runId');
        const lifecycle =
          input.event === 'started'
            ? await recordRunLifecycleStarted(pool, runId, input)
            : await recordRunLifecycleEnded(pool, runId, input);
        return context.json(lifecycle, 200);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-run-lifecycle-event', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/repair-commands/next', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'run-repair-not-configured' }, 503);
      }
      try {
        const scope = runScopeSchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          ...scope,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const command = await claimNextRepairCommand(pool, scope);
        return command ? context.json(command) : context.body(null, 204);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-repair-command-query', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .patch('/v1/repair-commands/:repairId', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'run-repair-not-configured' }, 503);
      }
      try {
        const input = repairCommandResultSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: input.organizationId,
          environmentId: input.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const recorded = await recordRepairCommandResult(
          pool,
          context.req.param('repairId'),
          input,
        );
        return recorded
          ? context.body(null, 204)
          : context.json({ error: 'repair-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-repair-command-result', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .post('/v1/workflow-approvals', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'workflow-approval-not-configured' }, 503);
      }
      if (!workflowExecutionServices.bundleSigner) {
        return context.json({ error: 'bundle-signing-not-configured' }, 503);
      }
      try {
        const request = workflowApprovalRequestSchema.parse(await context.req.json());
        const actor = await workflowExecutionServices.approvalAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
        });
        if (!actor) return context.json({ error: 'admin-role-required' }, 403);
        const result = await approveWorkflow(
          pool,
          request,
          actor,
          workflowExecutionServices.bundleSigner,
        );
        if (!result.approved) {
          return context.json(
            { error: 'workflow-not-approvable', diagnostics: result.validation.diagnostics },
            422,
          );
        }
        return context.json(result, 201);
      } catch (error) {
        if (error instanceof WorkflowSandboxTestsUnavailable) {
          return context.json(
            {
              error: 'workflow-sandbox-tests-unavailable',
              status: error.readinessStatus,
            },
            422,
          );
        }
        if (error instanceof WorkflowApprovalConflict) {
          return context.json({ error: 'workflow-approval-conflict', message: error.message }, 409);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-approval', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .on(
      ['PUT', 'GET', 'DELETE'],
      '/v1/workflow-sandbox-test-requests/:requestId',
      async (context) => {
        if (
          !workflowExecutionServices ||
          !options.workflowSandboxExecutor ||
          !sandboxTestRequests
        ) {
          return context.json({ error: 'workflow-sandbox-not-configured' }, 503);
        }
        try {
          const requestId = z.string().uuid().parse(context.req.param('requestId'));
          const request =
            context.req.method === 'PUT'
              ? workflowSandboxRequestSchema.parse(await context.req.json())
              : z
                  .object({ organizationId: z.string().min(1), environmentId: z.string().min(1) })
                  .strict()
                  .parse({
                    organizationId: context.req.query('organizationId'),
                    environmentId: context.req.query('environmentId'),
                  });
          const admin = await workflowExecutionServices.approvalAuthorizer.authorize({
            authorizationHeader: context.req.header('authorization'),
            organizationId: request.organizationId,
          });
          if (!admin) {
            const planningFail = await planningAuthorizationFailure(
              planningAuthorizer,
              context.req.header('authorization'),
              request,
            );
            if (planningFail) return context.json(planningFail.body, planningFail.status);
          }
          const owner = {
            actorId: admin?.actorId ?? options.customerAuth?.currentActor?.()?.actorId ?? 'author',
            organizationId: request.organizationId,
            environmentId: request.environmentId,
          };
          if (context.req.method === 'GET') {
            const state = sandboxTestRequests.read(requestId, owner);
            return state
              ? context.json(state)
              : context.json({ error: 'workflow-sandbox-test-request-not-found' }, 404);
          }
          if (context.req.method === 'DELETE') {
            const state = sandboxTestRequests.cancel(requestId, owner);
            return state
              ? context.json(state)
              : context.json({ error: 'workflow-sandbox-test-request-not-found' }, 404);
          }
          const sandboxRequest = workflowSandboxRequestSchema.parse(request);
          const state = sandboxTestRequests.start(
            requestId,
            owner,
            sha256(JSON.stringify(sandboxRequest)),
            (signal, onProgress) =>
              runWorkflowSandboxTests(
                pool,
                options.workflowSandboxExecutor!,
                sandboxRequest,
                owner.actorId,
                signal,
                onProgress,
              ),
          );
          return state
            ? context.json(state, 201)
            : context.json({ error: 'workflow-sandbox-test-request-conflict' }, 409);
        } catch (error) {
          if (error instanceof z.ZodError) {
            return context.json({ error: 'invalid-workflow-sandbox-test-request' }, 400);
          }
          throw error;
        }
      },
    )
    .post('/v1/workflow-sandbox-tests', async (context) => {
      if (!workflowExecutionServices || !options.workflowSandboxExecutor) {
        return context.json({ error: 'workflow-sandbox-not-configured' }, 503);
      }
      try {
        const request = workflowSandboxRequestSchema.parse(await context.req.json());
        const actor = await workflowExecutionServices.approvalAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
        });
        if (!actor) {
          if (!planningAuthorizer) return context.json({ error: 'admin-role-required' }, 403);
          const planningFail = await planningAuthorizationFailure(
            planningAuthorizer,
            context.req.header('authorization'),
            request,
          );
          if (planningFail) return context.json({ error: 'author-role-required' }, 403);
        }
        return context.json(
          await runWorkflowSandboxTests(
            pool,
            options.workflowSandboxExecutor,
            request,
            actor?.actorId ?? options.customerAuth?.currentActor?.()?.actorId ?? 'author',
          ),
          201,
        );
      } catch (error) {
        if (error instanceof InvalidSandboxTarget) {
          return context.json(
            { error: 'invalid-workflow-sandbox-target', message: error.message },
            400,
          );
        }
        if (error instanceof WorkflowSandboxTestsUnavailable) {
          return context.json(
            {
              error: 'workflow-sandbox-tests-unavailable',
              status: error.readinessStatus,
            },
            503,
          );
        }
        if (error instanceof WorkflowSandboxExecutionFailed) {
          return context.json({ error: 'workflow-sandbox-execution-failed' }, 502);
        }
        if (error instanceof z.ZodError || error instanceof TypeError) {
          console.error('workflow-sandbox-request-or-evidence-invalid', {
            category: error instanceof z.ZodError ? 'schema-error' : 'type-error',
            frames: error.stack
              ?.split('\n')
              .filter((line) => /^\s+at /.test(line))
              .slice(0, 8),
            ...(error instanceof z.ZodError
              ? { issues: error.issues.map(({ code, path }) => ({ code, path })) }
              : {}),
          });
          return context.json({ error: 'invalid-workflow-sandbox-test' }, 400);
        }
        throw error;
      }
    })
    .post('/v1/capability-sandbox-targets', (context) =>
      configureSandboxResource(
        context,
        capabilitySandboxTargetSchema,
        (request, actorId) => configureCapabilitySandboxTarget(pool, request, actorId),
        'invalid-capability-sandbox-target',
      ),
    )
    .post('/v1/capability-test-data-profiles', (context) =>
      configureSandboxResource(
        context,
        capabilityTestDataProfileSchema,
        (request, actorId) => configureCapabilityTestDataProfile(pool, request, actorId),
        'invalid-capability-test-data-profile',
      ),
    )
    .post('/v1/workflow-sandbox-retest-policies', (context) =>
      configureSandboxResource(
        context,
        workflowSandboxRetestPolicySchema,
        (request) => configureWorkflowSandboxRetestPolicy(pool, request),
        'invalid-workflow-sandbox-retest-policy',
      ),
    )
    .get('/v1/workflow-sandbox-tests/readiness', async (context) => {
      try {
        const query = workflowSandboxReadinessQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
          workflowVersionId: context.req.query('workflowVersionId'),
          irHash: context.req.query('irHash'),
        });
        return context.json(await readWorkflowSandboxReadiness(pool, query));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-workflow-sandbox-readiness-query' }, 400);
        }
        throw error;
      }
    })
    .get('/v1/workflow-sandbox-tests/history', async (context) => {
      const scope = {
        organizationId: context.req.query('organizationId') ?? '',
        environmentId: context.req.query('environmentId') ?? '',
        workflowVersionId: context.req.query('workflowVersionId') ?? '',
      };
      if (!scope.organizationId || !scope.environmentId || !scope.workflowVersionId) {
        return context.json({ error: 'invalid-workflow-sandbox-history-query' }, 400);
      }
      return context.json(await readWorkflowSandboxTestHistory(pool, scope));
    })
    .post('/v1/execution-grants', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'execution-grant-not-configured' }, 503);
      }
      try {
        const request = executionGrantRequestSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
          environmentId: request.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const authorization = await issueApprovedExecutionGrant(
          pool,
          workflowExecutionServices.executionGrantIssuer,
          request,
        );
        if (!authorization) return context.json({ error: 'approved-workflow-not-found' }, 404);
        return context.json(authorization, 201);
      } catch (error) {
        if (error instanceof WorkflowCapabilityLossBlocked) {
          return context.json(
            { error: 'workflow-capability-removed', blockers: error.blockers },
            409,
          );
        }
        if (error instanceof WorkflowQuarantined) {
          return context.json({ error: 'workflow-quarantined' }, 409);
        }
        if (error instanceof WorkflowSandboxTestsUnavailable) {
          return context.json(
            { error: 'workflow-artifact-unavailable', status: error.readinessStatus },
            422,
          );
        }
        if (error instanceof ExecutionArtifactMismatch) {
          return context.json({ error: 'execution-artifact-no-longer-active' }, 409);
        }
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-execution-grant-request', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .get('/v1/workflow-versions/:workflowVersionId', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'workflow-fetch-not-configured' }, 503);
      }
      const organizationId = context.req.query('organizationId');
      const environmentId = context.req.query('environmentId');
      if (!organizationId || !environmentId) {
        return context.json({ error: 'organizationId-and-environmentId-required' }, 400);
      }
      const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
        authorizationHeader: context.req.header('authorization'),
        organizationId,
        environmentId,
      });
      if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
      const workflow = await readApprovedWorkflow(
        pool,
        organizationId,
        environmentId,
        context.req.param('workflowVersionId'),
      );
      return workflow ? context.json(workflow) : context.json({ error: 'not-found' }, 404);
    })
    .get('/v1/workflow-artifacts/:artifactId', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'workflow-fetch-not-configured' }, 503);
      }
      const organizationId = context.req.query('organizationId');
      const environmentId = context.req.query('environmentId');
      if (!organizationId || !environmentId) {
        return context.json({ error: 'organizationId-and-environmentId-required' }, 400);
      }
      const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
        authorizationHeader: context.req.header('authorization'),
        organizationId,
        environmentId,
      });
      if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
      const artifact = await readApprovedTemporalWorkflowArtifact(
        pool,
        { organizationId, environmentId },
        context.req.param('artifactId'),
      );
      return artifact ? context.json(artifact) : context.json({ error: 'not-found' }, 404);
    })
    .get('/v1/workflow-bundles/:artifactId', async (context) => {
      const authorization = await authorizeWorkerScope(context);
      if ('denial' in authorization) return authorization.denial;
      const bytes = await readAtlasWorkflowBundle(
        pool,
        authorization.scope,
        context.req.param('artifactId'),
      );
      return bytes
        ? new Response(new Uint8Array(bytes), {
            headers: { 'content-type': 'application/vnd.atlas.bundle+json;version=1' },
          })
        : context.json({ error: 'not-found' }, 404);
    })
    .get('/v1/workflow-bundles/:artifactId/execution-policy', async (context) => {
      const authorization = await authorizeWorkerScope(context);
      if ('denial' in authorization) return authorization.denial;
      const policy = await readAtlasBundleExecutionPolicy(
        pool,
        authorization.scope,
        context.req.param('artifactId'),
      );
      return policy ? context.json(policy) : context.json({ error: 'not-found' }, 404);
    })
    .post('/v1/bundle-verification-events', async (context) => {
      if (!workflowExecutionServices)
        return context.json({ error: 'workflow-fetch-not-configured' }, 503);
      try {
        const body = await context.req.json();
        const value = body as Record<string, unknown>;
        const scope = runScopeSchema.parse({
          organizationId: value.organizationId,
          environmentId: value.environmentId,
        });
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          ...scope,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        await recordAtlasBundleVerificationEvent(pool, body);
        return context.body(null, 204);
      } catch (error) {
        if (error instanceof z.ZodError)
          return context.json(
            { error: 'invalid-bundle-verification-event', issues: error.issues },
            400,
          );
        throw error;
      }
    })
    .get('/v1/bundle-verification-events/:artifactId', async (context) => {
      if (!membershipAuthorizer)
        return context.json({ error: 'authorization-not-configured' }, 503);
      try {
        const scope = runScopeSchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const actor = await membershipAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: scope.organizationId,
          action: 'view-organization',
        });
        if (!actor) return context.json({ error: 'authorization-required' }, 403);
        const event = await readLatestAtlasBundleVerificationEvent(
          pool,
          scope,
          context.req.param('artifactId'),
        );
        return context.json({ event: event ?? null });
      } catch (error) {
        if (error instanceof z.ZodError)
          return context.json(
            { error: 'invalid-bundle-verification-query', issues: error.issues },
            400,
          );
        throw error;
      }
    })
    .post('/v1/workflow-compilations', async (context) => {
      try {
        const body = workflowCompilationRequestSchema.parse(await context.req.json());
        const authorizationFailure = await planningAuthorizationFailure(
          planningAuthorizer,
          context.req.header('authorization'),
          body,
        );
        if (authorizationFailure) {
          return context.json(authorizationFailure.body, authorizationFailure.status);
        }
        const projection = await readPlannerCapabilityProjection(
          pool,
          body.organizationId,
          body.environmentId,
        );
        const result = await compileWorkflowSource(body.source, {
          organizationId: body.organizationId,
          workflowVersionId: body.workflowVersionId,
          projection,
        });
        return context.json(result, result.success ? 200 : 422);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-compilation-request', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .on(['PUT', 'GET', 'DELETE'], '/v1/draft-requests/:requestId', async (context) => {
      if (!draftRequests || !plannerModel || !pool || !planningAuthorizer)
        return context.json({ error: 'planning-not-configured' }, 503);
      try {
        const id = z.string().uuid().parse(context.req.param('requestId'));
        const body =
          context.req.method === 'PUT'
            ? planningRequestSchema.parse(await context.req.json())
            : runScopeSchema.parse({
                organizationId: context.req.query('organizationId'),
                environmentId: context.req.query('environmentId'),
              });
        const authorizationHeader = context.req.header('authorization');
        const actor = await planningAuthorizer.authorize({ authorizationHeader, body });
        if (!actor) return context.json({ error: 'author-role-required' }, 403);
        const owner = {
          actorId:
            options.customerAuth?.currentActor?.()?.actorId ??
            (authorizationHeader ? sha256(authorizationHeader) : 'unauthenticated-author'),
          organizationId: body.organizationId,
          environmentId: body.environmentId,
        };
        const state =
          context.req.method === 'PUT'
            ? await draftRequests.start(
                id,
                owner,
                sha256(JSON.stringify(body)),
                (signal, onProgress) =>
                  draftWorkflow(pool, plannerModel, body, {
                    actorId: owner.actorId,
                    signal,
                    onProgress,
                  }),
              )
            : context.req.method === 'DELETE'
              ? await draftRequests.cancel(id, owner)
              : await draftRequests.read(id, owner);
        return state
          ? context.json(state)
          : context.json({ error: 'draft-request-not-found-or-conflicting' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError)
          return context.json({ error: 'invalid-draft-request' }, 400);
        throw error;
      }
    })
    .post('/v1/workflow-drafts', async (context) => {
      if (!plannerModel) return context.json({ error: 'planner-not-configured' }, 503);
      if (!planningAuthorizer) {
        return context.json({ error: 'planning-authorization-not-configured' }, 503);
      }
      try {
        const body = await context.req.json();
        const authorizationHeader = context.req.header('authorization');
        const actorRole = await planningAuthorizer.authorize({
          authorizationHeader,
          body,
        });
        if (!actorRole) return context.json({ error: 'author-role-required' }, 403);
        const actorId =
          options.customerAuth?.currentActor?.()?.actorId ??
          (authorizationHeader ? sha256(authorizationHeader) : 'unauthenticated-author');
        const trace = await options.planningTraceStore?.start({
          request: body,
          actorId,
          ...(authorizationHeader
            ? { authorizationFingerprint: credentialFingerprint(authorizationHeader) }
            : {}),
        });
        if (!trace) {
          const result = await draftWorkflow(pool, plannerModel, body, { actorId });
          return context.json(result.body, result.httpStatus);
        }
        context.header('x-atlas-planning-trace-id', trace.traceId);
        return runWithPlanningTrace(trace, async () => {
          const startedAt = performance.now();
          try {
            const result = await draftWorkflow(pool, plannerModel, body, { actorId });
            await trace.record('planning.finished', {
              durationMs: performance.now() - startedAt,
              httpStatus: result.httpStatus,
              response: result.body,
            });
            return context.json(result.body, result.httpStatus);
          } catch (error) {
            if (error instanceof PlannerUnavailableError) {
              const response = error.code
                ? { error: 'planner-unavailable' as const, reason: error.code }
                : { error: 'planner-unavailable' as const };
              await trace.record('planning.finished', {
                durationMs: performance.now() - startedAt,
                httpStatus: 503,
                response,
                error: serializeTraceError(error),
              });
              return context.json(response, 503);
            }
            if (error instanceof z.ZodError) {
              const response = {
                error: 'invalid-planning-request' as const,
                issues: error.issues,
              };
              await trace.record('planning.finished', {
                durationMs: performance.now() - startedAt,
                httpStatus: 400,
                response,
                error: serializeTraceError(error),
              });
              return context.json(response, 400);
            }
            await trace.record('planning.failed', {
              durationMs: performance.now() - startedAt,
              error: serializeTraceError(error),
            });
            throw error;
          } finally {
            await trace.close();
          }
        });
      } catch (error) {
        if (error instanceof PlannerUnavailableError) {
          return context.json(
            error.code
              ? { error: 'planner-unavailable', reason: error.code }
              : { error: 'planner-unavailable' },
            503,
          );
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-planning-request', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/workflow-validations', async (context) => {
      try {
        const report = await validateWorkflowDraft(pool, await context.req.json());
        return context.json(report, report.decision.approvable ? 200 : 422);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-validation-request', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/capability-ingestions', async (context) => {
      if (!options.allowLegacySourceRoutes) {
        return context.json({ error: 'source-connection-route-required' }, 403);
      }
      try {
        const request = await materializeRemoteCapabilitySource(
          await context.req.json(),
          sourcePolicy,
        );
        const result = await ingestCapabilities(pool, request);
        return context.json(result, 201);
      } catch (error) {
        if (error instanceof CapabilitySourcePolicyError) {
          return context.json({ error: error.code }, 400);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-ingestion', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/burger-town-source-connections', async (context) => {
      try {
        const scope = {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        };
        const authorization = await authorizeSourceConnection(
          context.req.header('authorization'),
          scope,
          'view-organization',
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        const applicationUrl = options.burgerTownAllowedApplicationUrls?.[0];
        const openApiUrl = options.burgerTownAllowedOpenApiUrls?.[0];
        if (!applicationUrl || !openApiUrl) {
          return context.json({ error: 'burger-town-connection-not-configured' }, 503);
        }
        return context.json({
          applicationUrl,
          openApiUrl,
          arazzoUrl: openApiUrl.replace(/\/openapi\.json$/i, '/arazzo.yaml'),
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-burger-town-connection-scope' }, 400);
        }
        throw error;
      }
    })
    .post('/v1/burger-town-source-connections', async (context) => {
      try {
        if (
          !options.burgerTownPlan ||
          !options.burgerTownSourcePolicy ||
          !options.burgerTownAllowedApplicationUrls ||
          !options.burgerTownAllowedOpenApiUrls
        ) {
          return context.json({ error: 'burger-town-connection-not-configured' }, 503);
        }
        const body = await context.req.json();
        const authorization = await authorizeSourceConnection(
          context.req.header('authorization'),
          body,
          'view-organization',
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        return context.json(
          await connectBurgerTown(pool, options.burgerTownSourcePolicy, body, {
            actorId: authorization.actor.actorId,
            allowedApplicationUrls: options.burgerTownAllowedApplicationUrls,
            allowedOpenApiUrls: options.burgerTownAllowedOpenApiUrls,
            plan: options.burgerTownPlan,
            plannerModel,
          }),
          201,
        );
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-burger-town-connection', issues: error.issues },
            400,
          );
        }
        return context.json(
          {
            error: 'burger-town-connection-failed',
            message: error instanceof Error ? error.message : 'Burger Town setup failed',
          },
          400,
        );
      }
    })
    .get('/v1/burger-town-monitoring', async (context) => {
      if (!options.burgerTownMonitor) {
        return context.json({ error: 'burger-town-monitoring-not-configured' }, 503);
      }
      try {
        const scope = burgerTownMonitoringScopeSchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        });
        const authorization = await authorizeOrganizationViewer(
          context.req.header('authorization'),
          scope.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        return context.json(await options.burgerTownMonitor.read(scope));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-burger-town-monitoring-scope' }, 400);
        }
        throw error;
      }
    })
    .post('/v1/burger-town-monitoring/:action', async (context) => {
      if (!options.burgerTownMonitor) {
        return context.json({ error: 'burger-town-monitoring-not-configured' }, 503);
      }
      const action = context.req.param('action');
      if (action !== 'start' && action !== 'stop') {
        return context.json({ error: 'burger-town-monitoring-action-not-found' }, 404);
      }
      try {
        const body = await context.req.json();
        const authorization = await authorizeSourceConnection(
          context.req.header('authorization'),
          body,
          'view-organization',
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        const status = await options.burgerTownMonitor[action](authorization.scope);
        return context.json(status);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-burger-town-monitoring-scope' }, 400);
        }
        if (error instanceof BurgerTownMonitoringUnavailable) {
          return context.json(
            { error: 'burger-town-monitoring-unavailable', message: error.message },
            409,
          );
        }
        throw error;
      }
    })
    .post('/v1/capability-source-connections', async (context) => {
      let refreshScope:
        | { organizationId: string; environmentId: string; serviceId: string }
        | undefined;
      try {
        const body = await context.req.json();
        const authorization = await authorizeSourceConnection(
          context.req.header('authorization'),
          body,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        if (
          body &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          typeof (body as Record<string, unknown>).serviceId === 'string'
        ) {
          refreshScope = {
            organizationId: authorization.scope.organizationId,
            environmentId: authorization.scope.environmentId,
            serviceId: (body as Record<string, unknown>).serviceId as string,
          };
        }
        const bound = bindHumanConfirmation(
          body,
          authorization.actor.actorId,
          new Date().toISOString(),
        ) as Record<string, unknown>;
        const discoveryInput = bound;
        const request = await materializeRemoteCapabilitySource(
          { ...discoveryInput, trigger: 'repository-push' },
          sourcePolicy,
        );
        const discovery = await discoverCapabilities(pool, request, plannerModel);
        const source = discoveryInput.source as Record<string, unknown>;
        const manifest = discoveryInput.manifest as Record<string, unknown>;
        return context.json(
          {
            ...discovery,
            connection: {
              serviceId: discoveryInput.serviceId,
              environmentId: authorization.scope.environmentId,
              evidence: summarizeCapabilitySourceEvidence(source),
              manifestEvidence: summarizeCapabilitySourceEvidence(
                manifest.source as Record<string, unknown>,
              ),
            },
          },
          201,
        );
      } catch (error) {
        if (refreshScope) {
          await markCapabilitySourceObservationsStale(pool, refreshScope, 'discovery-failed');
        }
        if (error instanceof CapabilitySourcePolicyError) {
          return context.json({ error: error.code }, 400);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-source-connection', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/capability-source-connections', async (context) => {
      try {
        const scope = {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        };
        const authorization = await authorizeSourceConnection(
          context.req.header('authorization'),
          scope,
          'view-organization',
        );
        return 'denial' in authorization
          ? context.json(authorization.denial.body, authorization.denial.status)
          : context.json(
              await readCapabilitySourceRegistrations(
                pool,
                authorization.scope.organizationId,
                authorization.scope.environmentId,
              ),
            );
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-source-connection-scope', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .delete('/v1/capability-source-connections/:serviceId', async (context) => {
      try {
        const scope = {
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
        };
        const authorization = await authorizeSourceConnection(
          context.req.header('authorization'),
          scope,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        const disconnected = await disconnectCapabilitySource(pool, {
          organizationId: authorization.scope.organizationId,
          environmentId: authorization.scope.environmentId,
          serviceId: context.req.param('serviceId'),
          sourceKey: context.req.query('sourceKey'),
        });
        return disconnected
          ? context.json({ disconnected: true })
          : context.json({ error: 'capability-source-not-registered' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-source-connection-scope', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .post('/v1/capability-source-connections/:serviceId/rediscovery', async (context) => {
      try {
        const body = await context.req.json();
        const authorization = await authorizeSourceConnection(
          context.req.header('authorization'),
          body,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        const discovery = await rediscoverRegisteredCapabilitySource(
          pool,
          rediscoveryPolicy,
          {
            organizationId: authorization.scope.organizationId,
            environmentId: authorization.scope.environmentId,
            serviceId: context.req.param('serviceId'),
            ...(body &&
            typeof body === 'object' &&
            !Array.isArray(body) &&
            typeof (body as Record<string, unknown>).sourceKey === 'string'
              ? { sourceKey: (body as Record<string, unknown>).sourceKey as string }
              : {}),
          },
          plannerModel,
        );
        return discovery
          ? context.json(discovery, 201)
          : context.json({ error: 'capability-source-not-registered' }, 404);
      } catch (error) {
        if (error instanceof CapabilitySourcePolicyError) {
          return context.json({ error: error.code }, 400);
        }
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-source-connection-scope', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .post('/v1/capability-discoveries/:trigger', async (context) => {
      if (!options.allowLegacySourceRoutes) {
        return context.json({ error: 'source-connection-route-required' }, 403);
      }
      try {
        const request = await materializeRemoteCapabilitySource(
          {
            ...(await context.req.json()),
            trigger: context.req.param('trigger'),
          },
          sourcePolicy,
        );
        return context.json(await discoverCapabilities(pool, request, plannerModel), 201);
      } catch (error) {
        if (error instanceof CapabilitySourcePolicyError) {
          return context.json({ error: error.code }, 400);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-discovery', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .post('/v1/capability-rediscovery-requests', async (context) => {
      if (!workflowExecutionServices) {
        return context.json({ error: 'rediscovery-request-not-configured' }, 503);
      }
      try {
        const request = rediscoveryRequestSchema.parse(await context.req.json());
        const authorized = await workflowExecutionServices.workerAuthorizer.authorize({
          authorizationHeader: context.req.header('authorization'),
          organizationId: request.organizationId,
          environmentId: request.environmentId,
        });
        if (!authorized) return context.json({ error: 'worker-authorization-required' }, 403);
        const recorded = await requestCapabilityRediscovery(
          pool,
          rediscoveryPolicy,
          request,
          plannerModel,
        );
        return recorded
          ? context.json(recorded, 202)
          : context.json({ error: 'capability-version-not-found' }, 404);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-rediscovery-request', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/capability-source-registrations', async (context) => {
      if (!options.allowLegacySourceRoutes) {
        return context.json({ error: 'source-connection-route-required' }, 403);
      }
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      return context.json(await readCapabilitySourceRegistrations(pool, organizationId));
    })
    .post('/v1/capability-source-rediscoveries', async (context) => {
      if (!options.allowLegacySourceRoutes) {
        return context.json({ error: 'source-connection-route-required' }, 403);
      }
      try {
        const discovery = await rediscoverRegisteredCapabilitySource(
          pool,
          rediscoveryPolicy,
          await context.req.json(),
          plannerModel,
        );
        return discovery
          ? context.json(discovery, 201)
          : context.json({ error: 'capability-source-not-registered' }, 404);
      } catch (error) {
        if (error instanceof CapabilitySourcePolicyError) {
          return context.json({ error: error.code }, 400);
        }
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-source-rediscovery', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/capability-discoveries', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      return context.json(
        await readCapabilityDiscoveries(
          pool,
          organizationId,
          context.req.query('environmentId') ?? 'production',
        ),
      );
    })
    .get('/v1/capability-discoveries/:discoveryId', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      const discovery = await readCapabilityDiscovery(
        pool,
        organizationId,
        context.req.param('discoveryId'),
        context.req.query('environmentId'),
      );
      return discovery ? context.json(discovery) : context.json({ error: 'not-found' }, 404);
    })
    .get('/v1/capabilities', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      const environmentId = context.req.query('environmentId') ?? 'production';
      const capabilityVersionId = context.req.query('capabilityVersionId');
      return context.json({
        capabilities: capabilityVersionId
          ? await readCapabilityCatalog(pool, organizationId, environmentId, capabilityVersionId)
          : await readCapabilityComparisonCatalog(pool, organizationId, environmentId),
      });
    })
    .get('/v1/capability-overview', async (context) => {
      try {
        const query = capabilityOverviewQuerySchema.parse({
          organizationId: context.req.query('organizationId'),
          environmentId: context.req.query('environmentId'),
          focusType: context.req.query('focusType'),
          focusId: context.req.query('focusId'),
        });
        const authorization = await authorizeOrganizationViewer(
          context.req.header('authorization'),
          query.organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        return context.json(
          await readCapabilityOverview(
            pool,
            query.organizationId,
            query.environmentId,
            query.focusType && query.focusId
              ? { type: query.focusType, id: query.focusId }
              : undefined,
          ),
        );
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-capability-overview-query', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .get('/v1/capability-architecture', async (context) => {
      try {
        const organizationId = z.string().trim().min(1).parse(context.req.query('organizationId'));
        const environmentId = z.string().trim().min(1).parse(context.req.query('environmentId'));
        const authorization = await authorizeOrganizationViewer(
          context.req.header('authorization'),
          organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        return context.json(await readCapabilityArchitecture(pool, organizationId, environmentId));
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json(
            { error: 'invalid-capability-architecture-query', issues: error.issues },
            400,
          );
        }
        throw error;
      }
    })
    .put(
      '/v1/organizations/:organizationId/environments/:environmentId/capabilities/:capabilityIdentityId/source-authority',
      async (context) => {
        const organizationId = context.req.param('organizationId');
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          organizationId,
        );
        if ('denial' in authorization) {
          return context.json(authorization.denial.body, authorization.denial.status);
        }
        try {
          const body = capabilitySourceAuthoritySchema.parse(await context.req.json());
          const resolution = await designateCapabilitySourceAuthority(pool, {
            organizationId,
            environmentId: context.req.param('environmentId'),
            capabilityIdentityId: context.req.param('capabilityIdentityId'),
            sourceKey: body.sourceKey,
            actorId: authorization.actor.actorId,
          });
          return resolution
            ? context.json(resolution)
            : context.json({ error: 'capability-source-claim-not-found' }, 404);
        } catch (error) {
          if (error instanceof z.ZodError) {
            return context.json(
              { error: 'invalid-capability-source-authority', issues: error.issues },
              400,
            );
          }
          throw error;
        }
      },
    )
    .delete(
      '/v1/organizations/:organizationId/environments/:environmentId/capabilities/:capabilityIdentityId',
      async (context) => {
        const organizationId = context.req.param('organizationId');
        const authorization = await authorizeOrganizationAdmin(
          context.req.header('authorization'),
          organizationId,
        );
        if ('denial' in authorization)
          return context.json(authorization.denial.body, authorization.denial.status);
        const capabilityIdentityId = context.req.param('capabilityIdentityId');
        if (
          !/^[1-9][0-9]{0,18}$/.test(capabilityIdentityId) ||
          BigInt(capabilityIdentityId) > 9223372036854775807n
        )
          return context.json({ error: 'invalid-capability-id' }, 400);
        const result = await deleteCapability(pool, {
          organizationId,
          environmentId: context.req.param('environmentId'),
          capabilityIdentityId,
          actorId: authorization.actor.actorId,
        });
        if (result === 'not-found') return context.json({ error: 'capability-not-found' }, 404);
        if (result === 'in-use')
          return context.json(
            {
              error: 'capability-in-use',
              message: 'This capability is used by a saved workflow and cannot be deleted.',
            },
            409,
          );
        return context.json({ deleted: true });
      },
    )
    .post(
      '/v1/organizations/:organizationId/capabilities/:capabilityIdentityId/annotations',
      async (context) => {
        const organizationId = context.req.param('organizationId');
        const authorization = await authorizeCapabilityAnnotator(
          context.req.header('authorization'),
          organizationId,
        );
        if ('denial' in authorization)
          return context.json(authorization.denial.body, authorization.denial.status);
        try {
          const capabilityIdentityId = databaseIdSchema.parse(
            context.req.param('capabilityIdentityId'),
          );
          const body = capabilityUserAnnotationSchema.parse(await context.req.json());
          const annotation = await createCapabilityUserAnnotation(pool, {
            organizationId,
            capabilityIdentityId,
            body: body.body,
            actorId: authorization.actor.actorId,
          });
          return annotation
            ? context.json(annotation, 201)
            : context.json({ error: 'capability-not-found' }, 404);
        } catch (error) {
          if (error instanceof z.ZodError) {
            return context.json(
              { error: 'invalid-capability-annotation', issues: error.issues },
              400,
            );
          }
          throw error;
        }
      },
    )
    .put(
      '/v1/organizations/:organizationId/capabilities/:capabilityIdentityId/annotations/:annotationId',
      async (context) => {
        const organizationId = context.req.param('organizationId');
        const authorization = await authorizeCapabilityAnnotator(
          context.req.header('authorization'),
          organizationId,
        );
        if ('denial' in authorization)
          return context.json(authorization.denial.body, authorization.denial.status);
        try {
          const capabilityIdentityId = databaseIdSchema.parse(
            context.req.param('capabilityIdentityId'),
          );
          const annotationId = databaseIdSchema.parse(context.req.param('annotationId'));
          const body = capabilityUserAnnotationSchema.parse(await context.req.json());
          const annotation = await updateCapabilityUserAnnotation(pool, {
            organizationId,
            capabilityIdentityId,
            annotationId,
            body: body.body,
            actorId: authorization.actor.actorId,
          });
          return annotation
            ? context.json(annotation)
            : context.json({ error: 'capability-annotation-not-found' }, 404);
        } catch (error) {
          if (error instanceof z.ZodError) {
            return context.json(
              { error: 'invalid-capability-annotation', issues: error.issues },
              400,
            );
          }
          throw error;
        }
      },
    )
    .delete(
      '/v1/organizations/:organizationId/capabilities/:capabilityIdentityId/annotations/:annotationId',
      async (context) => {
        const organizationId = context.req.param('organizationId');
        const authorization = await authorizeCapabilityAnnotator(
          context.req.header('authorization'),
          organizationId,
        );
        if ('denial' in authorization)
          return context.json(authorization.denial.body, authorization.denial.status);
        try {
          const deleted = await deleteCapabilityUserAnnotation(pool, {
            organizationId,
            capabilityIdentityId: databaseIdSchema.parse(context.req.param('capabilityIdentityId')),
            annotationId: databaseIdSchema.parse(context.req.param('annotationId')),
          });
          return deleted
            ? context.json({ deleted: true })
            : context.json({ error: 'capability-annotation-not-found' }, 404);
        } catch (error) {
          if (error instanceof z.ZodError) {
            return context.json(
              { error: 'invalid-capability-annotation', issues: error.issues },
              400,
            );
          }
          throw error;
        }
      },
    )
    .get('/v1/planner-capabilities', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      return context.json(
        await readPlannerCapabilityProjection(
          pool,
          organizationId,
          context.req.query('environmentId') ?? 'production',
        ),
      );
    })
    .get('/v1/planner-capability-references', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      const environmentId = context.req.query('environmentId') ?? 'production';
      try {
        const projection = await readPlannerCapabilityProjection(
          pool,
          organizationId,
          environmentId,
        );
        const catalog = await readCapabilityCatalog(pool, organizationId, environmentId);
        const allowed = new Set(
          projection.capabilities.map((capability) => capability.capabilityVersionId),
        );
        const expectedFingerprint = context.req.query('fingerprint');
        const result = plannerCapabilityReferenceIndex(projection, {
          ...(expectedFingerprint ? { expectedFingerprint } : {}),
          provenanceByCapabilityVersionId: new Map(
            catalog
              .filter((capability) => allowed.has(capability.capabilityVersionId))
              .map((capability) => [capability.capabilityVersionId, capability.provenance]),
          ),
        });
        if (result.status === 'stale') return context.json(result, 409);
        if (result.status === 'unavailable') return context.json(result, 503);
        return context.json(result);
      } catch {
        return context.json({ status: 'unavailable' }, 503);
      }
    })
    .post('/v1/pinned-execution-selections', async (context) => {
      try {
        const request = pinnedExecutionSelectionSchema.parse(await context.req.json());
        const selection = await readPinnedExecutionSelection(
          pool,
          request.organizationId,
          request.approvedCapabilityVersionIds,
        );
        return context.json(selection, selection.allowed ? 200 : 403);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return context.json({ error: 'invalid-selection', issues: error.issues }, 400);
        }
        throw error;
      }
    })
    .get('/v1/capability-versions/:capabilityVersionId/selection', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      const selection = await readCapabilitySelection(
        pool,
        organizationId,
        context.req.param('capabilityVersionId'),
        context.req.query('environmentId') ?? 'production',
      );
      return selection ? context.json(selection) : context.json({ error: 'not-found' }, 404);
    })
    .get('/v1/capability-versions/:capabilityVersionId', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      const version = await readCapabilityVersion(
        pool,
        organizationId,
        context.req.param('capabilityVersionId'),
        context.req.query('environmentId') ?? 'production',
      );
      return version ? context.json(version) : context.json({ error: 'not-found' }, 404);
    })
    .get('/v1/capability-versions/:capabilityVersionId/workflow-dependencies', async (context) => {
      const organizationId = context.req.query('organizationId');
      if (!organizationId) return context.json({ error: 'organizationId-required' }, 400);
      return context.json({
        dependencies: await readWorkflowDependencies(
          pool,
          organizationId,
          context.req.param('capabilityVersionId'),
          context.req.query('environmentId'),
        ),
      });
    });
}

export const app = createApp();
