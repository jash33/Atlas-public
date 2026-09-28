import { z } from 'zod';

import type { DemoRole } from './shell/session.js';

const consoleConfigSchema = z.object({
  backendUrl: z.union([z.literal(''), z.url()]),
  demoAuthorToken: z.string(),
  demoAdminToken: z.string(),
  demoOperatorToken: z.string(),
  isLocalDemo: z.boolean(),
});

export const customerAuth = import.meta.env.VITE_ATLAS_AUTH_MODE === 'customer';
const isLocalDemo =
  !customerAuth && (import.meta.env.DEV || import.meta.env.VITE_ATLAS_LOCAL_DEMO === 'true');

export const consoleConfig = consoleConfigSchema.parse({
  backendUrl: customerAuth
    ? ''
    : (import.meta.env.VITE_ATLAS_BACKEND_URL ?? 'http://localhost:4000'),
  demoAuthorToken: isLocalDemo ? (import.meta.env.VITE_ATLAS_DEMO_AUTHOR_TOKEN ?? '') : '',
  demoAdminToken: isLocalDemo ? (import.meta.env.VITE_ATLAS_DEMO_ADMIN_TOKEN ?? '') : '',
  demoOperatorToken: isLocalDemo ? (import.meta.env.VITE_ATLAS_DEMO_OPERATOR_TOKEN ?? '') : '',
  isLocalDemo,
});

// The demo role switcher exercises real server authorization: each role sends its
// own bearer token, so the backend — not the UI — decides what the role may do.
export function demoTokenForRole(role: DemoRole): string {
  if (role === 'admin') return consoleConfig.demoAdminToken;
  if (role === 'operator') return consoleConfig.demoOperatorToken;
  return consoleConfig.demoAuthorToken;
}
