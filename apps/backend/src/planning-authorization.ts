import { z } from 'zod';

import { matchesBearerToken } from './bearer-authorization.js';

export type PlanningActorRole = 'author' | 'admin';

export interface PlanningAuthorizationRequest {
  authorizationHeader: string | undefined;
  body: unknown;
}

export interface PlanningAuthorizer {
  authorize(request: PlanningAuthorizationRequest): Promise<PlanningActorRole | null>;
}

const planningScopeSchema = z.object({ organizationId: z.string().min(1) }).passthrough();

export function createPlanningTokenAuthorizer(input: {
  token: string;
  organizationId: string;
}): PlanningAuthorizer {
  return {
    async authorize(request) {
      const scope = planningScopeSchema.safeParse(request.body);
      if (!scope.success || scope.data.organizationId !== input.organizationId) return null;
      return matchesBearerToken(request.authorizationHeader, input.token) ? 'author' : null;
    },
  };
}
