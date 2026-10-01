import { DefaultFailureConverter } from '@temporalio/common';

// Move messages and stacks into payloads so the customer's codec encrypts them too.
// The SDK continues to decode failures recorded before this setting was enabled.
export const failureConverter = new DefaultFailureConverter({ encodeCommonAttributes: true });
