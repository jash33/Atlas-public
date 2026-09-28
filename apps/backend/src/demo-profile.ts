import { demoProfiles } from '@atlas/demo-estate';

import type { BackendConfig } from './config.js';

type DemoProfile = BackendConfig['demoProfile'];

interface LocalActors {
  readonly organizationId: string;
  readonly authorId: string;
  readonly adminId: string;
  readonly operatorId: string;
}

export function adminSuiteForDemoProfile(profile: DemoProfile, actors: LocalActors) {
  const selected = demoProfiles[profile];
  return {
    organization: { id: actors.organizationId, name: selected.organizationName },
    users: [
      {
        id: actors.authorId,
        ...selected.users.author,
        role: 'author' as const,
      },
      {
        id: actors.operatorId,
        ...selected.users.operator,
        role: 'operator' as const,
      },
      {
        id: actors.adminId,
        ...selected.users.admin,
        role: 'admin' as const,
      },
    ],
  };
}

export function usesSampleDemoData(profile: DemoProfile) {
  return profile === 'sample';
}
