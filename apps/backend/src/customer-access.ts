import { AsyncLocalStorage } from 'node:async_hooks';
import type { MiddlewareHandler } from 'hono';

import {
  roleAllowsAction,
  type MembershipAuthorizer,
  type RbacAction,
  type Role,
} from './admin-suite.js';

export interface CustomerActor {
  actorId: string;
  organizationId: string;
  role: Role;
  displayName?: string;
}

export interface CustomerSessionVerifier {
  authenticate(request: Request): Promise<CustomerActor | null>;
  environmentsBelongToOrganization(
    organizationId: string,
    environmentIds: readonly string[],
  ): Promise<boolean>;
  isTrustedRequest(request: Request): boolean;
}

// Only these existing endpoints accept worker credentials. Each handler verifies
// the worker's organization and environment before reading or changing data.
const workerRoutes = [
  /^POST \/v1\/environment-workers$/,
  /^GET \/v1\/run-commands\/next$/,
  /^PATCH \/v1\/run-commands\/[^/]+$/,
  /^POST \/v1\/runs\/[^/]+\/(attempts|lifecycle|completion)$/,
  /^PATCH \/v1\/runs\/[^/]+\/state$/,
  /^GET \/v1\/repair-commands\/next$/,
  /^PATCH \/v1\/repair-commands\/[^/]+$/,
  /^POST \/v1\/execution-grants$/,
  /^GET \/v1\/workflow-versions\/[^/]+$/,
  /^GET \/v1\/workflow-artifacts\/[^/]+$/,
  /^GET \/v1\/workflow-bundles\/[^/]+(\/execution-policy)?$/,
  /^POST \/v1\/bundle-verification-events$/,
  /^POST \/v1\/capability-rediscovery-requests$/,
];

export function customerRequestAction(method: string, pathname: string): RbacAction {
  if (
    (method === 'GET' && pathname === '/v1/workflow-editor-drafts') ||
    (['GET', 'PUT'].includes(method) && /^\/v1\/workflow-editor-drafts\/[^/]+$/.test(pathname)) ||
    (method === 'POST' &&
      /^\/v1\/workflow-editor-drafts\/[^/]+\/(versions|validation)$/.test(pathname))
  )
    return 'draft-workflow';
  if (
    ['PUT', 'GET', 'DELETE'].includes(method) &&
    /^\/v1\/(draft-requests|workflow-sandbox-test-requests)\/[^/]+$/.test(pathname)
  )
    return 'draft-workflow';
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'view-organization';
  if (method === 'POST') {
    if (
      /^\/v1\/(workflow-(drafts|edits|validations|compilations|sandbox-tests|migration-candidates)|pinned-execution-selections)$/.test(
        pathname,
      ) ||
      pathname === '/v1/workflow-catalog/versions'
    ) {
      return 'draft-workflow';
    }
    if (pathname === '/v1/workflow-reviews') return 'view-organization';
    if (/^\/v1\/(api-runs|webhook-runs|workflow-schedules)$/.test(pathname))
      return 'start-workflow-run';
    if (/^\/v1\/runs\/[^/]+\/(repairs|provider-condition-repair)$/.test(pathname))
      return 'retry-failed-step';
  }
  if (method === 'PATCH') {
    if (/^\/v1\/workflow-migration-candidates\/[^/]+$/.test(pathname)) return 'draft-workflow';
    if (/^\/v1\/workflow-schedules\/[^/]+$/.test(pathname)) return 'start-workflow-run';
    if (/^\/v1\/notifications\/[^/]+\/read$/.test(pathname)) return 'view-organization';
  }
  if (method === 'DELETE' && pathname === '/v1/notifications') return 'view-organization';
  // New write endpoints require administrator access until assigned an explicit rule.
  return 'manage-organization';
}

function containsOtherOrganization(value: unknown, organizationId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    key === 'organizationId'
      ? child !== organizationId
      : containsOtherOrganization(child, organizationId),
  );
}

function collectEnvironmentIds(value: unknown, result = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return result;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'environmentId' && typeof child === 'string') result.add(child);
    if (key === 'environmentIds' && Array.isArray(child)) {
      for (const environmentId of child) {
        if (typeof environmentId === 'string') result.add(environmentId);
      }
    }
    collectEnvironmentIds(child, result);
  }
  return result;
}

export function createCustomerAccess(sessions: CustomerSessionVerifier) {
  // The verified identity lives only in this request's server context. Headers,
  // request bodies, and concurrent requests cannot replace it.
  const actors = new AsyncLocalStorage<CustomerActor>();
  const membershipAuthorizer: MembershipAuthorizer = {
    async authorize(request) {
      const actor = actors.getStore();
      if (
        !actor ||
        actor.organizationId !== request.organizationId ||
        !roleAllowsAction(actor.role, request.action)
      )
        return null;
      return { actorId: actor.actorId, role: actor.role };
    },
  };
  const middleware: MiddlewareHandler = async (context, next) => {
    const request = context.req.raw;
    const url = new URL(request.url);
    if (workerRoutes.some((route) => route.test(`${request.method} ${url.pathname}`))) {
      return next();
    }
    context.header('Cache-Control', 'no-store');
    let actor: CustomerActor | null;
    try {
      actor = await sessions.authenticate(request);
    } catch {
      return context.json(
        {
          error: 'sign-in-unavailable',
          message: 'Sign-in is unavailable. Try again or contact your Atlas administrator.',
        },
        503,
      );
    }
    if (!actor) return context.json({ error: 'sign-in-required' }, 401);
    if (!roleAllowsAction(actor.role, customerRequestAction(request.method, url.pathname))) {
      return context.json(
        {
          error: 'permission-denied',
          message:
            'Your Atlas role does not allow this action. Contact an administrator if you need access.',
        },
        403,
      );
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      !sessions.isTrustedRequest(request)
    ) {
      return context.json({ error: 'request-origin-rejected' }, 403);
    }
    const pathOrganization = /^\/v1\/organizations\/([^/]+)/.exec(url.pathname)?.[1];
    if (
      url.searchParams.getAll('organizationId').some((id) => id !== actor.organizationId) ||
      (pathOrganization && decodeURIComponent(pathOrganization) !== actor.organizationId)
    )
      return context.json({ error: 'organization-access-rejected' }, 403);
    let body: unknown;
    if (!['GET', 'HEAD'].includes(request.method)) {
      try {
        body = await request.clone().json();
      } catch {
        // The route's schema reports malformed or absent request data.
      }
      if (containsOtherOrganization(body, actor.organizationId)) {
        return context.json({ error: 'organization-access-rejected' }, 403);
      }
    }
    const environmentIds = collectEnvironmentIds(body);
    for (const environmentId of url.searchParams.getAll('environmentId')) {
      environmentIds.add(environmentId);
    }
    const pathEnvironment = /^\/v1\/organizations\/[^/]+\/environments\/([^/]+)/.exec(
      url.pathname,
    )?.[1];
    if (pathEnvironment) environmentIds.add(decodeURIComponent(pathEnvironment));
    if (
      environmentIds.size > 0 &&
      !(await sessions.environmentsBelongToOrganization(actor.organizationId, [...environmentIds]))
    ) {
      return context.json(
        {
          error: 'environment-access-rejected',
          message: 'This environment does not belong to your Atlas organization.',
        },
        403,
      );
    }
    await actors.run(actor, next);
  };
  return { membershipAuthorizer, middleware, currentActor: () => actors.getStore() };
}
