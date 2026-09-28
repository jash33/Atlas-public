import type { DataConverter } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';

export function createTemporalTestEnvironment(options?: {
  readonly dataConverter?: DataConverter;
}): Promise<TestWorkflowEnvironment> {
  return TestWorkflowEnvironment.createTimeSkipping(
    options?.dataConverter ? { client: { dataConverter: options.dataConverter } } : undefined,
  );
}
