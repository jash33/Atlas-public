import { expect, it } from 'vite-plus/test';

import { seedDemoEnvironmentPolicies } from './demo-environment-policy.js';

it('seeds an idempotent environment policy without fixing workflow inputs', async () => {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const pool = {
    async query(text: string, values: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: [] };
    },
  };

  await seedDemoEnvironmentPolicies(pool, 'org_atlas', ['development', 'production']);

  expect(queries).toHaveLength(1);
  expect(queries[0]?.text).toContain('ON CONFLICT (organization_id, environment_id)');
  expect(queries[0]?.text).not.toContain('workflow_start_input_schema');
  expect(queries[0]?.values).toEqual(['org_atlas', ['development', 'production']]);
});
