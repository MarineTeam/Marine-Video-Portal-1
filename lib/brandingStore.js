import { redis, k } from './redis';
import { resolveSiteName, cleanSiteName } from './branding';

// Redis half of the portal name. SERVER ONLY — never import this from a
// component; see the note at the top of lib/branding.js.

const KEY = 'site_name';

// Falls back to the default on any read error rather than throwing. The name
// decorates a page header, an email and a push title; none of those is worth
// failing a request over, and a portal that renders "Marine Team" during an
// Upstash blip is strictly better than one that 500s.
export async function getSiteName() {
  try {
    return resolveSiteName(await redis.get(k(KEY)));
  } catch {
    return resolveSiteName(null);
  }
}

export async function setSiteName(name) {
  const clean = cleanSiteName(name);
  if (!clean) {
    // Clearing the field resets to the default instead of storing an empty
    // string, so there is no way to end up with an unnamed portal.
    await redis.del(k(KEY));
    return resolveSiteName(null);
  }
  await redis.set(k(KEY), clean);
  return clean;
}
