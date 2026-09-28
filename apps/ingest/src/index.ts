import { serve } from '@hono/node-server';

import { createIngestApp } from './app.js';
import { createBackendClient } from './backend-client.js';
import { loadIngestConfig } from './config.js';
import { createWorkflowResultClient } from './workflow-result.js';

const config = loadIngestConfig();
const app = createIngestApp({
  readWorkflowResult: createWorkflowResultClient({
    workerUrl: config.workerUrl,
    token: config.workflowResultToken,
  }),
  responseTimeoutMs: config.responseTimeoutMs,
  callerToken: config.callerToken,
  backend: createBackendClient({
    backendUrl: config.backendUrl,
    backendToken: config.backendToken,
    organizationId: config.organizationId,
    environmentId: config.environmentId,
  }),
});

serve({ fetch: app.fetch, port: config.httpPort });

console.log(
  `Atlas ingest gateway listening on http://localhost:${config.httpPort} (${config.environmentId})`,
);
