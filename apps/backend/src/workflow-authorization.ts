import { matchesBearerToken } from './bearer-authorization.js';

export interface WorkflowApprovalActor {
  readonly actorId: string;
  readonly role: 'admin';
}

export interface WorkflowApprovalAuthorizer {
  authorize(request: {
    authorizationHeader: string | undefined;
    organizationId: string;
  }): Promise<WorkflowApprovalActor | null>;
}

export interface WorkflowWorkerAuthorizer {
  authorize(request: {
    authorizationHeader: string | undefined;
    organizationId: string;
    environmentId: string;
  }): Promise<boolean>;
}

export interface WorkflowRepairActor {
  readonly actorId: string;
  readonly role: 'operator' | 'admin';
}

export interface WorkflowRepairAuthorizer {
  authorize(request: {
    authorizationHeader: string | undefined;
    organizationId: string;
    action?: 'retry_step' | 'resume_run' | 'cancel_run' | 'abandon_run';
  }): Promise<WorkflowRepairActor | null>;
}

export function createWorkflowApprovalTokenAuthorizer(input: {
  token: string;
  organizationId: string;
  actorId: string;
}): WorkflowApprovalAuthorizer {
  return {
    async authorize(request) {
      if (
        request.organizationId !== input.organizationId ||
        !matchesBearerToken(request.authorizationHeader, input.token)
      ) {
        return null;
      }
      return { actorId: input.actorId, role: 'admin' };
    },
  };
}

export function createWorkflowWorkerTokenAuthorizer(input: {
  token: string;
  organizationId: string;
  environmentId: string;
}): WorkflowWorkerAuthorizer {
  return {
    async authorize(request) {
      return (
        request.organizationId === input.organizationId &&
        request.environmentId === input.environmentId &&
        matchesBearerToken(request.authorizationHeader, input.token)
      );
    },
  };
}

export function createWorkflowWorkerCredentialsAuthorizer(
  credentials: readonly {
    readonly token: string;
    readonly organizationId: string;
    readonly environmentId: string;
  }[],
): WorkflowWorkerAuthorizer {
  const authorizers = credentials.map(createWorkflowWorkerTokenAuthorizer);
  return {
    async authorize(request) {
      for (const authorizer of authorizers) {
        if (await authorizer.authorize(request)) return true;
      }
      return false;
    },
  };
}

export function createWorkflowRepairTokenAuthorizer(input: {
  operatorToken: string;
  operatorActorId: string;
  adminToken: string;
  adminActorId: string;
  organizationId: string;
}): WorkflowRepairAuthorizer {
  return {
    async authorize(request) {
      if (request.organizationId !== input.organizationId) return null;
      if (matchesBearerToken(request.authorizationHeader, input.operatorToken)) {
        return { actorId: input.operatorActorId, role: 'operator' };
      }
      if (matchesBearerToken(request.authorizationHeader, input.adminToken)) {
        return { actorId: input.adminActorId, role: 'admin' };
      }
      return null;
    },
  };
}
