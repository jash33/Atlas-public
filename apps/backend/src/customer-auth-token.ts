import { createHash, randomBytes } from 'node:crypto';

const customerAuthTokenPattern = /^[A-Za-z0-9_-]{43}$/;

export function createCustomerAuthToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isCustomerAuthToken(value: string | undefined): value is string {
  return value !== undefined && customerAuthTokenPattern.test(value);
}

export function hashCustomerAuthToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
