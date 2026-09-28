import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite-plus';

import { consoleWorkspaceSourceAliases } from '../../tooling/workspace-source-aliases';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const authMode = env.VITE_ATLAS_AUTH_MODE ?? 'demo';
  if (!['demo', 'customer'].includes(authMode))
    throw new Error('VITE_ATLAS_AUTH_MODE must be demo or customer.');
  if (authMode === 'customer') {
    if (env.VITE_ATLAS_LOCAL_DEMO === 'true')
      throw new Error('Customer Console cannot enable local demo authentication.');
    if (env.VITE_ATLAS_BACKEND_URL)
      throw new Error(
        'Customer Console requires a same-origin backend; leave VITE_ATLAS_BACKEND_URL unset.',
      );
    if (
      Object.entries(env).some(
        ([key, value]) => key.startsWith('VITE_') && /TOKEN|SECRET|PASSWORD/.test(key) && value,
      )
    ) {
      throw new Error(
        'Customer Console cannot expose tokens, secrets, or passwords through VITE_ variables.',
      );
    }
  }
  return {
    plugins: [react()],
    resolve: { alias: consoleWorkspaceSourceAliases },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/auth': 'http://localhost:4000', '/v1': 'http://localhost:4000' },
    },
  };
});
