import { redis, k } from './redis';

// Admin-configurable country allow-list for video access. Disabled by
// default (enabled: false) so a fresh deployment behaves exactly as before.
// Stored as one JSON-ish object, same shape as the watermark global toggle:
// { enabled: boolean, countries: string[] } — ISO 3166-1 alpha-2 codes.

export async function getGeoWhitelist() {
  const v = await redis.get(k('geo_whitelist'));
  if (!v || typeof v !== 'object') return { enabled: false, countries: [] };
  return { enabled: Boolean(v.enabled), countries: Array.isArray(v.countries) ? v.countries : [] };
}

export async function setGeoWhitelist(enabled, countries) {
  const clean = [...new Set((countries || []).map((c) => String(c).toUpperCase().trim()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  await redis.set(k('geo_whitelist'), { enabled: Boolean(enabled), countries: clean });
  return clean;
}

// Vercel populates this header on every serverless function invocation when
// the app is actually running on Vercel's network — no external API, no
// middleware. Anywhere else (local dev, a non-Vercel host) it's simply
// absent, and callers must treat that as "unknown", not "blocked" (see
// isCountryAllowed).
export function getCountry(req) {
  const c = req.headers['x-vercel-ip-country'];
  return typeof c === 'string' && c ? c.toUpperCase() : null;
}

// Fails open by design, same philosophy as the rate limiter (Decision 9):
// disabled whitelist, or a country we can't determine, never blocks a
// viewer. Only an enabled whitelist with a KNOWN, non-matching country
// actually denies access.
export function isCountryAllowed(country, whitelist) {
  if (!whitelist?.enabled) return true;
  if (!country) return true;
  return whitelist.countries.includes(country);
}
