import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createEncryptedDataConverter,
  createTemporalWorker,
  INTERPRETER_WORKFLOW,
} from '@atlas/temporal-adapter';
import { createTemporalTestEnvironment } from '@atlas/temporal-adapter/testing';
import { createCompiledWorkflowVersion } from '@atlas/workflow-ir';

const organizationId = 'org_atlas_demo';
const taskQueue = 'atlas-production-test';
const dataConverter = createEncryptedDataConverter(Buffer.alloc(32, 80).toString('base64'));

let environment: Awaited<ReturnType<typeof createTemporalTestEnvironment>>;
let worker: Awaited<ReturnType<typeof createTemporalWorker>>;
let workerRun: Promise<void>;
const invokedSteps: string[] = [];

beforeAll(async () => {
  environment = await createTemporalTestEnvironment({ dataConverter });
  worker = await createTemporalWorker({
    connection: environment.nativeConnection,
    taskQueue,
    dataConverter,
    activities: {
      async invokeStep(invocation) {
        invokedSteps.push(invocation.stepId);
        return {};
      },
    },
  });
  workerRun = worker.run();
}, 60_000);

afterAll(async () => {
  worker.shutdown();
  await workerRun.catch(() => undefined);
  await environment.teardown();
});

describe('generic interpreter execution', () => {
  it('interprets the compiled workflow document supplied as Temporal input', async () => {
    invokedSteps.length = 0;
    const workflowId = 'run_authorized';
    const workflow = await createCompiledWorkflowVersion('authorized-workflow@1', organizationId, {
      irVersion: 1,
      steps: [
        {
          id: 'authorized-step',
          kind: 'capabilityCall',
          capabilityVersionId: 'approved-capability@1',
          arguments: {},
        },
        { id: 'completed', kind: 'terminal', state: 'completed' },
      ],
    });

    const result = await environment.client.workflow.execute(INTERPRETER_WORKFLOW, {
      workflowId,
      taskQueue,
      args: [{ workflow, input: { paymentId: 'pay_1' } }],
    });

    expect(result).toEqual({ state: 'completed' });
    expect(invokedSteps).toEqual(['authorized-step']);
  });
});
