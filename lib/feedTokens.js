import crypto from 'crypto';
import { redis, k } from './redis';

// Per-subscriber podcast feed tokens.
//
// Podcast apps cannot sign in — Apple Podcasts, Spotify and Overcast fetch an
// RSS URL with no session and no Auth0 cookie. Rather than making the feed
// public, each viewer gets their own feed URL carrying a long random token
// bound to their account. The feed route resolves the token back to an email
// and then applies exactly the same approved-viewer, group and schedule checks
// the logged-in library applies.
//
// A token is a BEARER CREDENTIAL: anyone holding the URL is that viewer as far
// as the feed is concerned. Three consequences are designed in:
//   - 256 bits of randomness, so it cannot be guessed
//   - one token per viewer, rotatable — if a URL leaks, rotate and the old one
//     dies immediately
//   - the token only ever grants the FEED. It cannot reach the admin panel,
//     cannot see another viewer's library, and is re-checked against the live
//     approved-viewer set on every fetch, so removing a viewer kills their
//     feed on the next poll without anyone having to revoke anything.

const BY_TOKEN = 'feed_token_email'; // hash token -> email
const BY_EMAIL = 'feed_token_by_email'; // hash email -> token

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// URL-safe, 43 chars, 256 bits.
function mint() {
  return crypto.randomBytes(32).toString('base64url');
}

export async function getExistingToken(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  try {
    const token = await redis.hget(k(BY_EMAIL), e);
    return token ? String(token) : null;
  } catch {
    return null;
  }
}

// Idempotent: the same viewer keeps the same feed URL across visits, so an
// already-subscribed app doesn't silently stop updating.
export async function getOrCreateToken(email) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('email required');

  const existing = await getExistingToken(e);
  if (existing) return existing;

  const token = mint();
  await redis.hset(k(BY_TOKEN), { [token]: e });
  await redis.hset(k(BY_EMAIL), { [e]: token });
  return token;
}

// Issues a fresh token and drops the old one. This is the "my feed URL
// leaked" button.
export async function rotateToken(email) {
  const e = normalizeEmail(email);
  if (!e) throw new Error('email required');

  const previous = await getExistingToken(e);
  const token = mint();
  await redis.hset(k(BY_TOKEN), { [token]: e });
  await redis.hset(k(BY_EMAIL), { [e]: token });
  if (previous) await redis.hdel(k(BY_TOKEN), previous);
  return token;
}

export async function revokeToken(email) {
  const e = normalizeEmail(email);
  if (!e) return { ok: true };
  const previous = await getExistingToken(e);
  if (previous) await redis.hdel(k(BY_TOKEN), previous);
  await redis.hdel(k(BY_EMAIL), e);
  return { ok: true };
}

// Resolves a feed token back to the viewer it belongs to, or null.
//
// Fails CLOSED on a Redis error, like lib/publicVideos.js and for the same
// reason: this guards content reachable without a session, and a blip must
// never turn into an open feed. It also re-reads the mapping on every request
// rather than caching, so a rotation or a removed viewer takes effect on the
// very next poll.
export async function resolveToken(token) {
  const t = String(token || '');
  // Cheap shape check before touching Redis — a 43-char base64url string.
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  try {
    const email = await redis.hget(k(BY_TOKEN), t);
    return email ? String(email) : null;
  } catch {
    return null;
  }
}

// Called when a viewer is removed, so their feed dies with their access
// rather than relying on the per-request approved check alone.
export async function clearTokenForEmail(email) {
  try {
    await revokeToken(email);
  } catch {
    // best-effort; the feed route re-checks approval on every fetch anyway
  }
}
