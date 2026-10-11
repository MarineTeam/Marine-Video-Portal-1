import { redis, k } from './redis';
import { listStaffEmails } from './roles';

// Orphaned per-viewer hashes. Since 2026-10-11 removing a viewer deletes their
// data itself (lib/viewerData.js — votes taken back out of the totals,
// comments included), so this sweep is the backstop for everything removed
// before that, and for anything else that ever loses an approval without
// going through the removal route. It removes any such hash whose email is no
// longer an approved viewer or staff — see architecture-contract's
// known-weak-point #3. Unlike removal it cannot take votes out of the totals,
// which is why the maintenance route recounts right after it.
//
// EVERY per-viewer key family belongs in this list AND in lib/viewerData.js.
// Adding one and forgetting this sweep is how weak-point #3 was created in the
// first place.
const VIEWER_KEY_PREFIXES = ['progress:', 'mylist:', 'ratings:'];

// Keys aren't tracked in a set (nothing needs one on the hot path), so this
// scans each prefix directly — fine for an occasional admin action.
export async function sweepOrphanedViewerData() {
  const approved = new Set(await redis.smembers(k('approved_viewers')));
  // Staff (owners, plus anyone whose roles give them a capability) keep
  // their data even if they were never added as an approved viewer. This
  // throws if the roles cannot be read, which stops the sweep — deciding
  // "nobody is staff" on a Redis blip would delete their data.
  const staff = new Set(await listStaffEmails());

  let scanned = 0;
  const staleKeys = [];
  for (const suffix of VIEWER_KEY_PREFIXES) {
    const prefix = k(suffix);
    const keys = await redis.keys(`${prefix}*`);
    scanned += keys.length;
    for (const key of keys) {
      const email = key.slice(prefix.length);
      if (!approved.has(email) && !staff.has(email)) staleKeys.push(key);
    }
  }

  if (staleKeys.length) await redis.del(...staleKeys);
  return { scanned, removed: staleKeys.length };
}

// Kept as the old name so nothing that imports it breaks; it now sweeps every
// per-viewer family, not progress alone.
export const sweepOrphanedProgress = sweepOrphanedViewerData;
