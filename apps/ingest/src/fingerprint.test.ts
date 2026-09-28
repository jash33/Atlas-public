import { describe, expect, it } from 'vite-plus/test';

import { fingerprintPayload } from './fingerprint.js';

describe('payload fingerprint', () => {
  it('is stable across key order', () => {
    expect(fingerprintPayload({ a: 1, b: 2 })).toBe(fingerprintPayload({ b: 2, a: 1 }));
  });

  it('changes when the payload changes', () => {
    expect(fingerprintPayload({ orderId: '1' })).not.toBe(fingerprintPayload({ orderId: '2' }));
  });
});
