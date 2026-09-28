import { describe, expect, it } from 'vite-plus/test';

import { adminSuiteForDemoProfile, usesSampleDemoData } from './demo-profile.js';

const localActors = {
  organizationId: 'org_atlas',
  authorId: 'atlas-author',
  adminId: 'atlas-admin',
  operatorId: 'atlas-operator',
};

describe('demo profile startup', () => {
  it('sets up Burger Town people and memberships without sample demo data', () => {
    expect(adminSuiteForDemoProfile('burger-town', localActors)).toEqual({
      organization: { id: 'org_atlas', name: 'Burger Town' },
      users: [
        {
          id: 'atlas-author',
          email: 'demo@burgertown.local',
          name: 'Burger Town Demo',
          role: 'author',
        },
        {
          id: 'atlas-operator',
          email: 'operator@burgertown.local',
          name: 'Burger Town Operator',
          role: 'operator',
        },
        {
          id: 'atlas-admin',
          email: 'admin@burgertown.local',
          name: 'Burger Town Admin',
          role: 'admin',
        },
      ],
    });
    expect(usesSampleDemoData('burger-town')).toBe(false);
  });

  it('keeps the existing sample profile as the default', () => {
    expect(adminSuiteForDemoProfile('sample', localActors).organization.name).toBe('Atlas Demo');
    expect(usesSampleDemoData('sample')).toBe(true);
  });
});
