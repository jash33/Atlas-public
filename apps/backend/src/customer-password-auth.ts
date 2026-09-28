import { randomBytes, scrypt as deriveWithScrypt, timingSafeEqual } from 'node:crypto';

import type { Pool } from 'pg';

import { roleSchema } from './admin-suite.js';
import { createCustomerAuthToken, hashCustomerAuthToken } from './customer-auth-token.js';
import type { CustomerActor } from './customer-auth.js';

const defaultParameters = {
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
} as const;
const keyLength = 64;
const maximumFailedAttempts = 10;
const lockMinutes = 5;

interface PasswordHash {
  passwordSalt: string;
  passwordHash: string;
  scryptCost: number;
  scryptBlockSize: number;
  scryptParallelization: number;
}

interface PasswordRecord extends PasswordHash, CustomerActor {
  username: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface CustomerPasswordAuthConfig {
  organizationId: string;
  authScope: string;
  sessionMaxAgeSeconds: number;
}

export interface PasswordSignInResult {
  token: string;
  user: CustomerActor;
}

export function normalizeUsername(username: string): string {
  return username.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

async function derivePassword(
  password: string,
  salt: Buffer,
  parameters: Pick<PasswordHash, 'scryptCost' | 'scryptBlockSize' | 'scryptParallelization'>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    deriveWithScrypt(
      password.normalize('NFC'),
      salt,
      keyLength,
      {
        cost: parameters.scryptCost,
        blockSize: parameters.scryptBlockSize,
        parallelization: parameters.scryptParallelization,
        maxmem: 64 * 1024 * 1024,
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
}

export async function hashCustomerPassword(
  password: string,
  parameters = defaultParameters,
): Promise<PasswordHash> {
  if (password.length < 15 || password.length > 1_024) {
    throw new Error('Passwords must be between 15 and 1024 characters');
  }
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt, {
    scryptCost: parameters.cost,
    scryptBlockSize: parameters.blockSize,
    scryptParallelization: parameters.parallelization,
  });
  return {
    passwordSalt: salt.toString('base64'),
    passwordHash: derived.toString('base64'),
    scryptCost: parameters.cost,
    scryptBlockSize: parameters.blockSize,
    scryptParallelization: parameters.parallelization,
  };
}

async function passwordMatches(password: string, record: PasswordHash): Promise<boolean> {
  try {
    const expected = Buffer.from(record.passwordHash, 'base64');
    const actual = await derivePassword(
      password,
      Buffer.from(record.passwordSalt, 'base64'),
      record,
    );
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

const dummyPasswordHash = hashCustomerPassword('not-a-real-password');

export function createCustomerPasswordAuth(
  pool: Pick<Pool, 'query'>,
  config: CustomerPasswordAuthConfig,
) {
  async function setPassword(input: {
    userId: string;
    username: string;
    password: string;
  }): Promise<void> {
    const username = normalizeUsername(input.username);
    if (!username || username.length > 254) throw new Error('Choose a valid username');
    const password = await hashCustomerPassword(input.password);
    const result = await pool.query<{ user_id: string }>(
      `INSERT INTO customer_password_credentials
         (organization_id, username, user_id, password_salt, password_hash,
          scrypt_cost, scrypt_block_size, scrypt_parallelization)
       SELECT $1, $2, user_id, $4, $5, $6, $7, $8
       FROM organization_memberships WHERE organization_id = $1 AND user_id = $3
       ON CONFLICT (organization_id, username) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         password_salt = EXCLUDED.password_salt,
         password_hash = EXCLUDED.password_hash,
         scrypt_cost = EXCLUDED.scrypt_cost,
         scrypt_block_size = EXCLUDED.scrypt_block_size,
         scrypt_parallelization = EXCLUDED.scrypt_parallelization,
         failed_attempts = 0,
         locked_until = NULL,
         updated_at = now()
       WHERE customer_password_credentials.user_id = EXCLUDED.user_id
       RETURNING user_id`,
      [
        config.organizationId,
        username,
        input.userId,
        password.passwordSalt,
        password.passwordHash,
        password.scryptCost,
        password.scryptBlockSize,
        password.scryptParallelization,
      ],
    );
    if (!result.rows.length) throw new Error('The user is not a member of this organization');
    await pool.query(
      'DELETE FROM customer_password_sessions WHERE organization_id = $1 AND user_id = $2',
      [config.organizationId, result.rows[0]!.user_id],
    );
  }

  async function signIn(
    usernameInput: string,
    password: string,
  ): Promise<PasswordSignInResult | null> {
    const username = normalizeUsername(usernameInput);
    const validUsername = Boolean(username) && username.length <= 254;
    const result = validUsername
      ? await pool.query<PasswordRecord>(
          `SELECT credential.username, credential.password_salt AS "passwordSalt",
              credential.password_hash AS "passwordHash",
              credential.scrypt_cost AS "scryptCost",
              credential.scrypt_block_size AS "scryptBlockSize",
              credential.scrypt_parallelization AS "scryptParallelization",
              credential.failed_attempts AS "failedAttempts",
              credential.locked_until AS "lockedUntil",
              credential.user_id AS "actorId", credential.organization_id AS "organizationId",
              membership.role, users.name AS "displayName"
       FROM customer_password_credentials credential
       JOIN organization_memberships membership
         ON membership.organization_id = credential.organization_id
        AND membership.user_id = credential.user_id
       JOIN users ON users.id = credential.user_id
       WHERE credential.organization_id = $1 AND credential.username = $2`,
          [config.organizationId, username],
        )
      : { rows: [] };
    const record = result.rows[0];
    const comparison = record ?? (await dummyPasswordHash);
    const matches = await passwordMatches(password.length <= 1_024 ? password : '', comparison);
    const locked = Boolean(record?.lockedUntil && record.lockedUntil.getTime() > Date.now());
    if (locked) return null;
    if (!record || !matches || !roleSchema.safeParse(record.role).success) {
      if (record) {
        await pool.query(
          `UPDATE customer_password_credentials SET
             failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= now()
               THEN 1 ELSE failed_attempts + 1 END,
             locked_until = CASE
               WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now()
                 THEN 1 ELSE failed_attempts + 1 END) >= $3
               THEN now() + $4 * interval '1 minute'
               ELSE locked_until
             END,
             updated_at = now()
           WHERE organization_id = $1 AND username = $2`,
          [config.organizationId, username, maximumFailedAttempts, lockMinutes],
        );
      }
      return null;
    }
    await pool.query(
      `UPDATE customer_password_credentials
       SET failed_attempts = 0, locked_until = NULL, updated_at = now()
       WHERE organization_id = $1 AND username = $2`,
      [config.organizationId, username],
    );
    const token = createCustomerAuthToken();
    await pool.query(
      `INSERT INTO customer_password_sessions
         (id_hash, organization_id, user_id, auth_scope, expires_at)
       VALUES ($1, $2, $3, $4, now() + $5 * interval '1 second')`,
      [
        hashCustomerAuthToken(token),
        config.organizationId,
        record.actorId,
        config.authScope,
        config.sessionMaxAgeSeconds,
      ],
    );
    return {
      token,
      user: {
        actorId: record.actorId,
        organizationId: record.organizationId,
        role: record.role,
        displayName: record.displayName,
      },
    };
  }

  async function authenticate(token: string | undefined): Promise<CustomerActor | null> {
    if (!token) return null;
    const result = await pool.query<CustomerActor>(
      `SELECT session.user_id AS "actorId", session.organization_id AS "organizationId",
              membership.role, users.name AS "displayName"
       FROM customer_password_sessions session
       JOIN organization_memberships membership
         ON membership.organization_id = session.organization_id
        AND membership.user_id = session.user_id
       JOIN users ON users.id = session.user_id
       WHERE session.id_hash = $1 AND session.organization_id = $2
         AND session.auth_scope = $3 AND session.expires_at > now()`,
      [hashCustomerAuthToken(token), config.organizationId, config.authScope],
    );
    const actor = result.rows[0];
    return actor && roleSchema.safeParse(actor.role).success ? actor : null;
  }

  async function revoke(token: string | undefined): Promise<void> {
    if (!token) return;
    await pool.query('DELETE FROM customer_password_sessions WHERE id_hash = $1', [
      hashCustomerAuthToken(token),
    ]);
  }

  return { authenticate, revoke, setPassword, signIn };
}
