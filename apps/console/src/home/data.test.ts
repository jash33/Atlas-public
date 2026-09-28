import { expect, it } from 'vite-plus/test';
import { environmentQuery } from './data.js';

it('builds distinct backend scopes when the environment changes', () => {
  expect(environmentQuery('org_atlas', 'development').toString()).toBe(
    'organizationId=org_atlas&environmentId=development',
  );
  expect(environmentQuery('org_atlas', 'production').toString()).toBe(
    'organizationId=org_atlas&environmentId=production',
  );
});
