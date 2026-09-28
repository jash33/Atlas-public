import { describe, expect, it } from 'vite-plus/test';

import { resolveTestDatabaseUrl } from './test-database.js';

describe('backend test database isolation', () => {
  it('uses a dedicated database and rejects the development database', () => {
    expect(resolveTestDatabaseUrl({})).toBe('postgresql://atlas:atlas@localhost:5432/atlas_test');
    expect(() =>
      resolveTestDatabaseUrl({
        ATLAS_TEST_DATABASE_URL: 'postgresql://atlas:atlas@localhost:5432/atlas',
      }),
    ).toThrow('Backend tests must not use the development database "atlas"');
  });
});
