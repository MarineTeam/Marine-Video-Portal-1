import { redis, k } from './redis';

// Optional email_verified enforcement.
//
// READ THIS BEFORE CHANGING ANYTHING HERE.
//
// On 2026-07-10 a security-hardening session added blanket `email_verified`
// enforcement across every authenticated route. It was caught at the push
// step. The reason it would have been a total outage: this Auth0 tenant has
// no mail server, so verification emails never send and the claim is `false`
// for every account that exists — including the admin's. Enforcing it
// unconditionally locks out the entire user base with no self-service
// recovery. That incident is `failure-archaeology` entry 2, and it is why
// the feature is shaped the way it is rather than as a simple check.
//
// Four independent guards make a repeat structurally impossible:
//
//   1. OFF BY DEFAULT, stored in Redis, toggled from the admin Settings tab.
//      Shipping this file changes nothing until somebody deliberately turns
//      it on. Same posture as the geo whitelist.
//   2. STAFF ARE ALWAYS EXEMPT. Admins and managers are never subject to it,
//      whatever the toggle says. An admin can therefore always reach /admin
//      and switch it back off — that is the recovery path, and it is why the
//      exemption is unconditional rather than another setting.
//   3. AN ENV BYPASS LIST (`EMAIL_VERIFIED_BYPASS_EMAILS`), mirroring
//      ADMIN_GEO_BYPASS_EMAILS: a standing safety net that works even if
//      Redis is wrong.
//   4. IT FAILS OPEN. Any error reading the flag admits the caller. An
//      infrastructure hiccup must never become a portal-wide lockout.
//
// And because the claim is invisible until someone signs in, the app records
// what it observes (`recordObservation`) WITHOUT enforcing anything. That
// turns "would this lock people out?" from a guess into a number the admin
// can read off the Settings tab before flipping the switch. If the tally says
// every observed account is unverified, turning this on will block every one
// of them — which is exactly the 2026-07-10 outage, just visible in advance.
//
// SCOPE: enforcement covers the approved-viewer library surface (/api/videos,
// /api/collections, /watch/video/[id]). Share links are deliberately NOT
// covered — /watch/[shareId] is the path used to reach people outside the
// viewer list, who are the least likely to have a verified address, and
// gating it would break sharing outright the moment the toggle went on.

const FLAG_KEY = 'require_email_verified';
const SEEN_KEY = 'email_verified_seen';

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Parsed leniently, matching monitorEnabled() in lib/monitor.js — a value
// pasted into a form or an env var can easily arrive as 'true ' or 'True'.
function truthy(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

export function bypassEmails() {
  return (process.env.EMAIL_VERIFIED_BYPASS_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isBypassed(email) {
  const e = normalizeEmail(email);
  return Boolean(e) && bypassEmails().includes(e);
}

export async function isEnforcementEnabled() {
  try {
    return truthy(await redis.get(k(FLAG_KEY)));
  } catch {
    return false; // fails open — guard 4
  }
}

export async function setEnforcementEnabled(enabled) {
  await redis.set(k(FLAG_KEY), enabled ? '1' : '0');
  return Boolean(enabled);
}

// Reads the claim off an Auth0 session user. Absent is treated as unverified
// for observation purposes, but see isVerified() for why absence never blocks.
export function claimFromSession(session) {
  const raw = session?.user?.email_verified;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  return null; // claim not present in this token at all
}

// Passive. Always safe to call, never enforces, never throws. This is what
// makes the blast radius measurable before the toggle is flipped.
export async function recordObservation(email, session) {
  const e = normalizeEmail(email);
  if (!e) return;
  try {
    await redis.hset(k(SEEN_KEY), {
      [e]: JSON.stringify({ verified: claimFromSession(session), at: Date.now() }),
    });
  } catch {
    // observation is a convenience; never break the request it rode in on
  }
}

function parseObservation(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return null;
    return {
      verified: obj.verified === true ? true : obj.verified === false ? false : null,
      at: Number(obj.at) || null,
    };
  } catch {
    return null;
  }
}

export async function listObservations() {
  const all = (await redis.hgetall(k(SEEN_KEY))) || {};
  return Object.entries(all)
    .map(([email, raw]) => {
      const parsed = parseObservation(raw);
      return parsed ? { email, ...parsed } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.email.localeCompare(b.email));
}

// The number the admin reads before flipping the switch: of the accounts this
// app has actually seen sign in, how many would enforcement block right now.
// `staffEmails` are excluded because they are exempt by guard 2.
export function summarizeObservations(observations, staffEmails = []) {
  const staff = new Set(staffEmails.map(normalizeEmail));
  const bypass = new Set(bypassEmails());
  const subject = observations.filter((o) => !staff.has(o.email) && !bypass.has(o.email));
  const verified = subject.filter((o) => o.verified === true);
  const unverified = subject.filter((o) => o.verified === false);
  const unknown = subject.filter((o) => o.verified === null);
  return {
    observed: observations.length,
    subject: subject.length,
    verified: verified.length,
    unverified: unverified.length,
    unknown: unknown.length,
    // Absent claims do NOT count as blocked — isVerified() admits them.
    wouldBlock: unverified.length,
    wouldBlockEmails: unverified.map((o) => o.email).sort(),
  };
}

// THE GATE. Returns true when the caller may proceed.
//
// Note the deliberate asymmetry: only an explicit `false` blocks. A missing
// claim admits the caller, because "this token doesn't carry the field" is a
// configuration difference, not evidence of an unverified address — and
// treating absence as failure is precisely how a claim that nobody can
// satisfy becomes a portal-wide outage.
export async function isVerified(session, { staff = false } = {}) {
  if (staff) return true; // guard 2 — never lock out an admin or manager
  const email = normalizeEmail(session?.user?.email);
  if (isBypassed(email)) return true; // guard 3

  let enabled;
  try {
    enabled = await isEnforcementEnabled();
  } catch {
    return true; // guard 4
  }
  if (!enabled) return true; // guard 1

  return claimFromSession(session) !== false;
}
