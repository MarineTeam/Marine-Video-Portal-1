import { describe, it, expect, afterEach } from 'vitest';
import { claimFromSession, summarizeObservations, isBypassed, bypassEmails } from '../verification';

// The guards in lib/verification.js exist because enforcing email_verified
// blind nearly took this portal down (failure-archaeology entry 2). These
// tests pin the three that are pure logic; the Redis-backed toggle and the
// staff exemption are exercised through the gate in apiGates.test.js.

const session = (claim) =>
  claim === undefined ? { user: { email: 'v@example.com' } } : { user: { email: 'v@example.com', email_verified: claim } };

describe('claimFromSession', () => {
  it('reads a real boolean claim', () => {
    expect(claimFromSession(session(true))).toBe(true);
    expect(claimFromSession(session(false))).toBe(false);
  });

  it('reads a stringified claim', () => {
    expect(claimFromSession(session('true'))).toBe(true);
    expect(claimFromSession(session('false'))).toBe(false);
  });

  // Absent must be distinguishable from false. Collapsing the two is exactly
  // how a claim nobody can satisfy becomes a portal-wide lockout.
  it('returns null when the claim is absent, not false', () => {
    expect(claimFromSession(session())).toBeNull();
    expect(claimFromSession({ user: {} })).toBeNull();
    expect(claimFromSession(null)).toBeNull();
  });
});

describe('bypass list', () => {
  const original = process.env.EMAIL_VERIFIED_BYPASS_EMAILS;
  afterEach(() => {
    if (original === undefined) delete process.env.EMAIL_VERIFIED_BYPASS_EMAILS;
    else process.env.EMAIL_VERIFIED_BYPASS_EMAILS = original;
  });

  it('is empty when unset', () => {
    delete process.env.EMAIL_VERIFIED_BYPASS_EMAILS;
    expect(bypassEmails()).toEqual([]);
    expect(isBypassed('anyone@example.com')).toBe(false);
  });

  it('trims, lowercases and matches case-insensitively', () => {
    process.env.EMAIL_VERIFIED_BYPASS_EMAILS = ' Skip@Example.com , other@example.com ';
    expect(bypassEmails()).toEqual(['skip@example.com', 'other@example.com']);
    expect(isBypassed('SKIP@example.com')).toBe(true);
    expect(isBypassed('nope@example.com')).toBe(false);
  });

  it('ignores empty entries from a trailing comma', () => {
    process.env.EMAIL_VERIFIED_BYPASS_EMAILS = 'a@example.com,,';
    expect(bypassEmails()).toEqual(['a@example.com']);
    expect(isBypassed('')).toBe(false);
  });
});

describe('summarizeObservations', () => {
  const observations = [
    { email: 'admin@example.com', verified: false, at: 1 },
    { email: 'verified@example.com', verified: true, at: 1 },
    { email: 'unverified1@example.com', verified: false, at: 1 },
    { email: 'unverified2@example.com', verified: false, at: 1 },
    { email: 'unknown@example.com', verified: null, at: 1 },
  ];

  it('excludes staff from the blast radius', () => {
    const s = summarizeObservations(observations, ['admin@example.com']);
    expect(s.observed).toBe(5);
    expect(s.subject).toBe(4);
    expect(s.wouldBlock).toBe(2);
    expect(s.wouldBlockEmails).toEqual(['unverified1@example.com', 'unverified2@example.com']);
  });

  // Absent claims are admitted by the gate, so they must not inflate the count
  // the admin uses to decide — the number has to mean what it says.
  it('does not count an absent claim as blocked', () => {
    const s = summarizeObservations(observations, []);
    expect(s.unknown).toBe(1);
    expect(s.wouldBlock).toBe(3);
    expect(s.wouldBlockEmails).not.toContain('unknown@example.com');
  });

  it('counts verified accounts separately', () => {
    expect(summarizeObservations(observations, []).verified).toBe(1);
  });

  it('handles an empty history', () => {
    const s = summarizeObservations([], []);
    expect(s).toMatchObject({ observed: 0, subject: 0, wouldBlock: 0, wouldBlockEmails: [] });
  });

  // The realistic state for this tenant: no mail server, so nobody is verified.
  it('reports a full lockout when no observed account is verified', () => {
    const all = [
      { email: 'a@example.com', verified: false, at: 1 },
      { email: 'b@example.com', verified: false, at: 1 },
    ];
    const s = summarizeObservations(all, []);
    expect(s.wouldBlock).toBe(s.subject);
    expect(s.verified).toBe(0);
  });
});
