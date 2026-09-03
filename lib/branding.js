// Portal name — PURE module, safe to import from client code.
//
// Deliberately split the same way lib/theme.js is: the validation and the
// default live here where a React component can import them, and the Redis
// read/write lives in lib/brandingStore.js. Importing the store from a client
// component would pull lib/redis.js (and through it Node's async_hooks) into
// the browser bundle and break the build — the same trap pages/admin.js hit
// with lib/roles.js.

export const DEFAULT_SITE_NAME = 'Marine Team';
export const MAX_SITE_NAME_LENGTH = 40;

// The name is admin-set, but it is rendered into the page header, the browser
// title, the PWA manifest, push notifications and outgoing email — so it is
// clamped and stripped of control characters here rather than trusting every
// one of those sinks to do it. React and lib/mail.js escape it for HTML on
// top of this; the manifest is JSON-encoded.
export function cleanSiteName(name) {
  return String(name ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SITE_NAME_LENGTH);
}

// An empty name would render a blank header and an unnamed PWA, so blank
// always resolves back to the default rather than being stored as-is.
export function resolveSiteName(name) {
  return cleanSiteName(name) || DEFAULT_SITE_NAME;
}

// PWA short_name has a much tighter budget than name (home-screen labels are
// truncated around 12 characters on most launchers). Take the first word, or
// a hard trim if that single word is still too long.
export function shortSiteName(name) {
  const full = resolveSiteName(name);
  if (full.length <= 12) return full;
  const firstWord = full.split(' ')[0];
  return firstWord.length <= 12 ? firstWord : firstWord.slice(0, 12);
}
