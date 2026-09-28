import { localEnvironment } from './setup-local.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { demoProviderResetScript } from './demo-provider-baseline.mjs';
import { pruneAtlasDockerStorage } from './docker-storage.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(workspaceRoot, 'infra/compose/compose.yaml');
const baseArgs = ['compose', '-f', composeFile];
const smokeRunId = randomUUID();
const reuseExistingStack = process.env.ATLAS_SMOKE_REUSE_STACK === '1';
const smokeEnvironment = reuseExistingStack
  ? { ...localEnvironment(), ATLAS_DEMO_PROFILE: 'sample' }
  : {
      ...localEnvironment(),
      ATLAS_DEMO_PROFILE: 'sample',
      ATLAS_POSTGRES_VOLUME_NAME: `atlas-smoke-postgres-${smokeRunId}`,
      ATLAS_DEVELOPMENT_WORKER_SECRETS_VOLUME_NAME: `atlas-smoke-development-secrets-${smokeRunId}`,
      ATLAS_PRODUCTION_WORKER_SECRETS_VOLUME_NAME: `atlas-smoke-production-secrets-${smokeRunId}`,
    };
const smokePaymentId = `smoke-payment-${smokeRunId}`;
const smokeInvoiceId = `smoke-invoice-${smokeRunId}`;
// API /ingest provenance: Temporal business key is the caller idempotency key (deliveryId),
// not paymentId. Mirrors WORKFLOW_RUN_ID_* + api branch in @atlas/temporal-adapter.
const smokeWorkflowId = 'one-box-smoke';
const smokeIdempotencyKey = smokeRunId;
const workflowRunNamespace = 'atlas.workflow-run-id';
const workflowRunHash = createHash('sha256')
  .update(
    JSON.stringify({
      namespace: workflowRunNamespace,
      parts: [smokeWorkflowId, smokeIdempotencyKey],
    }),
  )
  .digest('hex');
const smokeWorkflowRunId = `atlas:run:${workflowRunNamespace}:${workflowRunHash}`;

function docker(...args) {
  return execFileSync('docker', [...baseArgs, ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: smokeEnvironment,
    stdio: 'inherit',
  });
}

function dockerOutput(...args) {
  return execFileSync('docker', [...baseArgs, ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: smokeEnvironment,
  }).trim();
}

async function waitForProductionRunCommand() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = dockerOutput(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'atlas',
      '-Atc',
      "SELECT status || '|' || coalesce(error, '') FROM workflow_run_commands WHERE environment_id = 'production' ORDER BY created_at DESC LIMIT 1",
    );
    const [status, error] = result.split('|', 2);
    if (status === 'completed') return;
    if (status === 'failed')
      throw new Error(`One-box smoke run failed: ${error || 'unknown error'}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error('Production worker did not claim and acknowledge its outbound run command');
}

async function waitForCompletedRedactedRun() {
  for (let poll = 0; poll < 60; poll += 1) {
    const result = dockerOutput(
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'postgres',
      '-d',
      'atlas',
      '-Atc',
      `SELECT run.state || '|' || count(attempt.id) || '|' ||
        coalesce(bool_and((attempt.redacted_input::text || coalesce(attempt.redacted_output::text, ''))
          NOT LIKE '%${smokePaymentId}%' AND
          (attempt.redacted_input::text || coalesce(attempt.redacted_output::text, ''))
          LIKE '%[REDACTED]%'), false)
       FROM workflow_runs run
       LEFT JOIN workflow_run_step_attempts attempt
         USING (organization_id, environment_id, run_id)
       WHERE run.run_id = (
         SELECT workflow_run_id FROM workflow_run_commands
         WHERE environment_id = 'production' AND workflow_run_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1
       )
       GROUP BY run.state`,
    );
    if (result === 'completed|1|true') break;
    if (result && !result.startsWith('running|')) {
      throw new Error(`One-box run reached a non-success terminal state: ${result}`);
    }
    if (poll === 59) {
      throw new Error(`One-box run did not complete with one redacted attempt: ${result}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  const temporalPlaintextCount = dockerOutput(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'temporal',
    '-Atc',
    `SELECT
       (SELECT count(*) FROM history_node
        WHERE encode(data, 'escape') LIKE '%${smokePaymentId}%'
           OR encode(data, 'escape') LIKE '%${smokeInvoiceId}%')
       + (SELECT count(*) FROM executions
          WHERE workflow_id LIKE '%${smokePaymentId}%' OR workflow_id LIKE '%${smokeInvoiceId}%')
       + (SELECT count(*) FROM current_executions
          WHERE workflow_id LIKE '%${smokePaymentId}%' OR workflow_id LIKE '%${smokeInvoiceId}%')`,
  );
  if (temporalPlaintextCount !== '0') {
    throw new Error('Plaintext business payload leaked into Temporal persistence');
  }
  const executionCount = dockerOutput(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'temporal',
    '-Atc',
    `SELECT count(*) FROM executions WHERE workflow_id = '${smokeWorkflowRunId}'`,
  );
  if (executionCount !== '1') {
    throw new Error(`Duplicate input created ${executionCount} Temporal executions`);
  }
}

function configuredTopology() {
  return JSON.parse(
    execFileSync('docker', [...baseArgs, 'config', '--format', 'json'], {
      cwd: workspaceRoot,
      encoding: 'utf8',
    }),
  );
}

function assertTopology() {
  const topology = configuredTopology();
  const workerServices = ['worker-development', 'worker-production'];
  const ingestServices = ['ingest-development', 'ingest-production'];
  const requiredServices = [
    'backend',
    'demo-capability-seed',
    ...ingestServices,
    ...workerServices,
    'postgres',
    'temporal',
    'mock-services',
    'mock-specs',
  ];
  for (const service of requiredServices) {
    if (!topology.services[service]) throw new Error(`Compose topology is missing ${service}`);
  }
  for (const ingestService of ingestServices) {
    const ingest = topology.services[ingestService];
    if (!ingest.ports?.length) throw new Error(`${ingestService} must publish a host port`);
    const ingestNetworks = Object.keys(ingest.networks ?? {});
    if (!ingestNetworks.includes('atlas-control')) {
      throw new Error(`${ingestService} must join atlas-control`);
    }
  }
  for (const workerService of workerServices) {
    const worker = topology.services[workerService];
    if (worker.ports?.length) throw new Error(`${workerService} must not publish an inbound port`);
    if (worker.environment.ATLAS_WORKER_INTAKE_HTTP_ENABLED !== 'false') {
      throw new Error(`${workerService} must disable its inbound HTTP listener`);
    }
    const workerNetworks = Object.keys(worker.networks);
    for (const network of ['atlas-control', 'customer-execution']) {
      if (!workerNetworks.includes(network))
        throw new Error(`${workerService} is missing ${network}`);
    }
    if (workerNetworks.includes('atlas-data')) {
      throw new Error(`${workerService} must not join a database network`);
    }
  }
  if (topology.services['mock-services'].ports?.length) {
    throw new Error('Customer mock services must not publish an inbound port');
  }
}

try {
  assertTopology();
  docker('up', '-d', '--build', '--wait');
  const demoCatalog = JSON.parse(
    dockerOutput(
      'exec',
      '-T',
      'backend',
      'node',
      '-e',
      "fetch('http://localhost:4000/v1/planner-capabilities?organizationId=org_atlas&environmentId=development').then(r=>r.json()).then(v=>process.stdout.write(JSON.stringify(v.capabilities.map(c=>c.identity.serviceId+'/'+c.identity.operationId).sort())))",
    ),
  );
  const expectedDemoCatalog = [
    'billing/beginInvoiceSettlement',
    'billing/cancelInvoiceSettlement',
    'billing/getInvoice',
    'billing/markInvoicePaid',
    'events/publishInvoicePaid',
    'hubspot/createContact',
    'operations/notifyPaymentOperations',
    'payments/getPayment',
    'slack/chat_postMessage',
    'stripe/PostPaymentIntents',
  ];
  if (JSON.stringify(demoCatalog) !== JSON.stringify(expectedDemoCatalog)) {
    throw new Error(`Demo planner catalog is incomplete: ${JSON.stringify(demoCatalog)}`);
  }
  docker(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    "SELECT rolname FROM pg_roles WHERE rolname IN ('atlas', 'temporal') ORDER BY rolname;",
    '-c',
    "SELECT datname FROM pg_database WHERE datname IN ('atlas', 'temporal', 'temporal_visibility') ORDER BY datname;",
  );
  docker(
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'temporal',
    'temporal-namespace-production',
    'operator',
    'namespace',
    'describe',
    '--namespace',
    'atlas-production',
    '--address',
    '172.30.99.100:7233',
  );
  docker(
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'temporal',
    'temporal-namespace-development',
    'operator',
    'namespace',
    'describe',
    '--namespace',
    'atlas-development',
    '--address',
    '172.30.99.100:7233',
  );
  docker(
    'exec',
    '-T',
    'backend',
    'node',
    '-e',
    "Promise.all(['billing.openapi.json','stripe.openapi.json','slack.openapi.json','hubspot.openapi.json'].map(file=>fetch('http://mock-specs:4100/specs/'+file).then(r=>{if(!r.ok)throw new Error(file);return r.json()}))).then(specs=>{if(specs.some(s=>s.openapi!=='3.1.0'))process.exit(1)})",
  );
  docker(
    'exec',
    '-T',
    'mock-services',
    'node',
    '--input-type=module',
    '-e',
    demoProviderResetScript(),
  );
  docker('exec', '-T', 'backend', 'node', 'apps/backend/dist/one-box-smoke-seed.js');
  docker(
    'exec',
    '-T',
    'mock-services',
    'node',
    '-e',
    `fetch('http://localhost:4100/__control/resources',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'replace',resources:[{service:'payments',collection:'payments',id:${JSON.stringify(smokePaymentId)},document:{paymentId:${JSON.stringify(smokePaymentId)},invoiceId:${JSON.stringify(smokeInvoiceId)},status:'succeeded',amount:{value:100,currency:'USD'},paidAt:'2026-08-14T00:00:00Z'}}]})}).then(r=>{if(r.status!==204)process.exit(1)})`,
  );
  docker(
    'exec',
    '-T',
    'ingest-production',
    'node',
    '--input-type=module',
    '-e',
    `const headers={authorization:'Bearer '+process.env.ATLAS_INGEST_CALLER_TOKEN,'content-type':'application/json'};const key=${JSON.stringify(smokeIdempotencyKey)};const bodies=[];for(let duplicate=0;duplicate<2;duplicate++){const r=await fetch('http://ingest-production:4301/ingest',{method:'POST',headers,body:JSON.stringify({workflowName:'One-box smoke workflow',payload:{paymentId:${JSON.stringify(smokePaymentId)}},idempotencyKey:key})});if(r.status!==200)throw new Error('ingest workflow failed '+r.status+' '+await r.text());const commandId=r.headers.get('x-atlas-command-id');if(!commandId)throw new Error('missing command header');bodies.push({commandId,output:await r.json()})}if(JSON.stringify(bodies[0].output)!==JSON.stringify(bodies[1].output))throw new Error('same-key redelivery must return the original final response');if(bodies[1].commandId!==bodies[0].commandId)throw new Error('same-key redelivery must reuse the original commandId')`,
  );
  await waitForProductionRunCommand();
  await waitForCompletedRedactedRun();
  const duplicateEvidence = dockerOutput(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    'atlas',
    '-Atc',
    `SELECT count(*) FILTER (WHERE intake_status = 'accepted') || '|' ||
            count(*) FILTER (WHERE intake_status = 'duplicate') || '|' ||
            max(run.duplicate_submission_count)
     FROM workflow_run_commands command
     JOIN workflow_runs run ON run.run_id = command.workflow_run_id
     WHERE command.environment_id = 'production'
       AND command.workflow_run_id = (
         SELECT workflow_run_id
         FROM workflow_run_commands
         WHERE environment_id = 'production' AND workflow_run_id IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1
       )`,
  );
  // Gateway same-key redelivery returns duplicate:true without a second command row, so
  // Temporal-level intake_status=duplicate / duplicate_submission_count stay at zero.
  if (duplicateEvidence !== '1|0|0') {
    throw new Error(`One-box gateway same-key evidence was incomplete: ${duplicateEvidence}`);
  }
  const runningServices = execFileSync(
    'docker',
    [...baseArgs, 'ps', '--status', 'running', '--services'],
    { cwd: workspaceRoot, encoding: 'utf8', env: smokeEnvironment },
  )
    .trim()
    .split(/\r?\n/);
  for (const workerService of ['worker-development', 'worker-production']) {
    if (!runningServices.includes(workerService)) {
      throw new Error(`${workerService} did not remain running after its outbound startup checks`);
    }
  }
} finally {
  try {
    if (!reuseExistingStack) docker('down', '--volumes');
  } finally {
    pruneAtlasDockerStorage({ buildCache: 'preserve' });
  }
}
