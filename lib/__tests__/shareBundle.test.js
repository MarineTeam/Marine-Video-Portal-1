import { describe, it, expect } from 'vitest';
import { isExpired, ttlSecondsFor, GRACE_SECONDS } from '../shareBundle';

describe('isExpired', () => {
  it('is false for a future expiresAt', () => {
    expect(isExpired({ expiresAt: Date.now() + 60_000 })).toBe(false);
  });

  it('is true once expiresAt has passed', () => {
    expect(isExpired({ expiresAt: Date.now() - 1 })).toBe(true);
  });

  it('is true for a missing or malformed share', () => {
    expect(isExpired(null)).toBe(true);
    expect(isExpired({})).toBe(true);
  });
});

describe('ttlSecondsFor', () => {
  it('adds the grace window on top of the remaining time', () => {
    const expiresAt = Date.now() + 3600_000; // 1 hour out
    const ttl = ttlSecondsFor(expiresAt);
    expect(ttl).toBeGreaterThan(GRACE_SECONDS);
    expect(ttl).toBeLessThanOrEqual(3600 + GRACE_SECONDS + 1);
  });

  it('still returns a positive TTL for an already-expired timestamp (grace period)', () => {
    const expiresAt = Date.now() - 3600_000; // 1 hour ago
    expect(ttlSecondsFor(expiresAt)).toBeGreaterThan(0);
    expect(ttlSecondsFor(expiresAt)).toBeLessThanOrEqual(GRACE_SECONDS + 1);
  });
});
