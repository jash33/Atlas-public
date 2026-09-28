import { timingSafeEqual } from 'node:crypto';

export function matchesBearerToken(authorizationHeader: string | undefined, token: string) {
  if (!authorizationHeader) return false;
  const expectedAuthorization = `Bearer ${token}`;
  const actualBytes = Buffer.from(authorizationHeader);
  const expectedBytes = Buffer.from(expectedAuthorization);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
