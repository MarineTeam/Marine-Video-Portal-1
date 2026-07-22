import { redis, k } from './redis';

function parseList(raw) {
  return [...new Set(
    String(raw || '')
      .split(/[\s,;]+/)
      .map((c) => c.toUpperCase().trim())
      .filter((c) => /^[A-Z]{2}$/.test(c))
  )];
}

// Country lists are env-configured (deploy-time, read-only in the admin
// panel) — GEO_WHITELIST for viewers, ADMIN_GEO_WHITELIST for admins. Each
// has its own live on/off toggle stored in Redis (default OFF), so an admin
// can flip enforcement without a redeploy.
export function getViewerCountries() {
  return parseList(process.env.GEO_WHITELIST);
}

export function getAdminCountries() {
  return parseList(process.env.ADMIN_GEO_WHITELIST);
}

export async function isViewerGeoEnabled() {
  const v = await redis.get(k('geo_viewer_enabled'));
  return v === '1' || v === 1 || v === true;
}

export async function setViewerGeoEnabled(enabled) {
  await redis.set(k('geo_viewer_enabled'), enabled ? '1' : '0');
}

export async function isAdminGeoEnabled() {
  const v = await redis.get(k('geo_admin_enabled'));
  return v === '1' || v === 1 || v === true;
}

export async function setAdminGeoEnabled(enabled) {
  await redis.set(k('geo_admin_enabled'), enabled ? '1' : '0');
}

// Standing safety net: an admin whose email is in ADMIN_GEO_BYPASS_EMAILS
// always skips the admin geo check, regardless of country or the toggle.
// Meant to be set up BEFORE traveling, not edited in the moment — env var
// changes need a redeploy to take effect, so this isn't an instant fix if
// an admin is already locked out; it's a safety net an admin arms in
// advance for themselves.
export function isAdminGeoBypassed(email) {
  if (!email) return false;
  const list = String(process.env.ADMIN_GEO_BYPASS_EMAILS || '')
    .split(/[\s,;]+/)
    .map((e) => e.toLowerCase().trim())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

// Vercel populates this header on every serverless function invocation when
// the app is actually running on Vercel's network — no external API, no
// middleware. Anywhere else (local dev, a non-Vercel host) it's simply
// absent, and callers must treat that as "unknown", not "blocked".
export function getCountry(req) {
  const c = req.headers['x-vercel-ip-country'];
  return typeof c === 'string' && c ? c.toUpperCase() : null;
}

// Fails open by design, same philosophy as the rate limiter: a disabled
// toggle, an unknown country, or an empty/unconfigured country list all
// allow access. Only an enabled toggle + a known country absent from a
// non-empty list actually denies it.
export function isCountryAllowed(country, countries, enabled) {
  if (!enabled) return true;
  if (!country) return true;
  if (!countries || countries.length === 0) return true;
  return countries.includes(country);
}

// Single entry point used by every enforcement site. Admins get their own
// whitelist/toggle (and the bypass-email safety net); everyone else uses
// the viewer whitelist/toggle.
export async function isGeoAllowed(req, email, adminUser) {
  const country = getCountry(req);
  if (adminUser) {
    if (isAdminGeoBypassed(email)) return true;
    const enabled = await isAdminGeoEnabled();
    return isCountryAllowed(country, getAdminCountries(), enabled);
  }
  const enabled = await isViewerGeoEnabled();
  return isCountryAllowed(country, getViewerCountries(), enabled);
}
