import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';

import { initializeCustomerOrganization } from './customer-install.js';
import {
  LastOrganizationAdmin,
  MembershipAdminRequired,
  updateMembershipRole,
} from './admin-suite.js';
import { migrateTestDatabase, resolveTestDatabaseUrl } from './test-database.js';

const schema = `customer_install_test_${process.pid}`;
const databaseUrl = resolveTestDatabaseUrl();
const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });

beforeAll(async () => {
  await migrateTestDatabase(databaseUrl, { schema, lockValue: 2553 });
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

it('initializes an empty customer database without demo users or administrator access', async () => {
  await initializeCustomerOrganization(pool, {
    organizationId: 'customer',
    organizationName: 'Customer',
  });
  expect((await pool.query('SELECT id, name FROM organizations')).rows).toEqual([
    { id: 'customer', name: 'Customer' },
  ]);
  expect((await pool.query('SELECT id FROM environments ORDER BY id')).rows).toEqual([
    { id: 'development' },
    { id: 'production' },
  ]);
  expect((await pool.query('SELECT id FROM users')).rowCount).toBe(0);
  expect((await pool.query('SELECT * FROM organization_memberships')).rowCount).toBe(0);
});

it('can run again without replacing customer settings, identities, or permissions', async () => {
  await pool.query(`UPDATE organizations SET name='Renamed by customer' WHERE id='customer'`);
  await pool.query(
    `INSERT INTO users (id,email,name) VALUES ('customer-admin','admin@example.com','Admin')`,
  );
  await pool.query(
    `INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('customer','customer-admin','admin')`,
  );
  await initializeCustomerOrganization(pool, {
    organizationId: 'customer',
    organizationName: 'Original install name',
  });
  expect((await pool.query('SELECT name FROM organizations')).rows).toEqual([
    { name: 'Renamed by customer' },
  ]);
  expect((await pool.query('SELECT role FROM organization_memberships')).rows).toEqual([
    { role: 'admin' },
  ]);
  expect((await pool.query('SELECT id FROM environments')).rowCount).toBe(2);
});

it('rejects missing organization details before creating anything', async () => {
  await expect(
    initializeCustomerOrganization(pool, { organizationId: 'invalid', organizationName: '' }),
  ).rejects.toThrow(/organizationName/);
  expect((await pool.query(`SELECT id FROM organizations WHERE id='invalid'`)).rowCount).toBe(0);
});

it('keeps an administrator when customer roles change', async () => {
  await expect(
    updateMembershipRole(pool, 'customer', 'customer-admin', 'author', 'customer-admin', true),
  ).rejects.toBeInstanceOf(LastOrganizationAdmin);
  await pool.query(
    "INSERT INTO users (id,email,name) VALUES ('second-admin','second@example.com','Second')",
  );
  await pool.query(
    "INSERT INTO organization_memberships (organization_id,user_id,role) VALUES ('customer','second-admin','admin')",
  );
  await expect(
    updateMembershipRole(pool, 'customer', 'customer-admin', 'author', 'second-admin', true),
  ).resolves.toEqual({ userId: 'customer-admin', role: 'author' });
  await expect(
    updateMembershipRole(pool, 'customer', 'customer-admin', 'admin', 'customer-admin', true),
  ).rejects.toBeInstanceOf(MembershipAdminRequired);
  await expect(
    updateMembershipRole(pool, 'customer', 'second-admin', 'operator', 'second-admin', true),
  ).rejects.toBeInstanceOf(LastOrganizationAdmin);
});
