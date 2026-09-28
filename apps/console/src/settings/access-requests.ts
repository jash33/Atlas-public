import { z } from 'zod';

import { requestJson } from '../shell/api.js';
import type { DemoRole } from '../shell/session.js';

export const accessRequestSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  email: z.string().optional(),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string().optional(),
});
export type AccessRequest = z.infer<typeof accessRequestSchema>;

export async function loadAccessRequests(signal?: AbortSignal): Promise<AccessRequest[]> {
  const response = await requestJson(
    '/auth/access-requests',
    signal ? { signal } : undefined,
    () => 'Access requests could not be loaded. Refresh to try again.',
  );
  return z.object({ requests: z.array(accessRequestSchema) }).parse(response).requests;
}

export async function decideAccessRequest(
  id: string,
  decision: 'approve' | 'reject',
  role: DemoRole = 'author',
): Promise<void> {
  await requestJson(
    `/auth/access-requests/${encodeURIComponent(id)}/${decision}`,
    {
      method: 'POST',
      ...(decision === 'approve'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role }) }
        : {}),
    },
    () => 'This request could not be updated. Refresh to check its status and your admin access.',
  );
}
