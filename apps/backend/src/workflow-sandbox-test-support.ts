import {
  workflowSandboxRuntimeVersion,
  workflowSandboxWorkerVersion,
  type WorkflowSandboxExecutionMethod,
  type WorkflowSandboxTestKind,
} from '@atlas/demo-estate';

import type { WorkflowSandboxExecutor } from './workflow-sandbox.js';

export function deterministicTestExecutionMethods(
  kind: WorkflowSandboxTestKind,
): WorkflowSandboxExecutionMethod[] {
  return kind === 'compatibility' ? ['static-validation'] : ['local-test-service'];
}

export function createPassingLocalWorkflowSandboxExecutor(): WorkflowSandboxExecutor {
  return {
    async execute(input) {
      return input.tests.map((test) => ({
        testId: test.testId,
        status: 'passed',
        workerVersion: workflowSandboxWorkerVersion,
        runtimeVersion: workflowSandboxRuntimeVersion,
        executionMethods: deterministicTestExecutionMethods(test.kind),
      }));
    },
  };
}
